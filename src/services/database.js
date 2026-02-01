/**
 * MySQL database module for usage tracking
 *
 * Connects to the same MySQL database as nba-odds-app to track API usage.
 * This allows the proxy to enforce monthly rate limits with persistent storage.
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const logger = require('../utils/logger');

let pool = null;

// Cache apiKeyId lookups to avoid repeated DB queries
const apiKeyIdCache = new Map(); // keyHash -> { id, timestamp }
const API_KEY_ID_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Hash an API key using SHA-256 (same algorithm as nba-odds-app)
 * @param {string} apiKey - The raw API key
 * @returns {string} - SHA-256 hash
 */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Initialize the MySQL connection pool
 */
function initDatabase() {
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE || 'owls_insight';

  if (!host || !user || !password) {
    logger.warn('[database] MySQL credentials not configured - usage tracking will be in-memory only');
    return false;
  }

  try {
    pool = mysql.createPool({
      host,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    logger.info('[database] MySQL connection pool initialized');
    return true;
  } catch (err) {
    logger.error('[database] Failed to initialize MySQL pool:', err);
    return false;
  }
}

/**
 * Check if database is available
 */
function isDatabaseAvailable() {
  return pool !== null;
}

/**
 * Look up API key ID from the api_keys table by hash
 * @param {string} keyHash - SHA-256 hash of the API key
 * @returns {Promise<string|null>} - The API key ID or null if not found
 */
async function getApiKeyIdByHash(keyHash) {
  if (!pool) {
    return null;
  }

  // Check cache first
  const cached = apiKeyIdCache.get(keyHash);
  if (cached && Date.now() - cached.timestamp < API_KEY_ID_CACHE_TTL_MS) {
    return cached.id;
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id FROM api_keys WHERE key_hash = ? AND is_active = 1',
      [keyHash]
    );

    const id = rows[0]?.id || null;
    if (id) {
      apiKeyIdCache.set(keyHash, { id, timestamp: Date.now() });
    }
    return id;
  } catch (err) {
    logger.error('[database] Failed to look up API key ID:', err);
    return null;
  }
}

/**
 * Get monthly usage (sum of request_count for current month)
 * @param {string} apiKeyId - The API key ID from validation response
 * @returns {Promise<number>} - Monthly request count
 */
async function getMonthlyUsage(apiKeyId) {
  if (!pool) {
    return 0;
  }

  try {
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const firstOfMonthStr = firstOfMonth.toISOString().split('T')[0];

    const [rows] = await pool.execute(
      `SELECT COALESCE(SUM(request_count), 0) as total
       FROM usage_daily
       WHERE api_key_id = ? AND date >= ?`,
      [apiKeyId, firstOfMonthStr]
    );

    return rows[0]?.total || 0;
  } catch (err) {
    logger.error('[database] Failed to get monthly usage:', err);
    return 0;
  }
}

/**
 * Increment daily usage by 1 request
 * Returns the new monthly total after increment
 * @param {string} apiKeyId - The API key ID from validation response
 * @returns {Promise<number>} - New monthly total
 */
async function incrementUsage(apiKeyId) {
  if (!pool) {
    return 0;
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    // Increment or insert today's count
    await pool.execute(
      `INSERT INTO usage_daily (api_key_id, date, request_count, success_count)
       VALUES (?, ?, 1, 1)
       ON DUPLICATE KEY UPDATE
         request_count = request_count + 1,
         success_count = success_count + 1,
         updated_at = NOW()`,
      [apiKeyId, today]
    );

    // Return the new monthly total
    return getMonthlyUsage(apiKeyId);
  } catch (err) {
    logger.error('[database] Failed to increment usage:', err);
    return 0;
  }
}

/**
 * Track usage for a raw API key
 * Hashes the key, looks up the ID, and increments usage
 * @param {string} apiKey - The raw API key
 * @returns {Promise<{monthlyUsage: number, monthlyLimit: number}|null>} - Usage data or null if tracking failed
 */
async function trackUsageByApiKey(apiKey) {
  if (!pool) {
    return null;
  }

  try {
    const keyHash = hashApiKey(apiKey);
    const apiKeyId = await getApiKeyIdByHash(keyHash);

    if (!apiKeyId) {
      logger.debug('[database] API key ID not found for hash');
      return null;
    }

    const monthlyUsage = await incrementUsage(apiKeyId);
    return { monthlyUsage };
  } catch (err) {
    logger.error('[database] Failed to track usage:', err);
    return null;
  }
}

/**
 * Get monthly usage for a raw API key
 * @param {string} apiKey - The raw API key
 * @returns {Promise<number>} - Monthly request count or 0 if not found
 */
async function getMonthlyUsageByApiKey(apiKey) {
  if (!pool) {
    return 0;
  }

  try {
    const keyHash = hashApiKey(apiKey);
    const apiKeyId = await getApiKeyIdByHash(keyHash);

    if (!apiKeyId) {
      return 0;
    }

    return getMonthlyUsage(apiKeyId);
  } catch (err) {
    logger.error('[database] Failed to get monthly usage:', err);
    return 0;
  }
}

/**
 * Close the database connection pool
 */
async function closeDatabase() {
  if (pool) {
    try {
      await pool.end();
      logger.info('[database] MySQL connection pool closed');
    } catch (err) {
      logger.error('[database] Error closing MySQL pool:', err);
    }
    pool = null;
  }
}

module.exports = {
  initDatabase,
  isDatabaseAvailable,
  hashApiKey,
  getApiKeyIdByHash,
  getMonthlyUsage,
  getMonthlyUsageByApiKey,
  incrementUsage,
  trackUsageByApiKey,
  closeDatabase,
};
