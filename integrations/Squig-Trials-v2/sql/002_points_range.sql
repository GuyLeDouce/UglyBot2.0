ALTER TABLE trials
  ADD COLUMN IF NOT EXISTS points_min INT,
  ADD COLUMN IF NOT EXISTS points_max INT;

UPDATE trials
SET points_min = COALESCE(points_min, points),
    points_max = COALESCE(points_max, points);

ALTER TABLE trials
  ALTER COLUMN points_min SET NOT NULL,
  ALTER COLUMN points_max SET NOT NULL;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS awarded_points INT,
  ADD COLUMN IF NOT EXISTS public_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_trials_points_range ON trials(points_min, points_max);
CREATE INDEX IF NOT EXISTS idx_submissions_awarded_points ON submissions(awarded_points);
