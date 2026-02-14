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
        // 2. Extract fields from this specific request
        const body = req.body || {};
        const phoneNumber = body.phoneNumber;
        const customerName = body.customerName;
        const orderNo = body.orderNo;
        const orderStatus = body.orderStatus;           // e.g. "DELIVERED"
        const notificationType = body.notificationType; // e.g. "DELIVEREDNOTIFICATION"

        // Validate required fields
        if (!phoneNumber) {
            console.error(`[${requestId}] Error: Missing phoneNumber.`);
            return res.status(400).json({ error: 'Missing phoneNumber', requestId });
        }

        if (!orderNo) {
            console.error(`[${requestId}] Error: Missing orderNo.`);
            return res.status(400).json({ error: 'Missing orderNo', requestId });
        }

        // 3. Normalize status from orderStatus or notificationType
        const normalizedStatus = normalizeStatus(orderStatus, notificationType);

        // 4. Only send WhatsApp for important statuses
        const importantStatuses = {
            'shipped': 'has been shipped! It\'s on its way to you 🚚',
            'out_for_delivery': 'is out for delivery! You\'ll receive it very soon 🛵',
            'delivered': 'has been delivered successfully! 🎉',
            'cancelled': 'has been cancelled. Please reach out to us for any queries ❌',
            'rto': 'is being returned to the seller 🔄',
        };

        if (!importantStatuses[normalizedStatus]) {
            console.log(`[${requestId}] Skipping non-important status: "${normalizedStatus}" (orderStatus="${orderStatus}", notificationType="${notificationType}")`);
            return res.status(200).json({
                success: true,
                message: 'Status not important enough for WhatsApp notification',
                status: normalizedStatus,
                requestId
            });
        }

        const statusText = importantStatuses[normalizedStatus];

        // 5. Clean and Format Phone Number (+91 for India)
        let formattedPhone = phoneNumber.toString().replace(/\D/g, '');

        if (formattedPhone.startsWith('0')) {
            formattedPhone = formattedPhone.slice(1);
        }

        if (formattedPhone.length === 12 && formattedPhone.startsWith('91')) {
            formattedPhone = formattedPhone.slice(2);
        }

        if (formattedPhone.length !== 10) {
            console.error(`[${requestId}] Invalid phone format: raw="${phoneNumber}" cleaned="${formattedPhone}"`);
            return res.status(400).json({
                error: 'Invalid phone number format',
                received: phoneNumber,
                requestId
            });
        }

        formattedPhone = `+91${formattedPhone}`;

        // 6. Prepare AiSensy Payload
        // Template: Hey {{1}} 👋
        //           Your order *{{2}}* {{3}}.
        //           Track your order here or contact us for any queries...
        //           Thank you for shopping with Protein Pantry!
        // Button URL: https://www.zippee.delivery/track-order?orderNumber={{1}}
        const name = String(customerName || 'Customer');
        const orderNumber = String(orderNo);

        const aisensyData = {
            apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc2NjAzOTQ1OH0.OO4Yoj-800AudUM1B8i9IJ78BK_TepVqnmkdPDVuqTM",
            campaignName: "delivery_tracking",
            destination: formattedPhone,
            userName: name,
            templateParams: [
                name,           // Body {{1}} - Customer Name
                orderNumber,    // Body {{2}} - Order Number
                statusText,     // Body {{3}} - Status text (e.g. "has been shipped!")
                orderNumber     // Button URL {{1}} → ?orderNumber=<orderNo>
            ]
        };

        console.log(`[${requestId}] Sending to ${formattedPhone}: Order ${orderNumber} ${statusText} for ${name}`);

        // 7. Fire to AiSensy
        const response = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyData);

        console.log(`[${requestId}] AiSensy Response:`, response.data);
        return res.status(200).json({
            success: true,
            message: 'Message queued',
            status: normalizedStatus,
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

/**
 * Normalize Zippee's orderStatus and notificationType into a consistent key.
 * Zippee sends statuses like "DELIVERED" and notification types like "DELIVEREDNOTIFICATION".
 */
function normalizeStatus(orderStatus, notificationType) {
    const raw = (orderStatus || '').toString().toUpperCase().trim();
    const notif = (notificationType || '').toString().toUpperCase().trim();

    // Map from Zippee's values to our normalized keys
    const statusMap = {
        // orderStatus values
        'SHIPPED': 'shipped',
        'INTRANSIT': 'in_transit',
        'IN_TRANSIT': 'in_transit',
        'OUTFORDELIVERY': 'out_for_delivery',
        'OUT_FOR_DELIVERY': 'out_for_delivery',
        'DELIVERED': 'delivered',
        'CANCELLED': 'cancelled',
        'CANCELED': 'cancelled',
        'RTO': 'rto',
        'RETURNED': 'rto',
        'CREATED': 'created',
        'CONFIRMED': 'confirmed',
        'PROCESSING': 'processing',
        'READY_TO_SHIP': 'ready_to_ship',
    };

    // notificationType values (e.g. "DELIVEREDNOTIFICATION")
    const notifMap = {
        'SHIPPEDNOTIFICATION': 'shipped',
        'INTRANSITNOTIFICATION': 'in_transit',
        'OUTFORDELIVERYNOTIFICATION': 'out_for_delivery',
        'DELIVEREDNOTIFICATION': 'delivered',
        'CANCELLEDNOTIFICATION': 'cancelled',
        'CANCELEDNOTIFICATION': 'cancelled',
        'RTONOTIFICATION': 'rto',
    };

    // Prefer orderStatus, fallback to notificationType
    return statusMap[raw] || notifMap[notif] || raw.toLowerCase() || 'unknown';
}
