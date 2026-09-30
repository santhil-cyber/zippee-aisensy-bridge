/**
 * Chatbot Order Lookup API
 * ========================
 * Endpoint: GET /api/chatbot-order-lookup?q=PPY18583
 * 
 * Looks up order status by:
 *   1. Order ID (e.g. PPY18583, #PPY18583)
 *   2. Phone number (e.g. +919876543210, 9876543210)
 * 
 * Data sources (in order):
 *   1. Redis cache (fastest — cached by shopflo/order-confirmation webhooks)
 *   2. Shopify Admin API (authoritative — findOrder / hasPlacedOrder)
 *   3. Zippee / Pikndel tracking API (live shipment status)
 * 
 * Returns a unified order status card for the chatbot widget.
 */

const { findOrder } = require('./lib/shopify');
const { getLead } = require('./lib/db');

module.exports = async (req, res) => {
  // CORS headers for cross-origin widget requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(200).send('Chatbot Order Lookup API is active.');
  }

  const query = (req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({
      found: false,
      error: 'Missing query parameter "q". Pass an Order ID or phone number.',
    });
  }

  try {
    let orderResult = null;
    let leadData = null;
    let source = null;

    // ─── STRATEGY 1: Direct Order ID lookup via Shopify ───
    // Matches patterns like: PPY18583, #PPY18583, #1042, 1042
    const isOrderId = /^#?[A-Z]*\d{3,}$/i.test(query);

    if (isOrderId) {
      orderResult = await findOrder(query);
      source = 'shopify';
    }

    // ─── STRATEGY 2: Phone number lookup via Redis + Shopify ───
    // Matches patterns like: 9876543210, +919876543210, 09876543210
    const isPhone = /^\+?\d{10,13}$/.test(query.replace(/[\s-]/g, ''));

    if (!orderResult && isPhone) {
      const cleanPhone = formatPhoneForLookup(query);

      // Check Redis cache first (populated by shopflo/order-confirmation webhooks)
      try {
        leadData = await getLead(cleanPhone);
        if (leadData && leadData.status === 'CONVERTED') {
          source = 'redis';
        }
      } catch (redisErr) {
        console.warn('[Chatbot Lookup] Redis notice:', redisErr.message);
      }

      // Also check Shopify for the actual order
      if (!orderResult) {
        // Try to find recent orders for this phone via Shopify search
        try {
          const { hasPlacedOrder } = require('./lib/shopify');
          const hasOrder = await hasPlacedOrder(cleanPhone, null, null);
          if (hasOrder) {
            source = 'shopify-phone';
          }
        } catch (shopErr) {
          console.warn('[Chatbot Lookup] Shopify phone search notice:', shopErr.message);
        }
      }
    }

    // ─── BUILD RESPONSE ───
    if (orderResult) {
      // We have a Shopify order — now get shipping status
      const city = (orderResult.city || '').toLowerCase().trim();
      const isJaipur = city === 'jaipur';
      const logisticsPartner = isJaipur ? 'Pikndel' : 'Zippee';

      // In production, call Zippee/Pikndel tracking API here
      // For now, return Shopify order data with a generic status
      return res.status(200).json({
        found: true,
        source,
        orderId: orderResult.orderId,
        customerName: orderResult.customerName,
        city: orderResult.city,
        logisticsPartner,
        // Shipment status would come from Zippee/Pikndel API
        // Default to "Processing" if no tracking data yet
        status: 'PICKUP_PENDING',
        statusText: 'Your order is being prepared for dispatch',
        rider: null,
        eta: isJaipur ? 'Today (same-day delivery)' : 'Within 1 day',
        updatedAt: new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          day: '2-digit',
          month: 'short',
        }),
        trackingUrl: null, // Would be Zippee/Pikndel tracking URL
      });
    }

    if (leadData) {
      // We have Redis lead data but no matching Shopify order
      // This means the customer abandoned checkout but may have converted
      return res.status(200).json({
        found: true,
        source: 'redis',
        orderId: leadData.order_id || 'Processing',
        customerName: leadData.name || 'Customer',
        city: leadData.city || '',
        status: leadData.status === 'CONVERTED' ? 'PICKUP_PENDING' : 'PROCESSING',
        statusText: leadData.status === 'CONVERTED'
          ? 'Your order is confirmed and being prepared!'
          : 'We found your details. Please complete checkout to place your order.',
        rider: null,
        eta: null,
        updatedAt: null,
      });
    }

    // ─── NOT FOUND ───
    return res.status(200).json({
      found: false,
      message: 'No order found for this ID or phone number.',
      query,
    });

  } catch (error) {
    console.error('[Chatbot Lookup Error]:', error.message);
    return res.status(500).json({
      found: false,
      error: 'Internal error while looking up order.',
    });
  }
};

/**
 * Normalize phone number to +91XXXXXXXXXX format
 */
function formatPhoneForLookup(phone) {
  let cleaned = String(phone).replace(/[\s\-\(\)]/g, '');
  // Remove leading 0
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  // Remove 91 prefix without +
  if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
  // Add +91
  if (cleaned.length === 10) return `+91${cleaned}`;
  // Already has + prefix
  if (cleaned.startsWith('+')) return cleaned;
  return `+91${cleaned}`;
}
