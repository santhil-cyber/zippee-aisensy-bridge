#!/usr/bin/env node
/**
 * Purge Queue & Reset Recovery State Utility
 * -------------------------------------------
 * Completely clears the stuck message queue, orphan message payloads,
 * lead queue sets, and resets failure counters for a clean start.
 */

const fs = require('fs');
const path = require('path');

// Manually load .env variables
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  });
}

const { getRedis } = require('../api/lib/db');
const { QUEUE_KEY } = require('../api/lib/queue');

async function purgeQueue() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🧹 RECOVERY ENGINE — COMPLETE QUEUE PURGE & RESET         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const redis = getRedis();
  if (!redis) {
    console.error('❌ Redis credentials not found in environment!');
    process.exit(1);
  }

  // 1. Check current queue size
  const totalBefore = await redis.zcard(QUEUE_KEY);
  console.log(`Current items in ${QUEUE_KEY}: ${totalBefore}`);

  // 2. Fetch all members in the queue
  const members = await redis.zrange(QUEUE_KEY, 0, -1);
  console.log(`Found ${members.length} member keys to purge.`);

  // 3. Delete msg:* keys and lead_queue:* keys
  let deletedMsgKeys = 0;
  let deletedLeadQueueKeys = 0;

  for (const member of members) {
    const memberStr = typeof member === 'object' ? JSON.stringify(member) : String(member);
    await redis.del(`msg:${memberStr}`);
    deletedMsgKeys++;

    const [phone] = memberStr.split(':');
    if (phone) {
      await redis.del(`lead_queue:${phone}`);
      deletedLeadQueueKeys++;
    }
  }

  // 4. Scan & clean any orphan msg:* and lead_queue:* keys
  console.log('Scanning for any lingering msg:* or lead_queue:* keys...');
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'msg:*', count: 100 });
    cursor = String(nextCursor);
    if (keys && keys.length > 0) {
      for (const k of keys) {
        await redis.del(k);
        deletedMsgKeys++;
      }
    }
  } while (cursor !== '0');

  cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'lead_queue:*', count: 100 });
    cursor = String(nextCursor);
    if (keys && keys.length > 0) {
      for (const k of keys) {
        await redis.del(k);
        deletedLeadQueueKeys++;
      }
    }
  } while (cursor !== '0');

  // 5. Delete the main queue
  await redis.del(QUEUE_KEY);
  console.log(`✅ Cleared ${QUEUE_KEY}`);

  // 6. Reset current_nudge: 0 on active leads so future events trigger clean sequences
  const activePhones = await redis.smembers('set:active_leads');
  console.log(`Resetting state for ${activePhones?.length || 0} active lead profiles...`);
  
  if (activePhones && activePhones.length > 0) {
    for (const phone of activePhones) {
      const lead = await redis.get(`lead:${phone}`);
      if (lead) {
        lead.current_nudge = 0;
        lead.last_sent_at = null;
        lead.updated_at = new Date().toISOString();
        await redis.set(`lead:${phone}`, lead);
      }
    }
  }

  // 7. Reset old failure analytics counters
  console.log('Resetting historical error counters in analytics...');
  await redis.del('analytics:global');
  await redis.del('analytics:campaign:1st_nudge');
  await redis.del('analytics:campaign:shopflo_abandon_reminder');
  await redis.del('analytics:campaign:shopflo_abandoned_cart');
  await redis.del('analytics:campaign:recover_checkout_nudge');

  // 8. Verification
  const totalAfter = await redis.zcard(QUEUE_KEY);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 PURGE SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Queue size before:       ${totalBefore}`);
  console.log(`Queue size after:        ${totalAfter} (Clean!)`);
  console.log(`Deleted msg:* records:   ${deletedMsgKeys}`);
  console.log(`Deleted lead_queue sets: ${deletedLeadQueueKeys}`);
  console.log(`Reset lead profiles:     ${activePhones?.length || 0}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🎉 Queue successfully purged! Fresh starts will now use nudge_X_cart templates without fallbacks.\n');
}

purgeQueue().catch(err => {
  console.error('Purge error:', err);
  process.exit(1);
});
