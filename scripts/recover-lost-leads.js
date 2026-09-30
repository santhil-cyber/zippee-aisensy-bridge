/**
 * One-Time Recovery Script — Re-Enqueue Lost Leads from Sep 28-30 Redis Outage
 * ──────────────────────────────────────────────────────────────────────────────
 * When Redis hit its 500K monthly request limit on Sep 28-30, shopflo-webhook.js
 * silently swallowed errors and returned 200 OK. Any customer who abandoned checkout
 * during that window was never enrolled in the recovery funnel.
 *
 * This script queries Shopify for recent abandoned checkouts from that period,
 * filters out customers who already converted, and re-enrolls them.
 *
 * Usage:
 *   DRY RUN (preview):  node scripts/recover-lost-leads.js --dry-run
 *   LIVE (enqueue):      node scripts/recover-lost-leads.js
 *
 * Prerequisites:
 *   - Redis quota must have reset (run on/after Oct 1)
 *   - SHOPIFY_ADMIN_TOKEN must be set in environment
 *   - KV_REST_API_URL and KV_REST_API_TOKEN must be set
 */
const fs = require('fs');
const path = require('path');

// Load environment variables safely (supports dotenv if installed, falls back to manual loader)
try {
  require('dotenv').config();
} catch (_) {}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  });
}
loadEnvFile(path.join(__dirname, '../.env'));
loadEnvFile(path.join(__dirname, '../.env.local'));
const axios = require('axios');
const { saveLead, getLead } = require('../api/lib/db');
const { enqueueMessage } = require('../api/lib/queue');
const { getNudgeConfig } = require('../api/lib/classifier');
const { trackCampaignEvent } = require('../api/lib/analytics');

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '0nb9nh-8p.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const isDryRun = process.argv.includes('--dry-run');

function formatPhone(rawPhone) {
  if (!rawPhone) return null;
  let cleaned = rawPhone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
  if (cleaned.length !== 10) return null;
  return `+91${cleaned}`;
}

async function main() {
  console.log(`\n=== LOST LEADS RECOVERY SCRIPT ===`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (preview only)' : 'LIVE (will enqueue messages)'}`);
  console.log(`Date range: Sep 28, 2026 to Sep 30, 2026\n`);

  if (!SHOPIFY_ADMIN_TOKEN) {
    console.error('SHOPIFY_ADMIN_TOKEN not set. Cannot query Shopify.');
    console.error('Set it: export SHOPIFY_ADMIN_TOKEN=shpat_...');
    process.exit(1);
  }

  // Query Shopify for abandoned checkouts in the outage window
  const startDate = '2026-09-28T00:00:00+05:30';
  const endDate = '2026-09-30T23:59:59+05:30';

  console.log(`Fetching Shopify abandoned checkouts from ${startDate} to ${endDate}...\n`);

  try {
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-10/checkouts.json?created_at_min=${encodeURIComponent(startDate)}&created_at_max=${encodeURIComponent(endDate)}&limit=250`;

    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const checkouts = response.data?.checkouts || [];
    console.log(`Found ${checkouts.length} abandoned checkouts in the outage window.\n`);

    if (checkouts.length === 0) {
      console.log('No abandoned checkouts found. Nothing to recover.');
      return;
    }

    let enrolled = 0;
    let skippedConverted = 0;
    let skippedNoPhone = 0;
    let skippedAlreadyActive = 0;

    for (const checkout of checkouts) {
      const customer = checkout.customer || {};
      const shipping = checkout.shipping_address || {};
      const rawPhone = shipping.phone || customer.phone || checkout.phone;
      const phone = formatPhone(rawPhone);

      if (!phone) {
        skippedNoPhone++;
        continue;
      }

      const name = customer.first_name
        || shipping.first_name
        || 'Customer';
      const email = customer.email || checkout.email || '';
      const city = shipping.city || '';

      // Check if this lead already exists and is active or converted
      const existingLead = await getLead(phone);
      if (existingLead?.status === 'CONVERTED') {
        skippedConverted++;
        console.log(`  [SKIP] ${phone} (${name}) -- already CONVERTED`);
        continue;
      }
      if (existingLead?.status === 'ACTIVE' && existingLead?.current_nudge > 0) {
        skippedAlreadyActive++;
        console.log(`  [SKIP] ${phone} (${name}) -- already ACTIVE in ${existingLead.tier}`);
        continue;
      }

      // Extract cart items
      const items = (checkout.line_items || [])
        .map(i => i.title || i.name || 'Product')
        .slice(0, 3)
        .join(', ');

      const checkoutUrl = checkout.abandoned_checkout_url
        || checkout.checkout_url
        || 'https://proteinpantry.in/cart';

      console.log(`  [ENROLL] ${phone} (${name}) -- ${items || 'unknown items'} -- ${city || 'unknown city'}`);

      if (!isDryRun) {
        const leadData = {
          phone,
          name,
          email,
          city,
          cart_items: items || 'Protein Snacks',
          checkout_url: checkoutUrl,
          tier: 'TIER_1_CHECKOUT_ABANDON',
          current_nudge: 0,
          source: 'recovery_script_oct1',
        };

        const savedLead = await saveLead(leadData);

        // Enqueue Nudge 1 with delayMs=0 (fire at next cron run within 20 minutes)
        const nudge1Config = getNudgeConfig('TIER_1_CHECKOUT_ABANDON', 1, phone);
        if (nudge1Config && savedLead) {
          const templateParams = nudge1Config.getParams(savedLead);
          await enqueueMessage(phone, 'TIER_1_CHECKOUT_ABANDON', 1, 0, {
            campaignName: nudge1Config.campaignName,
            fallbackCampaign: nudge1Config.fallbackCampaign,
            templateParams,
            tags: [...(nudge1Config.tags || []), 'Recovery_Script_Oct1'],
            attributes: {
              Tier: 'TIER_1_CHECKOUT_ABANDON',
              Cart_Items: items || 'Protein Snacks',
              City: city,
              Source: 'recovery_script',
            },
          });
          await trackCampaignEvent(nudge1Config.campaignName, 'enqueued', {
            tier: 'TIER_1_CHECKOUT_ABANDON',
            nudgeNum: 1,
          });
        }
      }

      enrolled++;
    }

    console.log(`\n=== RECOVERY SUMMARY ===`);
    console.log(`Total abandoned checkouts found:  ${checkouts.length}`);
    console.log(`Enrolled into recovery funnel:    ${enrolled}`);
    console.log(`Skipped (already converted):      ${skippedConverted}`);
    console.log(`Skipped (already active):         ${skippedAlreadyActive}`);
    console.log(`Skipped (no valid phone):         ${skippedNoPhone}`);

    if (isDryRun) {
      console.log(`\nThis was a DRY RUN. No leads were actually enrolled.`);
      console.log(`Run without --dry-run to enqueue messages.`);
    } else {
      console.log(`\nLive enrollment complete. Messages will dispatch at next cron run (within 20 minutes).`);
    }

  } catch (err) {
    if (err.response?.status === 404) {
      console.log('\nShopify abandoned checkouts endpoint returned 404.');
      console.log('This may mean the store does not have the abandoned checkout API enabled,');
      console.log('or you need to use the Shopflo dashboard to export abandoned checkouts instead.');
    } else {
      console.error('\nError:', err.response?.data || err.message);
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
