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
        if (formattedPhone.length === 10) {
            formattedPhone = `+91${formattedPhone}`;
        } else if (!formattedPhone.startsWith('+')) {
            formattedPhone = `+${formattedPhone}`;
        }

        // 4. Prepare AiSensy Payload
        // Template: Hey {{1}}, Your order {{2}} is on its way... URL includes {{3}}
        const aisensyData = {
            apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc2NjAzOTQ1OH0.OO4Yoj-800AudUM1B8i9IJ78BK_TepVqnmkdPDVuqTM",
            campaignName: "zippee_aisensy_bridge", 
            destination: formattedPhone,
            userName: customerName || "Customer",
            templateParams: [
                String(customerName || "Customer"), // {{1}} - FirstName
                String(orderNo || "Order"),        // {{2}} - OrderName
                String(orderNo || "Order")         // {{3}} - OrderName (for the URL button)
            ]
        };

        // 5. Fire to AiSensy
        const response = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyData);
        
        console.log("AiSensy Status:", response.data);
        return res.status(200).json({ success: true, message: 'Message queued' });

    } catch (error) {
        console.error('Bridge Error:', error.response?.data || error.message);
        return res.status(500).json({ 
            error: 'Failed to forward to AiSensy', 
            details: error.response?.data || error.message 
        });
    }
}; 
