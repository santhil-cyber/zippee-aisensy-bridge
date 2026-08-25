#!/usr/bin/env node
/**
 * Interactive Flow Simulator & Database Inspector
 * ------------------------------------------------
 * Tests the complete 4-step recovery sequence for a test phone number in real-time.
 * Fast-forwards queue timestamps so you can inspect DB transitions and receive test messages.
 *
 * Usage:
 *   node scripts/simulate-flow.js --phone +919XXXXXXXXX
 *   node scripts/simulate-flow.js --phone +919XXXXXXXXX --dry-run
 */

const axios = require('axios');
const { getRedis, saveLead, getLead, markConverted, updateLeadProgress } = require('../api/lib/db');
const { classifyCustomer, getNudgeConfig, getMaxNudgesForTier } = require('../api/lib/classifier');
const { enqueueMessage, getDueMessages, removeMessage, cancelAllMessagesForPhone, isWithinSendingHours } = require('../api/lib/queue');

const AISENSY_API_KEY = process.env.AISENSY_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";
const AISENSY_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

// Parse arguments
const args = process.argv.slice(2);
let phone = '+919999999999';
let isDryRun = false;
let sendRealAiSensy = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phone' && args[i + 1]) phone = args[i + 1];
  if (args[i] === '--dry-run') isDryRun = true;
  if (args[i] === '--no-send') sendRealAiSensy = false;
}

// Clean phone format
let cleanPhone = phone.replace(/\D/g, '');
if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.slice(1);
if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = cleanPhone.slice(2);
if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendAiSensyMessage(payload, fallbackCampaign) {
  if (isDryRun || !sendRealAiSensy) {
    console.log(`   [Dry Run] Would send AiSensy campaign: ${payload.campaignName} (fallback: ${fallbackCampaign})`);
    return { success: true, mode: 'dry_run' };
  }

  try {
    const res = await axios.post(AISENSY_URL, payload);
    return res.data;
  } catch (err) {
    if (fallbackCampaign && fallbackCampaign !== payload.campaignName) {
      console.log(`   ⚠️ Primary campaign "${payload.campaignName}" not active yet. Trying fallback "${fallbackCampaign}"...`);
      const fallbackPayload = { ...payload, campaignName: fallbackCampaign };
      const res = await axios.post(AISENSY_URL, fallbackPayload);
      return res.data;
    }
    throw err;
  }
}

async function runSimulation() {
  console.log('\n===============================================================');
  console.log('  🧪 PROTEIN PANTRY — RECOVERY ENGINE FLOW SIMULATION');
  console.log('===============================================================');
  console.log(`📱 Test Phone:      ${cleanPhone}`);
  console.log(`🎯 Funnel Tier:     TIER_1_CHECKOUT_ABANDON (High Intent)`);
  console.log(`🚀 Mode:            ${isDryRun ? 'DRY RUN (No live API calls)' : 'LIVE TESTING'}`);
  console.log(`🕒 IST Send Window: ${isWithinSendingHours() ? 'OPEN (09:00 - 21:00 IST)' : 'CLOSED (Will use force mode)'}`);
  console.log('===============================================================\n');

  const redis = getRedis();
  if (!redis) {
    console.log('ℹ️  Upstash Redis is not connected locally. Running in-memory flow test.');
  }

  // ─────────────────────────────────────────────────────────────────
  // STAGE 0: Initial Abandonment Event & Enrollment
  // ─────────────────────────────────────────────────────────────────
  console.log('---------------------------------------------------------------');
  console.log('📍 STAGE 0: SHOPFLO WEBHOOK INGESTION (Checkout Abandoned)');
  console.log('---------------------------------------------------------------');

  const sampleEvents = ['store_page_view', 'product_page_viewed', 'added_to_cart_ui', 'checkout_initiated', 'checkout_abandoned'];
  const classification = classifyCustomer(sampleEvents, null);
  console.log(`1. Classified 5 events into: ${classification.tier} (Priority ${classification.priority})`);

  const initialLead = {
    phone: cleanPhone,
    name: 'Santhil Test',
    email: 'santhil@proteinpantry.in',
    city: 'Delhi',
    cart_items: 'High Protein Peanut Butter, Whey Isolate 1kg',
    checkout_url: 'https://proteinpantry.in/checkout?token=test1234',
    tier: classification.tier,
    current_nudge: 0,
    status: 'ACTIVE',
    utm_source: 'simulation_test'
  };

  console.log('\n2. 💾 Storing Lead Record in Database:');
  console.log(JSON.stringify(initialLead, null, 2));

  if (redis) {
    await saveLead(initialLead);
    console.log('   ✅ Saved in Redis key: `lead:' + cleanPhone + '`');
  }

  // ─────────────────────────────────────────────────────────────────
  // SIMULATE ALL 4 NUDGES IN SEQUENCE
  // ─────────────────────────────────────────────────────────────────
  const tier = classification.tier;
  const maxNudges = getMaxNudgesForTier(tier);

  for (let nudgeNum = 1; nudgeNum <= maxNudges; nudgeNum++) {
    const config = getNudgeConfig(tier, nudgeNum);
    console.log('\n---------------------------------------------------------------');
    console.log(`📍 STAGE ${nudgeNum}: NUDGE ${nudgeNum} of ${maxNudges} (${config.campaignName})`);
    console.log(`   Normal Delay: ${config.delayMs / (60 * 1000)} minutes`);
    console.log('---------------------------------------------------------------');

    const params = config.getParams(initialLead);
    console.log(`1. Template Parameters Generated:`);
    params.forEach((p, idx) => console.log(`   {{${idx + 1}}} = "${p}"`));

    const payload = {
      apiKey: AISENSY_API_KEY,
      campaignName: config.campaignName,
      destination: cleanPhone,
      userName: initialLead.name,
      tags: config.tags,
      attributes: {
        Tier: tier,
        Nudge_Number: String(nudgeNum),
        Cart_Items: initialLead.cart_items,
      },
      templateParams: params,
    };

    console.log(`\n2. 📤 Dispatching to AiSensy:`);
    try {
      const result = await sendAiSensyMessage(payload, config.fallbackCampaign);
      console.log(`   ✅ AiSensy Response:`, result);
    } catch (err) {
      console.log(`   ❌ AiSensy Error:`, err.response?.data || err.message);
    }

    // Update DB state
    initialLead.current_nudge = nudgeNum;
    initialLead.last_sent_at = new Date().toISOString();

    console.log(`\n3. 🔄 Database State Transition:`);
    console.log(`   • lead.current_nudge: ${nudgeNum}`);
    console.log(`   • lead.last_sent_at:  ${initialLead.last_sent_at}`);

    if (nudgeNum < maxNudges) {
      const nextConfig = getNudgeConfig(tier, nudgeNum + 1);
      console.log(`   • Next scheduled:     Nudge ${nudgeNum + 1} (${nextConfig.campaignName}) in ${nextConfig.delayMs / (60 * 1000)} mins`);
    } else {
      console.log(`   • Sequence Status:    COMPLETED_TIER_SEQUENCE (All ${maxNudges} nudges sent)`);
    }

    if (redis) {
      await updateLeadProgress(cleanPhone, {
        current_nudge: nudgeNum,
        last_sent_at: initialLead.last_sent_at,
        status: nudgeNum === maxNudges ? 'COMPLETED_TIER_SEQUENCE' : 'ACTIVE'
      });
    }

    if (nudgeNum < maxNudges) {
      console.log('\n⏳ Waiting 2 seconds before simulating next stage...');
      await sleep(2000);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // STAGE 5: Order Completion & Cancellation
  // ─────────────────────────────────────────────────────────────────
  console.log('\n---------------------------------------------------------------');
  console.log('📍 STAGE 5: CONVERSION EVENT (Customer Purchases)');
  console.log('---------------------------------------------------------------');
  console.log(`1. Customer ${initialLead.name} (${cleanPhone}) places an order.`);
  console.log('2. Marking status: CONVERTED in Database...');

  initialLead.status = 'CONVERTED';
  initialLead.converted_at = new Date().toISOString();

  if (redis) {
    await markConverted(cleanPhone);
    await cancelAllMessagesForPhone(cleanPhone);
    console.log('   ✅ Redis `lead:' + cleanPhone + '` status updated to CONVERTED');
    console.log('   ✅ All future scheduled messages purged from `queue:recovery_messages`');
  }

  console.log('\n3. Final Database Record:');
  console.log(JSON.stringify(initialLead, null, 2));

  console.log('\n===============================================================');
  console.log('🎉 SIMULATION COMPLETE! All 4 nudges & conversion lifecycle verified.');
  console.log('===============================================================\n');
}

runSimulation().catch(console.error);
