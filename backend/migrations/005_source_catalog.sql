-- Persisted overrides for the curated discovery source catalog.
-- The built-in catalog remains in code; rows here add custom domains or replace
-- a built-in entry without duplicating the whole list in the database.
CREATE TABLE IF NOT EXISTS source_catalog_overrides (
  domain text PRIMARY KEY,
  entry jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS source_catalog_overrides_updated ON source_catalog_overrides(updated_at DESC);
