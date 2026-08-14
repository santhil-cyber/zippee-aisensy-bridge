/**
 * Vercel Serverless Function — Shopflo to AiSensy Webhook Bridge
 * -------------------------------------------------------------
 * Endpoint: https://<your-vercel-domain>/api/shopflo-webhook
 */

const axios = require('axios');

const AISENSY_API_KEY = process.env.AISENSY_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";
const AISENSY_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

function formatPhoneNumber(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.length > 10 && phone.toString().startsWith('+')) return phone.toString();
  return null;
}

module.exports = async (req, res) => {
  // Handle GET or Test Pings
  if (req.method === 'GET') {
    return res.status(200).send('Shopflo AiSensy Webhook is Live!');
  }

  const body = req.body || {};
  console.log('[Shopflo Webhook] Received:', JSON.stringify(body));

  // Handle Shopflo Dashboard Test Ping
  if (body.type === 'test' || body.test === true || Object.keys(body).length === 0) {
    return res.status(200).json({ success: true, message: 'Shopflo Webhook connection verified successfully!' });
  }

  try {
    const eventType = String(body.event || body.type || body.event_type || 'checkout_abandoned').toLowerCase();
    const customer = body.customer || body.customer_details || body.user || {};
    const shipping = body.shipping_address || body.shippingAddress || {};
    
    const rawPhone = body.phone || customer.phone || shipping.phone || body.customer_phone || '';
    const phone = formatPhoneNumber(rawPhone);
    const name = customer.name || (customer.first_name ? `${customer.first_name} ${customer.last_name || ''}`.trim() : '') || 'Customer';
    const email = customer.email || body.email || '';
    const city = shipping.city || customer.city || '';

    if (!phone) {
      return res.status(200).json({ success: true, message: 'No phone number in payload' });
    }

    // 1. Order Completed / Buyer -> Suppress from Retargeting
    if (eventType.includes('order_completed') || eventType.includes('payment_completed')) {
      await axios.post(AISENSY_URL, {
        apiKey: AISENSY_API_KEY,
        campaignName: 'shopflo_conversion_sync',
        destination: phone,
        userName: name,
        tags: ['Customer_Converted'],
        attributes: { Last_Order_Date: new Date().toISOString(), City: city, Email: email }
      }).catch(err => console.log('AiSensy tag sync notice:', err.response?.data || err.message));

      return res.status(200).json({ success: true, status: 'customer_marked_as_converted' });
    }

    // 2. Abandoned Cart / Checkout -> Sync to AiSensy with Retargeting Tag
    const rawItems = body.items || body.cart?.items || body.line_items || [];
    const items = Array.isArray(rawItems) ? rawItems.map(i => i.title || i.name || 'Product').slice(0, 3).join(', ') : '';
    const checkoutUrl = body.checkout_url || body.checkoutUrl || 'https://proteinpantry.in';

    await axios.post(AISENSY_URL, {
      apiKey: AISENSY_API_KEY,
      campaignName: 'shopflo_abandoned_cart',
      destination: phone,
      userName: name,
      tags: ['ShopPass_Cart_Abandon', '2Week_Retargeting'],
      attributes: {
        Cart_Items: items || 'Protein Pantry Items',
        Checkout_URL: checkoutUrl,
        City: city,
        Email: email
      },
      templateParams: [String(name), String(items || 'your selected items'), String(checkoutUrl)]
    }).catch(err => console.log('AiSensy sync notice:', err.response?.data || err.message));

    return res.status(200).json({ success: true, message: 'Cart abandonment captured and synced to AiSensy' });

  } catch (error) {
    console.error('[Shopflo Webhook Error]:', error);
    return res.status(500).json({ error: error.message });
  }
};
