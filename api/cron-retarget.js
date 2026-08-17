/**
 * Vercel Cron Job — 2-Week Recurring Retargeting Engine
 * ------------------------------------------------------
 * Schedule: Runs daily at 10:00 AM IST (0 5 * * *)
 *
 * Actions:
 * 1. Scans all ACTIVE leads enrolled from ShopPass.
 * 2. Checks if >= 14 days have passed since the last message.
 * 3. Double-checks Shopify orders to confirm customer has NOT purchased.
 * 4. If purchased -> Marks CONVERTED & stops future messages.
 * 5. If not purchased -> Sends next 2-week progressive WhatsApp campaign via AiSensy.
 */

const axios = require('axios');
const { getActiveLeads, updateLeadProgress, markConverted } = require('./lib/db');
const { hasPlacedOrder } = require('./lib/shopify');

const AISENSY_API_KEY = process.env.AISENSY_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";
const AISENSY_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

// 14 days in milliseconds
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Progressive Campaign Templates for each 2-week cycle
 */
const CAMPAIGN_CYCLES = {
  1: {
    campaignName: 'retarget_cycle_1_10off',
    getParams: (lead) => [
      String(lead.name || 'there'),
      String(lead.cart_items || 'your favorite protein snacks'),
      String(lead.checkout_url || 'https://proteinpantry.in'),
    ],
  },
  2: {
    campaignName: 'retarget_cycle_2_freeship',
    getParams: (lead) => [
      String(lead.name || 'there'),
      'FREESHIP',
      String(lead.checkout_url || 'https://proteinpantry.in'),
    ],
  },
  3: {
    campaignName: 'retarget_cycle_3_vip15',
    getParams: (lead) => [
      String(lead.name || 'there'),
      'FIT15',
      'https://proteinpantry.in',
    ],
  },
};

module.exports = async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] --- STARTING 2-WEEK RETARGETING CRON EXECUTION ---`);

  try {
    const activeLeads = await getActiveLeads();
    console.log(`[Cron] Found ${activeLeads.length} active retargeting leads in database.`);

    if (activeLeads.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No active leads pending retargeting',
        processed: 0,
        timestamp,
      });
    }

    const now = Date.now();
    const results = {
      evaluated: activeLeads.length,
      retargeted: 0,
      converted: 0,
      skipped_too_recent: 0,
      errors: 0,
    };

    for (const lead of activeLeads) {
      const phone = lead.phone;
      const lastSentTime = new Date(lead.last_sent_at || lead.enrolled_at).getTime();
      const timeElapsed = now - lastSentTime;

      // Check if at least 14 days (or test force flag)
      const isDue = timeElapsed >= FOURTEEN_DAYS_MS || req.query.force === 'true';

      if (!isDue) {
        const daysRemaining = Math.ceil((FOURTEEN_DAYS_MS - timeElapsed) / (1000 * 60 * 60 * 24));
        console.log(`[Cron] Lead ${phone} not due yet (${daysRemaining} days remaining).`);
        results.skipped_too_recent++;
        continue;
      }

      console.log(`[Cron] Lead ${phone} is due for 2-week retargeting! Running live purchase check...`);

      // ── STEP 1: Live Purchase Check via Shopify ──
      const hasBought = await hasPlacedOrder(phone, lead.email, lead.enrolled_at);

      if (hasBought) {
        console.log(`[Cron] 🎉 Lead ${phone} has placed an order in Shopify! Marking CONVERTED.`);
        await markConverted(phone);
        
        // Sync conversion tag to AiSensy
        await axios.post(AISENSY_URL, {
          apiKey: AISENSY_API_KEY,
          campaignName: 'shopflo_conversion_sync',
          destination: phone,
          userName: lead.name || 'Customer',
          tags: ['Customer_Converted'],
          attributes: { Last_Order_Date: timestamp },
        }).catch(() => {});

        results.converted++;
        continue;
      }

      // ── STEP 2: Send Next 2-Week Progressive Message ──
      const nextCycle = (lead.cycle_count || 0) + 1;
      const cycleConfig = CAMPAIGN_CYCLES[nextCycle] || CAMPAIGN_CYCLES[3];

      const payload = {
        apiKey: AISENSY_API_KEY,
        campaignName: cycleConfig.campaignName,
        destination: phone,
        userName: lead.name || 'there',
        tags: [`2Week_Cycle_${nextCycle}`, 'ShopPass_Active_Drip'],
        attributes: {
          Retarget_Cycle: String(nextCycle),
          Last_Retarget_Date: timestamp,
        },
        templateParams: cycleConfig.getParams(lead),
      };

      try {
        console.log(`[Cron] Firing Cycle ${nextCycle} WhatsApp message to ${phone}...`);
        await axios.post(AISENSY_URL, payload);

        // Update progress in Redis
        await updateLeadProgress(phone, {
          cycleCount: nextCycle,
          lastSentAt: timestamp,
        });

        results.retargeted++;
      } catch (err) {
        console.error(`[Cron] Error triggering AiSensy for ${phone}:`, err.response?.data || err.message);
        results.errors++;
      }
    }

    console.log(`[Cron Finished]: Evaluated: ${results.evaluated}, Sent: ${results.retargeted}, Converted: ${results.converted}`);

    return res.status(200).json({
      success: true,
      summary: results,
      timestamp,
    });

  } catch (error) {
    console.error('[Cron Execution Failed]:', error);
    return res.status(500).json({
      error: 'Cron execution failed',
      details: error.message,
    });
  }
};
