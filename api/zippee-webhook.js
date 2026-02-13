const axios = require('axios');

module.exports = async (req, res) => {
    // 1. Handle non-POST requests
    if (req.method !== 'POST') {
        return res.status(200).send('Bridge is active! Waiting for Zippee data...');
    }

    // Log the incoming data for your Vercel Dashboard
    console.log("--- ZIPPEE WEBHOOK RECEIVED ---");
    console.log(JSON.stringify(req.body, null, 2));

    try {
        // 2. Map Zippee's specific keys to our variables
        const {
            phoneNumber,     // Zippee uses 'phoneNumber'
            customerName,    // Zippee uses 'customerName'
            orderNo,         // Zippee uses 'orderNo'
            orderStatus      // Zippee uses 'orderStatus'
        } = req.body || {};

        if (!phoneNumber) {
            console.error('Error: Zippee sent a request without a phoneNumber.');
            return res.status(400).json({ error: 'Missing phoneNumber' });
        }

        // 3. Clean and Format Phone Number (+91 for India)
        let formattedPhone = phoneNumber.toString().replace(/\D/g, '');

        // Strip leading 0 (e.g., "09876543210" -> "9876543210")
        if (formattedPhone.startsWith('0')) {
            formattedPhone = formattedPhone.slice(1);
        }

        // Strip country code if already present (91 + 10 digits = 12 digits)
        if (formattedPhone.length === 12 && formattedPhone.startsWith('91')) {
            formattedPhone = formattedPhone.slice(2);
        }

        // Validate: we must now have exactly 10 digits
        if (formattedPhone.length !== 10) {
            console.error(`Invalid phone format: raw="${phoneNumber}" cleaned="${formattedPhone}"`);
            return res.status(400).json({
                error: 'Invalid phone number format',
                received: phoneNumber
            });
        }

        formattedPhone = `+91${formattedPhone}`;

        // 4. Build a generic status message for the template
        const statusMessages = {
            'created': 'has been confirmed',
            'confirmed': 'has been confirmed',
            'processing': 'is being processed',
            'ready_to_ship': 'is ready to ship',
            'shipped': 'has been shipped',
            'in_transit': 'is in transit',
            'out_for_delivery': 'is out for delivery',
            'delivered': 'has been delivered',
            'cancelled': 'has been cancelled',
            'returned': 'has been returned',
            'rto': 'is being returned to origin',
        };

        const normalizedStatus = (orderStatus || '').toString().toLowerCase().trim();
        const statusText = statusMessages[normalizedStatus] || `has been updated (${orderStatus || 'status unknown'})`;

        // 5. Prepare AiSensy Payload
        // Body: {{1}} = Name, {{2}} = Order No, {{3}} = Status Text
        // URL Button {{1}} is auto-handled by AiSensy (maps to Body {{2}} internally)
        const aisensyData = {
            apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc2NjAzOTQ1OH0.OO4Yoj-800AudUM1B8i9IJ78BK_TepVqnmkdPDVuqTM",
            campaignName: "zippee_order_status_update",
            destination: formattedPhone,
            userName: customerName || "Customer",
            templateParams: [
                String(customerName || "Customer"), // Body {{1}} - Customer Name
                String(orderNo || "Order"),          // Body {{2}} - Order Number
                statusText                           // Body {{3}} - Status (e.g. "has been shipped")
            ]
        };

        console.log(`Sending to ${formattedPhone}: Order ${orderNo} ${statusText} for ${customerName}`);

        // 6. Fire to AiSensy
        const response = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyData);

        console.log("AiSensy Status:", response.data);
        return res.status(200).json({ success: true, message: 'Message queued', status: normalizedStatus });

    } catch (error) {
        console.error('Bridge Error:', error.response?.data || error.message);
        return res.status(500).json({
            error: 'Failed to forward to AiSensy',
            details: error.response?.data || error.message
        });
    }
};
