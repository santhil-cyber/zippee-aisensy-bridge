/**
 * Scheduled Message Queue Engine
 * ------------------------------
 * Manages timed recovery nudges using Upstash Redis Sorted Sets.
 * Ensures deduplication, cooldowns, and non-disturb sending windows.
 */

const { getRedis } = require('./db');

const QUEUE_KEY = 'queue:recovery_messages';
const MAX_MESSAGES_PER_WEEK = 3;

/**
 * Check if current time is within acceptable WhatsApp send hours in IST (9:00 AM - 9:00 PM IST)
 */
function isWithinSendingHours(now = new Date()) {
  // Convert UTC to IST (+5:30)
  const utcHours = now.getUTCHours();
  const utcMins = now.getUTCMinutes();
  const istMinutes = (utcHours * 60 + utcMins + 330) % (24 * 60);
  const istHour = Math.floor(istMinutes / 60);

  // Allow between 09:00 (9 AM) and 21:00 (9 PM) IST
  return istHour >= 9 && istHour < 21;
}

/**
 * Get next valid 9:00 AM IST timestamp if current time is outside sending window
 */
function getNextValidSendTime(targetTimeMs) {
  const date = new Date(targetTimeMs);
  const utcHours = date.getUTCHours();
  const utcMins = date.getUTCMinutes();
  const istMinutes = (utcHours * 60 + utcMins + 330) % (24 * 60);
  const istHour = Math.floor(istMinutes / 60);

  if (istHour >= 9 && istHour < 21) {
    return targetTimeMs;
  }

  // Calculate milliseconds until next 9:00 AM IST
  // 9:00 AM IST = 3:30 AM UTC
  const nextMorning = new Date(date);
  if (istHour >= 21) {
    nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
  }
  nextMorning.setUTCHours(3, 30, 0, 0); // 09:00 IST
  return nextMorning.getTime();
}

/**
 * Enqueue a scheduled WhatsApp recovery nudge
 * @param {string} phone 
 * @param {string} tier 
 * @param {number} nudgeNum 
 * @param {number} delayMs 
 * @param {object} campaignData 
 */
async function enqueueMessage(phone, tier, nudgeNum, delayMs, campaignData = {}) {
  const redis = getRedis();
  if (!redis || !phone) return null;

  // --- Weekly Message Cap Check ---
  try {
    const weekKey = `rate:weekly:${phone}`;
    const weekCount = await redis.get(weekKey);
    if (weekCount && parseInt(weekCount, 10) >= MAX_MESSAGES_PER_WEEK) {
      console.log(`[Queue] Weekly cap reached for ${phone} (${weekCount}/${MAX_MESSAGES_PER_WEEK}). Skipping enqueue.`);
      return null;
    }
  } catch (_) {}

  // --- Blocked Number Check ---
  try {
    const blocked = await redis.get(`blocked:${phone}`);
    if (blocked) {
      console.log(`[Queue] Phone ${phone} is blocked/opted-out. Skipping enqueue.`);
      return null;
    }
  } catch (_) {}

  const rawSendAt = Date.now() + delayMs;
  const sendAt = getNextValidSendTime(rawSendAt);
  const memberKey = `${phone}:${tier}:${nudgeNum}`;
  const dataKey = `msg:${memberKey}`;

  const payload = {
    phone,
    tier,
    nudgeNum,
    sendAt,
    scheduledAt: new Date(sendAt).toISOString(),
    campaignName: campaignData.campaignName || '',
    fallbackCampaign: campaignData.fallbackCampaign || '',
    mediaUrl: campaignData.mediaUrl || '',
    templateParams: campaignData.templateParams || [],
    tags: campaignData.tags || [],
    attributes: campaignData.attributes || {},
    enqueuedAt: new Date().toISOString(),
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.zadd(QUEUE_KEY, { score: sendAt, member: memberKey });
    pipeline.set(dataKey, payload, { ex: 60 * 60 * 24 * 14 }); // 14 days TTL
    pipeline.sadd(`lead_queue:${phone}`, memberKey);
    await pipeline.exec();

    console.log(`[Queue] Enqueued ${memberKey} to fire at ${payload.scheduledAt}`);
    return payload;
  } catch (err) {
    console.error(`[Queue] Error enqueuing message ${memberKey}:`, err.message);
    return null;
  }
}

/**
 * Retrieve messages that are due for dispatch
 * @param {number} limit 
 * @returns {Promise<Array<object>>}
 */
async function getDueMessages(limit = 50) {
  const redis = getRedis();
  if (!redis) return [];

  const now = Date.now();

  try {
    // Get members whose score <= current time
    const readyMembers = await redis.zrange(QUEUE_KEY, 0, now, { byScore: true, count: limit });

    if (!readyMembers || readyMembers.length === 0) {
      return [];
    }

    const messages = [];
    for (const member of readyMembers) {
      const data = await redis.get(`msg:${member}`);
      if (data) {
        messages.push({ ...data, memberKey: member });
      } else {
        // Stale queue pointer cleanup
        await redis.zrem(QUEUE_KEY, member);
      }
    }

    return messages;
  } catch (err) {
    console.error('[Queue] Error fetching due messages:', err.message);
    return [];
  }
}

/**
 * Remove a single dispatched or canceled message from queue
 */
async function removeMessage(memberKey) {
  const redis = getRedis();
  if (!redis || !memberKey) return;

  try {
    const [phone] = memberKey.split(':');
    const pipeline = redis.pipeline();
    pipeline.zrem(QUEUE_KEY, memberKey);
    pipeline.del(`msg:${memberKey}`);
    if (phone) {
      pipeline.srem(`lead_queue:${phone}`, memberKey);
    }
    await pipeline.exec();
  } catch (err) {
    console.warn(`[Queue] Error removing message ${memberKey}:`, err.message);
  }
}

/**
 * Cancel and purge ALL pending messages for a customer phone (e.g. upon conversion)
 */
async function cancelAllMessagesForPhone(phone) {
  const redis = getRedis();
  if (!redis || !phone) return;

  try {
    const queueMembers = await redis.smembers(`lead_queue:${phone}`);
    if (!queueMembers || queueMembers.length === 0) return;

    const pipeline = redis.pipeline();
    for (const member of queueMembers) {
      pipeline.zrem(QUEUE_KEY, member);
      pipeline.del(`msg:${member}`);
    }
    pipeline.del(`lead_queue:${phone}`);
    await pipeline.exec();

    console.log(`[Queue] Purged all pending scheduled messages for converted lead: ${phone}`);
  } catch (err) {
    console.warn(`[Queue] Error canceling queue for ${phone}:`, err.message);
  }
}

/**
 * Increment the weekly send counter for a phone (called after successful dispatch)
 */
async function incrementWeeklyCount(phone) {
  const redis = getRedis();
  if (!redis || !phone) return;
  try {
    const weekKey = `rate:weekly:${phone}`;
    const current = await redis.incr(weekKey);
    if (current === 1) {
      // First message this week — set 7-day expiry
      await redis.expire(weekKey, 7 * 24 * 60 * 60);
    }
  } catch (err) {
    console.warn(`[Queue] Error incrementing weekly count for ${phone}:`, err.message);
  }
}

/**
 * Mark a phone as blocked/opted-out (stops all future messages)
 */
async function markPhoneBlocked(phone, reason = 'unknown') {
  const redis = getRedis();
  if (!redis || !phone) return;
  try {
    await redis.set(`blocked:${phone}`, { reason, blocked_at: new Date().toISOString() });
    await cancelAllMessagesForPhone(phone);
    console.log(`[Queue] Phone ${phone} marked as blocked/opted-out. Reason: ${reason}`);
  } catch (err) {
    console.warn(`[Queue] Error marking ${phone} as blocked:`, err.message);
  }
}

/**
 * Check if a phone is blocked
 */
async function isPhoneBlocked(phone) {
  const redis = getRedis();
  if (!redis || !phone) return false;
  try {
    const blocked = await redis.get(`blocked:${phone}`);
    return Boolean(blocked);
  } catch (_) {
    return false;
  }
}

module.exports = {
  QUEUE_KEY,
  MAX_MESSAGES_PER_WEEK,
  isWithinSendingHours,
  getNextValidSendTime,
  enqueueMessage,
  getDueMessages,
  removeMessage,
  cancelAllMessagesForPhone,
  incrementWeeklyCount,
  markPhoneBlocked,
  isPhoneBlocked,
};
