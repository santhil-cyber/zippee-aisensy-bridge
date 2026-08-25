/**
 * Recovery Engine Test Suite
 * --------------------------
 * Tests:
 * 1. Classifier across various event combinations
 * 2. Sequence configurations and nudge definitions (nudge_X_cart templates)
 * 3. Time window helper for Indian Standard Time (IST)
 * 4. Template parameter count validation
 */

const assert = require('assert');
const { classifyCustomer, getNudgeConfig, getMaxNudgesForTier, TIERS } = require('../api/lib/classifier');
const { isWithinSendingHours, getNextValidSendTime } = require('../api/lib/queue');

console.log('=== RUNNING RECOVERY ENGINE UNIT TESTS ===\n');

// ── TEST 1: Classifier Behavior ──
console.log('Test 1: Segment Classification');

// 1.1 Buyer classification
const buyerEvents = 'address_selected, checkout_initiated, coupon_success, order_completed, payment_completed';
const resBuyer1 = classifyCustomer(buyerEvents, '');
assert.strictEqual(resBuyer1.tier, 'BUYER', 'Should classify order_completed as BUYER');

const resBuyer2 = classifyCustomer('store_page_view', '2026-07-11 19:05:49.066');
assert.strictEqual(resBuyer2.tier, 'BUYER', 'Should classify customer with LAST_ORDERED_DATE as BUYER');
console.log('  ✔ Buyer classification passed');

// 1.2 Tier 1: Checkout Abandoned
const abandonEvents = 'address_selected, checkout_abandoned, checkout_initiated, login_completed';
const resAbandon = classifyCustomer(abandonEvents, '');
assert.strictEqual(resAbandon.tier, 'TIER_1_CHECKOUT_ABANDON', 'Should classify checkout_abandoned as TIER_1');

const payInitEvents = 'checkout_initiated, payment_initiated, payment_page_loaded';
const resPayInit = classifyCustomer(payInitEvents, '');
assert.strictEqual(resPayInit.tier, 'TIER_1_CHECKOUT_ABANDON', 'Should classify payment_initiated as TIER_1');
console.log('  ✔ Tier 1 Checkout Abandon classification passed');

// 1.3 Tier 2: Cart Adder
const cartEvents = 'added_to_cart_ui, collection_page_viewed, product_page_viewed, store_page_view';
const resCart = classifyCustomer(cartEvents, '');
assert.strictEqual(resCart.tier, 'TIER_2_CART_ADDER', 'Should classify added_to_cart_ui as TIER_2');
console.log('  ✔ Tier 2 Cart Adder classification passed');

// 1.4 Tier 3: Product Browser
const productEvents = 'product_page_viewed, store_page_view';
const resProduct = classifyCustomer(productEvents, '');
assert.strictEqual(resProduct.tier, 'TIER_3_PRODUCT_BROWSER', 'Should classify product_page_viewed as TIER_3');
console.log('  ✔ Tier 3 Product Browser classification passed');

// 1.5 Tier 4: Collection Browser
const colEvents = 'collection_page_viewed, store_page_view';
const resCol = classifyCustomer(colEvents, '');
assert.strictEqual(resCol.tier, 'TIER_4_COLLECTION_BROWSER', 'Should classify collection_page_viewed as TIER_4');
console.log('  ✔ Tier 4 Collection Browser classification passed');

// 1.6 Tier 5: Store Visitor
const visitorEvents = 'store_page_view';
const resVisitor = classifyCustomer(visitorEvents, '');
assert.strictEqual(resVisitor.tier, 'TIER_5_STORE_VISITOR', 'Should classify store_page_view as TIER_5');
console.log('  ✔ Tier 5 Store Visitor classification passed');

// ── TEST 2: Sequence & Nudge Configurations (Updated for nudge_X_cart templates) ──
console.log('\nTest 2: Sequence & Nudge Configs (nudge_X_cart templates)');

// 2.1 Tier 1 nudge sequence
const tier1Nudge1 = getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 1);
assert.ok(tier1Nudge1, 'Tier 1 Nudge 1 must exist');
assert.strictEqual(tier1Nudge1.campaignName, 'nudge_1_cart', 'Tier 1 Nudge 1 should use nudge_1_cart template');
assert.strictEqual(tier1Nudge1.fallbackCampaign, null, 'Tier 1 Nudge 1 fallback should be null since templates are approved');
assert.strictEqual(tier1Nudge1.delayMs, 30 * 60 * 1000, 'Tier 1 Nudge 1 delay should be 30 mins');

const tier1Nudge2 = getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 2);
assert.ok(tier1Nudge2, 'Tier 1 Nudge 2 must exist');
assert.strictEqual(tier1Nudge2.campaignName, 'nudge_2_cart', 'Tier 1 Nudge 2 should use nudge_2_cart template');

const tier1Nudge3 = getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 3);
assert.ok(tier1Nudge3, 'Tier 1 Nudge 3 must exist');
assert.strictEqual(tier1Nudge3.campaignName, 'nudge_3_cart', 'Tier 1 Nudge 3 should use nudge_3_cart template');

const tier1Nudge4 = getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 4);
assert.ok(tier1Nudge4, 'Tier 1 Nudge 4 must exist');
assert.strictEqual(tier1Nudge4.campaignName, 'nudge_4_cart', 'Tier 1 Nudge 4 should use nudge_4_cart template');

const tier1Max = getMaxNudgesForTier('TIER_1_CHECKOUT_ABANDON');
assert.strictEqual(tier1Max, 4, 'Tier 1 should have 4 sequential nudges');

const tier2Max = getMaxNudgesForTier('TIER_2_CART_ADDER');
assert.strictEqual(tier2Max, 3, 'Tier 2 should have 3 sequential nudges');

console.log('  ✔ Sequence configs, campaign names, and counts passed');

// 2.2 Template parameter count validation
console.log('\nTest 3: Template Parameter Counts');

const mockLead = { name: 'Sunny', cart_items: 'Peanut Butter, Whey', checkout_url: 'https://proteinpantry.in/cart' };

// nudge_1_cart: 2 params (name, cart_items)
const params1 = tier1Nudge1.getParams(mockLead);
assert.strictEqual(params1.length, 2, 'nudge_1_cart should have exactly 2 template params');
assert.strictEqual(params1[0], 'Sunny', 'Param {{1}} should be customer name');
assert.strictEqual(params1[1], 'Peanut Butter, Whey', 'Param {{2}} should be cart items');
console.log('  ✔ nudge_1_cart: 2 params (name, cart_item) — correct');

// nudge_2_cart: 2 params (name, coupon_code) — Pro10 is a template variable
const params2 = tier1Nudge2.getParams(mockLead);
assert.strictEqual(params2.length, 2, 'nudge_2_cart should have exactly 2 template params');
assert.strictEqual(params2[0], 'Sunny', 'Param {{1}} should be customer name');
assert.strictEqual(params2[1], 'Pro10', 'Param {{2}} should be coupon code Pro10');
console.log('  ✔ nudge_2_cart: 2 params (name, coupon_code Pro10)');

// nudge_3_cart: 2 params (name, coupon_code) — FREEDEL is a template variable
const params3 = tier1Nudge3.getParams(mockLead);
assert.strictEqual(params3.length, 2, 'nudge_3_cart should have exactly 2 template params');
assert.strictEqual(params3[0], 'Sunny', 'Param {{1}} should be customer name');
assert.strictEqual(params3[1], 'FREEDEL', 'Param {{2}} should be coupon code FREEDEL');
console.log('  ✔ nudge_3_cart: 2 params (name, coupon_code FREEDEL)');

// nudge_4_cart: 1 param (name) — scarcity message hardcoded
const params4 = tier1Nudge4.getParams(mockLead);
assert.strictEqual(params4.length, 1, 'nudge_4_cart should have exactly 1 template param');
console.log('  ✔ nudge_4_cart: 1 param (name) — scarcity in template image');

// Tier 2 uses same templates, verify param counts
const tier2Nudge1 = getNudgeConfig('TIER_2_CART_ADDER', 1);
const tier2Params1 = tier2Nudge1.getParams(mockLead);
assert.strictEqual(tier2Params1.length, 2, 'Tier 2 Nudge 1 (nudge_1_cart) should have 2 params');
assert.strictEqual(tier2Nudge1.campaignName, 'nudge_1_cart', 'Tier 2 Nudge 1 should use nudge_1_cart');

const tier2Nudge2 = getNudgeConfig('TIER_2_CART_ADDER', 2);
const tier2Params2 = tier2Nudge2.getParams(mockLead);
assert.strictEqual(tier2Params2.length, 2, 'Tier 2 Nudge 2 (nudge_2_cart) should have 2 params');

const tier2Nudge3 = getNudgeConfig('TIER_2_CART_ADDER', 3);
const tier2Params3 = tier2Nudge3.getParams(mockLead);
assert.strictEqual(tier2Params3.length, 1, 'Tier 2 Nudge 3 (nudge_4_cart) should have 1 param');
assert.strictEqual(tier2Nudge3.campaignName, 'nudge_4_cart', 'Tier 2 Nudge 3 should use nudge_4_cart');
console.log('  ✔ Tier 2 template params validated');

// Tier 3
const tier3Nudge1 = getNudgeConfig('TIER_3_PRODUCT_BROWSER', 1);
const tier3Params1 = tier3Nudge1.getParams(mockLead);
assert.strictEqual(tier3Params1.length, 2, 'Tier 3 Nudge 1 (nudge_2_cart) should have 2 params');
assert.strictEqual(tier3Nudge1.campaignName, 'nudge_2_cart', 'Tier 3 Nudge 1 should use nudge_2_cart');
console.log('  ✔ Tier 3 template params validated');

// ── TEST 4: Sending Window & IST Time Management ──
console.log('\nTest 4: IST Sending Windows');
// 12:00 PM IST = 06:30 UTC -> inside window (9am-9pm IST)
const afternoonUtc = new Date('2026-08-21T06:30:00.000Z');
assert.strictEqual(isWithinSendingHours(afternoonUtc), true, '12 PM IST should be inside sending hours');

// 11:00 PM IST = 17:30 UTC -> outside window
const nightUtc = new Date('2026-08-21T17:30:00.000Z');
assert.strictEqual(isWithinSendingHours(nightUtc), false, '11 PM IST should be outside sending hours');

// 04:00 AM IST = 22:30 UTC (previous day) -> outside window
const earlyMorningUtc = new Date('2026-08-21T22:30:00.000Z');
assert.strictEqual(isWithinSendingHours(earlyMorningUtc), false, '4 AM IST should be outside sending hours');

const adjustedTime = getNextValidSendTime(nightUtc.getTime());
const adjustedDate = new Date(adjustedTime);
// Adjusted time must fall inside 09:00 - 21:00 IST
assert.strictEqual(isWithinSendingHours(adjustedDate), true, 'Adjusted send time must fall in active sending hours');
console.log('  ✔ IST time management and night-time pause passed');

// ── TEST 5: Template & Config Integrity ──
console.log('\nTest 5: Template & Config Integrity');
const allTiers = ['TIER_1_CHECKOUT_ABANDON', 'TIER_2_CART_ADDER', 'TIER_3_PRODUCT_BROWSER'];
for (const tierKey of allTiers) {
  const maxNudges = getMaxNudgesForTier(tierKey);
  for (let i = 1; i <= maxNudges; i++) {
    const config = getNudgeConfig(tierKey, i);
    assert.ok(config.campaignName, `${tierKey} Nudge ${i} must have campaignName`);
    assert.strictEqual(config.fallbackCampaign, null, `${tierKey} Nudge ${i} fallbackCampaign should be null`);
    assert.ok(config.getParams, `${tierKey} Nudge ${i} must have getParams function`);
    assert.ok(config.tags && config.tags.length > 0, `${tierKey} Nudge ${i} must have tags`);
  }
}
console.log('  ✔ All tier/nudge configs have valid campaign, params, and tags');

console.log('\n=============================================');
console.log('🎉 ALL UNIT TESTS PASSED SUCCESSFULLY!');
console.log('=============================================');
