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

const { findOrder, findOrderByPhone } = require('./lib/shopify');
const { getLead, getOrder } = require('./lib/db');
const { getEasyEcomOrder } = require('./lib/easyecom');

module.exports = async (req, res) => {
  // CORS headers for cross-origin widget requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Safely parse JSON body if sent via POST
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }
  body = body || {};

  const rawQuery = (
    body.order_id ||
    body.orderId ||
    body.q ||
    body.query ||
    (req.query && (req.query.q || req.query.order_id || req.query.orderId || req.query.query)) ||
    ''
  );
  const query = String(rawQuery).trim();

  if (!query) {
    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'ok',
        message: 'Chatbot Order Lookup API is active.',
      });
    }
    return res.status(400).json({
      found: false,
      order_status: 'Not Found',
      orderStatus: 'Not Found',
      status: 'NOT_FOUND',
      courier_name: 'N/A',
      tracking_link: 'N/A',
      delivery_updates: 'Please provide an Order ID (e.g. PPY21302) or 10-digit mobile number.',
      error: 'Missing query parameter. Pass "order_id" in body or "q" in query.',
    });
  }

  // Handle template placeholder or test request from AiSensy Flow Builder
  if (query === '$order_id' || query.toLowerCase() === 'test' || query.toLowerCase() === 'sample') {
    return res.status(200).json({
      found: true,
      source: 'sample',
      orderId: 'PPY21302',
      order_id: 'PPY21302',
      orderNumber: '21302',
      customerName: 'Customer',
      city: 'Jaipur',
      province: 'Rajasthan',
      courier_name: 'Pikndel Express (Jaipur)',
      courierName: 'Pikndel Express (Jaipur)',
      carrier: 'Pikndel Express (Jaipur)',
      logisticsPartner: 'Pikndel',
      trackingNumber: 'TEST123456',
      trackingUrl: 'https://pikndel.com/tracking/TEST123456',
      tracking_link: 'https://pikndel.com/tracking/TEST123456',
      trackingLink: 'https://pikndel.com/tracking/TEST123456',
      order_status: 'IN_TRANSIT',
      orderStatus: 'IN_TRANSIT',
      status: 'IN_TRANSIT',
      delivery_updates: 'Dispatched from warehouse in thermal packaging with gel ice packs.',
      deliveryUpdates: 'Dispatched from warehouse in thermal packaging with gel ice packs.',
      statusText: 'Dispatched from warehouse in thermal packaging with gel ice packs.',
      step: 2,
      rider: null,
      items: ['Chicken Breast 500g (x1)'],
      totalPrice: '₹450',
      financialStatus: 'paid',
      eta: 'Today by evening',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
      }),
    });
  }

  try {
    let orderResult = null;
    let leadData = null;
    let source = null;

    const cleanInput = query.replace(/[\s\-\(\)]/g, '');
    const isPhoneNumber = /^(\+?91)?[6-9]\d{9}$/.test(cleanInput) || (/^\d{10,12}$/.test(cleanInput) && cleanInput.length >= 10);

    // ─── STRATEGY 1: Phone number lookup ───
    if (isPhoneNumber) {
      const cleanPhone = formatPhoneForLookup(cleanInput);

      // Check Shopify for the latest customer order
      try {
        orderResult = await findOrderByPhone(cleanPhone);
        if (orderResult) {
          source = 'shopify-phone';
        }
      } catch (shopErr) {
        console.warn('[Chatbot Lookup] Shopify phone lookup notice:', shopErr.message);
      }

      // Check Redis cache if no direct Shopify order found
      if (!orderResult) {
        try {
          leadData = await getLead(cleanPhone);
          if (leadData && leadData.status === 'CONVERTED') {
            source = 'redis';
            if (leadData.order_id) {
              orderResult = await findOrder(leadData.order_id);
              if (orderResult) source = 'shopify-redis-bridge';
            }
          }
        } catch (redisErr) {
          console.warn('[Chatbot Lookup] Redis notice:', redisErr.message);
        }
      }
    }

    // ─── STRATEGY 2: Order ID lookup (PPY..., #..., or numbers) ───
    if (!orderResult) {
      orderResult = await findOrder(query);
      if (orderResult) {
        source = 'shopify';
      }
    }

    // If still not found and input wasn't strictly identified as phone, try phone lookup as fallback
    if (!orderResult && !isPhoneNumber && /^\d{10}$/.test(cleanInput)) {
      const cleanPhone = formatPhoneForLookup(cleanInput);
      orderResult = await findOrderByPhone(cleanPhone);
      if (orderResult) source = 'shopify-phone-fallback';
    }

    // ─── BUILD ACCURATE RESPONSE ───
    if (orderResult) {
      const city = (orderResult.city || '').toLowerCase().trim();
      const isJaipur = city === 'jaipur';

      // Check fulfillments array for real tracking and carrier
      const fulfillments = orderResult.fulfillments || [];
      const latestFulfillment = fulfillments.length > 0 ? fulfillments[fulfillments.length - 1] : null;

      let carrier = isJaipur ? 'Pikndel Express (Jaipur)' : 'Zippee Express';
      let logisticsPartner = isJaipur ? 'Pikndel' : 'Zippee';
      let trackingNumber = null;
      let trackingUrl = null;

      if (latestFulfillment) {
        const company = (latestFulfillment.trackingCompany || '').toLowerCase();
        if (company.includes('pikndel')) {
          carrier = 'Pikndel Express (Jaipur)';
          logisticsPartner = 'Pikndel';
        } else if (company.includes('zippee')) {
          carrier = 'Zippee Express';
          logisticsPartner = 'Zippee';
        } else if (latestFulfillment.trackingCompany) {
          carrier = latestFulfillment.trackingCompany.replace(/\s*\(cold-chain\)/i, '').trim();
        }

        trackingNumber = latestFulfillment.trackingNumber || null;
        if (latestFulfillment.trackingUrl) {
          trackingUrl = latestFulfillment.trackingUrl;
        } else if (trackingNumber) {
          if (logisticsPartner === 'Pikndel') {
            trackingUrl = `https://pikndel.com/tracking/${trackingNumber}`;
          } else {
            trackingUrl = `https://zippee.delivery`;
          }
        }
      }

      // Check Redis for live rider updates (e.g. from Pikndel or Zippee webhooks)
      let rider = null;
      try {
        const cachedOrder = await getOrder(orderResult.orderId) || await getOrder(orderResult.orderNumber);
        if (cachedOrder && (cachedOrder.riderName || cachedOrder.rider_name)) {
          rider = {
            name: cachedOrder.riderName || cachedOrder.rider_name,
            phone: cachedOrder.riderPhone || cachedOrder.rider_phone || null
          };
        }
      } catch (_) {}

      // Calculate Status, Step, and StatusText accurately
      let status = 'CONFIRMED';
      let statusText = 'Order confirmed and being prepared at our facility.';
      let step = 1;
      let eta = isJaipur ? 'Today (if ordered before 2 PM)' : 'Within 1-2 days';

      if (orderResult.cancelledAt) {
        status = 'CANCELLED';
        statusText = `This order was cancelled.${orderResult.cancelReason ? ` Reason: ${orderResult.cancelReason}` : ''}`;
        step = 0;
        eta = 'Cancelled';
      } else if (latestFulfillment) {
        const shipmentStatus = (latestFulfillment.shipmentStatus || '').toLowerCase();
        const fStatus = (latestFulfillment.status || '').toLowerCase();

        if (shipmentStatus === 'delivered' || fStatus === 'delivered') {
          status = 'DELIVERED';
          statusText = 'Your order has been delivered! Enjoy your meal.';
          step = 4;
          eta = 'Delivered';
        } else if (shipmentStatus === 'out_for_delivery' || shipmentStatus === 'ofd') {
          status = 'OUT_FOR_DELIVERY';
          statusText = 'Out for delivery! Your delivery rider is on the way.';
          step = 3;
          eta = isJaipur ? 'Today within 45 minutes' : 'Today';
        } else if (shipmentStatus === 'in_transit' || shipmentStatus === 'confirmed' || fStatus === 'success') {
          status = 'IN_TRANSIT';
          statusText = 'Dispatched from warehouse in thermal packaging with gel ice packs.';
          step = 2;
          eta = isJaipur ? 'Today by evening' : 'Within 1 day';
        }
      } else if (orderResult.fulfillmentStatus === 'fulfilled') {
        status = 'IN_TRANSIT';
        statusText = 'Order fulfilled and handed over to logistics.';
        step = 2;
        eta = isJaipur ? 'Today' : 'Within 1 day';
      } else {
        // Query EasyEcom for granular warehouse fulfillment status (packing/manifested/allocated)
        try {
          const eeOrder = await getEasyEcomOrder(orderResult.orderId);
          if (eeOrder) {
            const eeStatus = (eeOrder.status || '').toLowerCase();
            if (eeStatus.includes('manifest') || eeStatus.includes('ready to dispatch')) {
              status = 'IN_TRANSIT';
              statusText = `Packed at ${eeOrder.warehouse || 'warehouse'}. Awaiting courier pickup.`;
              step = 2;
            } else if (eeStatus.includes('pack')) {
              statusText = `Currently being packed in thermal insulation at ${eeOrder.warehouse || 'facility'}.`;
              step = 2;
            } else if (eeStatus.includes('open') || eeStatus.includes('allocated')) {
              statusText = `Order confirmed and allocated to ${eeOrder.warehouse || 'fulfillment warehouse'}.`;
            }
            if (eeOrder.awbNumber && !trackingNumber) {
              trackingNumber = eeOrder.awbNumber;
              if (eeOrder.trackingUrl) trackingUrl = eeOrder.trackingUrl;
            }
          }
        } catch (_) {}
      }

      const itemsList = (orderResult.items || []).map(i => `${i.title} (x${i.quantity})`);

      const trackingLinkVal = trackingUrl || (trackingNumber ? (logisticsPartner === 'Pikndel' ? `https://pikndel.com/tracking/${trackingNumber}` : 'https://zippee.delivery') : 'Tracking link will be updated once dispatched');

      return res.status(200).json({
        found: true,
        source,
        orderId: orderResult.orderId,
        order_id: orderResult.orderId,
        orderNumber: orderResult.orderNumber,
        customerName: orderResult.customerName,
        city: orderResult.city,
        province: orderResult.province,
        // Courier & Tracking aliases
        carrier,
        courier_name: carrier,
        courierName: carrier,
        logisticsPartner,
        trackingNumber,
        trackingUrl,
        tracking_link: trackingLinkVal,
        trackingLink: trackingLinkVal,
        // Status & Delivery Updates aliases
        status,
        order_status: status,
        orderStatus: status,
        statusText,
        delivery_updates: statusText,
        deliveryUpdates: statusText,
        step,
        rider,
        items: itemsList,
        totalPrice: orderResult.totalPrice ? `₹${parseFloat(orderResult.totalPrice).toFixed(0)}` : null,
        financialStatus: orderResult.financialStatus,
        eta,
        createdAt: orderResult.createdAt,
        updatedAt: new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          day: '2-digit',
          month: 'short',
        }),
      });
    }

    if (leadData) {
      const leadStatus = leadData.status === 'CONVERTED' ? 'CONFIRMED' : 'PROCESSING';
      const leadStatusText = leadData.status === 'CONVERTED'
        ? 'Your order is confirmed and being prepared!'
        : 'We found your details. Please complete checkout to place your order.';

      return res.status(200).json({
        found: true,
        source: 'redis',
        orderId: leadData.order_id || 'Processing',
        order_id: leadData.order_id || 'Processing',
        customerName: leadData.name || 'Customer',
        city: leadData.city || '',
        carrier: 'Protein Pantry Logistics',
        courier_name: 'Protein Pantry Logistics',
        courierName: 'Protein Pantry Logistics',
        logisticsPartner: 'Protein Pantry',
        status: leadStatus,
        order_status: leadStatus,
        orderStatus: leadStatus,
        statusText: leadStatusText,
        delivery_updates: leadStatusText,
        deliveryUpdates: leadStatusText,
        tracking_link: 'Tracking link will be generated once dispatched',
        trackingLink: 'Tracking link will be generated once dispatched',
        trackingUrl: null,
        step: 1,
        rider: null,
        eta: 'Processing',
        items: [],
        updatedAt: null,
      });
    }

    // ─── NOT FOUND ───
    const notFoundMsg = `No order found for "${query}". Please check your Order ID or mobile number.`;
    return res.status(200).json({
      found: false,
      order_status: 'Not Found',
      orderStatus: 'Not Found',
      status: 'NOT_FOUND',
      courier_name: 'N/A',
      courierName: 'N/A',
      carrier: 'N/A',
      tracking_link: 'N/A',
      trackingLink: 'N/A',
      trackingUrl: null,
      delivery_updates: notFoundMsg,
      deliveryUpdates: notFoundMsg,
      statusText: notFoundMsg,
      message: notFoundMsg,
      query,
    });

  } catch (error) {
    console.error('[Chatbot Lookup Error]:', error.message);
    const errMsg = 'Error looking up order details. Please contact customer support.';
    return res.status(500).json({
      found: false,
      order_status: 'Error',
      orderStatus: 'Error',
      status: 'ERROR',
      courier_name: 'N/A',
      courierName: 'N/A',
      tracking_link: 'N/A',
      trackingLink: 'N/A',
      delivery_updates: errMsg,
      deliveryUpdates: errMsg,
      statusText: errMsg,
      error: 'Internal error while looking up order details.',
    });
  }
};

/**
 * Normalize phone number to +91XXXXXXXXXX format
 */
function formatPhoneForLookup(phone) {
  let cleaned = String(phone).replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.startsWith('+')) return cleaned;
  return `+91${cleaned}`;
}
