-- Buy-stage seller searches share the durable job queue with discovery rounds.
-- Older rows keep the default, so existing deployments upgrade in place.
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'discovery';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'discovery_jobs'::regclass AND conname = 'discovery_jobs_kind_check'
  ) THEN
    ALTER TABLE discovery_jobs ADD CONSTRAINT discovery_jobs_kind_check
      CHECK (kind IN ('discovery', 'seller_search'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS discovery_jobs_kind_pending ON discovery_jobs(kind, state, lease_until, created_at);
