const axios = require('axios');
const crypto = require('crypto');

module.exports = async (req, res) => {
    // 1. Handle non-POST requests
    if (req.method !== 'POST') {
        return res.status(200).send('Bridge is active! Waiting for Zippee data...');
    }

    // Generate a unique request ID for tracing
    const requestId = crypto.randomUUID();

    // Log the incoming data for your Vercel Dashboard
    console.log(`--- ZIPPEE WEBHOOK RECEIVED [${requestId}] ---`);
    console.log(JSON.stringify(req.body, null, 2));

    try {
        // 2. Extract fields from Zippee's actual webhook payload
        //    Ref: https://www.zippee.delivery/api-docs (Webhooks → Shipment Status)
        const body = req.body || {};

        // Zippee sends these top-level fields:
        const customerPhone = body.customer_phone;
        const customerName  = body.customer_name;
        const awbNumber     = body.awb_number;
        const shipmentStatus = body.shipment_status;
        const riderName     = body.rider_name;
        const riderPhone    = body.rider_phone;

        // Extract order_code from the orders array (first order)
        const orderCode = body.orders?.[0]?.order_code;

        // Validate required fields
        if (!customerPhone) {
            console.error(`[${requestId}] Error: Missing customer_phone. Full body keys: ${Object.keys(body).join(', ')}`);
            return res.status(400).json({ error: 'Missing customer_phone', bodyKeys: Object.keys(body), requestId });
        }

        if (!awbNumber) {
            console.error(`[${requestId}] Error: Missing awb_number.`);
            return res.status(400).json({ error: 'Missing awb_number', requestId });
        }

        if (!shipmentStatus) {
            console.error(`[${requestId}] Error: Missing shipment_status.`);
            return res.status(400).json({ error: 'Missing shipment_status', requestId });
        }

        // 3. Only send WhatsApp for important statuses
        //    Zippee status codes: READY, ALLOCATION_PENDING, PICKUP_PENDING,
        //    PICKUP_IN_PROGRESS, PICKUP_COMPLETED, OUT_FOR_DELIVERY, REACHED_GATE,
        //    DELIVERY_IN_PROGRESS, DELIVERY_ATTEMPTED, DELIVERED, CANCELLED, RTO,
        //    OUT_FOR_PICKUP, PICKUP_ATTEMPTED, REACHED_PICKUP, REACHED_DELIVERY,
        //    PARTIALLY_DELIVERED
        const status = shipmentStatus.toUpperCase().trim();

        const importantStatuses = {
            'PICKUP_COMPLETED':    'has been picked up and is being prepared for delivery! 📦',
            'OUT_FOR_DELIVERY':    'is out for delivery! Your rider is on the way 🚚',
            'DELIVERED':           'has been delivered successfully! 🎉',
            'DELIVERY_ATTEMPTED':  'delivery was attempted but couldn\'t be completed. Our team will try again soon 🔔',
            'CANCELLED':           'has been cancelled. Please reach out to us for any queries ❌',
            'RTO':                 'could not be delivered and is being returned. Please reach out to us for assistance 🔄',
            'PARTIALLY_DELIVERED': 'has been partially delivered. Some items could not be delivered 📋',
        };

        if (!importantStatuses[status]) {
            console.log(`[${requestId}] Skipping non-important status: "${status}" for AWB: ${awbNumber}`);
            return res.status(200).json({
                success: true,
                message: 'Status not important enough for WhatsApp notification',
                shipment_status: status,
                awb_number: awbNumber,
                requestId
            });
        }

        const statusText = importantStatuses[status];

        // 4. Clean and Format Phone Number (+91 for India)
        let formattedPhone = customerPhone.toString().replace(/\D/g, '');

        if (formattedPhone.startsWith('0')) {
            formattedPhone = formattedPhone.slice(1);
        }

        // Handle numbers that already have country code
        if (formattedPhone.length === 12 && formattedPhone.startsWith('91')) {
            formattedPhone = formattedPhone.slice(2);
        }

        if (formattedPhone.length !== 10) {
            console.error(`[${requestId}] Invalid phone format: raw="${customerPhone}" cleaned="${formattedPhone}"`);
            return res.status(400).json({
                error: 'Invalid phone number format',
                received: customerPhone,
                requestId
            });
        }

        formattedPhone = `+91${formattedPhone}`;

        // 5. Prepare AiSensy Payload
        const name = String(customerName || 'Customer');
        // Use order_code if available, otherwise fall back to AWB number
        const trackingReference = String(orderCode || awbNumber);

        // Use env var if available, fallback to hardcoded key (temporary)
        const apiKey = process.env.AISENSY_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc3Njc4OTQ4NH0.ABs5XchvFj5U1D4PUvMK2lGvJuOj_c340Bl7oMy-WMc";

        const aisensyData = {
            apiKey: apiKey,
            campaignName: "delivery_tracking",
            destination: formattedPhone,
            userName: name,
            templateParams: [
                name,               // Body {{1}} - Customer Name
                trackingReference,  // Body {{2}} - Order/AWB Number
                statusText,         // Body {{3}} - Status text
                trackingReference   // Button URL {{1}} → ?orderNumber=<ref>
            ]
        };

        console.log(`[${requestId}] Sending to ${formattedPhone}: AWB ${awbNumber} (Order: ${orderCode || 'N/A'}) → ${status} for ${name}`);

        // 6. Fire to AiSensy
        const response = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyData);

        console.log(`[${requestId}] AiSensy Response:`, response.data);
        return res.status(200).json({
            success: true,
            message: 'Message queued',
            shipment_status: status,
            awb_number: awbNumber,
            order_code: orderCode || null,
            requestId
        });

    } catch (error) {
        console.error(`[${requestId}] Bridge Error:`, error.response?.data || error.message);
        return res.status(500).json({
            error: 'Failed to forward to AiSensy',
            details: error.response?.data || error.message,
            requestId
        });
    }
};
