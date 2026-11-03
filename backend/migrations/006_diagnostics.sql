-- Operational diagnostics, deliberately separate from immutable
-- shopping history. Session deletion also deletes its linked diagnostics.
CREATE TABLE IF NOT EXISTS diagnostic_events (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL,
  trace_id uuid NOT NULL,
  session_id uuid REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  round_id uuid,
  product_id varchar(100),
  source text NOT NULL CHECK (source IN ('browser', 'server')),
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  event varchar(80) NOT NULL,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagnostic_events_trace ON diagnostic_events(trace_id, created_at, sequence);
CREATE INDEX IF NOT EXISTS diagnostic_events_session ON diagnostic_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS diagnostic_events_created ON diagnostic_events(created_at DESC, sequence DESC);
CREATE UNIQUE INDEX IF NOT EXISTS diagnostic_events_browser_dedup ON diagnostic_events(trace_id, event) WHERE source = 'browser';
