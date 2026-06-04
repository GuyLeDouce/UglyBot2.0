// src/db.js
// Postgres store for The Gauntlet (Railway-friendly, non-destructive)
//
// - Uses DATABASE_URL for main data and DATABASE_URL_DRIP for DRIP overrides
// - Creates tables if they don't exist
// - NEVER drops tables unless GAUNTLET_RESET is explicitly "true" (or true)
// - Exposes a singleton Store + initStore()

const { Pool } = require("pg");
const { GAUNTLET_RESET, getSSL } = require("./utils");

// ------------------------------------------------------------
// INTERNAL HELPERS
// ------------------------------------------------------------

// Be VERY explicit about when we reset.
// Only if GAUNTLET_RESET is literally "true" or boolean true.
const shouldReset =
  GAUNTLET_RESET === true || GAUNTLET_RESET === "true";

function log(...args) {
  console.log("[GAUNTLET:DB]", ...args);
}

function connectionHost(connectionString) {
  try {
    return new URL(connectionString).host || "unknown host";
  } catch {
    return "unknown host";
  }
}

function uniqueConnectionCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const value = String(candidate.value || "").trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    candidate.value = value;
    return true;
  });
}

function getMainDatabaseCandidates() {
  return uniqueConnectionCandidates([
    { source: "GAUNTLET_DATABASE_URL", value: process.env.GAUNTLET_DATABASE_URL },
    { source: "DATABASE_URL", value: process.env.DATABASE_URL },
    { source: "DATABASE_PUBLIC_URL", value: process.env.DATABASE_PUBLIC_URL },
    { source: "POSTGRES_PUBLIC_URL", value: process.env.POSTGRES_PUBLIC_URL },
    { source: "DATABASE_URL_DRIP", value: process.env.DATABASE_URL_DRIP },
    { source: "DATABASE_PUBLIC_URL_DRIP", value: process.env.DATABASE_PUBLIC_URL_DRIP },
  ]);
}

function getDripDatabaseCandidate(mainConnectionString) {
  return uniqueConnectionCandidates([
    { source: "DATABASE_URL_DRIP", value: process.env.DATABASE_URL_DRIP },
    { source: "DATABASE_PUBLIC_URL_DRIP", value: process.env.DATABASE_PUBLIC_URL_DRIP },
    { source: "MAIN_DATABASE", value: mainConnectionString },
  ])[0];
}

// ------------------------------------------------------------
// PG STORE
// ------------------------------------------------------------

class PgStore {
  constructor() {
    this.pool = null;
    this.dripPool = null;
    this.mainConnectionSource = null;
    this.mainConnectionString = null;
    this.dripConnectionSource = null;
    this._initialized = false;
    this._keepAliveTimer = null;
  }

  _buildPool(connectionString, label) {
    const pool = new Pool({
      connectionString,
      ssl: getSSL(connectionString),
    });
    // Prevent unhandled pool errors from crashing the process.
    pool.on("error", (err) => {
      log(`Postgres ${label} pool error (will continue):`, err?.message || err);
    });
    return pool;
  }

  async _connectMainPool() {
    const candidates = getMainDatabaseCandidates();
    if (!candidates.length) {
      throw new Error(
        "[GAUNTLET:DB] No main database URL is set. Set DATABASE_URL, GAUNTLET_DATABASE_URL, or DATABASE_PUBLIC_URL in Railway variables."
      );
    }

    let lastError = null;
    for (const candidate of candidates) {
      if (this.pool) {
        await this.pool.end().catch(() => {});
      }

      this.pool = this._buildPool(candidate.value, "main");
      log(`Trying main DB via ${candidate.source} (${connectionHost(candidate.value)})...`);

      try {
        await this.pool.query("SELECT 1");
        this.mainConnectionSource = candidate.source;
        this.mainConnectionString = candidate.value;
        log(`DB health check OK (${candidate.source}).`);
        return;
      } catch (err) {
        lastError = err;
        log(`DB health check FAILED (${candidate.source}):`, err?.message || err);
      }
    }

    throw new Error(
      [
        "[GAUNTLET:DB] Main database is unreachable.",
        "The main Gauntlet database is required at startup.",
        "Railway private URLs only work when the bot and Postgres are in the same project/environment.",
        `Original error: ${lastError?.message || lastError}`,
      ].join(" ")
    );
  }

  async init() {
    if (this._initialized) {
      return;
    }

    log("Connecting to Postgres...");

    // Health check: verify we can reach the main DB at startup.
    await this._connectMainPool();

    const dripCandidate = getDripDatabaseCandidate(this.mainConnectionString);
    this.dripConnectionSource = dripCandidate.source;
    this.dripPool = this._buildPool(dripCandidate.value, "DRIP");

    try {
      await this.dripPool.query("SELECT 1");
      log(`DRIP DB health check OK (${dripCandidate.source}).`);
    } catch (err) {
      log("DRIP DB health check FAILED:", err?.message || err);
    }

    // Optional destructive reset – ONLY when explicitly enabled
    if (shouldReset) {
      log("GAUNTLET_RESET=true → DROPPING ALL GAUNTLET TABLES");
      await this.pool.query(`
        DROP TABLE IF EXISTS gauntlet_scores;
        DROP TABLE IF EXISTS gauntlet_plays;
        DROP TABLE IF EXISTS gauntlet_daily;
        DROP TABLE IF EXISTS gauntlet_charm_daily_grants;
        DROP TABLE IF EXISTS gauntlet_charm_inventory;
        DROP TABLE IF EXISTS gauntlet_item_daily_grants;
        DROP TABLE IF EXISTS gauntlet_item_inventory;
        DROP TABLE IF EXISTS gauntlet_runs;
        DROP TABLE IF EXISTS gauntlet_lb_messages;
        DROP TABLE IF EXISTS gauntlet_survival_settings;
        DROP TABLE IF EXISTS gauntlet_survival_lobby;
      `);
      await this.dripPool.query(`
        DROP TABLE IF EXISTS gauntlet_drip_user_overrides;
      `);
    } else {
      log("GAUNTLET_RESET is not true → keeping existing data");
    }

    // Main runs table: one row per completed game
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_runs (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        month TEXT NOT NULL,
        score INTEGER NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await this.pool.query(`
      ALTER TABLE gauntlet_runs
      ADD COLUMN IF NOT EXISTS result_type TEXT;
    `);
    await this.pool.query(`
      ALTER TABLE gauntlet_runs
      ADD COLUMN IF NOT EXISTS final_round INTEGER;
    `);
    await this.pool.query(`
      ALTER TABLE gauntlet_runs
      ADD COLUMN IF NOT EXISTS max_greed_level INTEGER NOT NULL DEFAULT 0;
    `);

    // Daily limit table: track if a user has played today
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_daily (
        user_id TEXT NOT NULL,
        play_date DATE NOT NULL,
        PRIMARY KEY (user_id, play_date)
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_item_inventory (
        user_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, item_key),
        CONSTRAINT gauntlet_item_inventory_quantity_check CHECK (quantity >= 0)
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_item_daily_grants (
        user_id TEXT NOT NULL,
        grant_date DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, grant_date)
      );
    `);
    const oldCharmInventory = await this.pool
      .query("SELECT to_regclass('public.gauntlet_charm_inventory') AS table_name")
      .catch(() => null);
    if (oldCharmInventory?.rows?.[0]?.table_name) {
      await this.pool.query(`
        INSERT INTO gauntlet_item_inventory (user_id, item_key, quantity, updated_at)
        SELECT user_id, charm_key, quantity, updated_at
        FROM gauntlet_charm_inventory
        ON CONFLICT (user_id, item_key)
        DO UPDATE SET
          quantity = GREATEST(gauntlet_item_inventory.quantity, EXCLUDED.quantity),
          updated_at = GREATEST(gauntlet_item_inventory.updated_at, EXCLUDED.updated_at);
      `);
    }

    const oldCharmDailyGrants = await this.pool
      .query("SELECT to_regclass('public.gauntlet_charm_daily_grants') AS table_name")
      .catch(() => null);
    if (oldCharmDailyGrants?.rows?.[0]?.table_name) {
      await this.pool.query(`
        INSERT INTO gauntlet_item_daily_grants (user_id, grant_date, created_at)
        SELECT user_id, grant_date, created_at
        FROM gauntlet_charm_daily_grants
        ON CONFLICT DO NOTHING;
      `);
    }

    // LB messages table: one per (guild, channel, month)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_lb_messages (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        month TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, channel_id, month)
      );
    `);

    // Active Squig Survival lobby (single row).
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_survival_lobby (
        id TEXT PRIMARY KEY,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        game_status TEXT NOT NULL,
        channel_id TEXT,
        guild_id TEXT,
        join_message_id TEXT,
        era TEXT,
        pool_increment INTEGER,
        countdown_end TIMESTAMPTZ,
        joined_ids JSONB NOT NULL DEFAULT '[]',
        settings JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    await this.pool.query(`
      ALTER TABLE gauntlet_survival_lobby
      ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_survival_settings (
        id TEXT PRIMARY KEY,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_survival_share_claims (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reward_amount INTEGER NOT NULL DEFAULT 0,
        source_message_id TEXT,
        source_channel_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, user_id)
      );
    `);

    // Manual DRIP routing override for Discord IDs.
    await this.dripPool.query(`
      CREATE TABLE IF NOT EXISTS gauntlet_drip_user_overrides (
        discord_user_id TEXT PRIMARY KEY,
        drip_user_id TEXT NOT NULL,
        drip_credential_type TEXT NOT NULL DEFAULT 'drip-id',
        added_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await this.dripPool.query(`
      ALTER TABLE gauntlet_drip_user_overrides
      ADD COLUMN IF NOT EXISTS drip_credential_type TEXT NOT NULL DEFAULT 'drip-id';
    `);
    await this.dripPool.query(`
      ALTER TABLE gauntlet_drip_user_overrides
      ALTER COLUMN drip_credential_type SET DEFAULT 'drip-id';
    `);

    this._initialized = true;
    log("Database ready.");

    // Keep-alive: reduce idle disconnects (Railway can drop idle connections).
    if (!this._keepAliveTimer) {
      const minutes = Number(process.env.PG_KEEPALIVE_MINUTES || "5");
      const intervalMs = Math.max(1, minutes) * 60_000;
      this._keepAliveTimer = setInterval(async () => {
        try {
          await this.pool.query("SELECT 1");
        } catch (err) {
          log("DB keep-alive failed:", err?.message || err);
        }
        try {
          await this.dripPool.query("SELECT 1");
        } catch (err) {
          log("DRIP DB keep-alive failed:", err?.message || err);
        }
      }, intervalMs);
      // Don't keep the process alive just for the timer.
      if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
      log(`DB keep-alive every ${minutes} minute(s).`);
    }
  }

  // ----------------------------------------------------------
  // DAILY PLAY LIMIT
  // ----------------------------------------------------------

  /**
   * Record that a user has played today.
   * @param {string} userId
   * @param {string} dateStr - YYYY-MM-DD
   */
  async recordPlay(userId, dateStr) {
    await this.pool.query(
      `
      INSERT INTO gauntlet_daily (user_id, play_date)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [userId, dateStr]
    );
  }

  /**
   * Has this user already played today?
   * @param {string} userId
   * @param {string} dateStr - YYYY-MM-DD
   * @returns {Promise<boolean>}
   */
  async hasPlayed(userId, dateStr) {
    const r = await this.pool.query(
      `
      SELECT 1
      FROM gauntlet_daily
      WHERE user_id = $1 AND play_date = $2
      LIMIT 1
      `,
      [userId, dateStr]
    );
    return r.rowCount > 0;
  }

  // ----------------------------------------------------------
  // RUNS (SCORES)
  // ----------------------------------------------------------

  /**
   * Insert a completed run.
   * @param {string} userId
   * @param {string} username
   * @param {string} month - e.g. "2025-11"
   * @param {number} score
   */
  async insertRun(userId, username, month, score, options = {}) {
    await this.pool.query(
      `
      INSERT INTO gauntlet_runs (
        user_id,
        username,
        month,
        score,
        result_type,
        final_round,
        max_greed_level
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        userId,
        username,
        month,
        score,
        options.resultType || null,
        Number.isInteger(options.finalRound) ? options.finalRound : null,
        Math.max(0, Number(options.maxGreedLevel || 0) || 0),
      ]
    );
  }

  async getGauntletItemInventory(userId) {
    const r = await this.pool.query(
      `
      SELECT item_key, quantity
      FROM gauntlet_item_inventory
      WHERE user_id = $1
      `,
      [userId]
    );

    return Object.fromEntries(
      (r.rows || []).map((row) => [
        row.item_key,
        Math.max(0, Number(row.quantity || 0) || 0),
      ])
    );
  }

  async addGauntletItems(userId, grants = {}) {
    const entries = Object.entries(grants)
      .map(([itemKey, quantity]) => [itemKey, Math.max(0, Number(quantity || 0) || 0)])
      .filter(([, quantity]) => quantity > 0);

    for (const [itemKey, quantity] of entries) {
      await this.pool.query(
        `
        INSERT INTO gauntlet_item_inventory (user_id, item_key, quantity, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (user_id, item_key)
        DO UPDATE SET
          quantity = gauntlet_item_inventory.quantity + EXCLUDED.quantity,
          updated_at = now()
        `,
        [userId, itemKey, quantity]
      );
    }
  }

  async consumeGauntletItem(userId, itemKey) {
    const r = await this.pool.query(
      `
      UPDATE gauntlet_item_inventory
      SET
        quantity = quantity - 1,
        updated_at = now()
      WHERE user_id = $1
        AND item_key = $2
        AND quantity > 0
      RETURNING quantity
      `,
      [userId, itemKey]
    );
    return r.rowCount > 0;
  }

  async grantDailyGauntletItemKit(userId, dateStr, grants = {}) {
    const r = await this.pool.query(
      `
      INSERT INTO gauntlet_item_daily_grants (user_id, grant_date)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING user_id
      `,
      [userId, dateStr]
    );

    if (r.rowCount === 0) {
      return false;
    }

    await this.addGauntletItems(userId, grants);
    return true;
  }

  async getSurvivalShareClaim(sessionId, userId) {
    const r = await this.pool.query(
      `
      SELECT
        session_id,
        user_id,
        reward_amount,
        source_message_id,
        source_channel_id,
        created_at
      FROM gauntlet_survival_share_claims
      WHERE session_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [sessionId, userId]
    );
    return r.rows[0] || null;
  }

  async createSurvivalShareClaim(
    sessionId,
    userId,
    rewardAmount,
    sourceMessageId,
    sourceChannelId
  ) {
    const r = await this.pool.query(
      `
      INSERT INTO gauntlet_survival_share_claims (
        session_id,
        user_id,
        reward_amount,
        source_message_id,
        source_channel_id
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (session_id, user_id) DO NOTHING
      RETURNING
        session_id,
        user_id,
        reward_amount,
        source_message_id,
        source_channel_id,
        created_at
      `,
      [sessionId, userId, rewardAmount, sourceMessageId || null, sourceChannelId || null]
    );
    return r.rows[0] || null;
  }

  async deleteSurvivalShareClaim(sessionId, userId) {
    await this.pool.query(
      `
      DELETE FROM gauntlet_survival_share_claims
      WHERE session_id = $1 AND user_id = $2
      `,
      [sessionId, userId]
    );
  }

  /**
   * Get top players for a given month.
   * Ranked by:
   *   1) highest single-game score ("best")
   *   2) total points ("total")
   *   3) username (ASC)
   *
   * Returns rows like:
   * { user_id, username, best, total }
   */
  async getMonthlyTop(month, limit = 10) {
    const r = await this.pool.query(
      `
      SELECT
        user_id,
        MAX(username) AS username,
        MAX(score) AS best,
        SUM(score) AS total
      FROM gauntlet_runs
      WHERE month = $1
      GROUP BY user_id
      ORDER BY best DESC, total DESC, username ASC
      LIMIT $2
      `,
      [month, limit]
    );
    return r.rows;
  }

  /**
   * Get recent runs for a given month, newest first.
   * Returns rows like:
   * { user_id, username, score, finished_at }
   */
  async getRecentRuns(month, limit = 10) {
    const r = await this.pool.query(
      `
      SELECT user_id, username, score, finished_at
      FROM gauntlet_runs
      WHERE month = $1
      ORDER BY finished_at DESC
      LIMIT $2
      `,
      [month, limit]
    );
    return r.rows;
  }

  /**
   * Get my stats for a given month:
   * best (max), least (min), total (sum), plays (count).
   */
  async getMyMonth(userId, month) {
    const r = await this.pool.query(
      `
      SELECT
        COALESCE(MAX(score), 0) AS best,
        COALESCE(MIN(score), 0) AS least,
        COALESCE(SUM(score), 0) AS total,
        COUNT(*) AS plays,
        COALESCE(MAX(max_greed_level), 0) AS max_greed_level
      FROM gauntlet_runs
      WHERE user_id = $1 AND month = $2
      `,
      [userId, month]
    );

    return r.rows[0] || { best: 0, least: 0, total: 0, plays: 0, max_greed_level: 0 };
  }

  /**
   * Get top players for a given month by total points.
   * Returns rows like:
   * { user_id, username, total, best }
   */
  async getMonthlyTopByTotal(month, limit = 10) {
    const r = await this.pool.query(
      `
      SELECT
        user_id,
        MAX(username) AS username,
        SUM(score) AS total,
        MAX(score) AS best
      FROM gauntlet_runs
      WHERE month = $1
      GROUP BY user_id
      ORDER BY total DESC, best DESC, username ASC
      LIMIT $2
      `,
      [month, limit]
    );
    return r.rows;
  }

  // ----------------------------------------------------------
  // LEADERBOARD MESSAGE TRACKING
  // ----------------------------------------------------------

  /**
   * Upsert a stored leaderboard message ID for a guild/channel/month.
   */
  async upsertLbMessage(guildId, channelId, month, messageId) {
    await this.pool.query(
      `
      INSERT INTO gauntlet_lb_messages (guild_id, channel_id, month, message_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (guild_id, channel_id, month)
      DO UPDATE SET message_id = EXCLUDED.message_id
      `,
      [guildId, channelId, month, messageId]
    );
  }

  /**
   * Get all leaderboard messages for a month.
   * Returns rows like:
   * { guild_id, channel_id, message_id }
   */
  async getLbMessages(month) {
    const r = await this.pool.query(
      `
      SELECT guild_id, channel_id, message_id
      FROM gauntlet_lb_messages
      WHERE month = $1
      `,
      [month]
    );
    return r.rows;
  }

  // ----------------------------------------------------------
  // SURVIVAL LOBBY (PERSISTED)
  // ----------------------------------------------------------

  async upsertSurvivalLobby(lobby) {
    const joinedIds = Array.from(lobby?.joined || []);
    const createdAt =
      lobby?.created_at instanceof Date
        ? lobby.created_at
        : lobby?.created_at
        ? new Date(lobby.created_at)
        : new Date();
    const countdownEnd =
      typeof lobby?.countdown_end === "number"
        ? new Date(lobby.countdown_end)
        : lobby?.countdown_end
        ? new Date(lobby.countdown_end)
        : null;

    await this.pool.query(
      `
      INSERT INTO gauntlet_survival_lobby (
        id,
        created_by,
        created_at,
        game_status,
        channel_id,
        guild_id,
        join_message_id,
        era,
        pool_increment,
        countdown_end,
        joined_ids,
        settings
      )
      VALUES (
        'active',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11
      )
      ON CONFLICT (id)
      DO UPDATE SET
        created_by = EXCLUDED.created_by,
        created_at = EXCLUDED.created_at,
        game_status = EXCLUDED.game_status,
        channel_id = EXCLUDED.channel_id,
        guild_id = EXCLUDED.guild_id,
        join_message_id = EXCLUDED.join_message_id,
        era = EXCLUDED.era,
        pool_increment = EXCLUDED.pool_increment,
        countdown_end = EXCLUDED.countdown_end,
        joined_ids = EXCLUDED.joined_ids,
        settings = EXCLUDED.settings
      `,
      [
        lobby?.created_by || null,
        createdAt,
        lobby?.game_status || "lobby",
        lobby?.channel_id || null,
        lobby?.guild_id || null,
        lobby?.join_message_id || null,
        lobby?.era || null,
        Number(lobby?.pool_increment || 0) || 0,
        countdownEnd,
        JSON.stringify(joinedIds),
        JSON.stringify(lobby?.settings || {}),
      ]
    );
  }

  async getSurvivalLobby() {
    const r = await this.pool.query(
      `
      SELECT
        created_by,
        created_at,
        game_status,
        channel_id,
        guild_id,
        join_message_id,
        era,
        pool_increment,
        countdown_end,
        joined_ids,
        settings
      FROM gauntlet_survival_lobby
      WHERE id = 'active'
      LIMIT 1
      `
    );
    return r.rows[0] || null;
  }

  async clearSurvivalLobby() {
    await this.pool.query(
      `
      DELETE FROM gauntlet_survival_lobby
      WHERE id = 'active'
      `
    );
  }

  async upsertSurvivalSettings(settings) {
    await this.pool.query(
      `
      INSERT INTO gauntlet_survival_settings (id, settings, updated_at)
      VALUES ('standard', $1, now())
      ON CONFLICT (id)
      DO UPDATE SET
        settings = EXCLUDED.settings,
        updated_at = now()
      `,
      [JSON.stringify(settings || {})]
    );
  }

  async getSurvivalSettings() {
    const r = await this.pool.query(
      `
      SELECT settings
      FROM gauntlet_survival_settings
      WHERE id = 'standard'
      LIMIT 1
      `
    );
    return r.rows[0]?.settings || null;
  }

  // ----------------------------------------------------------
  // DRIP USER OVERRIDES
  // ----------------------------------------------------------

  /**
   * Upsert manual DRIP user mapping for a Discord user ID.
   */
  async upsertDripUserOverride(
    discordUserId,
    dripUserId,
    addedBy,
    dripCredentialType = "drip-id"
  ) {
    await this.dripPool.query(
      `
      INSERT INTO gauntlet_drip_user_overrides (
        discord_user_id,
        drip_user_id,
        drip_credential_type,
        added_by
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (discord_user_id)
      DO UPDATE SET
        drip_user_id = EXCLUDED.drip_user_id,
        drip_credential_type = EXCLUDED.drip_credential_type,
        added_by = EXCLUDED.added_by,
        updated_at = now()
      `,
      [
        discordUserId,
        dripUserId,
        dripCredentialType || "drip-id",
        addedBy || null,
      ]
    );
  }

  /**
   * Get manual DRIP user mapping for a Discord user ID.
   */
  async getDripUserOverride(discordUserId) {
    const r = await this.dripPool.query(
      `
      SELECT
        discord_user_id,
        drip_user_id,
        drip_credential_type,
        added_by,
        created_at,
        updated_at
      FROM gauntlet_drip_user_overrides
      WHERE discord_user_id = $1
      LIMIT 1
      `,
      [discordUserId]
    );
    return r.rows[0] || null;
  }

  // ----------------------------------------------------------
  // OPTIONAL: CLEANUP (not required but nice to have)
  // ----------------------------------------------------------

  async close() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    await this.pool.end();
    await this.dripPool.end();
    log("Pool closed.");
  }
}

// ------------------------------------------------------------
// SINGLETON EXPORTS
// ------------------------------------------------------------

const Store = new PgStore();

/**
 * Call this once on bot startup.
 */
async function initStore() {
  await Store.init();
}

module.exports = {
  Store,
  initStore,
};
