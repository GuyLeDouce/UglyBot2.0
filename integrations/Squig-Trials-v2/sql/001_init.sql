CREATE TABLE IF NOT EXISTS trials (
  id              BIGSERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  points          INT  NOT NULL DEFAULT 1,
  image_url       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at         TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'LIVE',

  live_channel_id TEXT NOT NULL,
  live_message_id TEXT NOT NULL,

  past_channel_id TEXT,
  past_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_trials_guild_status ON trials (guild_id, status);
CREATE INDEX IF NOT EXISTS idx_trials_ends_at ON trials (ends_at);

CREATE TABLE IF NOT EXISTS submissions (
  id              BIGSERIAL PRIMARY KEY,
  trial_id        BIGINT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  guild_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,

  proof_url       TEXT NOT NULL,
  description     TEXT,

  status          TEXT NOT NULL DEFAULT 'PENDING',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT,
  reject_reason   TEXT,

  review_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_submissions_trial_user ON submissions(trial_id, user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

CREATE TABLE IF NOT EXISTS points_events (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  trial_id    BIGINT REFERENCES trials(id) ON DELETE SET NULL,
  points      INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_points_events_guild_time ON points_events(guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_points_events_user_time ON points_events(user_id, created_at);
