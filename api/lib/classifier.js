/**
 * Customer Segment Classifier & Campaign Sequence Config
 * --------------------------------------------------------
 * Classifies customer events from Shopflo into 5 intent tiers
 * and defines the timing, templates, and parameters for each tier.
 */

const TIERS = {
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
      campaignName: 'nudge_2nd_cart',
      fallbackCampaign: null, // nudge_2nd_cart is approved & live in AiSensy
      skipIfReturning: true, // Pro10 coupon — skip for returning customers
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        'Pro10',
      ],
      tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge2_10off'],
    },
    {
      nudgeNum: 3,
      delayMs: 24 * 60 * 60 * 1000, // T + 24 hours
      campaignName: 'nudge_3_cart',
      fallbackCampaign: null, // nudge_3_cart is approved & live in AiSensy
      skipIfReturning: true, // FREEDEL coupon — skip for returning customers
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        'FREEDEL',
      ],
      tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge3_FreeShip'],
    },
    {
      nudgeNum: 4,
      delayMs: 72 * 60 * 60 * 1000, // T + 72 hours
      campaignName: 'nudge_4_cart',
      fallbackCampaign: null, // nudge_4_cart is approved & live in AiSensy
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['ShopPass_Cart_Abandon', 'Tier1_Nudge4_Scarcity'],
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
      campaignName: 'nudge_2nd_cart',
      fallbackCampaign: null, // nudge_2nd_cart is approved & live in AiSensy
      skipIfReturning: true, // Pro10 coupon — skip for returning customers
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        'Pro10',
      ],
      tags: ['ShopPass_Cart_Adder', 'Tier2_Nudge2_10off'],
    },
    {
      nudgeNum: 3,
      delayMs: 5 * 24 * 60 * 60 * 1000, // T + 5 days
      campaignName: 'nudge_4_cart',
      fallbackCampaign: null, // nudge_4_cart is approved & live in AiSensy
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
      ],
      tags: ['ShopPass_Cart_Adder', 'Tier2_Nudge3_LastChance'],
    },
  ],

  TIER_3_PRODUCT_BROWSER: [
    {
      nudgeNum: 1,
      delayMs: 24 * 60 * 60 * 1000, // T + 24 hours
      campaignName: 'nudge_2nd_cart',
      fallbackCampaign: null, // nudge_2nd_cart is approved & live in AiSensy
      skipIfReturning: true, // Pro10 coupon — skip for returning customers
      getParams: (lead = {}) => [
        String(lead?.name || 'there'),
        'Pro10',
      ],
      tags: ['ShopPass_Product_Browser', 'Tier3_Nudge1'],
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
 * Get sequence step definition for a given tier and nudge number
 */
function getNudgeConfig(tierKey, nudgeNum = 1) {
  const sequence = SEQUENCE_CONFIG[tierKey] || [];
  return sequence.find(s => s.nudgeNum === nudgeNum) || null;
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
  classifyCustomer,
  getNudgeConfig,
  getMaxNudgesForTier,
};
