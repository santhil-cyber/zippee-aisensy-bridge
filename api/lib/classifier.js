/**
 * Customer Segment Classifier & Campaign Sequence Config
 * --------------------------------------------------------
 * Classifies customer events from Shopflo into 5 intent tiers
 * and defines the timing, templates, and parameters for each tier.
 *
 * A/B TESTING: Nudges 2, 3, 4 have variant A (original) and variant B (new copy).
 * Users are deterministically assigned to A or B based on phone hash (50/50 split).
 * Each user always sees the same variant across all nudges for consistency.
 */

const crypto = require('crypto');

const TIERS = {
  TIER_0_REORDER: {
    key: 'TIER_0_REORDER',
    priority: -1, // Separate funnel — not part of acquisition intent hierarchy
    label: 'Past Buyer (Reorder Funnel)',
    cooldownMs: 15 * 24 * 60 * 60 * 1000, // 15 days post-order
  },
  BUYER: {
    key: 'BUYER',
    priority: 0,
    label: 'Converted Buyer',
    cooldownMs: 0,
  },
  TIER_1_CHECKOUT_ABANDON: {
    key: 'TIER_1_CHECKOUT_ABANDON',
    priority: 1,
    label: 'Checkout Abandoned (Very High Intent)',
    cooldownMs: 30 * 60 * 1000, // 30 mins
  },
  TIER_2_CART_ADDER: {
    key: 'TIER_2_CART_ADDER',
    priority: 2,
    label: 'Added to Cart (High Intent)',
    cooldownMs: 2 * 60 * 60 * 1000, // 2 hours
  },
  TIER_3_PRODUCT_BROWSER: {
    key: 'TIER_3_PRODUCT_BROWSER',
    priority: 3,
    label: 'Product Browser (Medium Intent)',
    cooldownMs: 24 * 60 * 60 * 1000, // 24 hours
  },
  TIER_4_COLLECTION_BROWSER: {
    key: 'TIER_4_COLLECTION_BROWSER',
    priority: 4,
    label: 'Collection Browser (Low Intent)',
    cooldownMs: 48 * 60 * 60 * 1000, // 48 hours
  },
  TIER_5_STORE_VISITOR: {
    key: 'TIER_5_STORE_VISITOR',
    priority: 5,
    label: 'Store Visitor (Very Low Intent)',
    cooldownMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
};

/**
 * A/B Test Configuration
 * ----------------------
 * Strategy: 50/50 deterministic split based on phone number hash.
 * Each customer consistently receives the same variant (A or B)
 * across all nudges in their sequence.
 *
 * splitRatio: 50 means 50% get variant A, 50% get variant B
 *            (adjust to 70 for 70/30 conservative testing)
 */
const AB_TEST_CONFIG = {
  enabled: true,
  splitRatio: 50, // % of users who get variant A (rest get B)
  startDate: '2026-09-01', // A/B test start date for analytics
};

/**
 * Browse-Abandon A/B/C Test Configuration
 * ----------------------------------------
 * Strategy: 33/33/34 deterministic split based on phone number hash.
 * Each browse-abandon customer consistently receives the same variant (A, B, or C)
 * across all nudges in their sequence.
 *
 * Variant A — Trust Builder: Lab-test credibility angle
 * Variant B — Decision Helper: Chef's Picks / bundle recommendation
 * Variant C — Problem-Aware: Protein gap education + product highlight
 */
const ABC_TEST_CONFIG = {
  enabled: true,
  startDate: '2026-09-08', // A/B/C test start date for analytics
};

/**
 * Deterministic A/B variant assignment based on phone number.
 * Uses a simple hash to ensure the same phone always gets the same variant.
 * @param {string} phone - Customer phone number
 * @returns {'A' | 'B'} - The assigned variant
 */
function getABVariant(phone) {
  if (!AB_TEST_CONFIG.enabled || !phone) return 'A';

  // Hash the phone number for a deterministic, evenly distributed split
  const hash = crypto.createHash('md5').update(String(phone)).digest('hex');
  // Take the first 8 hex chars and convert to a number 0-100
  const hashNum = parseInt(hash.substring(0, 8), 16) % 100;

  return hashNum < AB_TEST_CONFIG.splitRatio ? 'A' : 'B';
}

/**
 * Deterministic A/B/C variant assignment for browse-abandon nudges.
 * Uses a separate hash salt so variant assignment is independent of the 2-way A/B test.
 * @param {string} phone - Customer phone number
 * @returns {'A' | 'B' | 'C'} - The assigned variant
 */
function getABCVariant(phone) {
  if (!ABC_TEST_CONFIG.enabled || !phone) return 'A';

  const hash = crypto.createHash('md5').update('browse_' + String(phone)).digest('hex');
  const hashNum = parseInt(hash.substring(0, 8), 16) % 100;

  if (hashNum < 33) return 'A';  // Trust Builder
  if (hashNum < 66) return 'B';  // Decision Helper (Chef's Picks)
  return 'C';                     // Problem-Aware (Protein Gap)
}

/**
 * Multi-step nurture sequences per tier
 */
function formatButtonUrl(url) {
  if (!url) return 'proteinpantry.in/cart';
  let clean = String(url).trim();
  if (clean.includes('wa.aisensy.com/')) {
    return clean.split('wa.aisensy.com/')[1] || clean;
  }
  return clean.replace(/^https?:\/\//i, '');
}

const SEQUENCE_CONFIG = {
  // ══════════════════════════════════════════════════════════════════════
  // REORDER SEQUENCE (Category 3 — Past Buyers)
  // ══════════════════════════════════════════════════════════════════════
  // Enrolled automatically when an order is confirmed.
  // Goal: bring satisfied customers back for repeat purchases.
  // 4 nudges spread over 15-45 days post-order.
  // ══════════════════════════════════════════════════════════════════════
  TIER_0_REORDER: [
    {
      nudgeNum: 0,
      delayMs: 14 * 24 * 60 * 60 * 1000, // T + 14 days post-order
      // ── A/B Test: 14-day re-engagement — two copy variants ──
      variants: {
        A: {
          campaignName: 'restock_14d_1',
          fallbackCampaign: 'browse_nudge_chefpick', // Fallback to live Chef's Picks template
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Reorder', 'Nudge0_Restock14d', 'AB_Variant_A'],
        },
        B: {
          campaignName: 'restock_14d_2',
          fallbackCampaign: 'browse_nudge_chefpick', // Fallback to live Chef's Picks template
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Reorder', 'Nudge0_Restock14d', 'AB_Variant_B'],
        },
      },
    },
    {
      nudgeNum: 1,
      delayMs: 15 * 24 * 60 * 60 * 1000, // T + 15 days post-order
      campaignName: 'reorder_nudge_1_restock',
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Reorder', 'Nudge1_Restock'],
    },
    {
      nudgeNum: 2,
      delayMs: 22 * 24 * 60 * 60 * 1000, // T + 22 days post-order
      campaignName: 'browse_nudge_chefpick', // REUSE: Chef's Picks recommendation works for upsell
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Reorder', 'Nudge2_ChefsPicks'],
    },
    {
      nudgeNum: 3,
      delayMs: 30 * 24 * 60 * 60 * 1000, // T + 30 days post-order
      campaignName: 'nudge_2nd_cart', // REUSE: Generic "protein goals + coupon" messaging works for reorder
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        'COMEBACK10',
      ],
      tags: ['Reorder', 'Nudge3_Loyalty_Coupon'],
    },
    {
      nudgeNum: 4,
      delayMs: 45 * 24 * 60 * 60 * 1000, // T + 45 days post-order
      campaignName: 'reorder_nudge_4_winback',
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Reorder', 'Nudge4_Winback'],
    },
  ],

  // ══════════════════════════════════════════════════════════════════════
  // CART ABANDON SEQUENCES (Category 1)
  // ══════════════════════════════════════════════════════════════════════

  TIER_1_CHECKOUT_ABANDON: [
    {
      nudgeNum: 1,
      delayMs: 30 * 60 * 1000, // T + 30 mins
      campaignName: 'nudge_1_cart',
      fallbackCampaign: null, // nudge_1_cart is approved & live in AiSensy
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        String(lead?.cart_items || 'your selected items'),
      ],
      tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge1'],
    },
    {
      nudgeNum: 2,
      delayMs: 4 * 60 * 60 * 1000, // T + 4 hours
      skipIfReturning: true, // PRO10 coupon — skip for returning customers
      // ── A/B Test: Variant A (original) vs Variant B (new copy) ──
      variants: {
        A: {
          campaignName: 'nudge_2nd_cart',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
            'PRO10',
          ],
          tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge2_10off', 'AB_Variant_A'],
        },
        B: {
          campaignName: 'nudge_2nd_cart_b',
          fallbackCampaign: 'nudge_2nd_cart', // fallback to A if B template not yet approved
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
            'PRO10',
          ],
          tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge2_10off', 'AB_Variant_B'],
        },
      },
    },
    {
      nudgeNum: 3,
      delayMs: 24 * 60 * 60 * 1000, // T + 24 hours
      skipIfReturning: true, // FREEDEL coupon — skip for returning customers
      // ── A/B Test: Variant A (original) vs Variant B (new copy) ──
      variants: {
        A: {
          campaignName: 'nudge_3_cart',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
            'FREEDEL',
          ],
          tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge3_FreeShip', 'AB_Variant_A'],
        },
        B: {
          campaignName: 'nudge_3rd_cart_b',
          fallbackCampaign: 'nudge_3_cart', // fallback to A if B template not yet approved
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
            'FREEDEL',
          ],
          tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge3_FreeShip', 'AB_Variant_B'],
        },
      },
    },
    {
      nudgeNum: 4,
      delayMs: 72 * 60 * 60 * 1000, // T + 72 hours
      // ── A/B Test: Variant A (original) vs Variant B (new copy) ──
      variants: {
        A: {
          campaignName: 'nudge_4_cart',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge4_Scarcity', 'AB_Variant_A'],
        },
        B: {
          campaignName: 'nudge_4_cart_b',
          fallbackCampaign: 'nudge_4_cart', // fallback to A if B template not yet approved
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge4_Scarcity', 'AB_Variant_B'],
        },
      },
    },
  ],

  TIER_2_CART_ADDER: [
    {
      nudgeNum: 1,
      delayMs: 2 * 60 * 60 * 1000, // T + 2 hours
      campaignName: 'nudge_1_cart',
      fallbackCampaign: null, // nudge_1_cart is approved & live in AiSensy
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        String(lead?.cart_items || 'your cart items'),
      ],
      tags: ['ShopPass_Cart_Adder', 'Tier2_Nudge1'],
    },
    {
      nudgeNum: 2,
      delayMs: 24 * 60 * 60 * 1000, // T + 24 hours
      skipIfReturning: true, // PRO10 coupon — skip for returning customers
      // ── A/B Test: Variant A (original) vs Variant B (new copy) ──
      variants: {
        A: {
          campaignName: 'nudge_2nd_cart',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
            'PRO10',
          ],
          tags: ['ShopPass_Cart_Adder', 'Tier2_Nudge2_10off', 'AB_Variant_A'],
        },
        B: {
          campaignName: 'nudge_2nd_cart_b',
          fallbackCampaign: 'nudge_2nd_cart',
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
            'PRO10',
          ],
          tags: ['ShopPass_Cart_Adder', 'Tier2_Nudge2_10off', 'AB_Variant_B'],
        },
      },
    },
    {
      nudgeNum: 3,
      delayMs: 5 * 24 * 60 * 60 * 1000, // T + 5 days
      // ── A/B Test: Variant A (original) vs Variant B (new copy) ──
      variants: {
        A: {
          campaignName: 'nudge_4_cart',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['ShopPass_Cart_Adder', 'Tier2_Nudge3_LastChance', 'AB_Variant_A'],
        },
        B: {
          campaignName: 'nudge_4_cart_b',
          fallbackCampaign: 'nudge_4_cart',
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['ShopPass_Cart_Adder', 'Tier2_Nudge3_LastChance', 'AB_Variant_B'],
        },
      },
    },
  ],

  // ══════════════════════════════════════════════════════════════════════
  // BROWSE-ABANDON SEQUENCES (Category 2 — A/B/C TEST)
  // ══════════════════════════════════════════════════════════════════════
  // These target customers who scrolled but put NOTHING in cart.
  // Nudge 1: 3 message variants tested via getABCVariant():
  //   A = Trust Builder (lab tests)      → browse_nudge_trust (with header image)
  //   B = Decision Helper (Chef's Picks) → browse_nudge_chefpick
  //   C = Problem-Aware (protein gap)    → browse_nudge_protein
  // Nudge 2+: Shared follow-up nudges (bestseller, social proof, coupon)
  // ══════════════════════════════════════════════════════════════════════

  TIER_3_PRODUCT_BROWSER: [
    {
      nudgeNum: 1,
      delayMs: 24 * 60 * 60 * 1000, // T + 24 hours
      // A/B/C browse-abandon test — 3 message angles
      variants: {
        A: {
          campaignName: 'browse_nudge_trust',
          fallbackCampaign: null,
          mediaUrl: 'https://cdn.shopify.com/s/files/1/0686/7379/8281/files/ChatGPT_Image_Sep_9_2026_02_15_05_AM.png?v=1788901647',
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier3_Nudge1', 'ABC_Variant_A', 'Trust_Builder'],
        },
        B: {
          campaignName: 'browse_nudge_chefpick',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier3_Nudge1', 'ABC_Variant_B', 'Chefs_Picks'],
        },
        C: {
          campaignName: 'browse_nudge_protein',
          fallbackCampaign: 'browse_nudge_chefpick', // Fallback to live Chef's Picks if C pending
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier3_Nudge1', 'ABC_Variant_C', 'Protein_Gap'],
        },
      },
    },
    {
      nudgeNum: 2,
      delayMs: 72 * 60 * 60 * 1000, // T + 72 hours
      skipIfReturning: true, // PRO10 coupon — skip for returning customers
      campaignName: 'nudge_2nd_cart',
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        'PRO10',
      ],
      tags: ['Browse_Abandon', 'Tier3_Nudge2_Coupon'],
    },
    {
      nudgeNum: 3,
      delayMs: 5 * 24 * 60 * 60 * 1000, // T + 5 days
      campaignName: 'browse_nudge_chefpick', // REUSE: Rotate Chef's Picks as follow-up
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Browse_Abandon', 'Tier3_Nudge3_ChefsPicks'],
    },
  ],

  TIER_4_COLLECTION_BROWSER: [
    {
      nudgeNum: 1,
      delayMs: 48 * 60 * 60 * 1000, // T + 48 hours
      // Same A/B/C browse-abandon test
      variants: {
        A: {
          campaignName: 'browse_nudge_trust',
          fallbackCampaign: null,
          mediaUrl: 'https://cdn.shopify.com/s/files/1/0686/7379/8281/files/ChatGPT_Image_Sep_9_2026_02_15_05_AM.png?v=1788901647',
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier4_Nudge1', 'ABC_Variant_A', 'Trust_Builder'],
        },
        B: {
          campaignName: 'browse_nudge_chefpick',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier4_Nudge1', 'ABC_Variant_B', 'Chefs_Picks'],
        },
        C: {
          campaignName: 'browse_nudge_protein',
          fallbackCampaign: 'browse_nudge_chefpick',
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier4_Nudge1', 'ABC_Variant_C', 'Protein_Gap'],
        },
      },
    },
    {
      nudgeNum: 2,
      delayMs: 4 * 24 * 60 * 60 * 1000, // T + 4 days
      campaignName: 'browse_nudge_chefpick', // REUSE: Rotate Chef's Picks as follow-up
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Browse_Abandon', 'Tier4_Nudge2_ChefsPicks'],
    },
    {
      nudgeNum: 3,
      delayMs: 7 * 24 * 60 * 60 * 1000, // T + 7 days
      campaignName: 'browse_nudge_trust', // REUSE: Rotate Trust/Lab-test as follow-up
      fallbackCampaign: null,
      mediaUrl: 'https://cdn.shopify.com/s/files/1/0686/7379/8281/files/ChatGPT_Image_Sep_9_2026_02_15_05_AM.png?v=1788901647',
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Browse_Abandon', 'Tier4_Nudge3_Trust'],
    },
  ],

  TIER_5_STORE_VISITOR: [
    {
      nudgeNum: 1,
      delayMs: 7 * 24 * 60 * 60 * 1000, // T + 7 days (very low intent — longer delay)
      // Same A/B/C browse-abandon test
      variants: {
        A: {
          campaignName: 'browse_nudge_trust',
          fallbackCampaign: null,
          mediaUrl: 'https://cdn.shopify.com/s/files/1/0686/7379/8281/files/ChatGPT_Image_Sep_9_2026_02_15_05_AM.png?v=1788901647',
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier5_Nudge1', 'ABC_Variant_A', 'Trust_Builder'],
        },
        B: {
          campaignName: 'browse_nudge_chefpick',
          fallbackCampaign: null,
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier5_Nudge1', 'ABC_Variant_B', 'Chefs_Picks'],
        },
        C: {
          campaignName: 'browse_nudge_protein',
          fallbackCampaign: 'browse_nudge_chefpick',
          getParams: (lead = {}) => [
            String(lead?.name || 'there'),
          ],
          tags: ['Browse_Abandon', 'Tier5_Nudge1', 'ABC_Variant_C', 'Protein_Gap'],
        },
      },
    },
    {
      nudgeNum: 2,
      delayMs: 10 * 24 * 60 * 60 * 1000, // T + 10 days
      campaignName: 'browse_nudge_chefpick', // REUSE: Rotate Chef's Picks as follow-up
      fallbackCampaign: null,
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Browse_Abandon', 'Tier5_Nudge2_ChefsPicks'],
    },
    {
      nudgeNum: 3,
      delayMs: 14 * 24 * 60 * 60 * 1000, // T + 14 days
      campaignName: 'browse_nudge_trust', // REUSE: Rotate Trust/Lab-test as follow-up
      fallbackCampaign: null,
      mediaUrl: 'https://cdn.shopify.com/s/files/1/0686/7379/8281/files/ChatGPT_Image_Sep_9_2026_02_15_05_AM.png?v=1788901647',
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['Browse_Abandon', 'Tier5_Nudge3_Trust'],
    },
  ],
};

/**
 * Classify a customer based on events list and order status
 * @param {Array<string>|string} rawEvents - List of event strings or comma-separated string
 * @param {boolean|string} hasOrderDate - Whether customer has placed order in past or order date string
 * @returns {object} Classification object with tier, priority, and config
 */
function classifyCustomer(rawEvents, hasOrderDate) {
  let eventList = [];
  if (Array.isArray(rawEvents)) {
    eventList = rawEvents.map(e => String(e).trim().toLowerCase());
  } else if (typeof rawEvents === 'string') {
    eventList = rawEvents.split(',').map(e => e.trim().toLowerCase());
  }

  const events = new Set(eventList.filter(Boolean));
  const hasOrder = Boolean(hasOrderDate && String(hasOrderDate).trim().length > 0);

  // 1. Buyer / Converted
  if (
    hasOrder ||
    events.has('order_completed') ||
    events.has('payment_completed') ||
    events.has('order_confirmation_loaded')
  ) {
    return { ...TIERS.BUYER, tier: TIERS.BUYER.key };
  }

  // 2. Tier 1: Checkout Abandoned / Payment dropoffs (Very high intent)
  if (
    events.has('checkout_abandoned') ||
    events.has('payment_initiated') ||
    events.has('payment_page_loaded') ||
    events.has('payment_page_refreshed') ||
    events.has('payment_method_selected') ||
    events.has('payment_mode_selected') ||
    events.has('payment_failed') ||
    events.has('checkout_initiated') ||
    events.has('checkout_clicked') ||
    events.has('checkout_ui_loaded') ||
    events.has('checkout_milestone_reached') ||
    events.has('address_selected') ||
    events.has('address_new_form_submitted') ||
    events.has('coupon_selected') ||
    events.has('coupon_success')
  ) {
    return { ...TIERS.TIER_1_CHECKOUT_ABANDON, tier: TIERS.TIER_1_CHECKOUT_ABANDON.key };
  }

  // 3. Tier 2: Cart Adders (High intent)
  if (events.has('added_to_cart_ui') || events.has('upsell_product_added')) {
    return { ...TIERS.TIER_2_CART_ADDER, tier: TIERS.TIER_2_CART_ADDER.key };
  }

  // 4. Tier 3: Product Page Browsers (Medium intent)
  if (events.has('product_page_viewed')) {
    return { ...TIERS.TIER_3_PRODUCT_BROWSER, tier: TIERS.TIER_3_PRODUCT_BROWSER.key };
  }

  // 5. Tier 4: Collection Browsers (Low intent)
  if (events.has('collection_page_viewed')) {
    return { ...TIERS.TIER_4_COLLECTION_BROWSER, tier: TIERS.TIER_4_COLLECTION_BROWSER.key };
  }

  // 6. Tier 5: Store Visitors (Very low intent)
  if (events.has('store_page_view') || events.has('cart_load_time_react') || events.has('cookie_login')) {
    return { ...TIERS.TIER_5_STORE_VISITOR, tier: TIERS.TIER_5_STORE_VISITOR.key };
  }

  // Default fallback for any remaining events
  return { ...TIERS.TIER_5_STORE_VISITOR, tier: TIERS.TIER_5_STORE_VISITOR.key };
}

/**
 * Get sequence step definition for a given tier and nudge number.
 * If the nudge has A/B variants and a phone is provided, resolves the correct variant.
 * Returns a flat config object with campaignName, getParams, tags, etc.
 *
 * @param {string} tierKey
 * @param {number} nudgeNum
 * @param {string} [phone] - Customer phone for A/B variant assignment
 * @returns {object|null} - Resolved nudge config with variant field
 */
function getNudgeConfig(tierKey, nudgeNum = 1, phone = null) {
  const sequence = SEQUENCE_CONFIG[tierKey] || [];
  const step = sequence.find(s => s.nudgeNum === nudgeNum) || null;
  if (!step) return null;

  // If this nudge has variants, resolve the correct one
  if (step.variants) {
    // Determine variant assignment strategy:
    //   - Browse tiers (BROWSER/VISITOR) use 3-way A/B/C split
    //   - Cart tiers and Reorder tier use 2-way A/B split
    const isBrowseTier = tierKey.includes('BROWSER') || tierKey.includes('VISITOR');
    const variant = isBrowseTier ? getABCVariant(phone) : getABVariant(phone);
    const variantConfig = step.variants[variant] || step.variants['A'];
    return {
      nudgeNum: step.nudgeNum,
      delayMs: step.delayMs,
      skipIfReturning: step.skipIfReturning || false,
      campaignName: variantConfig.campaignName,
      fallbackCampaign: variantConfig.fallbackCampaign || null,
      mediaUrl: variantConfig.mediaUrl || null,
      getParams: variantConfig.getParams,
      tags: variantConfig.tags || [],
      abVariant: variant, // Track which variant was assigned (A, B, or C)
    };
  }

  // Non-variant nudge (e.g. shared follow-up coupon) — return as-is
  return {
    ...step,
    mediaUrl: step.mediaUrl || null,
    abVariant: null,
  };
}

/**
 * Get the total number of nudges in a tier sequence
 */
function getMaxNudgesForTier(tierKey) {
  const sequence = SEQUENCE_CONFIG[tierKey] || [];
  return sequence.length;
}

module.exports = {
  TIERS,
  SEQUENCE_CONFIG,
  AB_TEST_CONFIG,
  ABC_TEST_CONFIG,
  classifyCustomer,
  getNudgeConfig,
  getMaxNudgesForTier,
  getABVariant,
  getABCVariant,
};
