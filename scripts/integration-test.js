#!/usr/bin/env node
/**
 * Full System Integration Test
 * ────────────────────────────
 * Validates end-to-end: Redis DB, template rename (nudge_2_cart → nudge_2nd_cart),
 * queue dedup, classifier, Shopify token, and live Vercel deployment.
 *
 * Usage:
 *   node scripts/integration-test.js
 *   node scripts/integration-test.js --live   (also tests deployed Vercel endpoints)
 */

const fs = require('fs');
const path = require('path');

// Load .env manually (no dotenv dependency)
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

const assert = require('assert');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

// ═══════════════ CONFIG ═══════════════
const VERCEL_DOMAIN = 'https://zippee-aisensy-bridge-debug.vercel.app';
const TEST_PHONE = '+910000000099'; // Fake number — never sent to real person
const isLive = process.argv.includes('--live');

// ═══════════════ REDIS SETUP ═══════════════
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

let redis = null;
if (redisUrl && redisToken) {
  redis = new Redis({ url: redisUrl, token: redisToken });
}

let passed = 0;
let failed = 0;
let warnings = 0;

function ok(label) {
  passed++;
  console.log(`  ✅ ${label}`);
}

function fail(label, detail) {
  failed++;
  console.log(`  ❌ ${label}`);
  if (detail) console.log(`     → ${detail}`);
}

function warn(label) {
  warnings++;
  console.log(`  ⚠️  ${label}`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 1: REDIS CONNECTIVITY & BASIC OPERATIONS
// ═══════════════════════════════════════════════════════════════
async function testRedisConnectivity() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1️⃣  REDIS / UPSTASH DATABASE CONNECTIVITY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!redis) {
    fail('Redis credentials missing (KV_REST_API_URL / KV_REST_API_TOKEN)');
    return false;
  }

  try {
    // PING
    const pong = await redis.ping();
    if (pong === 'PONG') {
      ok('Redis PING → PONG');
    } else {
      fail('Redis PING did not return PONG', `Got: ${pong}`);
      return false;
    }

    // Write/Read/Delete test key
    const testKey = '__integration_test__';
    await redis.set(testKey, { test: true, ts: Date.now() });
    const val = await redis.get(testKey);
    assert.ok(val && val.test === true, 'Read back test value');
    await redis.del(testKey);
    ok('Redis SET / GET / DEL round-trip');

    // Check active leads set exists
    const activeLeads = await redis.smembers('set:active_leads');
    ok(`Active leads set has ${activeLeads?.length || 0} entries`);

    return true;
  } catch (err) {
    fail('Redis connectivity error', err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: TEMPLATE RENAME VERIFICATION — no stale nudge_2_cart
// ═══════════════════════════════════════════════════════════════
async function testTemplateRename() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('2️⃣  TEMPLATE RENAME: nudge_2_cart → nudge_2nd_cart');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const { SEQUENCE_CONFIG, getNudgeConfig, getMaxNudgesForTier } = require('../api/lib/classifier');

  // 2a. Verify no tier uses the old name in config
  const allCampaigns = [];
  for (const [tierKey, nudges] of Object.entries(SEQUENCE_CONFIG)) {
    for (const nudge of nudges) {
      allCampaigns.push({ tier: tierKey, nudgeNum: nudge.nudgeNum, campaign: nudge.campaignName });
    }
  }

  const staleOldName = allCampaigns.filter(c => c.campaign === 'nudge_2_cart');
  if (staleOldName.length > 0) {
    fail(`Found ${staleOldName.length} reference(s) to OLD template name "nudge_2_cart" in SEQUENCE_CONFIG`, JSON.stringify(staleOldName));
  } else {
    ok('No references to old "nudge_2_cart" in SEQUENCE_CONFIG');
  }

  // 2b. Verify nudge_2nd_cart is present where expected
  const newNameEntries = allCampaigns.filter(c => c.campaign === 'nudge_2nd_cart');
  if (newNameEntries.length === 3) {
    ok(`"nudge_2nd_cart" found in exactly 3 places (Tier1/Nudge2, Tier2/Nudge2, Tier3/Nudge1)`);
  } else {
    fail(`Expected 3 occurrences of "nudge_2nd_cart", found ${newNameEntries.length}`, JSON.stringify(newNameEntries));
  }

  // 2c. Verify each specific config
  const t1n2 = getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 2);
  assert.strictEqual(t1n2.campaignName, 'nudge_2nd_cart');
  ok('Tier 1 Nudge 2 → nudge_2nd_cart ✓');

  const t2n2 = getNudgeConfig('TIER_2_CART_ADDER', 2);
  assert.strictEqual(t2n2.campaignName, 'nudge_2nd_cart');
  ok('Tier 2 Nudge 2 → nudge_2nd_cart ✓');

  const t3n1 = getNudgeConfig('TIER_3_PRODUCT_BROWSER', 1);
  assert.strictEqual(t3n1.campaignName, 'nudge_2nd_cart');
  ok('Tier 3 Nudge 1 → nudge_2nd_cart ✓');

  // 2d. Other templates still correct
  assert.strictEqual(getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 1).campaignName, 'nudge_1_cart');
  assert.strictEqual(getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 3).campaignName, 'nudge_3_cart');
  assert.strictEqual(getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 4).campaignName, 'nudge_4_cart');
  ok('Other templates (nudge_1_cart, nudge_3_cart, nudge_4_cart) unchanged');

  // 2e. Check Redis queue for any stale nudge_2_cart campaign references
  if (redis) {
    try {
      const queueMembers = await redis.zrange('queue:recovery_messages', 0, -1);
      let staleCount = 0;
      for (const member of (queueMembers || [])) {
        const data = await redis.get(`msg:${member}`);
        if (data && data.campaignName === 'nudge_2_cart') {
          staleCount++;
          warn(`Stale queue entry with old template: ${member} → campaignName: nudge_2_cart`);
        }
      }
      if (staleCount === 0) {
        ok(`No stale "nudge_2_cart" entries found in Redis message queue (checked ${queueMembers?.length || 0} entries)`);
      } else {
        warn(`Found ${staleCount} stale queue entries still using "nudge_2_cart" — they were enqueued before the rename and will fire with the old template name`);
      }
    } catch (err) {
      warn(`Could not scan Redis queue for stale entries: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: DEDUPLICATION LOGIC (Classifier + DB)
// ═══════════════════════════════════════════════════════════════
async function testDeduplication() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('3️⃣  DEDUPLICATION & ENROLLMENT LOGIC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!redis) {
    warn('Skipping dedup test — no Redis connection');
    return;
  }

  const { saveLead, getLead, markConverted } = require('../api/lib/db');
  const { cancelAllMessagesForPhone } = require('../api/lib/queue');

  try {
    // Clean up test phone first
    await redis.del(`lead:${TEST_PHONE}`);
    await redis.srem('set:active_leads', TEST_PHONE);

    // 3a. Enroll fresh lead
    const lead1 = await saveLead({
      phone: TEST_PHONE,
      name: 'IntegrationTest',
      tier: 'TIER_1_CHECKOUT_ABANDON',
      current_nudge: 0,
    });
    assert.ok(lead1, 'First enrollment should succeed');
    assert.strictEqual(lead1.status, 'ACTIVE');
    ok('Fresh lead enrollment → ACTIVE');

    // 3b. Re-enroll same phone — should merge, not duplicate
    const lead2 = await saveLead({
      phone: TEST_PHONE,
      name: 'IntegrationTest',
      tier: 'TIER_1_CHECKOUT_ABANDON',
      current_nudge: 2, // Simulate nudge progress
    });
    assert.ok(lead2, 'Second enrollment should merge');
    assert.strictEqual(lead2.current_nudge, 2, 'current_nudge should be preserved');
    ok('Re-enrollment preserves current_nudge (no reset)');

    // 3c. Check for duplicates in active_leads set
    const activeLeads = await redis.smembers('set:active_leads');
    const dupes = activeLeads.filter(p => p === TEST_PHONE);
    assert.strictEqual(dupes.length, 1, 'Phone should appear exactly once in active_leads');
    ok('No duplicate entries in set:active_leads');

    // 3d. Conversion flow
    await markConverted(TEST_PHONE);
    const converted = await getLead(TEST_PHONE);
    assert.strictEqual(converted.status, 'CONVERTED');
    ok('markConverted → status = CONVERTED');

    // 3e. Attempt to re-enroll a converted lead
    const lead3 = await saveLead({
      phone: TEST_PHONE,
      name: 'IntegrationTest',
      tier: 'TIER_2_CART_ADDER',
      current_nudge: 0,
    });
    assert.strictEqual(lead3.status, 'CONVERTED', 'Converted lead should not be re-enrolled');
    ok('Converted lead cannot be re-enrolled (dedup guard)');

    // 3f. Cleanup
    await redis.del(`lead:${TEST_PHONE}`);
    await redis.srem('set:active_leads', TEST_PHONE);
    await cancelAllMessagesForPhone(TEST_PHONE);
    ok('Test data cleaned up');

  } catch (err) {
    fail('Deduplication test error', err.message);
    // Cleanup on error
    try {
      await redis.del(`lead:${TEST_PHONE}`);
      await redis.srem('set:active_leads', TEST_PHONE);
    } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 4: QUEUE INTEGRITY (No stale / orphaned entries)
// ═══════════════════════════════════════════════════════════════
async function testQueueIntegrity() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('4️⃣  QUEUE INTEGRITY CHECK');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!redis) {
    warn('Skipping queue test — no Redis connection');
    return;
  }

  try {
    const queueMembers = await redis.zrange('queue:recovery_messages', 0, -1, { withScores: true });
    const totalEntries = queueMembers ? Math.floor(queueMembers.length / 2) : 0;
    ok(`Queue has ${totalEntries} scheduled messages`);

    let orphanedCount = 0;
    let validCount = 0;
    const phoneSet = new Set();

    // Check for orphaned entries (score in sorted set but no msg: data)
    for (let i = 0; i < (queueMembers?.length || 0); i += 2) {
      const memberKey = queueMembers[i];
      const score = queueMembers[i + 1];
      const data = await redis.get(`msg:${memberKey}`);

      if (!data) {
        orphanedCount++;
        warn(`Orphaned queue entry (no msg data): ${memberKey}`);
      } else {
        validCount++;
        const phone = data.phone || memberKey.split(':')[0];
        phoneSet.add(phone);
      }
    }

    if (orphanedCount === 0) {
      ok(`All ${validCount} queue entries have valid message data (no orphans)`);
    } else {
      warn(`Found ${orphanedCount} orphaned queue entries — consider running purge-queue.js`);
    }

    // Check for duplicate phone+tier+nudge combinations
    const seen = new Set();
    let dupCount = 0;
    for (let i = 0; i < (queueMembers?.length || 0); i += 2) {
      const memberKey = queueMembers[i];
      if (seen.has(memberKey)) {
        dupCount++;
        warn(`Duplicate queue entry: ${memberKey}`);
      }
      seen.add(memberKey);
    }

    if (dupCount === 0) {
      ok('No duplicate phone:tier:nudge entries in queue');
    }

    ok(`Unique phones in queue: ${phoneSet.size}`);

  } catch (err) {
    fail('Queue integrity check error', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 5: SHOPIFY ADMIN TOKEN AVAILABILITY
// ═══════════════════════════════════════════════════════════════
async function testShopifyToken() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('5️⃣  SHOPIFY ADMIN TOKEN CHECK');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Local check
  const localToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (localToken) {
    ok(`Local SHOPIFY_ADMIN_TOKEN configured (starts with ${localToken.substring(0, 8)}...)`);
  } else {
    warn('SHOPIFY_ADMIN_TOKEN not set in local env (set in Vercel only — OK for prod)');
  }

  // Vercel remote check (via env list)
  if (isLive) {
    try {
      const res = await axios.get(`${VERCEL_DOMAIN}/api/shopflo-webhook`, { timeout: 10000 });
      if (res.status === 200) {
        ok('Vercel shopflo-webhook endpoint is reachable (GET health check)');
      }
    } catch (err) {
      if (err.response?.status) {
        ok(`Vercel shopflo-webhook responded with status ${err.response.status}`);
      } else {
        warn(`Could not reach Vercel endpoint: ${err.message}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 6: LIVE VERCEL DEPLOYMENT CHECKS
// ═══════════════════════════════════════════════════════════════
async function testVercelDeployment() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('6️⃣  LIVE VERCEL DEPLOYMENT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!isLive) {
    warn('Skipping live deployment tests (run with --live flag to enable)');
    return;
  }

  // 6a. Health check — GET shopflo-webhook
  try {
    const healthRes = await axios.get(`${VERCEL_DOMAIN}/api/shopflo-webhook`, { timeout: 10000 });
    assert.strictEqual(healthRes.status, 200);
    ok(`GET /api/shopflo-webhook → 200 (${healthRes.data})`);
  } catch (err) {
    fail('Health check failed', err.message);
  }

  // 6b. Test ping → webhook should respond with connection verified
  try {
    const pingRes = await axios.post(`${VERCEL_DOMAIN}/api/shopflo-webhook`, { type: 'test', test: true }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    assert.strictEqual(pingRes.status, 200);
    assert.strictEqual(pingRes.data.success, true);
    ok(`POST /api/shopflo-webhook (test ping) → ${JSON.stringify(pingRes.data)}`);
  } catch (err) {
    fail('Test ping failed', err.response?.data || err.message);
  }

  // 6c. Cron endpoint check (should report outside window or 0 messages)
  try {
    const cronRes = await axios.get(`${VERCEL_DOMAIN}/api/cron-retarget`, { timeout: 15000 });
    assert.strictEqual(cronRes.status, 200);
    assert.strictEqual(cronRes.data.success, true);
    ok(`GET /api/cron-retarget → 200 (${cronRes.data.message || JSON.stringify(cronRes.data.summary)})`);
  } catch (err) {
    if (err.response?.status === 200) {
      ok(`Cron endpoint responded: ${JSON.stringify(err.response.data)}`);
    } else {
      fail('Cron endpoint check', err.response?.data || err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 7: CLASSIFIER FLOW — Full Tier Sequence Walk
// ═══════════════════════════════════════════════════════════════
async function testClassifierFlow() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('7️⃣  CLASSIFIER: FULL TIER SEQUENCE WALK');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const { getNudgeConfig, getMaxNudgesForTier, SEQUENCE_CONFIG } = require('../api/lib/classifier');

  const mockLead = { name: 'TestUser', cart_items: 'Whey, Peanut Butter', checkout_url: 'https://proteinpantry.in/cart' };

  for (const [tierKey, nudges] of Object.entries(SEQUENCE_CONFIG)) {
    const maxNudges = getMaxNudgesForTier(tierKey);
    console.log(`\n  📋 ${tierKey} (${maxNudges} nudges):`);

    for (let n = 1; n <= maxNudges; n++) {
      const config = getNudgeConfig(tierKey, n);
      assert.ok(config, `Config missing for ${tierKey} nudge ${n}`);
      assert.ok(config.campaignName, `Missing campaignName for ${tierKey} nudge ${n}`);
      assert.ok(typeof config.getParams === 'function', `Missing getParams fn for ${tierKey} nudge ${n}`);
      assert.ok(config.tags && config.tags.length > 0, `Missing tags for ${tierKey} nudge ${n}`);

      const params = config.getParams(mockLead);
      assert.ok(Array.isArray(params) && params.length > 0, `getParams should return non-empty array`);

      // Check that old template name is not used
      assert.notStrictEqual(config.campaignName, 'nudge_2_cart', `${tierKey} nudge ${n} still references old template!`);

      const delayHrs = (config.delayMs / (60 * 60 * 1000)).toFixed(1);
      ok(`  Nudge ${n}: ${config.campaignName} | delay=${delayHrs}h | params=[${params.join(', ')}] | tags=${config.tags.join(', ')}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 8: ANALYTICS KEYS IN REDIS
// ═══════════════════════════════════════════════════════════════
async function testAnalytics() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('8️⃣  ANALYTICS DATA');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!redis) {
    warn('Skipping analytics test — no Redis connection');
    return;
  }

  try {
    const globalStats = await redis.hgetall('analytics:global');
    if (globalStats && Object.keys(globalStats).length > 0) {
      ok(`Global analytics: ${JSON.stringify(globalStats)}`);
    } else {
      warn('No global analytics data yet (analytics:global is empty)');
    }

    // Check for old vs new campaign stats
    const oldStats = await redis.hgetall('analytics:campaign:nudge_2_cart');
    const newStats = await redis.hgetall('analytics:campaign:nudge_2nd_cart');

    if (oldStats && Object.keys(oldStats).length > 0) {
      warn(`Old "nudge_2_cart" analytics still exist: ${JSON.stringify(oldStats)} — these are historical and expected`);
    } else {
      ok('No analytics under old "nudge_2_cart" campaign key');
    }

    if (newStats && Object.keys(newStats).length > 0) {
      ok(`New "nudge_2nd_cart" analytics: ${JSON.stringify(newStats)}`);
    } else {
      ok('No analytics under "nudge_2nd_cart" yet (expected for fresh rename)');
    }
  } catch (err) {
    fail('Analytics check error', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   FULL SYSTEM INTEGRATION TEST                          ║');
  console.log('║   Zippee–AiSensy Bridge Recovery Engine                 ║');
  console.log(`║   ${new Date().toISOString()}                   ║`);
  console.log(`║   Mode: ${isLive ? 'LIVE (includes Vercel endpoints)' : 'LOCAL (add --live for Vercel tests)'}    ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');

  await testRedisConnectivity();
  await testTemplateRename();
  await testDeduplication();
  await testQueueIntegrity();
  await testShopifyToken();
  await testVercelDeployment();
  await testClassifierFlow();
  await testAnalytics();

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log(`║   RESULTS: ✅ ${passed} passed  |  ❌ ${failed} failed  |  ⚠️ ${warnings} warnings`);
  if (failed === 0) {
    console.log('║   🎉 ALL TESTS PASSED!                                  ║');
  } else {
    console.log('║   🔴 SOME TESTS FAILED — review output above            ║');
  }
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
