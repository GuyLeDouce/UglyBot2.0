ALTER TABLE submissions
  ALTER COLUMN proof_url DROP NOT NULL;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS awaiting_image BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS awaiting_image_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_submissions_awaiting_image ON submissions(awaiting_image);