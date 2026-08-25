#!/usr/bin/env node
/**
 * Re-enroll All Active Leads into New nudge_X_cart Sequence
 * ----------------------------------------------------------
 * Reads all 212 active leads from Redis and enqueues Nudge 1
 * with the correct nudge_1_cart template, staggered to avoid
 * blasting all at once.
 *
 * The cron job will then:
 *   1. Pick up due Nudge 1 messages
 *   2. Send via AiSensy (nudge_1_cart)
 *   3. Automatically enqueue Nudge 2, then 3, then 4 at the proper intervals
 *
 * Usage:
 *   node scripts/enroll-active-leads.js              (live run)
 *   node scripts/enroll-active-leads.js --dry-run     (preview only)
 */

const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  });
}

const { getRedis, getLead } = require('../api/lib/db');
const { enqueueMessage } = require('../api/lib/queue');
const { getNudgeConfig } = require('../api/lib/classifier');

const isDryRun = process.argv.includes('--dry-run');

async function enrollAll() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🚀 RE-ENROLLING ACTIVE LEADS INTO nudge_X_cart SEQUENCE   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Mode: ${isDryRun ? '🔍 DRY RUN (preview only)' : '🔴 LIVE — messages will be queued!'}\n`);

  const redis = getRedis();
  if (!redis) {
    console.error('❌ Redis not connected!');
    process.exit(1);
  }

  // Get all active lead phones
  const activePhones = await redis.smembers('set:active_leads');
  console.log(`Found ${activePhones.length} active leads in database.\n`);

  if (!activePhones || activePhones.length === 0) {
    console.log('No active leads to enroll.');
    return;
  }

  const results = {
    enrolled_tier1: 0,
    enrolled_tier2: 0,
    enrolled_tier3: 0,
    skipped_converted: 0,
    skipped_no_data: 0,
    skipped_already_queued: 0,
    errors: 0,
  };

  // Stagger messages: space them 30 seconds apart so not all hit at once
  // First batch fires after 1 minute (within next cron cycle)
  const BASE_DELAY_MS = 60 * 1000; // 1 min from now
  const STAGGER_MS = 30 * 1000;    // 30 sec apart per lead

  let enrollIndex = 0;

  for (const phone of activePhones) {
    const lead = await redis.get(`lead:${phone}`);

    if (!lead) {
      results.skipped_no_data++;
      continue;
    }

    if (lead.status === 'CONVERTED') {
      results.skipped_converted++;
      continue;
    }

    // Check if already has queue entries (avoid double-enqueue)
    const existingQueue = await redis.smembers(`lead_queue:${phone}`);
    if (existingQueue && existingQueue.length > 0) {
      results.skipped_already_queued++;
      continue;
    }

    const tier = lead.tier || 'TIER_1_CHECKOUT_ABANDON';
    const nudgeConfig = getNudgeConfig(tier, 1);

    if (!nudgeConfig) {
      console.log(`   ⚠️  No Nudge 1 config for tier ${tier} — skipping ${phone}`);
      results.errors++;
      continue;
    }

    const params = nudgeConfig.getParams(lead);
    const staggeredDelay = BASE_DELAY_MS + (enrollIndex * STAGGER_MS);

    if (isDryRun) {
      console.log(`   [DRY RUN] ${phone} (${lead.name}) → ${nudgeConfig.campaignName} | Tier: ${tier} | Params: ${JSON.stringify(params)} | Fire in: ${Math.round(staggeredDelay / 1000)}s`);
    } else {
      try {
        await enqueueMessage(phone, tier, 1, staggeredDelay, {
          campaignName: nudgeConfig.campaignName,
          fallbackCampaign: nudgeConfig.fallbackCampaign,
          templateParams: params,
          tags: nudgeConfig.tags,
          attributes: {
            Tier: tier,
            Cart_Items: lead.cart_items || 'Protein Snacks',
            City: lead.city || '',
            Email: lead.email || '',
          },
        });
      } catch (err) {
        console.error(`   ❌ Error enqueuing ${phone}: ${err.message}`);
        results.errors++;
        continue;
      }
    }

    if (tier === 'TIER_1_CHECKOUT_ABANDON') results.enrolled_tier1++;
    else if (tier === 'TIER_2_CART_ADDER') results.enrolled_tier2++;
    else if (tier === 'TIER_3_PRODUCT_BROWSER') results.enrolled_tier3++;

    enrollIndex++;
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 ENROLLMENT SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Tier 1 (Checkout Abandon) enrolled: ${results.enrolled_tier1}`);
  console.log(`Tier 2 (Cart Adder) enrolled:       ${results.enrolled_tier2}`);
  console.log(`Tier 3 (Product Browser) enrolled:   ${results.enrolled_tier3}`);
  console.log(`Total enrolled:                      ${results.enrolled_tier1 + results.enrolled_tier2 + results.enrolled_tier3}`);
  console.log(`Skipped (already converted):         ${results.skipped_converted}`);
  console.log(`Skipped (no lead data):              ${results.skipped_no_data}`);
  console.log(`Skipped (already queued):             ${results.skipped_already_queued}`);
  console.log(`Errors:                              ${results.errors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!isDryRun && enrollIndex > 0) {
    const firstFireMin = Math.round(BASE_DELAY_MS / 60000);
    const lastFireMin = Math.round((BASE_DELAY_MS + (enrollIndex * STAGGER_MS)) / 60000);
    console.log(`\n⏰ Messages will start firing in ~${firstFireMin} min, last one in ~${lastFireMin} min.`);
    console.log('   The 15-min cron will pick them up and send via AiSensy.');
    console.log('   After Nudge 1 is sent, the cron auto-schedules Nudge 2 → 3 → 4.\n');
  }
}

enrollAll().catch(err => {
  console.error('Enrollment failed:', err);
  process.exit(1);
});
