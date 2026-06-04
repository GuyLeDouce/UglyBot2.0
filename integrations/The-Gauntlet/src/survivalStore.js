// src/survivalStore.js
// Postgres store for Squig Survival stats (separate DB via DATABASE_URL_SURVIVAL).

const { Pool } = require("pg");
const { getSSL } = require("./utils");

function log(...args) {
  console.log("[GAUNTLET:SURVDB]", ...args);
}

function getSurvivalDatabaseUrl() {
  if (process.env.DATABASE_URL_SURVIVAL) {
    return process.env.DATABASE_URL_SURVIVAL;
  }

  if (process.env.DATABASUE_URL_SURVIVAL) {
    log(
      "DATABASUE_URL_SURVIVAL is set, but the correct variable name is DATABASE_URL_SURVIVAL. Using the misspelled variable for now."
    );
    return process.env.DATABASUE_URL_SURVIVAL;
  }

  return null;
}

class SurvivalStore {
  constructor() {
    this.pool = null;
    this._initialized = false;
  }

  _buildPool() {
    if (this.pool) return;
    this.pool = new Pool({
      connectionString: getSurvivalDatabaseUrl(),
      ssl: getSSL(getSurvivalDatabaseUrl()),
    });
    this.pool.on("error", (err) => {
      log("Postgres pool error (will continue):", err?.message || err);
    });
  }

  async init() {
    if (this._initialized) return;

    if (!getSurvivalDatabaseUrl()) {
      log("DATABASE_URL_SURVIVAL not set. Survival DB disabled.");
      this._initialized = true;
      return;
    }

    this._buildPool();

    try {
      await this.pool.query("SELECT 1");
      log("DB health check OK.");
    } catch (err) {
      log("DB health check FAILED:", err?.message || err);
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS squig_survival_games (
        id BIGSERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS squig_survival_game_players (
        game_id BIGINT NOT NULL REFERENCES squig_survival_games(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        eliminations INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER NOT NULL DEFAULT 0,
        images_used INTEGER NOT NULL DEFAULT 0,
        placement INTEGER NULL,
        PRIMARY KEY (game_id, user_id)
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS squig_survival_game_joins (
        id BIGSERIAL PRIMARY KEY,
        game_id BIGINT NOT NULL REFERENCES squig_survival_games(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS squig_survival_image_uses (
        id BIGSERIAL PRIMARY KEY,
        game_id BIGINT NOT NULL REFERENCES squig_survival_games(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        image_url TEXT NOT NULL,
        used_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    this._initialized = true;
    log("Survival database ready.");
  }

  async _ensureReady() {
    await this.init();
    return !!this.pool;
  }

  async createGame(startedAt = new Date()) {
    if (!(await this._ensureReady())) return null;
    const r = await this.pool.query(
      `INSERT INTO squig_survival_games (started_at) VALUES ($1) RETURNING id`,
      [startedAt]
    );
    return r.rows[0]?.id || null;
  }

  async recordJoin(gameId, userId, joinedAt = new Date()) {
    if (!(await this._ensureReady())) return;
    await this.pool.query(
      `
      INSERT INTO squig_survival_game_joins (game_id, user_id, joined_at)
      VALUES ($1, $2, $3)
      `,
      [gameId, userId, joinedAt]
    );
    await this.pool.query(
      `
      INSERT INTO squig_survival_game_players (game_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [gameId, userId]
    );
  }

  async addElimination(gameId, userId, count = 1) {
    if (!(await this._ensureReady())) return;
    await this.pool.query(
      `
      INSERT INTO squig_survival_game_players (game_id, user_id, eliminations)
      VALUES ($1, $2, $3)
      ON CONFLICT (game_id, user_id)
      DO UPDATE SET eliminations = squig_survival_game_players.eliminations + EXCLUDED.eliminations
      `,
      [gameId, userId, count]
    );
  }

  async addDeath(gameId, userId, count = 1) {
    if (!(await this._ensureReady())) return;
    await this.pool.query(
      `
      INSERT INTO squig_survival_game_players (game_id, user_id, deaths)
      VALUES ($1, $2, $3)
      ON CONFLICT (game_id, user_id)
      DO UPDATE SET deaths = squig_survival_game_players.deaths + EXCLUDED.deaths
      `,
      [gameId, userId, count]
    );
  }

  async addImageUse(gameId, userId, imageUrl) {
    if (!(await this._ensureReady())) return;
    await this.pool.query(
      `
      INSERT INTO squig_survival_image_uses (game_id, user_id, image_url)
      VALUES ($1, $2, $3)
      `,
      [gameId, userId, imageUrl]
    );
    await this.pool.query(
      `
      INSERT INTO squig_survival_game_players (game_id, user_id, images_used)
      VALUES ($1, $2, 1)
      ON CONFLICT (game_id, user_id)
      DO UPDATE SET images_used = squig_survival_game_players.images_used + 1
      `,
      [gameId, userId]
    );
  }

  async setPlacement(gameId, userId, placement) {
    if (!(await this._ensureReady())) return;
    await this.pool.query(
      `
      INSERT INTO squig_survival_game_players (game_id, user_id, placement)
      VALUES ($1, $2, $3)
      ON CONFLICT (game_id, user_id)
      DO UPDATE SET placement = EXCLUDED.placement
      `,
      [gameId, userId, placement]
    );
  }

  _rangeStart(range) {
    const now = new Date();
    if (range === "all") return new Date(0);
    if (range === "week") {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return start;
    }
    // month (default): UTC month boundaries
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  _rangeEnd(range) {
    const now = new Date();
    if (range === "all") return now;
    if (range === "week") return now;
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }

  _parseMonthStart(monthKey) {
    if (typeof monthKey !== "string") return null;
    const match = monthKey.trim().match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!match) return null;
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    if (!Number.isInteger(year) || !Number.isInteger(monthIndex)) return null;
    return new Date(Date.UTC(year, monthIndex, 1));
  }

  async getMonthlyWinnersTop10(monthKey = null, limit = 10) {
    if (!(await this._ensureReady())) return [];
    let start = this._rangeStart("month");
    if (monthKey) {
      const parsed = this._parseMonthStart(monthKey);
      if (parsed) start = parsed;
    }
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
    const r = await this.pool.query(
      `
      SELECT
        gp.user_id,
        COUNT(*) FILTER (WHERE gp.placement = 1) AS firsts,
        COUNT(*) FILTER (WHERE gp.placement = 2) AS seconds,
        COUNT(*) FILTER (WHERE gp.placement = 3) AS thirds,
        COUNT(*) AS games
      FROM squig_survival_game_players gp
      JOIN squig_survival_games g ON g.id = gp.game_id
      WHERE g.started_at >= $1 AND g.started_at < $2
      GROUP BY gp.user_id
      ORDER BY firsts DESC, seconds DESC, thirds DESC, games DESC, gp.user_id ASC
      LIMIT $3
      `,
      [start, end, safeLimit]
    );
    return r.rows || [];
  }

  async getUserStats(userId, range = "month") {
    if (!(await this._ensureReady())) {
      return {
        games: 0,
        eliminations: 0,
        deaths: 0,
        images_used: 0,
        firsts: 0,
        seconds: 0,
        thirds: 0,
      };
    }
    const start = this._rangeStart(range);
    const end = this._rangeEnd(range);
    const r = await this.pool.query(
      `
      SELECT
        COUNT(*) AS games,
        COALESCE(SUM(gp.eliminations), 0) AS eliminations,
        COALESCE(SUM(gp.deaths), 0) AS deaths,
        COALESCE(SUM(gp.images_used), 0) AS images_used,
        COUNT(*) FILTER (WHERE gp.placement = 1) AS firsts,
        COUNT(*) FILTER (WHERE gp.placement = 2) AS seconds,
        COUNT(*) FILTER (WHERE gp.placement = 3) AS thirds
      FROM squig_survival_game_players gp
      JOIN squig_survival_games g ON g.id = gp.game_id
      WHERE gp.user_id = $1 AND g.started_at >= $2 AND g.started_at < $3
      `,
      [userId, start, end]
    );
    return r.rows[0] || {
      games: 0,
      eliminations: 0,
      deaths: 0,
      images_used: 0,
      firsts: 0,
      seconds: 0,
      thirds: 0,
    };
  }

  async getOverallRank(userId) {
    if (!(await this._ensureReady())) return null;
    const r = await this.pool.query(
      `
      WITH totals AS (
        SELECT
          gp.user_id,
          COUNT(*) FILTER (WHERE gp.placement = 1) AS firsts,
          COUNT(*) FILTER (WHERE gp.placement = 2) AS seconds,
          COUNT(*) FILTER (WHERE gp.placement = 3) AS thirds,
          COUNT(*) AS games
        FROM squig_survival_game_players gp
        JOIN squig_survival_games g ON g.id = gp.game_id
        GROUP BY gp.user_id
      ),
      ranked AS (
        SELECT
          user_id,
          RANK() OVER (ORDER BY firsts DESC, seconds DESC, thirds DESC, games DESC, user_id ASC) AS rank
        FROM totals
      )
      SELECT rank FROM ranked WHERE user_id = $1
      `,
      [userId]
    );
    return r.rows[0]?.rank || null;
  }
}

const survivalStore = new SurvivalStore();

async function initSurvivalStore() {
  await survivalStore.init();
}

module.exports = {
  survivalStore,
  initSurvivalStore,
};
