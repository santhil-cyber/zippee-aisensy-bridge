const axios = require('axios');

module.exports = async (req, res) => {
    // 1. Handle non-POST requests gracefully
    if (req.method !== 'POST') {
        return res.status(200).send('Bridge is online. Please send a POST request with data.');
    }

    try {
        // 2. Safely extract data
        const { 
            phone, 
            customer_name, 
            order_number, 
            current_status, 
            tracking_link 
        } = req.body || {};

        // 3. Crash-protection: Check if phone exists
        if (!phone) {
            console.error('Missing phone number in request body');
            return res.status(400).json({ error: 'Missing phone number' });
        }

        // 4. Format phone number
        let formattedPhone = phone.toString().replace(/\D/g, '');
        if (formattedPhone.length === 10) {
            formattedPhone = `+91${formattedPhone}`;
        } else if (!formattedPhone.startsWith('+')) {
            formattedPhone = `+${formattedPhone}`;
        }

        const aisensyData = {
            apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc2NjAzOTQ1OH0.OO4Yoj-800AudUM1B8i9IJ78BK_TepVqnmkdPDVuqTM",
            campaignName: "order_status_live", 
            destination: formattedPhone,
            userName: customer_name || "Customer",
            templateParams: [
                String(customer_name || "Customer"),
                String(order_number || "N/A"),
                String(current_status || "Updated"),
                String(tracking_link || "")
            ]
        };

        const response = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyData);
        return res.status(200).json({ success: true, aisensy: response.data });

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        return res.status(500).json({ 
            error: 'Internal Bridge Error', 
            details: error.response?.data || error.message 
        });
    }
};
