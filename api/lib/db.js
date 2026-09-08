/**
 * Database Module — Upstash Redis / Vercel KV
 * --------------------------------------------
 * Manages active retargeting leads and their bi-weekly / multi-step lifecycle state.
 */

const { Redis } = require('@upstash/redis');

let redisClient = null;

function getRedis() {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL
    || process.env.KV_REST_API_URL
    || process.env.REDIS_REST_API_URL
    || process.env.STORAGE_REST_API_URL
    || process.env.STORAGE_URL
    || process.env.REDIS_URL;

  const token = process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.KV_REST_API_TOKEN
    || process.env.REDIS_REST_API_TOKEN
    || process.env.STORAGE_REST_API_TOKEN
    || process.env.STORAGE_TOKEN
    || process.env.REDIS_TOKEN;

  if (!url || !token) {
    console.warn('[DB] Upstash Redis credentials not found in environment variables.');
    return null;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

/**
 * Save or update a lead in Redis
 */
async function saveLead(lead) {
  const redis = getRedis();
  if (!redis || !lead?.phone) return null;

  const phone = lead.phone;
  const key = `lead:${phone}`;
  const now = new Date().toISOString();

  // Check if lead already exists
  const existing = await redis.get(key);

  if (existing && existing.status === 'CONVERTED') {
    console.log(`[DB] Lead ${phone} has already converted. Skipping enrollment.`);
    return existing;
  }

  const payload = {
    phone,
    name: lead.name || existing?.name || 'Customer',
    email: lead.email || existing?.email || '',
    city: lead.city || existing?.city || '',
    cart_items: lead.cart_items || existing?.cart_items || '',
    checkout_url: lead.checkout_url || existing?.checkout_url || 'https://proteinpantry.in',
    status: 'ACTIVE',
    tier: lead.tier || existing?.tier || 'TIER_1_CHECKOUT_ABANDON',
    current_nudge: lead.current_nudge !== undefined ? lead.current_nudge : (existing?.current_nudge || 0),
    enrolled_at: existing?.enrolled_at || now,
    last_sent_at: existing?.last_sent_at || null,
    cycle_count: existing?.cycle_count || 0,
    order_count: lead.order_count !== undefined ? lead.order_count : (existing?.order_count || 0),
    last_order_date: lead.last_order_date || existing?.last_order_date || null,
    source: lead.source || existing?.source || 'shopflo_shoppass',
    utm_source: lead.utm_source || existing?.utm_source || '',
    utm_medium: lead.utm_medium || existing?.utm_medium || '',
    utm_campaign: lead.utm_campaign || existing?.utm_campaign || '',
    utm_content: lead.utm_content || existing?.utm_content || '',
    updated_at: now,
  };

  await redis.set(key, payload);
  await redis.sadd('set:active_leads', phone);
  console.log(`[DB] Enrolled lead ${phone} (${payload.name}) in ${payload.tier}.`);
  return payload;
}

/**
 * Retrieve a specific lead by phone
 */
async function getLead(phone) {
  const redis = getRedis();
  if (!redis || !phone) return null;

  try {
    return await redis.get(`lead:${phone}`);
  } catch (err) {
    console.warn(`[DB] Error fetching lead ${phone}:`, err.message);
    return null;
  }
}

/**
 * Mark a lead as converted / purchased (stops future retargeting)
 */
async function markConverted(phone) {
  const redis = getRedis();
  if (!redis || !phone) return null;

  const key = `lead:${phone}`;
  const existing = await redis.get(key);

  const payload = {
    ...(existing || { phone }),
    status: 'CONVERTED',
    converted_at: new Date().toISOString(),
    last_order_date: new Date().toISOString(),
    order_count: (existing?.order_count || 0) + 1,
  };

  await redis.set(key, payload);
  await redis.srem('set:active_leads', phone);

  // NOTE: Queue cleanup (cancelAllMessagesForPhone) is the caller's responsibility.
  // This avoids a circular dependency between db.js <-> queue.js.

  console.log(`[DB] Lead ${phone} marked as CONVERTED. Removed from active retargeting.`);
  return payload;
}

/**
 * Get all active leads currently enrolled in retargeting
 */
async function getActiveLeads() {
  const redis = getRedis();
  if (!redis) return [];

  const phones = await redis.smembers('set:active_leads');
  if (!phones || phones.length === 0) return [];

  const leads = [];
  for (const phone of phones) {
    const data = await redis.get(`lead:${phone}`);
    if (data && data.status === 'ACTIVE') {
      leads.push(data);
    }
  }
  return leads;
}

/**
 * Update lead cycle count and timestamp after a campaign message is sent
 */
async function updateLeadProgress(phone, updates = {}) {
  const redis = getRedis();
  if (!redis || !phone) return null;

  const key = `lead:${phone}`;
  const existing = await redis.get(key);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  if (updates.status && updates.status !== 'ACTIVE') {
    await redis.srem('set:active_leads', phone);
  }

  await redis.set(key, updated);
  return updated;
}

/**
 * Cache Shopify order metadata for logistics webhook lookup
 */
async function saveOrder(orderData) {
  const redis = getRedis();
  if (!redis || !orderData) return null;

  try {
    const { orderId, orderNumber, shopifyId, customerName, customerPhone, city } = orderData;
    const payload = {
      orderId: orderId || '',
      orderNumber: orderNumber ? String(orderNumber) : '',
      shopifyId: shopifyId ? String(shopifyId) : '',
      customerName: customerName || 'Customer',
      customerPhone: customerPhone || '',
      city: city || '',
      saved_at: new Date().toISOString()
    };

    const ttlSeconds = 60 * 60 * 24 * 30; // 30 days retention

    // Save with multiple keys to ensure exact match regardless of format (#1042, 1042, PPY1042)
    const keys = new Set();
    if (orderId) {
      keys.add(`order:${orderId.trim()}`);
      keys.add(`order:${orderId.replace(/^#/, '').trim()}`);
      keys.add(`order:${orderId.replace(/^#/, '').trim().toLowerCase()}`);
    }
    if (orderNumber) {
      keys.add(`order:${String(orderNumber).trim()}`);
      keys.add(`order:#${String(orderNumber).trim()}`);
    }
    if (shopifyId) {
      keys.add(`order:${String(shopifyId).trim()}`);
    }

    for (const k of keys) {
      await redis.set(k, payload, { ex: ttlSeconds });
    }

    console.log(`[DB] Cached order info for ${orderId || orderNumber} (${payload.customerName} - ${payload.customerPhone})`);
    return payload;
  } catch (err) {
    console.warn('[DB Error saving order]:', err.message);
    return null;
  }
}

/**
 * Retrieve cached Shopify order metadata by any order ID / number identifier
 */
async function getOrder(orderIdentifier) {
  const redis = getRedis();
  if (!redis || !orderIdentifier) return null;

  try {
    const cleanId = String(orderIdentifier).trim();
    const cleanNoHash = cleanId.replace(/^#/, '');

    const candidates = [
      `order:${cleanId}`,
      `order:${cleanNoHash}`,
      `order:#${cleanNoHash}`,
      `order:${cleanNoHash.toLowerCase()}`,
      `order:${cleanId.toLowerCase()}`
    ];

    for (const key of candidates) {
      const data = await redis.get(key);
      if (data && (data.customerPhone || data.customer_phone)) {
        return data;
      }
    }
    return null;
  } catch (err) {
    console.warn(`[DB Error retrieving order ${orderIdentifier}]:`, err.message);
    return null;
  }
}

/**
 * Re-enroll a converted lead into the reorder funnel.
 * This preserves the lead's order history while switching them to TIER_0_REORDER.
 * Called from order-confirmation.js after marking CONVERTED.
 */
async function saveLeadForReorder(phone, leadData = {}) {
  const redis = getRedis();
  if (!redis || !phone) return null;

  const key = `lead:${phone}`;
  const now = new Date().toISOString();
  const existing = await redis.get(key);

  const payload = {
    ...(existing || {}),
    phone,
    name: leadData.name || existing?.name || 'Customer',
    email: leadData.email || existing?.email || '',
    city: leadData.city || existing?.city || '',
    status: 'ACTIVE',
    tier: 'TIER_0_REORDER',
    current_nudge: 0,
    last_order_date: leadData.last_order_date || now,
    order_count: existing?.order_count || 1,
    enrolled_at: now, // Reset enrollment to order date for reorder timing
    source: 'reorder_funnel',
    updated_at: now,
  };

  await redis.set(key, payload);
  await redis.sadd('set:active_leads', phone);
  console.log(`[DB] Enrolled lead ${phone} (${payload.name}) in TIER_0_REORDER funnel (Order #${payload.order_count}).`);
  return payload;
}

module.exports = {
  saveLead,
  getLead,
  markConverted,
  getActiveLeads,
  updateLeadProgress,
  saveLeadForReorder,
  saveOrder,
  getOrder,
  getRedis,
};
