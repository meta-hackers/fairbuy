CREATE TABLE IF NOT EXISTS shopping_sessions (
  id uuid PRIMARY KEY,
  owner_hash text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS shopping_sessions_owner ON shopping_sessions(owner_hash);
CREATE INDEX IF NOT EXISTS shopping_sessions_expiry ON shopping_sessions(expires_at);
CREATE TABLE IF NOT EXISTS discovery_jobs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discovery_jobs_pending ON discovery_jobs(state, lease_until, created_at);
