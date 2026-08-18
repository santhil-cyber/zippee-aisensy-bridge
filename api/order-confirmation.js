const axios = require('axios');
const crypto = require('crypto');
const { saveOrder } = require('./lib/db');

/**
 * Shopify / Shopflo → AiSensy Order Confirmation Webhook
 * 
 * Template message (order_confirmation_v4):
 *   Hi {{1}}, your order is confirmed! 🎉
 *   Your order ID is {{2}}. You will receive a tracking message from our
 *   logistics partner {{3}} once your order is dispatched.
 *   Your order will be delivered within {{4}}.
 *   ~Team Protein Pantry
 * 
 * Params:
 *   {{1}} = Customer First Name
 *   {{2}} = Order ID / Order Name (e.g. PPY18583)
 *   {{3}} = Logistics Partner (Pikndel for Jaipur, Zippee for others)
 *   {{4}} = Delivery timeframe (e.g. "1-2 days")
 * 
 * Shopify webhook topic: orders/create
 * Endpoint: POST /api/order-confirmation
 */

// City-based logistics partner and delivery timeframe
// Jaipur → Pikndel | All others → Zippee
function isJaipur(city) {
    if (!city) return false;
    return city.toLowerCase().trim() === 'jaipur';
}

function getLogisticsPartner(city) {
    return isJaipur(city) ? 'Pikndel' : 'Zippee';
}

function getDeliveryTime(city) {
    return '1-2 days';
}

module.exports = async (req, res) => {
    // Handle non-POST requests (health check)
    if (req.method !== 'POST') {
        return res.status(200).send('Order Confirmation webhook is active! Waiting for Shopify data...');
    }

    const requestId = crypto.randomUUID();
    console.log(`--- ORDER CONFIRMATION WEBHOOK RECEIVED [${requestId}] ---`);
    console.log(JSON.stringify(req.body, null, 2));

    try {
        const order = req.body || {};

        // ─── Extract fields from Shopify order payload ───────────────
        // Shopify sends: customer, shipping_address, order_number, name, phone, etc.
        const customer = order.customer || {};
        const shippingAddress = order.shipping_address || order.billing_address || {};

        // Customer name: try first_name from customer, then shipping address, fallback
        const firstName = customer.first_name
            || shippingAddress.first_name
            || order.contact_email?.split('@')[0]
            || 'Customer';

        // Order ID: Shopify "name" field gives "#1042" format, order_number gives 1042
        const orderId = order.name || `#${order.order_number}` || order.id?.toString() || 'N/A';

        // City from shipping address (used for cutoff time)
        const city = shippingAddress.city || '';

        // Phone: try shipping address phone, then customer phone, then order phone
        const rawPhone = shippingAddress.phone
            || customer.phone
            || customer.default_address?.phone
            || order.phone;

        // ─── Validate required fields ────────────────────────────────
        if (!rawPhone) {
            console.error(`[${requestId}] Error: No phone number found. Order: ${orderId}`);
            console.error(`[${requestId}] Available keys - order: ${Object.keys(order).join(', ')}`);
            console.error(`[${requestId}] customer keys: ${Object.keys(customer).join(', ')}`);
            console.error(`[${requestId}] shipping keys: ${Object.keys(shippingAddress).join(', ')}`);
            return res.status(400).json({
                error: 'No phone number found in order data',
                order_id: orderId,
                requestId
            });
        }

        // ─── Format phone number (+91 India) ────────────────────────
        let formattedPhone = rawPhone.toString().replace(/\D/g, '');

        // Remove leading 0
        if (formattedPhone.startsWith('0')) {
            formattedPhone = formattedPhone.slice(1);
        }

        // Handle numbers that already include country code 91
        if (formattedPhone.length === 12 && formattedPhone.startsWith('91')) {
            formattedPhone = formattedPhone.slice(2);
        }

        if (formattedPhone.length !== 10) {
            console.error(`[${requestId}] Invalid phone: raw="${rawPhone}" cleaned="${formattedPhone}"`);
            return res.status(400).json({
                error: 'Invalid phone number format',
                received: rawPhone,
                requestId
            });
        }

        formattedPhone = `+91${formattedPhone}`;

        // ─── Cache Order in DB for Logistics Webhook Lookup ─────────
        try {
            await saveOrder({
                orderId: order.name || orderId,
                orderNumber: order.order_number,
                shopifyId: order.id,
                customerName: firstName,
                customerPhone: formattedPhone,
                city: city
            });
        } catch (dbErr) {
            console.warn(`[${requestId}] Non-critical: Failed to cache order in DB:`, dbErr.message);
        }

        // ─── Prepare AiSensy payload ─────────────────────────────────
        const name = String(firstName);
        const logisticsPartner = getLogisticsPartner(city);
        const deliveryTime = getDeliveryTime(city);


        const apiKey = process.env.AISENSY_API_KEY
            || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";

        // IMPORTANT: Change "order_confirmation_v4" to match the EXACT campaign name
        // you create in AiSensy Dashboard
        const campaignName = process.env.ORDER_CONFIRM_CAMPAIGN || "order_confirmation_v4";

        const aisensyData = {
            apiKey: apiKey,
            campaignName: campaignName,
            destination: formattedPhone,
            userName: name,
            templateParams: [
                String(name),                   // {{1}} - Customer First Name
                String(orderId),                // {{2}} - Order ID (e.g. PPY18583)
                String(logisticsPartner),        // {{3}} - Logistics Partner (Pikndel/Zippee)
                String(deliveryTime)             // {{4}} - Delivery timeframe (e.g. "1-2 days")
            ]
        };

        console.log(`[${requestId}] === ORDER CONFIRMATION PAYLOAD ===`);
        console.log(JSON.stringify(aisensyData, null, 2));
        console.log(`[${requestId}] Sending to ${formattedPhone}: Order ${orderId} for ${name} | City: ${city || 'unknown'} | Partner: ${logisticsPartner} | Delivery: ${deliveryTime}`);

        // ─── Send to AiSensy ─────────────────────────────────────────
        const response = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyData);

        console.log(`[${requestId}] AiSensy Response:`, response.data);
        return res.status(200).json({
            success: true,
            message: 'Order confirmation WhatsApp queued',
            order_id: orderId,
            customer_name: name,
            phone: formattedPhone,
            requestId
        });

    } catch (error) {
        console.error(`[${requestId}] Order Confirmation Error:`, error.response?.data || error.message);
        return res.status(500).json({
            error: 'Failed to send order confirmation via AiSensy',
            details: error.response?.data || error.message,
            requestId
        });
    }
};
