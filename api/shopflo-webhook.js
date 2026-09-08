/**
 * Vercel Serverless Function — Shopflo to AiSensy Full-Funnel Recovery Bridge
 * --------------------------------------------------------------------------
 * Endpoint: POST https://<your-vercel-domain>/api/shopflo-webhook
 *
 * Captures all 74 Shopflo event types, classifies customer intent across 5 tiers,
 * maintains deduplication, and enqueues progressive WhatsApp recovery nudges.
 */

const axios = require('axios');
const { saveLead, getLead, markConverted, saveLeadForReorder } = require('./lib/db');
const { classifyCustomer, getNudgeConfig, TIERS } = require('./lib/classifier');
const { enqueueMessage, cancelAllMessagesForPhone } = require('./lib/queue');
const { trackCampaignEvent } = require('./lib/analytics');

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
  // Set CORS headers for browser-based dashboard tests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-shopflo-signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Handle GET or Health Check Pings
  if (req.method === 'GET') {
    return res.status(200).send('Shopflo Full-Funnel Recovery Webhook is Live!');
  }

  const body = req.body || {};
  console.log('[Shopflo Webhook] Received:', JSON.stringify(body));

  // Handle Shopflo Dashboard Test Ping
  if (body.type === 'test' || body.test === true || Object.keys(body).length === 0) {
    return res.status(200).json({ success: true, message: 'Shopflo Webhook connection verified successfully!' });
  }

  try {
    const rawEventType = String(body.event || body.type || body.event_type || 'checkout_abandoned').toLowerCase();
    const customer = body.customer || body.customer_details || body.user || {};
    const shipping = body.shipping_address || body.shippingAddress || {};

    const rawPhone = body.phone || customer.phone || shipping.phone || body.customer_phone || '';
    const phone = formatPhoneNumber(rawPhone);
    const name = customer.name || (customer.first_name ? `${customer.first_name} ${customer.last_name || ''}`.trim() : '') || body.name || 'Customer';
    const email = customer.email || body.email || '';
    const city = shipping.city || customer.city || body.city || '';
    const lastOrderedDate = customer.last_ordered_date || body.last_ordered_date || '';

    const utmSource = body.utm_source || customer.utm_source || body.utmSource || '';
    const utmMedium = body.utm_medium || customer.utm_medium || '';
    const utmCampaign = body.utm_campaign || customer.utm_campaign || '';
    const utmContent = body.utm_content || customer.utm_content || '';

    if (!phone) {
      return res.status(200).json({ success: true, message: 'No phone number in payload' });
    }

    const rawEvents = body.event_list || body.events || [rawEventType];
    const classification = classifyCustomer(rawEvents, lastOrderedDate);

    // ── 1. ORDER COMPLETED / BUYER ──
    if (
      classification.tier === 'BUYER' ||
      rawEventType.includes('order_completed') ||
      rawEventType.includes('payment_completed')
    ) {
      console.log(`[Shopflo Webhook] 🎉 Order completed for ${name} (${phone}). Marking CONVERTED.`);

      await markConverted(phone);
      await cancelAllMessagesForPhone(phone);
      await trackCampaignEvent('shopflo_conversion_sync', 'converted', { tier: 'BUYER' });

      // Sync conversion tag to AiSensy
      await axios.post(AISENSY_URL, {
        apiKey: AISENSY_API_KEY,
        campaignName: 'shopflo_conversion_sync',
        destination: phone,
        userName: name,
        tags: ['Customer_Converted', 'ShopPass_Buyer'],
        attributes: {
          Last_Order_Date: new Date().toISOString(),
          City: city,
          Email: email,
          UTM_Source: utmSource,
        },
      }).catch(err => console.log('AiSensy tag sync notice:', err.response?.data || err.message));

      // ── REORDER FUNNEL: Enqueue first reorder nudge (T+15 days) ──
      try {
        const reorderLead = await saveLeadForReorder(phone, {
          name,
          email,
          city,
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
              City: city,
            },
          });
          await trackCampaignEvent(reorderNudge1.campaignName, 'enqueued', { tier: 'TIER_0_REORDER', nudgeNum: 1 });
          console.log(`[Shopflo Webhook] 🔄 Reorder Nudge 1 enqueued for ${phone}.`);
        }
      } catch (reorderErr) {
        console.warn('[Shopflo Webhook] Non-critical: Reorder enqueue notice:', reorderErr.message);
      }

      return res.status(200).json({ success: true, status: 'customer_marked_as_converted', reorder_enrolled: true });
    }

    // ── 2. NON-BUYER RETARGETING ENROLLMENT & DEDUPLICATION ──
    const existingLead = await getLead(phone);

    if (existingLead && existingLead.status === 'CONVERTED') {
      console.log(`[Shopflo Webhook] Lead ${phone} has previously converted. Skipping recovery.`);
      return res.status(200).json({ success: true, message: 'Customer already converted' });
    }

    // Check tier hierarchy: only upgrade or maintain tier
    let assignedTier = classification.tier;
    if (existingLead && existingLead.tier) {
      const existingPriority = TIERS[existingLead.tier]?.priority || 99;
      const newPriority = classification.priority;

      if (newPriority < existingPriority) {
        // Upgrade to higher intent tier (e.g. from Browser to Checkout Abandoner)
        console.log(`[Shopflo Webhook] Upgrading ${phone} from ${existingLead.tier} to ${assignedTier}`);
        await cancelAllMessagesForPhone(phone);
      } else {
        // Keep existing higher-priority tier
        assignedTier = existingLead.tier;

        // If same tier and already active with queued nudges, skip re-enrollment
        // This prevents Shopflo re-fires from resetting the nudge counter
        if (existingLead.status === 'ACTIVE' && existingLead.current_nudge > 0) {
          console.log(`[Shopflo Webhook] Lead ${phone} already active in ${assignedTier} (Nudge ${existingLead.current_nudge}). Skipping re-enrollment.`);
          return res.status(200).json({
            success: true,
            message: `Already enrolled in ${assignedTier} recovery sequence`,
            tier: assignedTier,
            phone,
          });
        }
      }
    }

    // Items that are packaging/accessories, not real SKUs — exclude from messages
    const NON_SKU_ITEMS = ['insulated bag', 'insulated bag - large', 'insulated bag - small', 'ice pack', 'packaging'];
    const rawItems = body.items || body.cart?.items || body.line_items || [];
    const items = Array.isArray(rawItems)
      ? rawItems
          .map(i => i.title || i.name || 'Product')
          .filter(name => !NON_SKU_ITEMS.includes(name.toLowerCase().trim()))
          .slice(0, 3)
          .join(', ')
      : (typeof rawItems === 'string' ? rawItems : '');
    const checkoutUrl = body.checkout_url
      || body.checkoutUrl
      || body.abandoned_checkout_url
      || body.abandonedCheckoutUrl
      || body.data?.checkout_url
      || body.payload?.checkout_url
      || body.cart?.checkout_url
      || body.cart?.url
      || body.checkout?.checkout_url
      || body.checkout?.url
      || (body.cart_token ? `https://checkout.shopflo.com/?merchant=proteinpantry&cart_token=${body.cart_token}` : null)
      || (body.token ? `https://checkout.shopflo.com/?merchant=proteinpantry&token=${body.token}` : null)
      || body.url
      || existingLead?.checkout_url
      || 'https://proteinpantry.in/cart';

    const leadData = {
      phone,
      name,
      email,
      city,
      cart_items: items || existingLead?.cart_items || '',
      checkout_url: checkoutUrl,
      tier: assignedTier,
      current_nudge: existingLead?.current_nudge || 0,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      utm_content: utmContent,
    };

    // Save/Update lead profile in Redis (if configured)
    let leadProfile = null;
    try {
      leadProfile = await saveLead(leadData);
    } catch (saveErr) {
      console.warn('[Shopflo Webhook] DB save notice:', saveErr.message);
    }
    leadProfile = leadProfile || leadData;

    // Fetch Nudge 1 configuration for this tier (phone passed for future A/B variant support)
    const nudge1Config = getNudgeConfig(assignedTier, 1, phone);

    if (nudge1Config) {
      const templateParams = nudge1Config.getParams(leadProfile);

      // Schedule Nudge 1 in the message queue
      try {
        await enqueueMessage(phone, assignedTier, 1, nudge1Config.delayMs, {
          campaignName: nudge1Config.campaignName,
          fallbackCampaign: nudge1Config.fallbackCampaign,
          mediaUrl: nudge1Config.mediaUrl || '',
          templateParams,
          tags: nudge1Config.tags,
          attributes: {
            Tier: assignedTier,
            Cart_Items: items || 'Protein Snacks',
            City: city,
            Email: email,
            UTM_Source: utmSource,
          },
        });
        await trackCampaignEvent(nudge1Config.campaignName, 'enqueued', { tier: assignedTier, nudgeNum: 1 });
      } catch (qErr) {
        console.warn('[Shopflo Webhook] Queue notice:', qErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: `Enrolled in ${assignedTier} recovery sequence.`,
      tier: assignedTier,
      phone,
    });

  } catch (error) {
    console.error('[Shopflo Webhook Error]:', error);
    return res.status(500).json({ error: error.message });
  }
};
