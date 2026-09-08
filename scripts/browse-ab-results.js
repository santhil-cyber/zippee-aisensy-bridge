#!/usr/bin/env node

/**
 * Browse-Abandon A/B/C Test Results Dashboard
 * --------------------------------------------
 * Pulls per-variant analytics from Upstash Redis and displays
 * a formatted comparison of the 3 message variants:
 *   A = Trust Builder (lab tests credibility)
 *   B = Decision Helper (Chef's Picks recommendation)
 *   C = Problem-Aware (protein gap education)
 *
 * Usage:
 *   node scripts/browse-ab-results.js                # overall summary
 *   node scripts/browse-ab-results.js --date 2026-09-10  # specific date
 *   node scripts/browse-ab-results.js --days 7       # last 7 days
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const BROWSE_CAMPAIGNS = {
  A: { campaign: 'browse_nudge_trust', label: 'Trust Builder (Lab Tests)' },
  B: { campaign: 'browse_nudge_chefpick', label: 'Decision Helper (Chef\'s Picks)' },
  C: { campaign: 'browse_nudge_protein', label: 'Problem-Aware (Protein Gap)' },
};

const BROWSE_TIERS = ['TIER_3_PRODUCT_BROWSER', 'TIER_4_COLLECTION_BROWSER', 'TIER_5_STORE_VISITOR'];

async function fetchVariantStats(variant, dateSuffix = '') {
  const { campaign } = BROWSE_CAMPAIGNS[variant];
  const suffix = dateSuffix ? `:${dateSuffix}` : '';

  // Per-campaign stats
  const campaignStats = await redis.hgetall(`analytics:campaign:${campaign}${suffix}`) || {};

  // Per-variant aggregate (across all browse campaigns for this variant)
  const variantStats = await redis.hgetall(`analytics:ab:variant_${variant}${suffix}`) || {};

  // Per-campaign per-variant stats
  const abStats = await redis.hgetall(`analytics:ab:${campaign}:${variant}${suffix}`) || {};

  return {
    sent: parseInt(campaignStats.sent || abStats.sent || variantStats.sent || 0, 10),
    delivered: parseInt(campaignStats.delivered || variantStats.delivered || 0, 10),
    read: parseInt(campaignStats.read || variantStats.read || 0, 10),
    clicked: parseInt(campaignStats.clicked || variantStats.clicked || 0, 10),
    converted: parseInt(campaignStats.converted || variantStats.converted || 0, 10),
    failed: parseInt(campaignStats.failed || variantStats.failed || 0, 10),
    blocked: parseInt(campaignStats.blocked || variantStats.blocked || 0, 10),
  };
}

async function fetchTierStats(tier, dateSuffix = '') {
  const suffix = dateSuffix ? `:${dateSuffix}` : '';
  const stats = await redis.hgetall(`analytics:tier:${tier}${suffix}`) || {};
  return {
    sent: parseInt(stats.sent || 0, 10),
    converted: parseInt(stats.converted || 0, 10),
    enqueued: parseInt(stats.enqueued || 0, 10),
  };
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function padNum(num, len) {
  return String(num).padStart(len);
}

function cvr(sent, converted) {
  if (sent === 0) return '  N/A ';
  return ((converted / sent) * 100).toFixed(1).padStart(5) + '%';
}

async function main() {
  const args = process.argv.slice(2);
  let dateSuffix = '';
  let dateLabel = 'All-Time';

  // Parse --date or --days flags
  const dateIdx = args.indexOf('--date');
  if (dateIdx >= 0 && args[dateIdx + 1]) {
    dateSuffix = args[dateIdx + 1];
    dateLabel = dateSuffix;
  }

  const daysIdx = args.indexOf('--days');
  if (daysIdx >= 0 && args[daysIdx + 1]) {
    const days = parseInt(args[daysIdx + 1], 10);
    dateLabel = `Last ${days} days`;
    // We'll aggregate multiple dates below
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║       Browse-Abandon A/B/C Test Results                        ║');
  console.log('║       Target: Scrolled site, nothing in cart                   ║');
  console.log(`║       Period: ${pad(dateLabel, 50)}║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');

  // ── Overall Variant Comparison ──
  console.log('  VARIANT COMPARISON');
  console.log('  ──────────────────────────────────────────────────────────────');
  console.log('  Variant                            Sent  Delivered  Read  Clicked  Conv  CVR');
  console.log('  ──────────────────────────────────────────────────────────────');

  const variantResults = {};
  let bestVariant = null;
  let bestCVR = -1;

  for (const variant of ['A', 'B', 'C']) {
    const stats = await fetchVariantStats(variant, dateSuffix);
    variantResults[variant] = stats;

    const rate = stats.sent > 0 ? (stats.converted / stats.sent) * 100 : 0;
    if (rate > bestCVR && stats.sent > 0) {
      bestCVR = rate;
      bestVariant = variant;
    }

    const label = `${variant}: ${BROWSE_CAMPAIGNS[variant].label}`;
    console.log(
      `  ${pad(label, 37)}${padNum(stats.sent, 4)}  ${padNum(stats.delivered, 9)}  ${padNum(stats.read, 4)}  ${padNum(stats.clicked, 7)}  ${padNum(stats.converted, 4)}  ${cvr(stats.sent, stats.converted)}${variant === bestVariant && stats.sent > 0 ? '  ⭐ LEADER' : ''}`
    );
  }

  console.log('  ──────────────────────────────────────────────────────────────');

  const totalSent = Object.values(variantResults).reduce((sum, s) => sum + s.sent, 0);
  const totalConv = Object.values(variantResults).reduce((sum, s) => sum + s.converted, 0);
  console.log(
    `  ${pad('TOTAL', 37)}${padNum(totalSent, 4)}  ${' '.repeat(9)}  ${' '.repeat(4)}  ${' '.repeat(7)}  ${padNum(totalConv, 4)}  ${cvr(totalSent, totalConv)}`
  );

  // ── Per-Tier Breakdown ──
  console.log('');
  console.log('  PER-TIER BREAKDOWN');
  console.log('  ──────────────────────────────────────────────────────────────');

  for (const tier of BROWSE_TIERS) {
    const stats = await fetchTierStats(tier, dateSuffix);
    const tierLabel = tier.replace('TIER_', 'T').replace(/_/g, ' ');
    console.log(`  ${pad(tierLabel, 30)} Enqueued: ${padNum(stats.enqueued, 4)}  Sent: ${padNum(stats.sent, 4)}  Converted: ${padNum(stats.converted, 4)}  CVR: ${cvr(stats.sent, stats.converted)}`);
  }

  // ── Statistical Note ──
  console.log('');
  console.log('  ──────────────────────────────────────────────────────────────');
  if (totalSent < 100) {
    console.log('  ⚠️  Sample size < 100. Results are directional only. Need ~300+ sends for significance.');
  } else if (totalSent < 300) {
    console.log('  ⚠️  Sample size < 300. Results are trending. Need ~300+ sends per variant for significance.');
  } else {
    console.log('  ✅ Sample size sufficient for directional insights.');
  }
  console.log('');

  // ── Winner Summary ──
  if (bestVariant && totalSent > 0) {
    console.log(`  🏆  Current Leader: Variant ${bestVariant} — ${BROWSE_CAMPAIGNS[bestVariant].label}`);
    console.log(`      CVR: ${bestCVR.toFixed(1)}% (${variantResults[bestVariant].converted} conversions from ${variantResults[bestVariant].sent} sends)`);
    console.log('');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error fetching results:', err.message);
  process.exit(1);
});
