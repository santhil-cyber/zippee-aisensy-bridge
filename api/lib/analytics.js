/**
 * Campaign Analytics & Event Tracking
 * -----------------------------------
 * Tracks sent, delivered, read, clicked, and converted metrics per campaign and tier in Upstash Redis.
 */

const { getRedis } = require('./db');

/**
 * Track an event for a campaign
 * @param {string} campaignName 
 * @param {string} event - 'sent' | 'delivered' | 'read' | 'clicked' | 'converted' | 'failed'
 * @param {object} metadata - optional phone, tier, nudgeNum
 */
async function trackCampaignEvent(campaignName, event, metadata = {}) {
  const redis = getRedis();
  if (!redis || !campaignName) return;

  try {
    const pipeline = redis.pipeline();

    // 1. Global metric
    pipeline.hincrby('analytics:global', event, 1);

    // 2. Per-campaign counter
    pipeline.hincrby(`analytics:campaign:${campaignName}`, event, 1);

    // 3. Per-tier counter (if applicable)
    if (metadata.tier) {
      pipeline.hincrby(`analytics:tier:${metadata.tier}`, event, 1);
    }

    // 4. A/B variant aggregate (if applicable — for comparing variant performance)
    if (metadata.abVariant) {
      pipeline.hincrby(`analytics:ab:variant_${metadata.abVariant}`, event, 1);
    }

    await pipeline.exec();
  } catch (err) {
    console.warn(`[Analytics] Error tracking ${event} for ${campaignName}:`, err.message);
  }
}

/**
 * Get aggregated stats for a campaign
 */
async function getCampaignStats(campaignName) {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const data = await redis.hgetall(`analytics:campaign:${campaignName}`);
    return data || {};
  } catch (err) {
    console.warn(`[Analytics] Error fetching stats for ${campaignName}:`, err.message);
    return null;
  }
}

/**
 * Get summary overview of all recovery campaigns
 */
async function getGlobalAnalytics() {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const globalStats = await redis.hgetall('analytics:global');
    return globalStats || {};
  } catch (err) {
    console.warn('[Analytics] Error fetching global stats:', err.message);
    return null;
  }
}

module.exports = {
  trackCampaignEvent,
  getCampaignStats,
  getGlobalAnalytics,
};
