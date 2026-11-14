-- Accounts belong to the server process, not to the core: a host that embeds the core brings its own identity.
CREATE TABLE IF NOT EXISTS pandocs.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (position('@' IN email) > 1),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  password_hash text,
  is_admin boolean NOT NULL DEFAULT false,
  groups text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON pandocs.users (lower(email));

-- One row per way in: a person can sign in through the company's OIDC and still keep a password.
CREATE TABLE IF NOT EXISTS pandocs.user_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES pandocs.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON pandocs.user_identities (user_id);

-- Only hashes are stored, so reading this table gives no one a way in.
CREATE TABLE IF NOT EXISTS pandocs.sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pandocs.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON pandocs.sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON pandocs.sessions (user_id);

-- A link for setting a password, for someone invited or someone who forgot theirs. Only hashes here too.
CREATE TABLE IF NOT EXISTS pandocs.password_links (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pandocs.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_links_user_idx ON pandocs.password_links (user_id);

CREATE TABLE IF NOT EXISTS pandocs.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES pandocs.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  -- An agent token acts for its owner but never gets more than comment and propose rights.
  kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'agent')),
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON pandocs.api_tokens (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pandocs.login_attempts (
  key text PRIMARY KEY,
  failures integer NOT NULL,
  window_start timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pandocs.llm_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  purpose text NOT NULL,
  model text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_usage_user_idx ON pandocs.llm_usage (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pandocs.server_secrets (
  name text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A system that embeds pages. Its secret stays on its server, which trades it for short-lived tokens for its own users.
CREATE TABLE IF NOT EXISTS pandocs.embed_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- Connecting an agent by signing in, instead of copying a token around: the OAuth flow MCP clients use.
ALTER TABLE pandocs.api_tokens ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'oauth'));

CREATE TABLE IF NOT EXISTS pandocs.oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pandocs.oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES pandocs.oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES pandocs.users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pandocs.oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES pandocs.oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES pandocs.users(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  refresh_hash text NOT NULL UNIQUE,
  access_token_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON pandocs.oauth_grants (user_id);

-- Codes and refresh tokens already spent. One coming back means two parties hold it, and nobody can tell which is the
-- app, so the grant it belongs to is withdrawn (RFC 9700, 4.14.2). Kept until the grant would have run out anyway.
CREATE TABLE IF NOT EXISTS pandocs.oauth_spent (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES pandocs.oauth_grants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_spent_grant_idx ON pandocs.oauth_spent (grant_id);

-- The command line, which signs people in from a terminal as themselves. Its name and address are kept to these, so
-- that nothing else can come to look like it.
INSERT INTO pandocs.oauth_clients (client_id, client_name, redirect_uris) VALUES ('pandocs-cli', 'Pandocs command line', ARRAY['http://127.0.0.1/callback'])
ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris;

-- What has been run, so that a replica starting up can leave the tables alone when there is nothing to do.
CREATE TABLE IF NOT EXISTS pandocs.applied_schemas (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
