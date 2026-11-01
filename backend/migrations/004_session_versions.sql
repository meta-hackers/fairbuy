-- Session identity is stable; every subsequent state is an immutable revision.
-- Old normalized tables remain untouched for migration/rollback investigation.
-- Retained legacy expiry values are ignored; new identities have no expiry.
ALTER TABLE shopping_sessions ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE shopping_sessions ALTER COLUMN expires_at DROP NOT NULL;
CREATE TABLE IF NOT EXISTS session_versions (
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 0),
  parent_version integer,
  kind text NOT NULL CHECK (kind IN ('created', 'migrated', 'changed', 'archived')),
  archived boolean NOT NULL DEFAULT false,
  revoked_feedback_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, version),
  FOREIGN KEY (session_id, parent_version) REFERENCES session_versions(session_id, version),
  CHECK (parent_version IS NULL OR version = parent_version + 1),
  CHECK (state->>'id' = session_id::text),
  CHECK ((state->>'version')::integer = version)
);
CREATE UNIQUE INDEX IF NOT EXISTS session_versions_baseline ON session_versions(session_id) WHERE parent_version IS NULL;

CREATE OR REPLACE FUNCTION reject_session_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Session records are immutable; append a new revision instead' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS session_versions_no_update ON session_versions;
CREATE TRIGGER session_versions_no_update BEFORE UPDATE ON session_versions
  FOR EACH ROW EXECUTE FUNCTION reject_session_update();
DROP TRIGGER IF EXISTS shopping_sessions_no_update ON shopping_sessions;
CREATE TRIGGER shopping_sessions_no_update BEFORE UPDATE ON shopping_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_session_update();
