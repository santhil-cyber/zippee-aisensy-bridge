/**
 * EasyEcom API Integration Module
 * ================================
 * Provides live warehouse status, multi-location inventory checks,
 * and carrier tracking lookup via EasyEcom Open API v2/v3.
 */

const axios = require('axios');

const EASYECOM_BASE_URL = 'https://api.easyecom.io';
const EASYECOM_API_KEY = process.env.EASYECOM_API_KEY || '13fd028d3b4fae7b513a64572614180cbbb498fe';
const EASYECOM_JWT_TOKEN = process.env.EASYECOM_JWT_TOKEN || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FwaS5lYXN5ZWNvbS5pby9hY2Nlc3MvdG9rZW4iLCJpYXQiOjE3OTA3NTQ0OTQsImV4cCI6MTc5ODYzODQ5NCwibmJmIjoxNzkwNzU0NDk0LCJqdGkiOiIyaVVCdmxZMXRmY3c1ZzRvIiwic3ViIjoiMzE5NzkxIiwicHJ2IjoiYTg0ZGVmNjRhZDAxMTVkNWVjY2MxZjg4NDViY2QwZTdmZTZjNGI2MCIsInVzZXJfaWQiOjMxOTc5MSwiY29tcGFueV9pZCI6Mjg1MTA2LCJyb2xlX3R5cGVfaWQiOjIsInBpaV9hY2Nlc3MiOjEsInBpaV9yZXBvcnRfYWNjZXNzIjoxLCJyb2xlcyI6bnVsbCwiY19pZCI6Mjg1MTA2LCJ1X2lkIjozMTk3OTEsImxvY2F0aW9uX3JlcXVlc3RlZF9mb3IiOjI4NTEwNn0.Tq_B-BgjXBcT0VciecYMiSvkddOdirtjxgWe2x4iCyg';

function getHeaders() {
  return {
    'x-api-key': EASYECOM_API_KEY,
    'Authorization': `Bearer ${EASYECOM_JWT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch granular warehouse order status by reference code (e.g. PPY25671, PPY18583)
 * @param {string} orderReference - Order ID / Reference Code
 * @returns {Promise<object|null>}
 */
async function getEasyEcomOrder(orderReference) {
  if (!EASYECOM_API_KEY || !EASYECOM_JWT_TOKEN || !orderReference) return null;

  try {
    const cleanRef = String(orderReference).trim().replace(/^#/, '');
    const url = `${EASYECOM_BASE_URL}/orders/V2/getAllOrders?reference_code=${encodeURIComponent(cleanRef)}`;

    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 5000,
    });

    const orders = response.data?.data?.orders || [];
    if (orders.length === 0) return null;

    const order = orders[0];
    return {
      orderId: order.order_id,
      referenceCode: order.reference_code,
      status: order.order_status,
      statusId: order.order_status_id,
      warehouse: order.warehouse_name,
      courierName: order.courier_name,
      awbNumber: order.awb_number,
      trackingUrl: order.tracking_url,
      orderType: order.order_type,
      invoiceNumber: order.invoice_number,
    };
  } catch (error) {
    console.warn(`[EasyEcom getOrder notice for ${orderReference}]:`, error.response?.data?.message || error.message);
    return null;
  }
}

/**
 * Check stock availability for a product / SKU across all warehouse locations
 * @param {string} sku
 * @returns {Promise<{available: boolean, totalQuantity: number, locations: Array}>}
 */
async function getEasyEcomInventory(sku) {
  if (!EASYECOM_API_KEY || !EASYECOM_JWT_TOKEN || !sku) {
    return { available: true, totalQuantity: 99, locations: [] };
  }

  try {
    const url = `${EASYECOM_BASE_URL}/getInventoryDetailsV3?limit=50&sku=${encodeURIComponent(sku)}`;
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 5000,
    });

    const inventoryData = response.data?.data?.inventoryData || {};
    const items = inventoryData[sku] || [];

    let totalQty = 0;
    const locations = items.map(item => {
      const qty = parseInt(item.availableInventory || 0, 10);
      totalQty += qty;
      return {
        company: item.companyName,
        locationKey: item.location_key,
        available: qty,
      };
    });

    return {
      available: totalQty > 0,
      totalQuantity: totalQty,
      locations,
    };
  } catch (error) {
    console.warn(`[EasyEcom Inventory notice for ${sku}]:`, error.message);
    return { available: true, totalQuantity: 99, locations: [] };
  }
}

/**
 * Fetch all registered warehouse locations
 */
async function getEasyEcomLocations() {
  try {
    const url = `${EASYECOM_BASE_URL}/account/v1/api/locations`;
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 5000,
    });
    return response.data?.data || [];
  } catch (error) {
    console.warn('[EasyEcom Locations notice]:', error.message);
    return [];
  }
}

module.exports = {
  getEasyEcomOrder,
  getEasyEcomInventory,
  getEasyEcomLocations,
};
