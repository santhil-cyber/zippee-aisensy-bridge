/**
 * Vercel Cron Job — Full-Funnel WhatsApp Recovery Engine
 * --------------------------------------------------------
 * Schedule: Runs every 15 minutes (or on-demand via HTTP)
 *
 * Execution Steps:
 * 1. Verifies sending window (09:00 - 21:00 IST).
 * 2. Fetches scheduled messages due for dispatch from Upstash Redis queue.
 * 3. Double-checks Shopify Admin API to confirm customer has NOT purchased.
 * 4. If purchased -> Marks CONVERTED, cancels future queue, tags in AiSensy.
 * 5. If not purchased -> Dispatches WhatsApp campaign via AiSensy & enqueues next tier nudge.
 */

const axios = require('axios');
const { getLead, markConverted, updateLeadProgress, saveLeadForReorder } = require('./lib/db');
const { hasPlacedOrder } = require('./lib/shopify');
const {
  getDueMessages,
  removeMessage,
  enqueueMessage,
  isWithinSendingHours,
  incrementWeeklyCount,
  markPhoneBlocked,
  cancelAllMessagesForPhone,
} = require('./lib/queue');
const { getNudgeConfig, getMaxNudgesForTier } = require('./lib/classifier');
const { trackCampaignEvent } = require('./lib/analytics');

const AISENSY_API_KEY = process.env.AISENSY_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NDdiZDI5OGI0YWI1MGMwN2RiYzk4NiIsIm5hbWUiOiJTbGFwcGluIEZvb2RzIFB2dCBMdGQiLCJhcHBOYW1lIjoiQWlTZW5zeSIsImNsaWVudElkIjoiNjg0N2JkMjk4YjRhYjUwYzA3ZGJjOTgxIiwiYWN0aXZlUGxhbiI6IkJBU0lDX1lFQVJMWSIsImlhdCI6MTc4MTc4Nzc0N30.sffbnU3Z9cxUrTQYWQv-mh2vfm_ChWZ1iUDaaWATtE0";
const AISENSY_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

/**
 * Dispatch message with fallback support if new template is still under review in AiSensy
 */
async function sendWithFallback(payload, fallbackCampaign) {
  try {
    return await axios.post(AISENSY_URL, payload);
  } catch (err) {
    if (fallbackCampaign && fallbackCampaign !== payload.campaignName) {
      console.warn(`[Cron] Primary campaign ${payload.campaignName} failed (${err.response?.data?.message || err.message}). Attempting fallback: ${fallbackCampaign}`);
      const fallbackPayload = {
        ...payload,
        campaignName: fallbackCampaign,
      };
      // If fallback template is not browse_nudge_trust, do not send media header
      if (fallbackCampaign !== 'browse_nudge_trust') {
        delete fallbackPayload.media;
      }
      return await axios.post(AISENSY_URL, fallbackPayload);
    }
    throw err;
  }
}

module.exports = async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] --- STARTING RECOVERY ENGINE CRON EXECUTION ---`);

  const force = req.query?.force === 'true' || req.body?.force === true;

  // 1. Check sending window in IST (9 AM - 9 PM)
  if (!isWithinSendingHours() && !force) {
    console.log('[Cron] Outside IST sending window (09:00 - 21:00). Pausing dispatch.');
    return res.status(200).json({
      success: true,
      message: 'Outside sending window (9 AM - 9 PM IST). Messages held in queue.',
      timestamp,
    });
  }

  try {
    // 2. Fetch due messages from queue
    const dueMessages = await getDueMessages(100);
    console.log(`[Cron] Found ${dueMessages.length} due messages in queue.`);

    const results = {
      evaluated: dueMessages.length,
      dispatched: 0,
      converted: 0,
      skipped_converted: 0,
      skipped_returning: 0,
      errors: 0,
      ab_variant_a: 0,
      ab_variant_b: 0,
      abc_variant_c: 0,
    };

    if (dueMessages.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No messages currently due in queue',
        summary: results,
        timestamp,
      });
    }

    for (const msg of dueMessages) {
      const { memberKey, phone, tier, nudgeNum, campaignName, fallbackCampaign, mediaUrl, templateParams, tags, attributes } = msg;

      // ── Step A: Check DB Lead Status ──
      const lead = await getLead(phone);

      if (lead && lead.status === 'CONVERTED') {
        console.log(`[Cron] Customer ${phone} already marked converted in DB. Removing message.`);
        await removeMessage(memberKey);
        results.skipped_converted++;
        continue;
      }

      // ── Step B: Live Purchase Check via Shopify Admin API ──
      const hasBought = await hasPlacedOrder(phone, lead?.email, lead?.enrolled_at);

      if (hasBought) {
        console.log(`[Cron] 🎉 Lead ${phone} has placed an order in Shopify! Marking CONVERTED.`);
        await markConverted(phone);
        await cancelAllMessagesForPhone(phone);
        await removeMessage(memberKey);

        // Sync conversion tag to AiSensy
        await axios.post(AISENSY_URL, {
          apiKey: AISENSY_API_KEY,
          campaignName: 'shopflo_conversion_sync',
          destination: phone,
          userName: lead?.name || 'Customer',
          tags: ['Customer_Converted', 'Recovered_via_WhatsApp'],
          attributes: { Last_Order_Date: timestamp },
        }).catch(() => {});

        // ── REORDER FUNNEL: Enqueue reorder nudge if not already in reorder tier ──
        // Avoid infinite loop: don't re-enqueue reorder from within a reorder nudge
        if (tier !== 'TIER_0_REORDER') {
          try {
            const reorderLead = await saveLeadForReorder(phone, {
              name: lead?.name || 'Customer',
              email: lead?.email || '',
              city: lead?.city || '',
              last_order_date: new Date().toISOString(),
            });

            const reorderNudge1 = getNudgeConfig('TIER_0_REORDER', 1, phone);
            if (reorderNudge1 && reorderLead) {
              const reorderParams = reorderNudge1.getParams(reorderLead);
              await enqueueMessage(phone, 'TIER_0_REORDER', 1, reorderNudge1.delayMs, {
                campaignName: reorderNudge1.campaignName,
                fallbackCampaign: reorderNudge1.fallbackCampaign,
                templateParams: reorderParams,
                tags: reorderNudge1.tags,
                attributes: {
                  Tier: 'TIER_0_REORDER',
                  Nudge_Number: '1',
                },
              });
              console.log(`[Cron] 🔄 Reorder Nudge 1 enqueued for converted lead ${phone}.`);
            }
          } catch (reorderErr) {
            console.warn(`[Cron] Non-critical: Reorder enqueue failed for ${phone}:`, reorderErr.message);
          }
        }

        await trackCampaignEvent(campaignName, 'converted', { tier, nudgeNum });
        results.converted++;
        continue;
      }

      // ── Step B2: Skip coupon nudges for returning customers ──
      // Nudges with skipIfReturning (Pro10, FREEDEL) are wasteful for customers
      // who have ordered before — they've likely already used these coupons.
      const currentNudgeConfig = getNudgeConfig(tier, nudgeNum, phone);
      if (currentNudgeConfig?.skipIfReturning) {
        // Check for ANY past order (no sinceDate filter)
        const isReturningCustomer = await hasPlacedOrder(phone, lead?.email, null);
        if (isReturningCustomer) {
          console.log(`[Cron] 🔄 Returning customer ${phone} — skipping coupon nudge ${campaignName} (Nudge ${nudgeNum}).`);
          await removeMessage(memberKey);
          await trackCampaignEvent(campaignName, 'skipped_returning', { tier, nudgeNum });
          results.skipped_returning = (results.skipped_returning || 0) + 1;

          // Find and enqueue the next non-coupon nudge in the sequence
          const maxNudges = getMaxNudgesForTier(tier);
          let nextEligible = nudgeNum + 1;
          while (nextEligible <= maxNudges) {
            const nextConfig = getNudgeConfig(tier, nextEligible, phone);
            if (!nextConfig?.skipIfReturning) break; // Found a non-coupon nudge
            nextEligible++;
          }

          if (nextEligible <= maxNudges && lead) {
            const nextConfig = getNudgeConfig(tier, nextEligible, phone);
            const nextParams = nextConfig.getParams(lead);
            await enqueueMessage(phone, tier, nextEligible, nextConfig.delayMs, {
              campaignName: nextConfig.campaignName,
              fallbackCampaign: nextConfig.fallbackCampaign,
              templateParams: nextParams,
              tags: nextConfig.tags,
              attributes: { Tier: tier, Nudge_Number: String(nextEligible) },
            });
            console.log(`[Cron] ⏭️  Skipped to Nudge ${nextEligible} (${nextConfig.campaignName}) for returning customer ${phone}.`);
          } else {
            // All remaining nudges are coupon-based — complete the sequence
            await updateLeadProgress(phone, { status: 'COMPLETED_TIER_SEQUENCE' });
            console.log(`[Cron] Lead ${phone} — no non-coupon nudges remaining. Sequence complete.`);
          }

          continue;
        }
      }

      // ── Step C: Dispatch WhatsApp Campaign via AiSensy ──
      const payload = {
        apiKey: AISENSY_API_KEY,
        campaignName: campaignName || 'shopflo_abandoned_cart',
        destination: phone,
        userName: lead?.name || 'there',
        tags: tags || [tier, `Nudge_${nudgeNum}`],
        attributes: {
          ...(attributes || {}),
          Tier: tier,
          Nudge_Number: String(nudgeNum),
          Last_Nudge_Date: timestamp,
        },
        templateParams: templateParams || [String(lead?.name || 'there'), 'your items', 'https://proteinpantry.in'],
      };

      // Add media for templates with header images (e.g. browse_nudge_trust)
      if (mediaUrl || campaignName === 'browse_nudge_trust') {
        payload.media = {
          url: mediaUrl || 'https://cdn.shopify.com/s/files/1/0686/7379/8281/files/ChatGPT_Image_Sep_9_2026_02_15_05_AM.png?v=1788901647',
          filename: 'protein_pantry.png',
        };
      }

      try {
        console.log(`[Cron] Dispatched ${campaignName} (Nudge ${nudgeNum}) to ${phone}...`);
        await sendWithFallback(payload, fallbackCampaign);

        // Remove dispatched message from queue
        await removeMessage(memberKey);

        // Track weekly send count for this phone (max 3/week compliance)
        await incrementWeeklyCount(phone);

        // Update lead progress in DB (include A/B variant for tracking)
        await updateLeadProgress(phone, {
          current_nudge: nudgeNum,
          last_sent_at: timestamp,
          ab_variant: currentNudgeConfig?.abVariant || null,
        });

        // Track per-variant analytics for A/B/C comparison
        const variantLabel = currentNudgeConfig?.abVariant || 'A';
        await trackCampaignEvent(campaignName, 'sent', { tier, nudgeNum, abVariant: variantLabel });
        if (variantLabel === 'A') results.ab_variant_a++;
        if (variantLabel === 'B') results.ab_variant_b++;
        if (variantLabel === 'C') results.abc_variant_c++;

        // ── Step D: Schedule Next Nudge in Tier Sequence ──
        const nextNudgeNum = nudgeNum + 1;
        const maxNudges = getMaxNudgesForTier(tier);

        if (nextNudgeNum <= maxNudges) {
          const nextNudgeConfig = getNudgeConfig(tier, nextNudgeNum, phone);
          if (nextNudgeConfig && lead) {
            const nextParams = nextNudgeConfig.getParams(lead);
            await enqueueMessage(phone, tier, nextNudgeNum, nextNudgeConfig.delayMs, {
              campaignName: nextNudgeConfig.campaignName,
              fallbackCampaign: nextNudgeConfig.fallbackCampaign,
              mediaUrl: nextNudgeConfig.mediaUrl || '',
              templateParams: nextParams,
              tags: nextNudgeConfig.tags,
              attributes: {
                Tier: tier,
                Nudge_Number: String(nextNudgeNum),
              },
            });
            console.log(`[Cron] Enqueued Nudge ${nextNudgeNum} for ${phone} in ${nextNudgeConfig.delayMs / (60 * 1000)} mins.`);
          }
        } else {
          // Completed full tier sequence
          await updateLeadProgress(phone, { status: 'COMPLETED_TIER_SEQUENCE' });
          console.log(`[Cron] Lead ${phone} completed all ${maxNudges} nudges for ${tier}.`);
        }

        results.dispatched++;
      } catch (err) {
        const errData = err.response?.data;
        const errMsg = errData?.message || errData?.error || err.message || '';
        const errStr = String(errMsg).toLowerCase();

        // Detect blocked/unsubscribed numbers and stop retargeting them
        if (
          errStr.includes('blocked') ||
          errStr.includes('unsubscribed') ||
          errStr.includes('opted out') ||
          errStr.includes('not opted in') ||
          errStr.includes('invalid whatsapp') ||
          errStr.includes('number not on whatsapp')
        ) {
          console.warn(`[Cron] Phone ${phone} is blocked/unsubscribed. Marking DO_NOT_CONTACT.`);
          await markPhoneBlocked(phone, errStr);
          await removeMessage(memberKey);
          await trackCampaignEvent(campaignName, 'blocked', { tier, nudgeNum });
          results.errors++;
          continue;
        }

        console.error(`[Cron] Error triggering AiSensy for ${phone} (${campaignName}):`, errData || err.message);
        await trackCampaignEvent(campaignName, 'failed', { tier, nudgeNum });
        results.errors++;
      }
    }

    console.log(`[Cron Finished]: Evaluated: ${results.evaluated}, Dispatched: ${results.dispatched} (A: ${results.ab_variant_a}, B: ${results.ab_variant_b}, C: ${results.abc_variant_c}), Converted: ${results.converted}, Skipped (returning): ${results.skipped_returning}, Errors: ${results.errors}`);

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
