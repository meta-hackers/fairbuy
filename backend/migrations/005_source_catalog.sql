-- The source catalog is database-backed. A successful GitHub sync replaces
-- every entry in one transaction, so the application only ever reads the last
-- complete catalog. There is intentionally no bundled application fallback.

CREATE TABLE IF NOT EXISTS source_catalog_entries (
  domain text PRIMARY KEY,
  name text NOT NULL,
  roles jsonb NOT NULL,
  verticals jsonb NOT NULL,
  countries jsonb NOT NULL,
  priority smallint NOT NULL,
  note text,
  enabled boolean,
  position integer NOT NULL
);
CREATE INDEX IF NOT EXISTS source_catalog_entries_position ON source_catalog_entries(position);

CREATE TABLE IF NOT EXISTS source_catalog_meta (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  url text,
  fetched_at timestamptz,
  version text NOT NULL
);
