CREATE TABLE IF NOT EXISTS ai_usage (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  round_id text,
  phase text NOT NULL,
  operation text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  cached_tokens integer,
  reasoning_tokens integer,
  duration_ms integer NOT NULL,
  estimated_cost_usd double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_session ON ai_usage(session_id, created_at);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  username text NOT NULL,
  credential_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
