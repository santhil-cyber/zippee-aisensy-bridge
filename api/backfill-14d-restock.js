/**
 * Vercel API Endpoint — Backfill 14-Day Restock Messages
 * ──────────────────────────────────────────────────────────
 * GET /api/backfill-14d-restock?dry=true   → Preview mode
 * GET /api/backfill-14d-restock            → Actually enqueue messages
 *
 * Queries Shopify for orders placed 13-15 days ago, then enqueues
 * restock_14d_1 / restock_14d_2 (A/B) for each customer who doesn't
 * already have a Nudge 0 queued.
 *
 * Designed to be called once or on-demand. Safe to re-run (deduplicates).
 */

const axios = require('axios');
const { saveLeadForReorder, getLead } = require('./lib/db');
const { enqueueMessage, getNextValidSendTime } = require('./lib/queue');
const { getNudgeConfig } = require('./lib/classifier');
const { getRedis } = require('./lib/db');

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '0nb9nh-8p.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

function formatPhone(rawPhone) {
  if (!rawPhone) return null;
  let cleaned = rawPhone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
  if (cleaned.length !== 10) return null;
  return `+91${cleaned}`;
}

module.exports = async (req, res) => {
  const isDryRun = req.query?.dry === 'true';
  const timestamp = new Date().toISOString();

  console.log(`[Backfill 14d] Starting (${isDryRun ? 'DRY RUN' : 'LIVE'}) at ${timestamp}`);

  if (!SHOPIFY_ADMIN_TOKEN) {
    return res.status(500).json({ error: 'SHOPIFY_ADMIN_TOKEN not configured' });
  }

  try {
    // 1. Fetch orders from 13-15 days ago
    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - 15);
    const toDate = new Date(now);
    toDate.setDate(toDate.getDate() - 13);

    console.log(`[Backfill 14d] Fetching orders from ${fromDate.toISOString().split('T')[0]} to ${toDate.toISOString().split('T')[0]}`);

    const allOrders = [];
    let pageUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&created_at_min=${fromDate.toISOString()}&created_at_max=${toDate.toISOString()}&limit=250`;

    while (pageUrl) {
      const response = await axios.get(pageUrl, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const orders = response.data?.orders || [];
      allOrders.push(...orders);

      const linkHeader = response.headers?.link || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nextMatch ? nextMatch[1] : null;
    }

    console.log(`[Backfill 14d] Fetched ${allOrders.length} orders`);

    // 2. Deduplicate by phone
    const seen = new Set();
    const candidates = [];

    for (const order of allOrders) {
      const customer = order.customer || {};
      const shipping = order.shipping_address || order.billing_address || {};
      const rawPhone = shipping.phone || customer.phone || customer.default_address?.phone || order.phone;
      const phone = formatPhone(rawPhone);

      if (!phone || seen.has(phone)) continue;
      seen.add(phone);

      candidates.push({
        phone,
        firstName: customer.first_name || shipping.first_name || 'Customer',
        city: shipping.city || '',
        orderId: order.name || `#${order.order_number}`,
        orderDate: order.created_at,
        email: customer.email || '',
      });
    }

    console.log(`[Backfill 14d] ${candidates.length} unique customers from ${allOrders.length} orders`);

    // 3. Enqueue for each candidate
    const redis = getRedis();
    let enqueued = 0, skippedExisting = 0, skippedBlocked = 0, errors = 0;
    const results = [];

    for (const c of candidates) {
      try {
        // Check if already has Nudge 0 queued
        if (redis) {
          const existingKey = `msg:${c.phone}:TIER_0_REORDER:0`;
          const existing = await redis.get(existingKey);
          if (existing) {
            skippedExisting++;
            continue;
          }

          const blocked = await redis.get(`blocked:${c.phone}`);
          if (blocked) {
            skippedBlocked++;
            continue;
          }
        }

        const nudgeConfig = getNudgeConfig('TIER_0_REORDER', 0, c.phone);
        if (!nudgeConfig) { errors++; continue; }

        if (isDryRun) {
          results.push({
            phone: c.phone,
            name: c.firstName,
            order: c.orderId,
            orderDate: c.orderDate,
            template: nudgeConfig.campaignName,
            variant: nudgeConfig.abVariant,
          });
          enqueued++;
          continue;
        }

        // Save lead for reorder
        const lead = await saveLeadForReorder(c.phone, {
          name: c.firstName,
          email: c.email,
          city: c.city,
          last_order_date: c.orderDate,
        });

        if (!lead) { errors++; continue; }

        // Enqueue with delayMs=0 (already due → fires at next cron within sending hours)
        const params = nudgeConfig.getParams(lead);
        await enqueueMessage(c.phone, 'TIER_0_REORDER', 0, 0, {
          campaignName: nudgeConfig.campaignName,
          fallbackCampaign: nudgeConfig.fallbackCampaign,
          templateParams: params,
          tags: nudgeConfig.tags,
          attributes: {
            Tier: 'TIER_0_REORDER',
            Nudge_Number: '0',
            Order_ID: c.orderId,
            City: c.city,
            Backfilled: 'true',
          },
        });

        results.push({
          phone: c.phone,
          name: c.firstName,
          template: nudgeConfig.campaignName,
          status: 'enqueued',
        });
        enqueued++;

      } catch (err) {
        console.error(`[Backfill 14d] Error for ${c.phone}: ${err.message}`);
        errors++;
      }
    }

    const summary = {
      mode: isDryRun ? 'DRY_RUN' : 'LIVE',
      orders_found: allOrders.length,
      unique_customers: candidates.length,
      enqueued,
      skipped_existing: skippedExisting,
      skipped_blocked: skippedBlocked,
      errors,
      date_range: `${fromDate.toISOString().split('T')[0]} to ${toDate.toISOString().split('T')[0]}`,
      timestamp,
    };

    console.log(`[Backfill 14d] Done:`, JSON.stringify(summary));

    return res.status(200).json({
      success: true,
      summary,
      ...(isDryRun ? { preview: results } : {}),
    });

  } catch (error) {
    console.error('[Backfill 14d] Fatal:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
