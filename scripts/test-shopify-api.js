#!/usr/bin/env node
/**
 * Shopify API Connectivity Test
 * ─────────────────────────────
 * Tests if the SHOPIFY_ADMIN_TOKEN can:
 * 1. Connect to the Shopify Admin API
 * 2. Fetch recent orders
 * 3. Detect returning customers by phone number
 *
 * Usage:
 *   node scripts/test-shopify-api.js
 *   node scripts/test-shopify-api.js --phone +919876543210   (check specific customer)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '0nb9nh-8p.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Parse --phone arg
const args = process.argv.slice(2);
let testPhone = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phone' && args[i + 1]) testPhone = args[i + 1];
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  SHOPIFY ADMIN API — CONNECTIVITY & ORDER CHECK TEST ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // ── 1. Token Check ──
  console.log('1️⃣  TOKEN CHECK');
  if (!SHOPIFY_ADMIN_TOKEN) {
    console.log('  ❌ SHOPIFY_ADMIN_TOKEN is NOT set in environment.');
    console.log('  💡 Set it locally: export SHOPIFY_ADMIN_TOKEN=shpat_...');
    console.log('  💡 Or it may only be set in Vercel. Testing via deployed endpoint instead...\n');
    await testViaVercel();
    return;
  }
  console.log(`  ✅ Token found: ${SHOPIFY_ADMIN_TOKEN.substring(0, 12)}...`);
  console.log(`  📍 Store: ${SHOPIFY_STORE_DOMAIN}\n`);

  // ── 2. Basic API Connectivity — Fetch recent orders ──
  console.log('2️⃣  API CONNECTIVITY — Fetching recent orders');
  try {
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&limit=5`;
    const res = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const orders = res.data?.orders || [];
    console.log(`  ✅ Shopify API responded! Found ${orders.length} recent orders.`);

    if (orders.length > 0) {
      console.log('\n  📋 Latest 5 orders:');
      console.log('  ─────────────────────────────────────────────────────');
      for (const order of orders) {
        const customer = order.customer || {};
        const shipping = order.shipping_address || {};
        const name = customer.first_name || shipping.first_name || 'Unknown';
        const phone = shipping.phone || customer.phone || 'N/A';
        const date = new Date(order.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const total = order.total_price || '0';
        console.log(`  │ ${order.name} | ${name} | ${phone} | ₹${total} | ${date}`);
      }
      console.log('  ─────────────────────────────────────────────────────');
    }
  } catch (err) {
    console.log(`  ❌ API call FAILED: ${err.response?.status || ''} ${err.response?.data?.errors || err.message}`);
    if (err.response?.status === 401) {
      console.log('  💡 401 = Token is invalid or expired. Generate a new one from Shopify Admin → Settings → Apps → Develop apps.');
    } else if (err.response?.status === 403) {
      console.log('  💡 403 = Token lacks required scopes. Ensure read_orders and read_customers are enabled.');
    }
    return;
  }

  // ── 3. Returning Customer Check ──
  if (testPhone) {
    console.log(`\n3️⃣  RETURNING CUSTOMER CHECK — ${testPhone}`);
    await checkCustomerOrders(testPhone);
  } else {
    // Use a phone from recent orders to demonstrate the check works
    console.log('\n3️⃣  RETURNING CUSTOMER CHECK — Using phone from latest order');
    try {
      const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&limit=1`;
      const res = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      const orders = res.data?.orders || [];
      if (orders.length > 0) {
        const phone = orders[0].shipping_address?.phone || orders[0].customer?.phone;
        if (phone) {
          console.log(`  Using phone from order ${orders[0].name}: ${phone}`);
          await checkCustomerOrders(phone);
        } else {
          console.log('  ⚠️  No phone number on latest order. Use --phone flag to test manually.');
        }
      }
    } catch (err) {
      console.log(`  ⚠️  Could not fetch order for demo: ${err.message}`);
    }
  }

  // ── 4. Test the hasPlacedOrder logic (same as cron uses) ──
  console.log('\n4️⃣  hasPlacedOrder() FUNCTION TEST');
  const { hasPlacedOrder } = require('../api/lib/shopify');

  if (testPhone) {
    // Test with sinceDate (recent order check — used in Step B of cron)
    const recentCheck = await hasPlacedOrder(testPhone, null, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    console.log(`  hasPlacedOrder("${testPhone}", null, "7 days ago") → ${recentCheck}`);
    console.log(`    ${recentCheck ? '→ Customer ordered in last 7 days (would be marked CONVERTED)' : '→ No recent order found'}`);

    // Test WITHOUT sinceDate (any order ever — used in Step B2 for skipIfReturning)
    const anyOrderCheck = await hasPlacedOrder(testPhone, null, null);
    console.log(`  hasPlacedOrder("${testPhone}", null, null) → ${anyOrderCheck}`);
    console.log(`    ${anyOrderCheck ? '→ RETURNING CUSTOMER — coupon nudges will be SKIPPED ✅' : '→ NEW CUSTOMER — will receive all nudges including coupons'}`);
  } else {
    console.log('  ⚠️  Skipping — provide --phone to test hasPlacedOrder()');
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('✅ Shopify API test complete.');
  console.log('═══════════════════════════════════════════════════════\n');
}

async function checkCustomerOrders(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  const phoneQuery = cleanPhone.slice(-10);

  try {
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&query=${encodeURIComponent(`phone:*${phoneQuery}*`)}&limit=10`;
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    const orders = res.data?.orders || [];
    if (orders.length === 0) {
      console.log(`  📭 No orders found for ${phone} — this is a NEW CUSTOMER`);
      console.log('  → Will receive ALL nudges including coupon nudges (Pro10, FREEDEL)');
    } else {
      console.log(`  📦 Found ${orders.length} order(s) for ${phone} — this is a RETURNING CUSTOMER`);
      for (const order of orders) {
        const date = new Date(order.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        console.log(`     ${order.name} | ₹${order.total_price} | ${date} | ${order.financial_status}`);
      }
      console.log('  → Coupon nudges (Pro10, FREEDEL) will be SKIPPED ✅');
      console.log('  → Will only receive non-coupon nudges (cart reminder, scarcity)');
    }
  } catch (err) {
    console.log(`  ❌ Error searching orders: ${err.response?.data?.errors || err.message}`);
  }
}

async function testViaVercel() {
  console.log('  Testing Shopify connectivity through the deployed cron endpoint...');
  try {
    const res = await axios.get('https://zippee-aisensy-bridge-debug.vercel.app/api/cron-retarget?force=true', {
      timeout: 30000,
    });
    console.log(`  ✅ Cron endpoint responded: ${JSON.stringify(res.data, null, 2)}`);
    if (res.data?.summary) {
      const s = res.data.summary;
      console.log(`\n  Summary: Evaluated=${s.evaluated}, Dispatched=${s.dispatched}, Converted=${s.converted}, Skipped(returning)=${s.skipped_returning || 0}, Errors=${s.errors}`);
    }
  } catch (err) {
    console.log(`  ❌ Cron test failed: ${err.response?.data || err.message}`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
