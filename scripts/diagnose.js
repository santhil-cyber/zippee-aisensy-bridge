#!/usr/bin/env node
/**
 * Full System Diagnostic — Abandoned Cart Recovery Engine
 * -------------------------------------------------------
 * Inspects Redis DB, message queue, leads, analytics, and AiSensy connectivity.
 */

// Load env vars from .env file manually (no dotenv dependency)
const fs = require('fs');
const envPath = require('path').join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  });
}

const { getRedis, getLead, getActiveLeads } = require('../api/lib/db');
const { isWithinSendingHours, QUEUE_KEY } = require('../api/lib/queue');
const { getNudgeConfig, getMaxNudgesForTier, TIERS } = require('../api/lib/classifier');
const axios = require('axios');

const AISENSY_API_KEY = process.env.AISENSY_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";

async function runDiagnostics() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🔍 ABANDONED CART RECOVERY ENGINE — FULL DIAGNOSTIC      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // ── 1. REDIS CONNECTIVITY ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1️⃣  REDIS / UPSTASH CONNECTIVITY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const redis = getRedis();
  if (!redis) {
    console.log('❌ Redis NOT connected — no credentials found in env.');
    console.log('   Expected vars: KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_ variants)');
    console.log('   ⚠️  Without Redis, the queue, leads, and analytics will not work.');
    return;
  }
  
  try {
    const pong = await redis.ping();
    console.log(`✅ Redis connected: PING → ${pong}`);
  } catch (err) {
    console.log(`❌ Redis PING failed: ${err.message}`);
    return;
  }

  // ── 2. SENDING WINDOW CHECK ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('2️⃣  IST SENDING WINDOW');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const now = new Date();
  const istOffset = 330; // +5:30 in minutes
  const istMins = (now.getUTCHours() * 60 + now.getUTCMinutes() + istOffset) % (24 * 60);
  const istHour = Math.floor(istMins / 60);
  const istMin = istMins % 60;
  const inWindow = isWithinSendingHours(now);

  console.log(`Current IST Time: ${String(istHour).padStart(2,'0')}:${String(istMin).padStart(2,'0')}`);
  console.log(`Sending Window:   09:00 — 21:00 IST`);
  console.log(`Status:           ${inWindow ? '✅ OPEN (messages will dispatch)' : '🔴 CLOSED (messages held in queue)'}`);

  // ── 3. MESSAGE QUEUE STATE ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('3️⃣  MESSAGE QUEUE STATE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const totalQueued = await redis.zcard(QUEUE_KEY);
  console.log(`Total messages in queue: ${totalQueued}`);

  // Messages due NOW
  const dueNow = await redis.zrange(QUEUE_KEY, 0, Date.now(), { byScore: true });
  console.log(`Messages due for dispatch NOW: ${dueNow?.length || 0}`);

  // Messages scheduled for future
  const futureMessages = await redis.zrange(QUEUE_KEY, Date.now(), '+inf', { byScore: true });
  console.log(`Messages scheduled for future: ${futureMessages?.length || 0}`);

  // Show details of all queued messages
  if (totalQueued > 0) {
    const allMembers = await redis.zrange(QUEUE_KEY, 0, -1, { withScores: true });
    console.log('\n   📋 Queue Contents:');
    
    // allMembers could be [[member, score], ...] or [member, score, member, score, ...]
    const pairs = [];
    if (Array.isArray(allMembers) && allMembers.length > 0) {
      if (Array.isArray(allMembers[0])) {
        // Format: [[member, score], ...]
        for (const [member, score] of allMembers) {
          pairs.push({ member, score: Number(score) });
        }
      } else {
        // Format: [member, score, member, score, ...]
        // Or just members without scores
        for (let i = 0; i < allMembers.length; i++) {
          const item = allMembers[i];
          if (typeof item === 'string' || typeof item === 'object') {
            pairs.push({ member: item, score: null });
          }
        }
      }
    }

    for (const { member, score } of pairs.slice(0, 20)) {
      const memberStr = typeof member === 'object' ? JSON.stringify(member) : String(member);
      const msgData = await redis.get(`msg:${memberStr}`);
      const scheduledAt = score ? new Date(score).toISOString() : 'unknown';
      const isDue = score ? score <= Date.now() : false;
      
      console.log(`\n   ┌─ Member: ${memberStr}`);
      console.log(`   │  Scheduled: ${scheduledAt}`);
      console.log(`   │  Status: ${isDue ? '⏰ DUE NOW' : '⏳ Future'}`);
      if (msgData) {
        console.log(`   │  Campaign: ${msgData.campaignName || 'N/A'}`);
        console.log(`   │  Phone: ${msgData.phone || 'N/A'}`);
        console.log(`   │  Tier: ${msgData.tier || 'N/A'} | Nudge: ${msgData.nudgeNum || 'N/A'}`);
        console.log(`   │  Params: ${JSON.stringify(msgData.templateParams || [])}`);
        console.log(`   │  Fallback: ${msgData.fallbackCampaign || 'none'}`);
      } else {
        console.log(`   │  ⚠️  No msg data found for this member (stale pointer?)`);
      }
      console.log(`   └──────────────────`);
    }

    if (pairs.length > 20) {
      console.log(`\n   ... and ${pairs.length - 20} more messages`);
    }
  }

  // ── 4. ACTIVE LEADS ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('4️⃣  ACTIVE LEADS IN DATABASE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const activePhones = await redis.smembers('set:active_leads');
  console.log(`Total phones in set:active_leads: ${activePhones?.length || 0}`);

  if (activePhones && activePhones.length > 0) {
    const tierBreakdown = {};
    const statusBreakdown = {};
    let sampleLeads = [];

    for (const phone of activePhones.slice(0, 50)) {
      const lead = await redis.get(`lead:${phone}`);
      if (lead) {
        tierBreakdown[lead.tier] = (tierBreakdown[lead.tier] || 0) + 1;
        statusBreakdown[lead.status] = (statusBreakdown[lead.status] || 0) + 1;
        if (sampleLeads.length < 5) {
          sampleLeads.push(lead);
        }
      }
    }

    console.log('\n   Tier Breakdown:');
    for (const [tier, count] of Object.entries(tierBreakdown)) {
      console.log(`   • ${tier}: ${count}`);
    }
    console.log('\n   Status Breakdown:');
    for (const [status, count] of Object.entries(statusBreakdown)) {
      console.log(`   • ${status}: ${count}`);
    }

    console.log('\n   📋 Sample Leads (first 5):');
    for (const lead of sampleLeads) {
      const queueMembers = await redis.smembers(`lead_queue:${lead.phone}`);
      console.log(`\n   ┌─ ${lead.name} (${lead.phone})`);
      console.log(`   │  Tier: ${lead.tier} | Status: ${lead.status} | Nudge: ${lead.current_nudge}`);
      console.log(`   │  Cart: ${lead.cart_items || 'N/A'}`);
      console.log(`   │  Enrolled: ${lead.enrolled_at || 'N/A'}`);
      console.log(`   │  Last Sent: ${lead.last_sent_at || 'Never'}`);
      console.log(`   │  Queue entries: ${queueMembers?.length || 0} → [${(queueMembers || []).join(', ')}]`);
      console.log(`   └──────────────────`);
    }
  }

  // ── 5. BLOCKED NUMBERS ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('5️⃣  BLOCKED / OPTED-OUT NUMBERS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Scan for blocked: keys
  let blockedCount = 0;
  let cursor = '0';
  const blockedSamples = [];
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'blocked:*', count: 100 });
    cursor = String(nextCursor);
    blockedCount += keys.length;
    for (const key of keys.slice(0, 3)) {
      const data = await redis.get(key);
      blockedSamples.push({ key, data });
    }
  } while (cursor !== '0');

  console.log(`Total blocked numbers: ${blockedCount}`);
  if (blockedSamples.length > 0) {
    for (const { key, data } of blockedSamples) {
      console.log(`   • ${key}: ${JSON.stringify(data)}`);
    }
  }

  // ── 6. ANALYTICS / GLOBAL STATS ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('6️⃣  ANALYTICS / CAMPAIGN STATS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const globalStats = await redis.hgetall('analytics:global');
  if (globalStats && Object.keys(globalStats).length > 0) {
    console.log('   Global totals:');
    for (const [event, count] of Object.entries(globalStats)) {
      console.log(`   • ${event}: ${count}`);
    }
  } else {
    console.log('   No analytics data found (analytics:global is empty)');
  }

  // Check specific campaign stats
  const campaigns = ['nudge_1_cart', 'nudge_2_cart', 'nudge_3_cart', 'nudge_4_cart', '1st_nudge', 'nudge_2', 'shopflo_abandoned_cart'];
  console.log('\n   Campaign-level stats:');
  for (const campaign of campaigns) {
    const stats = await redis.hgetall(`analytics:campaign:${campaign}`);
    if (stats && Object.keys(stats).length > 0) {
      console.log(`   📊 ${campaign}: ${JSON.stringify(stats)}`);
    }
  }

  // ── 7. AISENSY TEMPLATE STATUS CHECK ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('7️⃣  AISENSY TEMPLATE LIVE CHECK');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const templateTests = [
    { campaign: 'nudge_1_cart', params: ['Test', 'Peanut Butter'] },
    { campaign: 'nudge_2_cart', params: ['Test', 'Pro10'] },
    { campaign: 'nudge_3_cart', params: ['Test', 'FREEDEL'] },
    { campaign: 'nudge_4_cart', params: ['Test'] },
    { campaign: '1st_nudge',   params: ['Test', 'items'] },  // fallback for nudge_1_cart
  ];

  // Use a dummy number that won't actually deliver (just checks if template is valid)
  for (const { campaign, params } of templateTests) {
    try {
      const res = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', {
        apiKey: AISENSY_API_KEY,
        campaignName: campaign,
        destination: '+919350233912',
        userName: 'DiagTest',
        templateParams: params,
      });
      console.log(`   ✅ ${campaign} (${params.length} params) → API accepted (${res.data?.success || 'ok'})`);
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message;
      if (errMsg.includes('Template params does not match')) {
        console.log(`   ❌ ${campaign} (${params.length} params) → PARAM MISMATCH — wrong number of params`);
      } else if (errMsg.includes('not found') || errMsg.includes('not active')) {
        console.log(`   ⏳ ${campaign} → PENDING/NOT ACTIVE — template not yet approved`);
      } else {
        console.log(`   ⚠️  ${campaign} → ${errMsg}`);
      }
    }
  }

  // ── 8. SHOPIFY API CHECK ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('8️⃣  SHOPIFY ADMIN API');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopifyToken) {
    console.log('   ⚠️  SHOPIFY_ADMIN_TOKEN not set — live purchase checks will be SKIPPED');
    console.log('   This means the cron job cannot verify if a customer has already bought.');
    console.log('   Converted customers might still receive nudge messages!');
  } else {
    console.log(`   ✅ SHOPIFY_ADMIN_TOKEN is configured (${shopifyToken.substring(0, 8)}...)`);
  }

  // ── 9. RATE LIMIT KEYS ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('9️⃣  WEEKLY RATE LIMITS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let rateCursor = '0';
  let rateCount = 0;
  const rateSamples = [];
  do {
    const [nextCursor, keys] = await redis.scan(rateCursor, { match: 'rate:weekly:*', count: 100 });
    rateCursor = String(nextCursor);
    rateCount += keys.length;
    for (const key of keys.slice(0, 5)) {
      const val = await redis.get(key);
      const ttl = await redis.ttl(key);
      rateSamples.push({ key, count: val, ttlDays: (ttl / 86400).toFixed(1) });
    }
  } while (rateCursor !== '0');

  console.log(`Phones with weekly rate counters: ${rateCount}`);
  for (const { key, count, ttlDays } of rateSamples) {
    const phone = key.replace('rate:weekly:', '');
    console.log(`   • ${phone}: ${count}/3 messages this week (expires in ${ttlDays} days)`);
  }

  // ── SUMMARY ──
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  📊 DIAGNOSTIC SUMMARY                                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`   Redis:          ✅ Connected`);
  console.log(`   Sending Window: ${inWindow ? '✅ OPEN' : '🔴 CLOSED'}`);
  console.log(`   Queue Size:     ${totalQueued} messages (${dueNow?.length || 0} due now)`);
  console.log(`   Active Leads:   ${activePhones?.length || 0}`);
  console.log(`   Blocked:        ${blockedCount}`);
  console.log(`   Rate Limited:   ${rateCount} phones`);
  console.log(`   Shopify Token:  ${shopifyToken ? '✅ Set' : '❌ Missing'}`);
  console.log('');
}

runDiagnostics().catch(err => {
  console.error('Diagnostic script failed:', err);
  process.exit(1);
});
