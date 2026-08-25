/**
 * CSV Customer Backfill Utility
 * ------------------------------
 * Reads customer export CSV, classifies non-buyers into recovery tiers,
 * and schedules staggered WhatsApp recovery messages in Upstash Redis.
 *
 * Usage:
 *   node scripts/backfill-csv.js --file ./shopjpassjcustomerjdata-1786470700202.csv --dry-run
 *   node scripts/backfill-csv.js --file ./shopjpassjcustomerjdata-1786470700202.csv --limit 50
 *   node scripts/backfill-csv.js --file ./shopjpassjcustomerjdata-1786470700202.csv --tier TIER_1_CHECKOUT_ABANDON
 *   node scripts/backfill-csv.js --file ./shopjpassjcustomerjdata-1786470700202.csv --days 5
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Load environment variables if available
try {
  require('dotenv').config();
} catch (_) {}

const { saveLead, markConverted } = require('../api/lib/db');
const { classifyCustomer, getNudgeConfig } = require('../api/lib/classifier');
const { enqueueMessage } = require('../api/lib/queue');

// Parse CLI arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const maxRecords = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const tierFilterIdx = args.indexOf('--tier');
const targetTier = tierFilterIdx !== -1 ? args[tierFilterIdx + 1] : null;
const daysIdx = args.indexOf('--days');
const spreadDays = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 3;

const fileIdx = args.indexOf('--file');
const defaultFilePath = path.join(__dirname, '../../shopjpassjcustomerjdata-1786470700202.csv');
const targetCsvPath = fileIdx !== -1 ? path.resolve(args[fileIdx + 1]) : defaultFilePath;

function formatPhoneNumber(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = cleaned.slice(2);
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.length > 10 && phone.toString().startsWith('+')) return phone.toString();
  return null;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

async function runBackfill() {
  console.log('=== STARTING CSV BACKFILL PROCESSOR ===');
  console.log(`CSV File: ${targetCsvPath}`);
  console.log(`Mode: ${isDryRun ? 'DRY-RUN (No DB changes)' : 'LIVE EXECUTION'}`);
  console.log(`Max Limit: ${maxRecords === Infinity ? 'Unlimited' : maxRecords}`);
  console.log(`Target Tier: ${targetTier || 'All Tiers'}`);
  console.log(`Spread Duration: ${spreadDays} days`);
  console.log('-------------------------------------------');

  if (!fs.existsSync(targetCsvPath)) {
    console.error(`Error: File not found at ${targetCsvPath}`);
    process.exit(1);
  }

  const fileStream = fs.createReadStream(targetCsvPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let header = null;
  let totalRows = 0;
  let buyersCount = 0;
  let enrolledCount = 0;
  const tierCounts = {};

  // Spread messages evenly across hours in the spreadDays window
  const totalSpreadMs = spreadDays * 24 * 60 * 60 * 1000;

  for await (const line of rl) {
    if (!line.trim()) continue;

    if (!header) {
      header = parseCSVLine(line).map(h => h.replace(/^["']|["']$/g, '').trim());
      continue;
    }

    totalRows++;
    const values = parseCSVLine(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = (values[i] || '').replace(/^["']|["']$/g, '').trim();
    });

    const rawPhone = row['PHONE'];
    const phone = formatPhoneNumber(rawPhone);
    const name = row['NAME'] || 'Customer';
    const email = row['EMAIL'] || '';
    const city = row['CITY'] || '';
    const eventList = row['EVENT_LIST'] || '';
    const lastOrderedDate = row['LAST_ORDERED_DATE'] || '';
    const utmSource = row['UTM_SOURCE'] || '';
    const utmMedium = row['UTM_MEDIUM'] || '';
    const utmCampaign = row['UTM_CAMPAIGN'] || '';
    const utmContent = row['UTM_CONTENT'] || '';

    if (!phone) continue;

    // Classify customer
    const classification = classifyCustomer(eventList, lastOrderedDate);

    // Skip buyers
    if (classification.tier === 'BUYER') {
      buyersCount++;
      if (!isDryRun) {
        await markConverted(phone).catch(() => {});
      }
      continue;
    }

    // Filter tier if specified
    if (targetTier && classification.tier !== targetTier) {
      continue;
    }

    tierCounts[classification.tier] = (tierCounts[classification.tier] || 0) + 1;

    if (enrolledCount >= maxRecords) {
      continue;
    }

    // Stagger delay for this lead so all leads aren't blasted at the exact same minute
    const staggeredDelayMs = Math.floor((enrolledCount * totalSpreadMs) / Math.max(maxRecords === Infinity ? 2779 : maxRecords, 100));

    if (!isDryRun) {
      // 1. Save Lead
      const leadProfile = await saveLead({
        phone,
        name,
        email,
        city,
        tier: classification.tier,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        utm_content: utmContent,
        source: 'csv_backfill',
      });

      // 2. Enqueue Nudge 1
      const nudgeConfig = getNudgeConfig(classification.tier, 1);
      if (nudgeConfig) {
        const params = nudgeConfig.getParams(leadProfile);
        await enqueueMessage(phone, classification.tier, 1, staggeredDelayMs + nudgeConfig.delayMs, {
          campaignName: nudgeConfig.campaignName,
          fallbackCampaign: nudgeConfig.fallbackCampaign,
          templateParams: params,
          tags: [...nudgeConfig.tags, 'CSV_Backfill'],
          attributes: {
            Tier: classification.tier,
            City: city,
            Email: email,
            UTM_Source: utmSource,
          },
        });
      }
    }

    enrolledCount++;
  }

  console.log('\n=== BACKFILL EXECUTION SUMMARY ===');
  console.log(`Total Rows Analyzed: ${totalRows}`);
  console.log(`Existing Buyers (Skipped): ${buyersCount}`);
  console.log(`Non-Buyers Enrolled: ${enrolledCount}`);
  console.log('\nBreakdown by Intent Tier:');
  Object.keys(tierCounts).forEach(tier => {
    console.log(`  ${tier}: ${tierCounts[tier]} customers`);
  });
  console.log('====================================');
}

runBackfill().catch(err => {
  console.error('Fatal Backfill Error:', err);
  process.exit(1);
});
