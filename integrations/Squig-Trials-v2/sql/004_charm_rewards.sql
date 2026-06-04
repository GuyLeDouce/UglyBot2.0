ALTER TABLE trials
  ADD COLUMN IF NOT EXISTS reward_currency_id TEXT,
  ADD COLUMN IF NOT EXISTS reward_amount INT NOT NULL DEFAULT 0;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS drip_id TEXT,
  ADD COLUMN IF NOT EXISTS payout_status TEXT NOT NULL DEFAULT 'NOT_SENT',
  ADD COLUMN IF NOT EXISTS payout_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS payout_error TEXT;

CREATE INDEX IF NOT EXISTS idx_submissions_payout_status ON submissions(payout_status);