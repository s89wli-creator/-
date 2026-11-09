-- 0001 Foundation: identity, tenancy, team, territories, audit.
-- Runs as the schema owner. Requires role `rakan_app` to exist (see scripts/setup-dev.ts).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Tenant / user context, set per transaction by the application:
--   SELECT set_config('app.tenant_id', $1, true)
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_invitation_token_hash() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.invitation_token_hash', true), '')
$$;

-- ---------------------------------------------------------------------
-- Platform tables (no tenant_id; accessed only by identity/platform modules)
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  full_name          text   NOT NULL,
  password_hash      text,
  locale             text   NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  is_platform_admin  boolean NOT NULL DEFAULT false,
  email_verified_at  timestamptz,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  disabled_at        timestamptz
);

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             citext NOT NULL UNIQUE,
  legal_name       text,
  cr_number        text,
  vat_number       text,
  industry         text,
  country          char(2) NOT NULL DEFAULT 'SA',
  timezone         text NOT NULL DEFAULT 'Asia/Riyadh',
  default_locale   text NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar','en')),
  status           text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','suspended','cancelled')),
  settings         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  active_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  ip               inet,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  idle_expires_at  timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at       timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Tenant-owned tables (RLS)
-- ---------------------------------------------------------------------

CREATE TABLE memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('owner','manager','rep','readonly')),
  title            text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email            citext NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner','manager','rep','readonly')),
  title            text,
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid NOT NULL REFERENCES users(id),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX invitations_pending_uniq ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE territories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  regions          text[] NOT NULL DEFAULT '{}',
  cities           text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE territory_assignments (
  tenant_id        uuid NOT NULL,
  territory_id     uuid NOT NULL,
  membership_id    uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, territory_id, membership_id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type       text NOT NULL CHECK (actor_type IN ('user','agent','system','platform_admin')),
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action           text NOT NULL,
  entity_type      text,
  entity_id        uuid,
  before           jsonb,
  after            jsonb,
  ip               inet,
  user_agent       text,
  request_id       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, id DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id);

-- ---------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- A signed-in user can list their own memberships across tenants (tenant switcher).
CREATE POLICY own_memberships_read ON memberships FOR SELECT
  USING (user_id = app_user_id());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Invitation acceptance: readable only by presenting its token hash.
CREATE POLICY invitation_by_token_read ON invitations FOR SELECT
  USING (token_hash = app_invitation_token_hash());

ALTER TABLE territories ENABLE ROW LEVEL SECURITY;
ALTER TABLE territories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON territories
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE territory_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE territory_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON territory_assignments
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_tenant_id());
CREATE POLICY audit_read ON audit_logs FOR SELECT
  USING (tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------
-- Grants for the application role (no DDL, no BYPASSRLS)
-- ---------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO rakan_app;
GRANT SELECT, INSERT, UPDATE ON users, tenants, sessions, password_reset_tokens TO rakan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, invitations, territories, territory_assignments TO rakan_app;
-- Audit log is append-only for the application.
GRANT SELECT, INSERT ON audit_logs TO rakan_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rakan_app;
