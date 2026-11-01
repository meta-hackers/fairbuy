-- Run once as the Supabase postgres administrator using psql.
-- Supply FAIRBUY_DATABASE_PASSWORD through the environment, never in Git.
-- Refuse to overwrite an existing role/schema or rotate a live password.
\set ON_ERROR_STOP on
\getenv fairbuy_password FAIRBUY_DATABASE_PASSWORD
\if :{?fairbuy_password}
\else
  \echo 'Set FAIRBUY_DATABASE_PASSWORD securely before running this script.'
  \quit 1
\endif
SELECT length(:'fairbuy_password') >= 32 AS strong_password \gset
\if :strong_password
\else
  \echo 'Use a random FAIRBUY_DATABASE_PASSWORD of at least 32 characters.'
  \quit 1
\endif

BEGIN;
CREATE ROLE fairbuy_app LOGIN PASSWORD :'fairbuy_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
-- Supabase's postgres administrator needs membership to assign ownership.
GRANT fairbuy_app TO postgres;
GRANT CONNECT ON DATABASE postgres TO fairbuy_app;
CREATE SCHEMA fairbuy AUTHORIZATION fairbuy_app;
REVOKE ALL ON SCHEMA fairbuy FROM PUBLIC, anon, authenticated;
ALTER ROLE fairbuy_app IN DATABASE postgres SET search_path = fairbuy, pg_catalog;
COMMIT;
