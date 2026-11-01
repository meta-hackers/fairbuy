-- NULL for historical sessions: their original runtime settings are unknown.
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS startup_config jsonb;
