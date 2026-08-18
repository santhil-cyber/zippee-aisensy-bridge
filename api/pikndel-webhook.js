const axios = require('axios');
const crypto = require('crypto');
const { getOrder } = require('./lib/db');
const { findOrder } = require('./lib/shopify');

/**
 * Pikndel Logistics → AiSensy WhatsApp Delivery Tracking Webhook Bridge
 * ----------------------------------------------------------------------
 * Endpoint: POST /api/pikndel-webhook
 * 
 * Handles real-time status pushes from Pikndel (Jaipur deliveries)
 * and sends live WhatsApp notifications to customers via AiSensy.
 * 
 * Sample Pikndel Webhook Payload:
 * {
 *   "ClientUniqueNo": "PPY18583",
 *   "AWB": "PAXXXXXXX",
 *   "OrderStatus": "OFD",
 *   "Message": "OUT FOR DELIVERY",
 *   "Time": "2026-08-18 10:42:57",
 *   "ReasonCode": "",
 *   "Reason": "",
 *   "OrderDate": "2026-08-17 10:37:47",
 *   "ExpectedDeliveryDate": "2026-08-18 23:59:59",
 *   "ReportingAddress": "",
 *   "ReportingLat": "0.0000000",
 *   "ReportingLng": "0.0000000",
 *   "DeliveryCode": "8982",
 *   "DeliveredByOtp": "",
 *   "CancelledByOtp": "",
 *   "ReportingCity": "Jaipur",
 *   "RescheduleDate": "",
 *   "FE": {
 *     "Name": "Rohit",
 *     "Mobile": 8700049068
 *   }
 * }
 * 
 * Tracking Link format: https://pikndel.com/tracking/{PIKNDEL_AWB_NO}
 */

function formatPhoneNumber(phone) {
    if (!phone) return null;
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
    if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
    if (cleaned.length === 10) return `+91${cleaned}`;
    return null;
}

// Map Pikndel status codes / messages to customer-friendly WhatsApp messages
function mapPikndelStatus(statusCode, message) {
    const code = String(statusCode || '').toUpperCase().trim();
    const msg = String(message || '').toUpperCase().trim();

    // 1. Out for delivery
    if (code === 'OFD' || msg.includes('OUT FOR DELIVERY') || msg.includes('OUT_FOR_DELIVERY')) {
        return {
            status: 'OUT_FOR_DELIVERY',
            text: 'is out for delivery! Your rider is on the way 🚚',
            isMilestone: true
        };
    }

    // 2. Delivered
    if (code === 'DELIVERED' || code === 'DLV' || code === 'DEL' || msg.includes('DELIVERED')) {
        return {
            status: 'DELIVERED',
            text: 'has been delivered successfully! 🎉',
            isMilestone: true
        };
    }

    // 3. Picked up / In Transit / Dispatched
    if (code === 'PICKED_UP' || code === 'PICKUP_COMPLETED' || code === 'DISPATCHED' || code === 'IN_TRANSIT' || code === 'IT' || code === 'RAD' || msg.includes('PICKED UP') || msg.includes('DISPATCHED')) {
        return {
            status: 'PICKUP_COMPLETED',
            text: 'has been picked up and is being prepared for delivery! 📦',
            isMilestone: true
        };
    }

    // 4. Undelivered / Delivery Attempted / NDR
    if (code === 'UNDELIVERED' || code === 'DELIVERY_ATTEMPTED' || code === 'NDR' || code === 'FAILED' || msg.includes('ATTEMPTED') || msg.includes('UNDELIVERED')) {
        return {
            status: 'DELIVERY_ATTEMPTED',
            text: 'delivery was attempted but couldn\'t be completed. Our team will try again soon 🔔',
            isMilestone: true
        };
    }

    // 5. Cancelled
    if (code === 'CANCELLED' || code === 'CAN' || code === 'CANCEL' || msg.includes('CANCEL')) {
        return {
            status: 'CANCELLED',
            text: 'has been cancelled. Please reach out to us for any queries ❌',
            isMilestone: true
        };
    }

    // 6. RTO / Returned
    if (code === 'RTO' || code === 'RETURN' || code === 'RETURNED' || msg.includes('RETURN')) {
        return {
            status: 'RTO',
            text: 'could not be delivered and is being returned. Please reach out to us for assistance 🔄',
            isMilestone: true
        };
    }

    // 7. Partially Delivered
    if (code === 'PARTIALLY_DELIVERED' || msg.includes('PARTIAL')) {
        return {
            status: 'PARTIALLY_DELIVERED',
            text: 'has been partially delivered. Some items could not be delivered 📋',
            isMilestone: true
        };
    }

    // Non-milestone or internal state (e.g. Allocation Pending, Order Created)
    return {
        status: code || 'UNKNOWN',
        text: null,
        isMilestone: false
    };
}

module.exports = async (req, res) => {
    // 1. Handle non-POST requests (Health Check / Browser Ping)
    if (req.method !== 'POST') {
        return res.status(200).send('Pikndel Bridge is active! Waiting for Pikndel webhook data...');
    }

    const requestId = crypto.randomUUID();
    console.log(`--- PIKNDEL WEBHOOK RECEIVED [${requestId}] ---`);
    console.log(JSON.stringify(req.body, null, 2));

    try {
        const body = req.body || {};

        // 2. Extract fields from Pikndel payload
        const awbNumber = body.AWB || body.awb || body.awb_number;
        const orderCode = body.ClientUniqueNo || body.client_unique_no || body.order_id || body.order_code || body.order_number;
        const orderStatus = body.OrderStatus || body.order_status || body.status;
        const message = body.Message || body.message || '';
        const deliveryCode = body.DeliveryCode || body.delivery_code || '';
        const riderName = body.FE?.Name || body.fe?.name || body.rider_name || '';
        const riderPhone = body.FE?.Mobile || body.fe?.mobile || body.rider_phone || '';
        const city = body.ReportingCity || body.reporting_city || body.city || 'Jaipur';

        if (!awbNumber) {
            console.error(`[${requestId}] Error: Missing AWB number in Pikndel webhook.`);
            return res.status(400).json({ error: 'Missing AWB number', requestId });
        }

        // 3. Map status to milestone WhatsApp message
        const mapped = mapPikndelStatus(orderStatus, message);
        if (!mapped.isMilestone) {
            console.log(`[${requestId}] Skipping non-milestone Pikndel status: "${orderStatus}" / "${message}" for AWB: ${awbNumber}`);
            return res.status(200).json({
                success: true,
                message: 'Status skipped (non-milestone event)',
                shipment_status: orderStatus,
                awb_number: awbNumber,
                order_code: orderCode || null,
                requestId
            });
        }

        // 4. Resolve Customer Phone & Name
        // Step A: Check if customer phone is present directly in webhook payload
        let rawPhone = body.CustomerPhone || body.CustomerMobile || body.customer_phone || body.phone || body.mobile || body.Customer?.Phone || body.customer?.phone;
        let customerName = body.CustomerName || body.customer_name || body.Customer?.Name || body.customer?.name || '';

        // Step B: If not in payload, look up order in Redis DB cache (cached during Shopify order confirmation)
        if (!rawPhone && orderCode) {
            console.log(`[${requestId}] Looking up customer info from Redis cache for order: ${orderCode}`);
            try {
                const cachedOrder = await getOrder(orderCode);
                if (cachedOrder) {
                    rawPhone = cachedOrder.customerPhone || cachedOrder.customer_phone;
                    if (!customerName) customerName = cachedOrder.customerName || cachedOrder.customer_name;
                    console.log(`[${requestId}] Found order in Redis cache: ${customerName} (${rawPhone})`);
                }
            } catch (cacheErr) {
                console.warn(`[${requestId}] Cache lookup failed:`, cacheErr.message);
            }
        }

        // Step C: If still not found, fetch order directly from Shopify Admin API
        if (!rawPhone && orderCode) {
            console.log(`[${requestId}] Looking up customer info from Shopify API for order: ${orderCode}`);
            try {
                const shopifyOrder = await findOrder(orderCode);
                if (shopifyOrder) {
                    rawPhone = shopifyOrder.customerPhone;
                    if (!customerName) customerName = shopifyOrder.customerName;
                    console.log(`[${requestId}] Found order via Shopify API: ${customerName} (${rawPhone})`);
                }
            } catch (shopifyErr) {
                console.warn(`[${requestId}] Shopify API lookup failed:`, shopifyErr.message);
            }
        }

        // Validate customer phone
        const formattedPhone = formatPhoneNumber(rawPhone);
        if (!formattedPhone) {
            console.error(`[${requestId}] Error: Could not resolve valid customer phone for AWB: ${awbNumber}, Order: ${orderCode}, Raw: ${rawPhone}`);
            return res.status(400).json({
                error: 'Could not resolve customer phone number for order',
                awb_number: awbNumber,
                order_code: orderCode,
                requestId
            });
        }

        const name = String(customerName || 'Customer');
        const trackingReference = String(orderCode || awbNumber);
        const trackingUrl = `https://pikndel.com/tracking/${awbNumber}`;

        // 5. Prepare AiSensy Delivery Tracking Payload
        const apiKey = process.env.AISENSY_API_KEY
            || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";

        const campaignName = process.env.PIKNDEL_TRACKING_CAMPAIGN || process.env.DELIVERY_TRACKING_CAMPAIGN || "delivery_tracking_v4";

        const aisensyData = {
            apiKey: apiKey,
            campaignName: campaignName,
            destination: formattedPhone,
            userName: name,
            tags: ['Logistics_Pikndel', `Pikndel_${mapped.status}`],
            attributes: {
                Logistics_Partner: 'Pikndel',
                AWB_Number: String(awbNumber),
                Order_ID: trackingReference,
                Tracking_URL: trackingUrl,
                City: String(city),
                Rider_Name: String(riderName),
                Rider_Phone: String(riderPhone),
                Delivery_OTP: String(deliveryCode)
            },
            templateParams: [
                String(name),                          // Body {{1}} - Customer Name
                String(trackingReference),              // Body {{2}} - Order Number / ID
                String(mapped.text),                   // Body {{3}} - Status Text (e.g. out for delivery)
                String(awbNumber)                       // Button URL {{1}} - Pikndel AWB for tracking link
            ]
        };

        console.log(`[${requestId}] === PIKNDEL AISENSY PAYLOAD ===`);
        console.log(JSON.stringify(aisensyData, null, 2));
        console.log(`[${requestId}] Sending to ${formattedPhone}: AWB ${awbNumber} (Order: ${trackingReference}) → ${mapped.status} for ${name} [Pikndel Jaipur]`);

        // 6. Fire to AiSensy
        const response = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyData);
        console.log(`[${requestId}] AiSensy Response:`, response.data);

        return res.status(200).json({
            success: true,
            message: 'Pikndel tracking WhatsApp message queued successfully',
            logistics: 'Pikndel',
            shipment_status: mapped.status,
            awb_number: awbNumber,
            order_code: orderCode || null,
            tracking_url: trackingUrl,
            customer_phone: formattedPhone,
            requestId
        });

    } catch (error) {
        console.error(`[${requestId}] Pikndel Bridge Error:`, error.response?.data || error.message);
        return res.status(500).json({
            error: 'Failed to process Pikndel webhook',
            details: error.response?.data || error.message,
            requestId
        });
    }
};
