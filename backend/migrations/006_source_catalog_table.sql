-- The database is the runtime source of truth for discovery hints. The seed
-- file in data/source-catalog.ts is loaded by the seed script or at startup.
CREATE TABLE IF NOT EXISTS source_catalog (
  domain text PRIMARY KEY,
  entry jsonb NOT NULL,
  default_entry jsonb,
  seed_version text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS source_catalog_updated ON source_catalog(updated_at DESC);

-- Preserve any short-lived overrides created by the earlier overrides table.
-- They become custom entries until the seed script attaches a default.
INSERT INTO source_catalog(domain, entry, default_entry, seed_version, updated_by, updated_at)
SELECT domain, entry, NULL, NULL, updated_by, updated_at FROM source_catalog_overrides
ON CONFLICT (domain) DO NOTHING;
DROP TABLE IF EXISTS source_catalog_overrides;
