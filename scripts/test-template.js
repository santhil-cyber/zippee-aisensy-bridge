#!/usr/bin/env node
/**
 * Direct AiSensy Template Tester
 * ------------------------------
 * Sends a live test message to your phone using a specific template created in AiSensy.
 *
 * Templates & their param counts:
 *   nudge_1_cart: 2 params (name, cart_item)
 *   nudge_2_cart: 1 param  (name) — coupon Pro10 hardcoded in template
 *   nudge_3_cart: 1 param  (name) — FREEDEL code hardcoded in template
 *   nudge_4_cart: 1 param  (name) — scarcity message hardcoded in template
 *
 * Usage:
 *   node scripts/test-template.js --phone +919XXXXXXXXX --campaign nudge_1_cart
 *   node scripts/test-template.js --phone +919XXXXXXXXX --campaign nudge_2_cart
 */

const axios = require('axios');

const AISENSY_API_KEY = process.env.AISENSY_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";
const AISENSY_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

const args = process.argv.slice(2);
let phone = '';
let campaignName = 'nudge_2_cart';
let userName = 'Sunny';
let cartItem = 'Chaap';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phone' && args[i + 1]) phone = args[i + 1];
  if (args[i] === '--campaign' && args[i + 1]) campaignName = args[i + 1];
  if (args[i] === '--name' && args[i + 1]) userName = args[i + 1];
  if (args[i] === '--item' && args[i + 1]) cartItem = args[i + 1];
}

if (!phone) {
  console.error('❌ Error: Please provide your phone number with --phone +919XXXXXXXXX');
  console.log('Example: node scripts/test-template.js --phone +919876543210 --campaign nudge_1_cart');
  process.exit(1);
}

// Clean phone format
let cleanPhone = phone.replace(/\D/g, '');
if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.slice(1);
if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = cleanPhone.slice(2);
if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;

/**
 * Build template params based on the campaign name.
 * Each template has a specific number of params defined in AiSensy.
 */
function getTemplateParams(campaign, name, item) {
  switch (campaign) {
    case 'nudge_1_cart':
      // {{1}} = Name, {{2}} = Cart Item
      return [String(name), String(item)];

    case 'nudge_2_cart':
      // {{1}} = Name, {{2}} = Coupon code
      return [String(name), 'Pro10'];

    case 'nudge_3_cart':
      // {{1}} = Name, {{2}} = Coupon code
      return [String(name), 'FREEDEL'];

    case 'nudge_4_cart':
      // {{1}} = Name (scarcity message is hardcoded in template)
      return [String(name)];

    // Legacy templates (for fallback testing)
    case '1st_nudge':
      return [String(name), String(item)];
    case 'nudge_2':
      return [String(name), 'Pro10'];

    default:
      console.warn(`⚠️ Unknown campaign "${campaign}". Sending [name] as single param.`);
      return [String(name)];
  }
}

async function testSend() {
  const params = getTemplateParams(campaignName, userName, cartItem);

  console.log('\n===============================================================');
  console.log(`  🧪 TESTING AISENSY TEMPLATE: "${campaignName}"`);
  console.log('===============================================================');
  console.log(`📱 Destination:     ${cleanPhone}`);
  console.log(`👤 Customer:        ${userName}`);
  console.log(`📦 Cart Item:       ${cartItem}`);
  console.log(`🔢 Template Params: ${params.length} → [${params.join(', ')}]`);
  console.log('===============================================================\n');

  const payload = {
    apiKey: AISENSY_API_KEY,
    campaignName: campaignName,
    destination: cleanPhone,
    userName: userName,
    templateParams: params,
    tags: ['Test_Campaign', campaignName],
    attributes: {
      Test_Mode: 'true',
      Trigger_Time: new Date().toISOString()
    }
  };

  console.log('📤 Sending payload to AiSensy API...');
  console.log(JSON.stringify(payload, null, 2));

  try {
    const res = await axios.post(AISENSY_URL, payload);
    console.log('\n🎉 SUCCESS! AiSensy API Response:');
    console.log(JSON.stringify(res.data, null, 2));
    console.log(`\n📲 Check WhatsApp on ${cleanPhone}!`);
  } catch (err) {
    console.error('\n❌ AiSensy Error Response:');
    if (err.response?.data) {
      console.error(JSON.stringify(err.response.data, null, 2));

      // Helpful hint for PENDING templates
      const errMsg = String(err.response?.data?.message || '').toLowerCase();
      if (errMsg.includes('not found') || errMsg.includes('not active') || errMsg.includes('pending')) {
        console.log(`\n💡 TIP: Template "${campaignName}" may still be PENDING approval in AiSensy.`);
        console.log('   Check AiSensy Dashboard → Templates → search for this template.');
      }
    } else {
      console.error(err.message);
    }
  }
}

testSend();
