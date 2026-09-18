/**
 * Vercel API Endpoint — Backfill 14-Day Restock Messages
 * ──────────────────────────────────────────────────────────
 * GET /api/backfill-14d-restock?dry=true   → Preview mode (fast, no Redis)
 * GET /api/backfill-14d-restock            → Actually enqueue messages
 * GET /api/backfill-14d-restock?limit=5    → Process only first N customers
 *
 * Queries Shopify for orders placed 13-15 days ago, then enqueues
 * restock_14d_1 / restock_14d_2 (A/B) for each customer.
 *
 * Optimized for Vercel Hobby 60s timeout:
 *   - Dry run skips all Redis calls (instant preview)
 *   - Live mode processes in parallel batches of 5
 *   - Limit parameter caps processing count
 */

const axios = require('axios');
const { saveLeadForReorder } = require('./lib/db');
const { enqueueMessage } = require('./lib/queue');
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
  const limit = parseInt(req.query?.limit, 10) || 999;
  const timestamp = new Date().toISOString();

  console.log(`[Backfill 14d] Starting (${isDryRun ? 'DRY RUN' : 'LIVE'}, limit=${limit}) at ${timestamp}`);

  if (!SHOPIFY_ADMIN_TOKEN) {
    return res.status(500).json({ error: 'SHOPIFY_ADMIN_TOKEN not configured' });
  }

  try {
    // 1. Fetch orders from 13-15 days ago (single page, limit 250 is enough)
    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - 15);
    const toDate = new Date(now);
    toDate.setDate(toDate.getDate() - 13);

    const shopifyUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&created_at_min=${fromDate.toISOString()}&created_at_max=${toDate.toISOString()}&limit=250&fields=id,name,order_number,created_at,customer,shipping_address,billing_address,phone`;

    const response = await axios.get(shopifyUrl, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const allOrders = response.data?.orders || [];
    console.log(`[Backfill 14d] Fetched ${allOrders.length} orders (${fromDate.toISOString().split('T')[0]} to ${toDate.toISOString().split('T')[0]})`);

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

      if (candidates.length >= limit) break;

      candidates.push({
        phone,
        firstName: customer.first_name || shipping.first_name || 'Customer',
        city: shipping.city || '',
        orderId: order.name || `#${order.order_number}`,
        orderDate: order.created_at,
        email: customer.email || '',
      });
    }

    // 3. DRY RUN — skip all Redis, just show what would happen
    if (isDryRun) {
      const preview = candidates.map(c => {
        const nudgeConfig = getNudgeConfig('TIER_0_REORDER', 0, c.phone);
        return {
          phone: c.phone,
          name: c.firstName,
          order: c.orderId,
          orderDate: c.orderDate,
          template: nudgeConfig?.campaignName || 'unknown',
          variant: nudgeConfig?.abVariant || 'A',
        };
      });

      return res.status(200).json({
        success: true,
        summary: {
          mode: 'DRY_RUN',
          orders_found: allOrders.length,
          unique_customers: candidates.length,
          would_enqueue: preview.length,
          date_range: `${fromDate.toISOString().split('T')[0]} to ${toDate.toISOString().split('T')[0]}`,
        },
        preview,
      });
    }

    // 4. LIVE — Process in parallel batches of 5 for speed
    const redis = getRedis();
    let enqueued = 0, skippedExisting = 0, skippedBlocked = 0, errors = 0;

    const BATCH_SIZE = 5;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (c) => {
        try {
          // Quick dedup check — single Redis call
          if (redis) {
            const existing = await redis.get(`msg:${c.phone}:TIER_0_REORDER:0`);
            if (existing) { skippedExisting++; return; }
          }

          const nudgeConfig = getNudgeConfig('TIER_0_REORDER', 0, c.phone);
          if (!nudgeConfig) { errors++; return; }

          const lead = await saveLeadForReorder(c.phone, {
            name: c.firstName,
            email: c.email,
            city: c.city,
            last_order_date: c.orderDate,
          });

          if (!lead) { errors++; return; }

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

          enqueued++;
          console.log(`[Backfill 14d] ✅ ${c.phone} (${c.firstName}) → ${nudgeConfig.campaignName}`);
        } catch (err) {
          console.error(`[Backfill 14d] ❌ ${c.phone}: ${err.message}`);
          errors++;
        }
      }));
    }

    return res.status(200).json({
      success: true,
      summary: {
        mode: 'LIVE',
        orders_found: allOrders.length,
        unique_customers: candidates.length,
        enqueued,
        skipped_existing: skippedExisting,
        skipped_blocked: skippedBlocked,
        errors,
        date_range: `${fromDate.toISOString().split('T')[0]} to ${toDate.toISOString().split('T')[0]}`,
        timestamp,
      },
    });

  } catch (error) {
    console.error('[Backfill 14d] Fatal:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
