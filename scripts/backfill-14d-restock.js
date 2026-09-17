#!/usr/bin/env node

/**
 * Backfill: 14-Day Restock A/B Messages
 * ─────────────────────────────────────────
 * One-time script to immediately enqueue restock_14d_1 / restock_14d_2
 * messages for customers who placed orders ~14 days ago.
 *
 * How it works:
 *   1. Queries Shopify Admin API for orders created 13-15 days ago
 *   2. Deduplicates by phone number
 *   3. Checks if a restock_14d message is already queued for each phone
 *   4. Enqueues the A/B variant message with delayMs = 0 (already due)
 *      → The queue's getNextValidSendTime() auto-bumps to 9:00 AM IST
 *
 * Usage:
 *   node scripts/backfill-14d-restock.js --dry-run   # Preview only
 *   node scripts/backfill-14d-restock.js              # Actually enqueue
 *
 * Environment:
 *   Requires .env or .env.local with SHOPIFY_ADMIN_TOKEN, UPSTASH_REDIS_REST_URL, etc.
 */

const fs = require('fs');
const path = require('path');

// Load env vars from .env and .env.local manually (no dotenv dependency)
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  });
}
loadEnvFile(path.join(__dirname, '../.env'));
loadEnvFile(path.join(__dirname, '../.env.local'));

const axios = require('axios');
const { saveLeadForReorder, getLead } = require('../api/lib/db');
const { enqueueMessage, getNextValidSendTime } = require('../api/lib/queue');
const { getNudgeConfig } = require('../api/lib/classifier');
const { getRedis } = require('../api/lib/db');

const DRY_RUN = process.argv.includes('--dry-run');
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '0nb9nh-8p.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

/**
 * Fetch orders from Shopify created between `daysAgo - 1` and `daysAgo + 1` days ago
 */
async function fetchOrdersFromDaysAgo(targetDays = 14, windowDays = 1) {
  if (!SHOPIFY_ADMIN_TOKEN) {
    console.error('❌ SHOPIFY_ADMIN_TOKEN not set. Cannot fetch orders.');
    process.exit(1);
  }

  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - (targetDays + windowDays));
  const toDate = new Date(now);
  toDate.setDate(toDate.getDate() - (targetDays - windowDays));

  console.log(`📅 Fetching orders from ${fromDate.toISOString().split('T')[0]} to ${toDate.toISOString().split('T')[0]} (${targetDays} ± ${windowDays} days ago)`);

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
    console.log(`   Fetched ${orders.length} orders (total: ${allOrders.length})`);

    // Pagination via Link header
    const linkHeader = response.headers?.link || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = nextMatch ? nextMatch[1] : null;
  }

  return allOrders;
}

/**
 * Format phone to +91XXXXXXXXXX
 */
function formatPhone(rawPhone) {
  if (!rawPhone) return null;
  let cleaned = rawPhone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
  if (cleaned.length !== 10) return null;
  return `+91${cleaned}`;
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  14-Day Restock A/B — Backfill Script');
  console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no messages enqueued)' : '🚀 LIVE (will enqueue messages)'}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // 1. Fetch orders from ~14 days ago
  const orders = await fetchOrdersFromDaysAgo(14, 1);

  if (orders.length === 0) {
    console.log('⚠️  No orders found in the 14-day window. Nothing to backfill.');
    process.exit(0);
  }

  // 2. Deduplicate by phone
  const seen = new Set();
  const candidates = [];

  for (const order of orders) {
    const customer = order.customer || {};
    const shipping = order.shipping_address || order.billing_address || {};
    const rawPhone = shipping.phone || customer.phone || customer.default_address?.phone || order.phone;
    const phone = formatPhone(rawPhone);

    if (!phone || seen.has(phone)) continue;
    seen.add(phone);

    const firstName = customer.first_name || shipping.first_name || 'Customer';
    const city = shipping.city || '';
    const orderId = order.name || `#${order.order_number}`;
    const orderDate = order.created_at;

    candidates.push({ phone, firstName, city, orderId, orderDate, email: customer.email || '' });
  }

  console.log(`\n👥 Found ${candidates.length} unique customers from ${orders.length} orders\n`);

  // 3. Check each candidate and enqueue
  const redis = getRedis();
  let enqueued = 0;
  let skippedExisting = 0;
  let skippedBlocked = 0;
  let errors = 0;

  for (const c of candidates) {
    try {
      // Check if already has a restock_14d message queued
      if (redis) {
        const existingKey0 = `msg:${c.phone}:TIER_0_REORDER:0`;
        const existing = await redis.get(existingKey0);
        if (existing) {
          console.log(`   ⏭️  ${c.phone} (${c.firstName}) — already has Nudge 0 queued. Skipping.`);
          skippedExisting++;
          continue;
        }

        // Check if blocked
        const blocked = await redis.get(`blocked:${c.phone}`);
        if (blocked) {
          console.log(`   🚫 ${c.phone} (${c.firstName}) — blocked/opted-out. Skipping.`);
          skippedBlocked++;
          continue;
        }
      }

      // Get the A/B variant for this phone
      const nudgeConfig = getNudgeConfig('TIER_0_REORDER', 0, c.phone);
      if (!nudgeConfig) {
        console.warn(`   ❌ ${c.phone} — no nudge config for Nudge 0. Skipping.`);
        errors++;
        continue;
      }

      // Calculate when the message should fire
      // Since these customers ordered 14 days ago, delayMs = 0 (already due)
      // The queue's getNextValidSendTime() will bump to next 9 AM IST if outside sending hours
      const sendAt = getNextValidSendTime(Date.now());
      const sendAtIST = new Date(sendAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      if (DRY_RUN) {
        console.log(`   ✅ WOULD ENQUEUE: ${c.phone} (${c.firstName}) | Order: ${c.orderId} on ${new Date(c.orderDate).toLocaleDateString()} | Template: ${nudgeConfig.campaignName} (Variant ${nudgeConfig.abVariant}) | Scheduled: ${sendAtIST}`);
        enqueued++;
        continue;
      }

      // Save lead for reorder funnel
      const lead = await saveLeadForReorder(c.phone, {
        name: c.firstName,
        email: c.email,
        city: c.city,
        last_order_date: c.orderDate,
      });

      if (!lead) {
        console.warn(`   ❌ ${c.phone} — failed to save lead. Skipping.`);
        errors++;
        continue;
      }

      // Enqueue with delayMs = 0 (already past due — fires at next cron within sending hours)
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

      console.log(`   ✅ ENQUEUED: ${c.phone} (${c.firstName}) | Template: ${nudgeConfig.campaignName} (${nudgeConfig.abVariant}) | Fires: ${sendAtIST}`);
      enqueued++;

    } catch (err) {
      console.error(`   ❌ Error processing ${c.phone}: ${err.message}`);
      errors++;
    }
  }

  // Summary
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  BACKFILL SUMMARY');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Total candidates:     ${candidates.length}`);
  console.log(`  ${DRY_RUN ? 'Would enqueue' : 'Enqueued'}:        ${enqueued}`);
  console.log(`  Skipped (existing):   ${skippedExisting}`);
  console.log(`  Skipped (blocked):    ${skippedBlocked}`);
  console.log(`  Errors:               ${errors}`);
  console.log('═══════════════════════════════════════════════');

  if (DRY_RUN) {
    console.log('\n💡 This was a DRY RUN. Run without --dry-run to actually enqueue messages.');
  } else {
    console.log('\n🎯 Messages enqueued! They will dispatch at 9:00 AM IST via the cron job.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
