#!/usr/bin/env node
/**
 * Patch Stale Queue Entries
 * ─────────────────────────
 * Updates all queued messages that still reference 'nudge_2_cart'
 * to use the new 'nudge_2nd_cart' template name.
 *
 * Usage:
 *   node scripts/patch-queue-template.js --dry-run   (preview only)
 *   node scripts/patch-queue-template.js              (apply patch)
 */

const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

// Load .env manually
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const OLD_NAME = 'nudge_2_cart';
const NEW_NAME = 'nudge_2nd_cart';
const QUEUE_KEY = 'queue:recovery_messages';
const isDryRun = process.argv.includes('--dry-run');

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!redisUrl || !redisToken) {
  console.error('❌ Redis credentials not found. Set KV_REST_API_URL and KV_REST_API_TOKEN.');
  process.exit(1);
}

const redis = new Redis({ url: redisUrl, token: redisToken });

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log(`║  PATCH: ${OLD_NAME} → ${NEW_NAME}`);
  console.log(`║  Mode: ${isDryRun ? '🔍 DRY RUN (no changes)' : '🔧 LIVE PATCH'}`);
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const queueMembers = await redis.zrange(QUEUE_KEY, 0, -1);
  console.log(`Total queue entries: ${queueMembers?.length || 0}\n`);

  let patched = 0;
  let skipped = 0;
  let errors = 0;

  for (const memberKey of (queueMembers || [])) {
    const dataKey = `msg:${memberKey}`;
    const data = await redis.get(dataKey);

    if (!data) {
      skipped++;
      continue;
    }

    if (data.campaignName === OLD_NAME) {
      if (isDryRun) {
        console.log(`  [DRY RUN] Would patch: ${memberKey} → ${NEW_NAME}`);
        patched++;
      } else {
        try {
          const updated = {
            ...data,
            campaignName: NEW_NAME,
            patchedAt: new Date().toISOString(),
            originalCampaign: OLD_NAME,
          };

          // Get TTL of existing key to preserve it
          const ttl = await redis.ttl(dataKey);
          const ttlSeconds = ttl > 0 ? ttl : 60 * 60 * 24 * 14; // fallback 14 days

          await redis.set(dataKey, updated, { ex: ttlSeconds });
          console.log(`  ✅ Patched: ${memberKey} (phone: ${data.phone}, scheduled: ${data.scheduledAt})`);
          patched++;
        } catch (err) {
          console.error(`  ❌ Error patching ${memberKey}: ${err.message}`);
          errors++;
        }
      }
    } else {
      skipped++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${isDryRun ? 'Would patch' : 'Patched'}: ${patched}`);
  console.log(`  Skipped (already correct): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (isDryRun && patched > 0) {
    console.log(`\n💡 Run without --dry-run to apply: node scripts/patch-queue-template.js`);
  }

  if (!isDryRun && patched > 0) {
    console.log(`\n🎉 ${patched} queue entries patched from "${OLD_NAME}" → "${NEW_NAME}"`);
    console.log('   Next cron run will dispatch these with the correct template.');
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
