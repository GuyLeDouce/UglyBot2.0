// src/imageStore.js
// Postgres store for Squig Survival images (separate DB via DATABASE_URL_IMAGE).

const { Pool } = require("pg");
const { getSSL } = require("./utils");

function log(...args) {
  console.log("[GAUNTLET:IMGDB]", ...args);
}

class ImageStore {
  constructor() {
    this.pool = null;
    this._initialized = false;
  }

  _buildPool() {
    if (this.pool) return;
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL_IMAGE,
      ssl: getSSL(),
    });
    this.pool.on("error", (err) => {
      log("Postgres pool error (will continue):", err?.message || err);
    });
  }

  async init() {
    if (this._initialized) return;

    if (!process.env.DATABASE_URL_IMAGE) {
      log("DATABASE_URL_IMAGE not set. Image DB disabled.");
      this._initialized = true;
      return;
    }

    if (process.env.IMAGE_DB_SAFE !== "true") {
      log(
        "IMAGE_DB_SAFE is not set to \"true\". Image DB disabled to prevent accidental destructive changes."
      );
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
      CREATE TABLE IF NOT EXISTS squig_survival_images (
        id BIGSERIAL PRIMARY KEY,
        image_url TEXT NOT NULL UNIQUE,
        user_id TEXT NULL,
        era_keys TEXT NULL,
        reward_points INTEGER NOT NULL DEFAULT 100,
        added_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await this.pool.query(`
      ALTER TABLE squig_survival_images
      ADD COLUMN IF NOT EXISTS era_keys TEXT NULL
    `);
    await this.pool.query(`
      ALTER TABLE squig_survival_images
      ADD COLUMN IF NOT EXISTS reward_points INTEGER NOT NULL DEFAULT 100
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS squig_survival_image_approval_notifications (
        id BIGSERIAL PRIMARY KEY,
        submission_id BIGINT,
        discord_user_id TEXT NOT NULL,
        discord_username TEXT NOT NULL,
        era_key TEXT NOT NULL,
        image_url TEXT NOT NULL,
        prompt_text TEXT,
        reward_points INTEGER NOT NULL DEFAULT 100,
        approved_by TEXT,
        approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        post_status TEXT NOT NULL DEFAULT 'pending',
        post_attempts INTEGER NOT NULL DEFAULT 0,
        posted_at TIMESTAMPTZ,
        posted_message_id TEXT,
        post_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT squig_survival_image_approval_notifications_status_check
          CHECK (post_status IN ('pending', 'processing', 'posted', 'failed'))
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_squig_survival_image_approval_notifications_status
      ON squig_survival_image_approval_notifications (post_status, approved_at ASC);
    `);
    await this.pool.query(`
      ALTER TABLE squig_survival_image_approval_notifications
      ADD COLUMN IF NOT EXISTS prompt_text TEXT
    `);

    this._initialized = true;
    log("Image database ready.");
  }

  async addSurvivalImage({
    imageUrl,
    userId = null,
    eraKeys = null,
    rewardPoints = 100,
    addedBy = null,
  }) {
    await this.init();

    if (!process.env.DATABASE_URL_IMAGE || !this.pool) {
      return { ok: false, reason: "DATABASE_URL_IMAGE not set" };
    }

    const r = await this.pool.query(
      `
      INSERT INTO squig_survival_images (image_url, user_id, era_keys, reward_points, added_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (image_url)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        era_keys = EXCLUDED.era_keys,
        reward_points = EXCLUDED.reward_points,
        added_by = EXCLUDED.added_by
      RETURNING id
      `,
      [imageUrl, userId, eraKeys, rewardPoints, addedBy]
    );

    return { ok: true, id: r.rows[0]?.id || null };
  }

  async getSurvivalImages() {
    await this.init();

    if (!process.env.DATABASE_URL_IMAGE || !this.pool) return [];

    const r = await this.pool.query(`
      SELECT image_url, user_id, era_keys, reward_points
      FROM squig_survival_images
      ORDER BY id ASC
    `);
    return r.rows || [];
  }

  async enqueueApprovalNotification({
    submissionId = null,
    discordUserId,
    discordUsername,
    eraKey,
    imageUrl,
    promptText = null,
    rewardPoints = 100,
    approvedBy = null,
  }) {
    await this.init();

    if (!process.env.DATABASE_URL_IMAGE || !this.pool) {
      return { ok: false, reason: "DATABASE_URL_IMAGE not set" };
    }

    const r = await this.pool.query(
      `
      INSERT INTO squig_survival_image_approval_notifications (
        submission_id,
        discord_user_id,
        discord_username,
        era_key,
        image_url,
        prompt_text,
        reward_points,
        approved_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      [
        submissionId,
        discordUserId,
        discordUsername,
        eraKey,
        imageUrl,
        promptText,
        rewardPoints,
        approvedBy,
      ]
    );

    return { ok: true, id: r.rows[0]?.id || null };
  }

  async claimNextApprovalNotification() {
    await this.init();

    if (!process.env.DATABASE_URL_IMAGE || !this.pool) return null;

    const r = await this.pool.query(
      `
      WITH next_notification AS (
        SELECT id
        FROM squig_survival_image_approval_notifications
        WHERE post_status IN ('pending', 'failed')
        ORDER BY approved_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE squig_survival_image_approval_notifications AS notifications
      SET
        post_status = 'processing',
        post_attempts = notifications.post_attempts + 1,
        post_error = NULL
      FROM next_notification
      WHERE notifications.id = next_notification.id
      RETURNING
        notifications.id,
        notifications.submission_id,
        notifications.discord_user_id,
        notifications.discord_username,
        notifications.era_key,
        notifications.image_url,
        notifications.prompt_text,
        notifications.reward_points,
        notifications.approved_by,
        notifications.approved_at,
        notifications.post_attempts
      `
    );

    return r.rows[0] || null;
  }

  async markApprovalNotificationPosted(notificationId, messageId = null) {
    await this.init();

    if (!process.env.DATABASE_URL_IMAGE || !this.pool) return false;

    await this.pool.query(
      `
      UPDATE squig_survival_image_approval_notifications
      SET
        post_status = 'posted',
        posted_at = now(),
        posted_message_id = $2,
        post_error = NULL
      WHERE id = $1
      `,
      [notificationId, messageId]
    );
    return true;
  }

  async markApprovalNotificationFailed(notificationId, errorMessage) {
    await this.init();

    if (!process.env.DATABASE_URL_IMAGE || !this.pool) return false;

    await this.pool.query(
      `
      UPDATE squig_survival_image_approval_notifications
      SET
        post_status = 'failed',
        post_error = $2
      WHERE id = $1
      `,
      [notificationId, String(errorMessage || "Unknown error").slice(0, 1000)]
    );
    return true;
  }
}

const imageStore = new ImageStore();

async function initImageStore() {
  await imageStore.init();
}

module.exports = {
  imageStore,
  initImageStore,
};
