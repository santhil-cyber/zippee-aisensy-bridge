#!/usr/bin/env node
/**
 * Quick diagnosis: why were no messages sent today?
 * Checks queue state, active leads, and recent analytics.
 */

const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

// Load .env
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = new Redis({ url: redisUrl, token: redisToken });

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  WHY NO MESSAGES SENT? — DIAGNOSIS                   ║');
  console.log(`║  ${new Date().toISOString()}                   ║`);
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // 1. Queue state
  console.log('1️⃣  QUEUE STATE');
  const allMembers = await redis.zrange('queue:recovery_messages', 0, -1, { withScores: true });
  const totalEntries = allMembers ? Math.floor(allMembers.length / 2) : 0;
  console.log(`  Total queued messages: ${totalEntries}`);

  const now = Date.now();
  let dueCount = 0;
  let futureCount = 0;
  let pastDueDetails = [];

  for (let i = 0; i < (allMembers?.length || 0); i += 2) {
    const memberKey = allMembers[i];
    const score = Number(allMembers[i + 1]);
    if (score <= now) {
      dueCount++;
      const data = await redis.get(`msg:${memberKey}`);
      if (pastDueDetails.length < 10) {
        pastDueDetails.push({
          key: memberKey,
          dueAt: new Date(score).toISOString(),
          campaign: data?.campaignName || 'unknown',
          phone: data?.phone || memberKey.split(':')[0],
          skipIfReturning: data?.campaignName ? undefined : undefined,
        });
      }
    } else {
      futureCount++;
    }
  }

  console.log(`  Due NOW (should have been sent): ${dueCount}`);
  console.log(`  Scheduled for future: ${futureCount}`);

  if (pastDueDetails.length > 0) {
    console.log('\n  📋 Sample of overdue messages:');
    for (const d of pastDueDetails) {
      console.log(`    ${d.key} | ${d.campaign} | due: ${d.dueAt}`);
    }
  }

  // 2. Active leads
  console.log('\n2️⃣  ACTIVE LEADS');
  const activeLeads = await redis.smembers('set:active_leads');
  console.log(`  Total active leads: ${activeLeads?.length || 0}`);

  // Sample a few leads to see their status
  let activeCount = 0, convertedCount = 0, completedCount = 0, otherCount = 0;
  for (const phone of (activeLeads || []).slice(0, 50)) {
    const lead = await redis.get(`lead:${phone}`);
    if (!lead) continue;
    if (lead.status === 'ACTIVE') activeCount++;
    else if (lead.status === 'CONVERTED') convertedCount++;
    else if (lead.status === 'COMPLETED_TIER_SEQUENCE') completedCount++;
    else otherCount++;
  }
  console.log(`  Sample (first 50): ACTIVE=${activeCount}, CONVERTED=${convertedCount}, COMPLETED=${completedCount}, OTHER=${otherCount}`);

  // 3. Analytics for today
  console.log('\n3️⃣  TODAY\'S ANALYTICS');
  const today = new Date().toISOString().split('T')[0];
  const todayStats = await redis.hgetall(`analytics:global:${today}`);
  if (todayStats && Object.keys(todayStats).length > 0) {
    console.log(`  Today (${today}): ${JSON.stringify(todayStats)}`);
  } else {
    console.log(`  Today (${today}): NO EVENTS RECORDED ❌`);
  }

  const globalStats = await redis.hgetall('analytics:global');
  console.log(`  All-time: ${JSON.stringify(globalStats)}`);

  // 4. Check the skipIfReturning impact
  console.log('\n4️⃣  skipIfReturning ANALYSIS');
  let skipFlagCount = 0;
  let noSkipCount = 0;
  for (let i = 0; i < Math.min(allMembers?.length || 0, 200); i += 2) {
    const memberKey = allMembers[i];
    const data = await redis.get(`msg:${memberKey}`);
    if (!data) continue;
    // Check if this message's campaign corresponds to a coupon nudge
    if (['nudge_2nd_cart', 'nudge_3_cart'].includes(data.campaignName)) {
      skipFlagCount++;
    } else {
      noSkipCount++;
    }
  }
  console.log(`  Queue breakdown: Coupon nudges (would be checked for returning)=${skipFlagCount}, Non-coupon=${noSkipCount}`);

  // 5. Check what the forced cron earlier did
  console.log('\n5️⃣  CONVERSION CHECK — Shopify');
  const skipStats = await redis.hgetall('analytics:campaign:nudge_2nd_cart');
  console.log(`  nudge_2nd_cart stats: ${JSON.stringify(skipStats || {})}`);
  const n3Stats = await redis.hgetall('analytics:campaign:nudge_3_cart');
  console.log(`  nudge_3_cart stats: ${JSON.stringify(n3Stats || {})}`);
  const n1Stats = await redis.hgetall('analytics:campaign:nudge_1_cart');
  console.log(`  nudge_1_cart stats: ${JSON.stringify(n1Stats || {})}`);
  const n4Stats = await redis.hgetall('analytics:campaign:nudge_4_cart');
  console.log(`  nudge_4_cart stats: ${JSON.stringify(n4Stats || {})}`);

  // 6. Check if the Shopify wildcard search is too broad
  console.log('\n6️⃣  SHOPIFY API — RETURNING CUSTOMER FALSE POSITIVE CHECK');
  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!SHOPIFY_ADMIN_TOKEN) {
    console.log('  ⚠️  No SHOPIFY_ADMIN_TOKEN locally — checking via hasPlacedOrder...');
    console.log('  💡 Set it to test: export SHOPIFY_ADMIN_TOKEN=shpat_...');
  } else {
    // Pick a few active leads and check if Shopify thinks they're returning
    const axios = require('axios');
    const SHOPIFY_STORE_DOMAIN = '0nb9nh-8p.myshopify.com';
    let testedCount = 0;
    let falsePositives = 0;

    for (const phone of (activeLeads || []).slice(0, 5)) {
      const lead = await redis.get(`lead:${phone}`);
      if (!lead || lead.status !== 'ACTIVE') continue;

      const cleanPhone = phone.replace(/\D/g, '');
      const phoneQuery = cleanPhone.slice(-10);
      try {
        const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&query=${encodeURIComponent(`phone:*${phoneQuery}*`)}&limit=5`;
        const res = await axios.get(url, {
          headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
          timeout: 8000,
        });
        const orders = res.data?.orders || [];
        testedCount++;

        // Check if ANY of the returned orders actually match this phone
        let exactMatch = false;
        for (const order of orders) {
          const orderPhone = (order.shipping_address?.phone || order.customer?.phone || '').replace(/\D/g, '');
          if (orderPhone.includes(phoneQuery)) {
            exactMatch = true;
            break;
          }
        }

        const label = orders.length > 0 ? (exactMatch ? 'RETURNING (exact match)' : `⚠️ FALSE POSITIVE (${orders.length} orders matched wildcard but NOT this phone!)`) : 'NEW CUSTOMER';
        console.log(`  ${phone} → ${orders.length} orders → ${label}`);
        if (orders.length > 0 && !exactMatch) falsePositives++;
      } catch (err) {
        console.log(`  ${phone} → ERROR: ${err.message}`);
      }
    }
    if (falsePositives > 0) {
      console.log(`\n  🚨 FOUND ${falsePositives} FALSE POSITIVES! Shopify wildcard phone search is matching wrong customers.`);
      console.log('  This could be causing the cron to skip messages for customers who never actually ordered.');
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
