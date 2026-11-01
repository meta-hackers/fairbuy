-- Normalized session storage. The former shopping_sessions.data JSONB blob is split
-- into session rows plus ordered child rows for messages, configuration, feedback,
-- discovery rounds, products, offers, evidence, attributes and sources.
CREATE TABLE IF NOT EXISTS shopping_sessions (
  id uuid PRIMARY KEY,
  owner_hash text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'demo' CHECK (mode IN ('live', 'demo')),
  stage text NOT NULL DEFAULT 'ask' CHECK (stage IN ('ask', 'configure', 'discovery', 'buy')),
  ask_session_id uuid,
  configure_session_id uuid,
  ready boolean NOT NULL DEFAULT false,
  selected_product_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
-- Upgrade an existing pre-normalization table in place. The application copies any
-- legacy JSONB session rows into the new tables, then drops the old data column.
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'demo';
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'ask';
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS ask_session_id uuid;
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS configure_session_id uuid;
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS ready boolean NOT NULL DEFAULT false;
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS selected_product_id text;
ALTER TABLE shopping_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'shopping_sessions' AND column_name = 'data') THEN
    ALTER TABLE shopping_sessions ALTER COLUMN data DROP NOT NULL;
  END IF;
END $$;
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

CREATE TABLE IF NOT EXISTS session_messages (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('ask', 'configure')),
  position integer NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, phase, position)
);
CREATE INDEX IF NOT EXISTS session_messages_session ON session_messages(session_id, phase, position);

CREATE TABLE IF NOT EXISTS session_configs (
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('current', 'initial')),
  category text,
  purpose text,
  budget_max double precision,
  budget_hard boolean NOT NULL DEFAULT false,
  currency text NOT NULL,
  country text,
  city text,
  PRIMARY KEY (session_id, scope)
);

CREATE TABLE IF NOT EXISTS session_config_requirements (
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('current', 'initial')),
  position integer NOT NULL,
  label text NOT NULL,
  hard boolean NOT NULL,
  attribute text,
  op text,
  value jsonb,
  unit text,
  PRIMARY KEY (session_id, scope, position)
);

CREATE TABLE IF NOT EXISTS session_missing (
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  position integer NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (session_id, position)
);

CREATE TABLE IF NOT EXISTS session_feedback (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  position integer NOT NULL,
  product_id text,
  product_name text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, position)
);
CREATE INDEX IF NOT EXISTS session_feedback_session ON session_feedback(session_id, position);

CREATE TABLE IF NOT EXISTS feedback_requirements (
  feedback_id uuid NOT NULL REFERENCES session_feedback(id) ON DELETE CASCADE,
  position integer NOT NULL,
  label text NOT NULL,
  hard boolean NOT NULL,
  attribute text,
  op text,
  value jsonb,
  unit text,
  PRIMARY KEY (feedback_id, position)
);

CREATE TABLE IF NOT EXISTS discovery_rounds (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shopping_sessions(id) ON DELETE CASCADE,
  number integer NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('configure', 'learn', 'refresh')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms bigint,
  summary text NOT NULL DEFAULT '',
  error text,
  initial_request text NOT NULL DEFAULT '',
  UNIQUE (session_id, number)
);
CREATE INDEX IF NOT EXISTS discovery_rounds_session ON discovery_rounds(session_id, number);

CREATE TABLE IF NOT EXISTS round_configs (
  round_id uuid NOT NULL REFERENCES discovery_rounds(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('current', 'initial')),
  category text,
  purpose text,
  budget_max double precision,
  budget_hard boolean NOT NULL DEFAULT false,
  currency text NOT NULL,
  country text,
  city text,
  PRIMARY KEY (round_id, scope)
);

CREATE TABLE IF NOT EXISTS round_config_requirements (
  round_id uuid NOT NULL REFERENCES discovery_rounds(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('current', 'initial')),
  position integer NOT NULL,
  label text NOT NULL,
  hard boolean NOT NULL,
  attribute text,
  op text,
  value jsonb,
  unit text,
  PRIMARY KEY (round_id, scope, position)
);

CREATE TABLE IF NOT EXISTS round_feedback (
  round_id uuid NOT NULL REFERENCES discovery_rounds(id) ON DELETE CASCADE,
  feedback_id uuid NOT NULL,
  position integer NOT NULL,
  product_id text,
  product_name text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (round_id, feedback_id),
  UNIQUE (round_id, position)
);

CREATE TABLE IF NOT EXISTS round_feedback_requirements (
  round_id uuid NOT NULL,
  feedback_id uuid NOT NULL,
  position integer NOT NULL,
  label text NOT NULL,
  hard boolean NOT NULL,
  attribute text,
  op text,
  value jsonb,
  unit text,
  PRIMARY KEY (round_id, feedback_id, position),
  FOREIGN KEY (round_id, feedback_id) REFERENCES round_feedback(round_id, feedback_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_products (
  round_id uuid NOT NULL REFERENCES discovery_rounds(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  position integer NOT NULL,
  name text NOT NULL,
  summary text NOT NULL,
  why text NOT NULL,
  image_url text,
  PRIMARY KEY (round_id, product_id)
);
CREATE INDEX IF NOT EXISTS round_products_round ON round_products(round_id, position);

CREATE TABLE IF NOT EXISTS round_product_tradeoffs (
  round_id uuid NOT NULL,
  product_id text NOT NULL,
  position integer NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (round_id, product_id, position),
  FOREIGN KEY (round_id, product_id) REFERENCES round_products(round_id, product_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_offers (
  round_id uuid NOT NULL,
  product_id text NOT NULL,
  offer_id text NOT NULL,
  position integer NOT NULL,
  category text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live', 'fixture')),
  provenance_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  availability text NOT NULL CHECK (availability IN ('available', 'sold_out', 'stale', 'unknown')),
  title text NOT NULL,
  seller text NOT NULL,
  condition_status text NOT NULL CHECK (condition_status IN ('verified', 'seller_claim', 'estimate', 'unknown')),
  condition_value text,
  condition_note text,
  currency text NOT NULL,
  final_price_cents integer,
  PRIMARY KEY (round_id, product_id, offer_id),
  FOREIGN KEY (round_id, product_id) REFERENCES round_products(round_id, product_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS round_offers_round ON round_offers(round_id, product_id, position);

CREATE TABLE IF NOT EXISTS round_offer_evidence (
  round_id uuid NOT NULL,
  product_id text NOT NULL,
  offer_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('offer', 'condition')),
  position integer NOT NULL,
  source_type text NOT NULL,
  ref text NOT NULL,
  snippet text,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (round_id, product_id, offer_id, scope, position),
  FOREIGN KEY (round_id, product_id, offer_id) REFERENCES round_offers(round_id, product_id, offer_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_offer_attributes (
  round_id uuid NOT NULL,
  product_id text NOT NULL,
  offer_id text NOT NULL,
  attribute_key text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL CHECK (status IN ('verified', 'seller_claim', 'estimate', 'unknown')),
  kind text CHECK (kind IN ('number', 'enum', 'bool', 'text')),
  number_value double precision,
  text_value text,
  boolean_value boolean,
  unit text,
  note text,
  PRIMARY KEY (round_id, product_id, offer_id, attribute_key),
  FOREIGN KEY (round_id, product_id, offer_id) REFERENCES round_offers(round_id, product_id, offer_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_offer_attribute_evidence (
  round_id uuid NOT NULL,
  product_id text NOT NULL,
  offer_id text NOT NULL,
  attribute_key text NOT NULL,
  position integer NOT NULL,
  source_type text NOT NULL,
  ref text NOT NULL,
  snippet text,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (round_id, product_id, offer_id, attribute_key, position),
  FOREIGN KEY (round_id, product_id, offer_id, attribute_key) REFERENCES round_offer_attributes(round_id, product_id, offer_id, attribute_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_offer_missing (
  round_id uuid NOT NULL,
  product_id text NOT NULL,
  offer_id text NOT NULL,
  position integer NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (round_id, product_id, offer_id, position),
  FOREIGN KEY (round_id, product_id, offer_id) REFERENCES round_offers(round_id, product_id, offer_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_sources (
  round_id uuid NOT NULL REFERENCES discovery_rounds(id) ON DELETE CASCADE,
  position integer NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  PRIMARY KEY (round_id, position)
);
