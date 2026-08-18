/**
 * Database Module — Upstash Redis / Vercel KV
 * --------------------------------------------
 * Manages active retargeting leads and their bi-weekly lifecycle state.
 */

const { Redis } = require('@upstash/redis');

let redisClient = null;

function getRedis() {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

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
  if (!redis) return null;

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
    name: lead.name || 'there',
    email: lead.email || '',
    city: lead.city || '',
    cart_items: lead.cart_items || '',
    checkout_url: lead.checkout_url || '',
    status: 'ACTIVE',
    enrolled_at: existing?.enrolled_at || now,
    last_sent_at: existing?.last_sent_at || now,
    cycle_count: existing?.cycle_count || 0,
    source: 'shopflo_shoppass',
  };

  await redis.set(key, payload);
  await redis.sadd('set:active_leads', phone);
  console.log(`[DB] Enrolled lead ${phone} (${payload.name}) for 2-week retargeting cycle.`);
  return payload;
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
  };

  await redis.set(key, payload);
  await redis.srem('set:active_leads', phone);
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
async function updateLeadProgress(phone, { cycleCount, lastSentAt }) {
  const redis = getRedis();
  if (!redis || !phone) return null;

  const key = `lead:${phone}`;
  const existing = await redis.get(key);
  if (!existing) return null;

  existing.cycle_count = cycleCount;
  existing.last_sent_at = lastSentAt || new Date().toISOString();

  // If reached max cycles (e.g. 3 cycles = 6 weeks), mark completed
  if (cycleCount >= 3) {
    existing.status = 'COMPLETED_MAX_CYCLES';
    await redis.srem('set:active_leads', phone);
    console.log(`[DB] Lead ${phone} completed maximum retargeting cycles (3 cycles / 6 weeks).`);
  }

  await redis.set(key, existing);
  return existing;
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

module.exports = {
  saveLead,
  markConverted,
  getActiveLeads,
  updateLeadProgress,
  saveOrder,
  getOrder,
  getRedis,
};

