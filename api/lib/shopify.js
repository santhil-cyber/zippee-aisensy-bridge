/**
 * Shopify Admin API Helper
 * ------------------------
 * Checks if a customer with a given phone number or email has placed an order in Shopify.
 */

const axios = require('axios');

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '0nb9nh-8p.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

/**
 * Check if a customer has placed an order since the given date
 * @param {string} phone - Customer phone (+91...)
 * @param {string} email - Customer email
 * @param {string} sinceDate - ISO Date string
 * @returns {Promise<boolean>} - true if order exists, false otherwise
 */
async function hasPlacedOrder(phone, email, sinceDate) {
  if (!SHOPIFY_ADMIN_TOKEN) {
    console.warn('[Shopify API] No SHOPIFY_ADMIN_TOKEN configured. Skipping live Shopify check.');
    return false;
  }

  try {
    // 1. Search customer by phone (or email)
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    const phoneQuery = cleanPhone.slice(-10); // last 10 digits

    let query = '';
    if (phoneQuery) {
      query = `phone:*${phoneQuery}*`;
    } else if (email) {
      query = `email:${email}`;
    }

    if (!query) return false;

    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&query=${encodeURIComponent(query)}&limit=5`;

    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });

    const orders = response.data?.orders || [];

    if (orders.length === 0) {
      return false;
    }

    // If sinceDate is provided, check if any order was placed after that date
    if (sinceDate) {
      const targetTime = new Date(sinceDate).getTime();
      const hasRecentOrder = orders.some(o => new Date(o.created_at).getTime() >= targetTime);
      return hasRecentOrder;
    }

    // Any order placed counts as conversion
    return orders.length > 0;

  } catch (error) {
    console.error(`[Shopify API Check Error for ${phone}]:`, error.response?.data || error.message);
    return false;
  }
}

/**
 * Fetch customer name and phone for a given order identifier (e.g. #1042, 1042, PPY18583)
 * @param {string} orderIdentifier 
 * @returns {Promise<{orderId: string, customerName: string, customerPhone: string, city: string}|null>}
 */
async function findOrder(orderIdentifier) {
  if (!SHOPIFY_ADMIN_TOKEN || !orderIdentifier) {
    return null;
  }

  try {
    const cleanId = String(orderIdentifier).trim();
    const cleanNoHash = cleanId.replace(/^#/, '');

    // 1. Try querying by order name
    let url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&name=${encodeURIComponent(cleanId)}&limit=1`;
    let response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 6000,
    });

    let orders = response.data?.orders || [];

    // 2. If not found, try search query
    if (orders.length === 0 && cleanNoHash) {
      const searchUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&query=name:${encodeURIComponent(cleanNoHash)}&limit=1`;
      const searchRes = await axios.get(searchUrl, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 6000,
      });
      orders = searchRes.data?.orders || [];
    }

    // 3. If still not found and cleanId is numeric, try order ID directly
    if (orders.length === 0 && /^\d+$/.test(cleanId)) {
      try {
        const idUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders/${cleanId}.json`;
        const idRes = await axios.get(idUrl, {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json',
          },
          timeout: 6000,
        });
        if (idRes.data?.order) {
          orders = [idRes.data.order];
        }
      } catch (_) {}
    }

    if (orders.length > 0) {
      const order = orders[0];
      const customer = order.customer || {};
      const shipping = order.shipping_address || order.billing_address || {};
      const firstName = customer.first_name || shipping.first_name || 'Customer';
      const rawPhone = shipping.phone || customer.phone || customer.default_address?.phone || order.phone;
      const city = shipping.city || customer.default_address?.city || '';

      return {
        orderId: order.name || `#${order.order_number}` || String(order.id),
        orderNumber: String(order.order_number || ''),
        customerName: firstName,
        customerPhone: rawPhone,
        city: city,
      };
    }

    return null;
  } catch (error) {
    console.error(`[Shopify Find Order Error for ${orderIdentifier}]:`, error.response?.data || error.message);
    return null;
  }
}

module.exports = {
  hasPlacedOrder,
  findOrder,
};

