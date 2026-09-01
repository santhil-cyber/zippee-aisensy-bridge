#!/usr/bin/env node
/**
 * Repair False Conversions
 * ────────────────────────
 * Reverts leads that were falsely marked CONVERTED by the Shopify wildcard bug.
 * Uses the fixed hasPlacedOrder() to re-verify each CONVERTED lead.
 *
 * Usage:
 *   node scripts/repair-false-conversions.js --dry-run   (preview only)
 *   node scripts/repair-false-conversions.js              (apply fix)
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

const isDryRun = process.argv.includes('--dry-run');

const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;
const redis = new Redis({ url: redisUrl, token: redisToken });

// Use the FIXED hasPlacedOrder
const { hasPlacedOrder } = require('../api/lib/shopify');

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  REPAIR FALSE CONVERSIONS                            ║');
  console.log(`║  Mode: ${isDryRun ? '🔍 DRY RUN' : '🔧 LIVE REPAIR'}                                 ║`);
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // Get ALL leads (scan all lead: keys)
  const activeLeads = await redis.smembers('set:active_leads');
  console.log(`Active leads set: ${activeLeads?.length || 0} entries\n`);

  // Also scan for converted leads not in active set
  // We'll check leads that have status CONVERTED
  let scannedKeys = [];
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, { match: 'lead:*', count: 100 });
    cursor = result[0];
    scannedKeys = scannedKeys.concat(result[1]);
  } while (cursor !== 0 && cursor !== '0');

  console.log(`Total lead keys found: ${scannedKeys.length}`);

  let convertedCount = 0;
  let falseConversions = 0;
  let realConversions = 0;
  let revertedCount = 0;
  let errorCount = 0;

  for (const key of scannedKeys) {
    const lead = await redis.get(key);
    if (!lead || lead.status !== 'CONVERTED') continue;
    convertedCount++;

    const phone = lead.phone || key.replace('lead:', '');

    try {
      // Re-verify with the FIXED function (filters false positives)
      const reallyBought = await hasPlacedOrder(phone, lead.email, null);

      if (reallyBought) {
        realConversions++;
      } else {
        falseConversions++;
        console.log(`  🔄 FALSE CONVERSION: ${phone} (${lead.name || 'Unknown'}) — never actually ordered`);

        if (!isDryRun) {
          // Revert to ACTIVE status
          const updated = {
            ...lead,
            status: 'ACTIVE',
            current_nudge: 0, // Reset nudge counter so they start fresh
            reverted_at: new Date().toISOString(),
            reverted_reason: 'shopify_wildcard_false_positive',
          };
          await redis.set(key, updated);
          await redis.sadd('set:active_leads', phone);
          revertedCount++;
          console.log(`    ✅ Reverted to ACTIVE — will be re-enrolled on next webhook`);
        }
      }
    } catch (err) {
      errorCount++;
      console.log(`  ❌ Error checking ${phone}: ${err.message}`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Total CONVERTED leads checked: ${convertedCount}`);
  console.log(`  Real conversions (verified): ${realConversions}`);
  console.log(`  FALSE conversions (wildcard bug): ${falseConversions}`);
  console.log(`  ${isDryRun ? 'Would revert' : 'Reverted'}: ${isDryRun ? falseConversions : revertedCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (isDryRun && falseConversions > 0) {
    console.log(`\n💡 Run without --dry-run to repair: node scripts/repair-false-conversions.js`);
  }
  if (!isDryRun && revertedCount > 0) {
    console.log(`\n🎉 ${revertedCount} leads reverted from CONVERTED → ACTIVE.`);
    console.log('   They will be re-enrolled when Shopflo sends their next event.');
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
