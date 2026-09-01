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

  const now = new Date();
  const dateKey = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const hourKey = `${dateKey}_${String(now.getUTCHours()).padStart(2, '0')}`;

  try {
    const pipeline = redis.pipeline();

    // 1. Overall campaign counters
    pipeline.hincrby(`analytics:campaign:${campaignName}`, event, 1);
    pipeline.hincrby(`analytics:campaign:${campaignName}:${dateKey}`, event, 1);
    pipeline.hincrby(`analytics:hourly:${hourKey}`, event, 1);

    // 2. Tier-specific counters
    if (metadata.tier) {
      pipeline.hincrby(`analytics:tier:${metadata.tier}`, event, 1);
      pipeline.hincrby(`analytics:tier:${metadata.tier}:${dateKey}`, event, 1);
    }

    // 3. A/B variant-specific counters (for comparing variant A vs B performance)
    if (metadata.abVariant) {
      const variant = metadata.abVariant; // 'A' or 'B'
      pipeline.hincrby(`analytics:ab:${campaignName}:${variant}`, event, 1);
      pipeline.hincrby(`analytics:ab:${campaignName}:${variant}:${dateKey}`, event, 1);
      // Aggregate across all campaigns for this variant
      pipeline.hincrby(`analytics:ab:variant_${variant}`, event, 1);
      pipeline.hincrby(`analytics:ab:variant_${variant}:${dateKey}`, event, 1);
      // Per-nudge variant tracking
      if (metadata.nudgeNum) {
        pipeline.hincrby(`analytics:ab:nudge_${metadata.nudgeNum}:${variant}`, event, 1);
        pipeline.hincrby(`analytics:ab:nudge_${metadata.nudgeNum}:${variant}:${dateKey}`, event, 1);
      }
    }

    // 4. Global metric
    pipeline.hincrby('analytics:global', event, 1);
    pipeline.hincrby(`analytics:global:${dateKey}`, event, 1);

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
