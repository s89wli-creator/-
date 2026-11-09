-- =====================================================================
-- Rakan — AI Sales Employee
-- Reference database schema (PostgreSQL 16 + pgvector)
-- Status: Discovery draft. Source of truth will become Drizzle migrations
-- in packages/db; this file documents the intended model.
--
-- Conventions
--   * Every tenant-owned table has tenant_id uuid NOT NULL and RLS enabled.
--   * Composite FKs (tenant_id, x_id) prevent cross-tenant references.
--   * Timestamps are timestamptz. Money stored as numeric(14,2) + currency.
--   * Soft delete via deleted_at for business records; hard delete only
--     through approved deletion jobs.
--   * client_id supports idempotent offline sync from the PWA.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Application role: no BYPASSRLS, does not own tables.
-- CREATE ROLE app_user LOGIN PASSWORD '...' NOBYPASSRLS;

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- =====================================================================
-- 1. PLATFORM (not tenant-scoped)
-- =====================================================================

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE,
  full_name        text   NOT NULL,
  phone            text,
  password_hash    text,                       -- argon2id; null for SSO-only
  locale           text   NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  mfa_secret_enc   bytea,                      -- encrypted TOTP secret
  is_platform_admin boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  disabled_at      timestamptz
);

CREATE TABLE plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,       -- solo | team | business | enterprise
  name_ar          text NOT NULL,
  name_en          text NOT NULL,
  price_monthly    numeric(10,2),              -- SAR, null = custom
  price_yearly     numeric(10,2),
  currency         char(3) NOT NULL DEFAULT 'SAR',
  limits           jsonb NOT NULL,             -- {users, ai_credits, searches, storage_mb, stt_minutes, ...}
  features         jsonb NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             citext NOT NULL UNIQUE,
  legal_name       text,
  cr_number        text,                       -- السجل التجاري
  vat_number       text,
  industry         text,
  country          char(2) NOT NULL DEFAULT 'SA',
  timezone         text NOT NULL DEFAULT 'Asia/Riyadh',
  default_locale   text NOT NULL DEFAULT 'ar',
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('trial','active','suspended','cancelled')),
  settings         jsonb NOT NULL DEFAULT '{}', -- rep_visibility, recording_enabled, ...
  data_key_enc     bytea,                      -- tenant DEK encrypted by KMS KEK
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2. TENANCY, RBAC
-- =====================================================================

CREATE TABLE roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE, -- null = system role
  key              text NOT NULL,              -- owner | manager | rep | readonly | custom_*
  name             text NOT NULL,
  permissions      text[] NOT NULL,            -- e.g. {'crm.account.read', 'approvals.decide'}
  is_system        boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, key)
);

CREATE TABLE memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id          uuid NOT NULL REFERENCES roles(id),
  manager_membership_id uuid,
  title            text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
  approval_limits  jsonb NOT NULL DEFAULT '{}', -- {max_discount_pct, max_quote_value}
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email            citext NOT NULL,
  role_id          uuid NOT NULL REFERENCES roles(id),
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid NOT NULL REFERENCES users(id),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  active_tenant_id uuid REFERENCES tenants(id),
  ip               inet,
  user_agent       text,
  mfa_verified     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz
);

CREATE TABLE territories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  regions          text[] NOT NULL DEFAULT '{}',  -- e.g. {'الرياض','القصيم'}
  cities           text[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id)
);

CREATE TABLE territory_assignments (
  tenant_id        uuid NOT NULL,
  territory_id     uuid NOT NULL,
  membership_id    uuid NOT NULL,
  PRIMARY KEY (tenant_id, territory_id, membership_id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

-- =====================================================================
-- 3. AUDIT (append-only)
-- =====================================================================

CREATE TABLE audit_logs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid,                       -- null for platform-level events
  actor_type       text NOT NULL CHECK (actor_type IN ('user','agent','system','platform_admin')),
  actor_user_id    uuid,
  actor_agent_run_id uuid,
  action           text NOT NULL,              -- e.g. 'account.update', 'approval.approve'
  entity_type      text,
  entity_id        uuid,
  before           jsonb,
  after            jsonb,
  ip               inet,
  user_agent       text,
  request_id       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX ON audit_logs (tenant_id, entity_type, entity_id);
-- GRANT INSERT, SELECT ON audit_logs TO app_user;  -- no UPDATE / DELETE

-- =====================================================================
-- 4. CRM
-- =====================================================================

-- Tracks = customer segments with separate pipelines/ICP/reports
-- (Enjazni: 'shipper' / 'carrier'; generic for any tenant).
CREATE TABLE tracks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key              text NOT NULL,
  name             text NOT NULL,
  description      text,
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE pipelines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  track_id         uuid,
  name             text NOT NULL,
  is_default       boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, track_id) REFERENCES tracks(tenant_id, id)
);

CREATE TABLE pipeline_stages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  pipeline_id      uuid NOT NULL,
  key              text NOT NULL,              -- new, analyzed, qualified, contacted, visit_scheduled,
                                               -- visit_done, proposal_sent, negotiation, won, lost, postponed
  name             text NOT NULL,
  position         int  NOT NULL,
  category         text NOT NULL CHECK (category IN ('open','won','lost','postponed')),
  win_probability  numeric(4,3),
  UNIQUE (tenant_id, pipeline_id, key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE custom_field_defs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity           text NOT NULL CHECK (entity IN ('account','contact','opportunity','visit')),
  key              text NOT NULL,
  label            text NOT NULL,
  type             text NOT NULL CHECK (type IN ('text','number','date','select','multiselect','boolean')),
  options          jsonb,
  track_id         uuid,                       -- optional: field only for one track
  UNIQUE (tenant_id, entity, key)
);

CREATE TABLE accounts (                         -- companies being sold to
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  track_id         uuid,
  name             text NOT NULL,
  name_normalized  text NOT NULL,              -- Arabic normalization (أ/إ/آ→ا, ة→ه, tashkeel removed, legal suffixes)
  legal_name       text,
  cr_number        text,
  vat_number       text,
  website_domain   citext,
  phone            text,                       -- company switchboard only
  industry         text,
  sub_industry     text,
  size_band        text,
  region           text,
  city             text,
  address          text,
  lat              double precision,
  lng              double precision,
  location_source  text,
  owner_membership_id uuid,                    -- assigned rep
  territory_id     uuid,
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('pending_review','active','disqualified','customer','archived')),
  disqualify_reason text,
  lead_source      text NOT NULL,              -- import | manual | prospecting | referral | inbound
  lead_source_detail jsonb,
  custom_fields    jsonb NOT NULL DEFAULT '{}',
  score            int,
  score_tier       char(1),
  last_activity_at timestamptz,
  client_id        uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_id),
  FOREIGN KEY (tenant_id, track_id) REFERENCES tracks(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id)
);
CREATE INDEX ON accounts (tenant_id, owner_membership_id) WHERE deleted_at IS NULL;
CREATE INDEX ON accounts (tenant_id, track_id, score DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON accounts USING gin (name_normalized gin_trgm_ops);
CREATE UNIQUE INDEX accounts_cr_uniq ON accounts (tenant_id, cr_number)
  WHERE cr_number IS NOT NULL AND deleted_at IS NULL;

-- Provenance: every factual field about an account can cite its source.
CREATE TABLE data_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  field            text,                       -- null = whole record
  source_type      text NOT NULL CHECK (source_type IN
                     ('import_file','user_input','external_provider','web_page','meeting','ai_inference')),
  source_ref       text,                       -- file id / URL / provider record id
  provider         text,
  retrieved_at     timestamptz NOT NULL DEFAULT now(),
  confidence       numeric(4,3),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON data_sources (tenant_id, entity_type, entity_id);

CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL,
  full_name        text NOT NULL,
  job_title        text,
  phone_enc        bytea,                      -- encrypted with tenant DEK
  phone_hash       text,                       -- for dedupe lookup
  email_enc        bytea,
  email_hash       text,
  preferred_channel text CHECK (preferred_channel IN ('phone','whatsapp','email','visit')),
  consent_status   text NOT NULL DEFAULT 'unknown'
                   CHECK (consent_status IN ('unknown','granted','withdrawn')),
  consent_evidence jsonb,
  do_not_contact   boolean NOT NULL DEFAULT false,
  dnc_reason       text,
  dnc_at           timestamptz,
  custom_fields    jsonb NOT NULL DEFAULT '{}',
  client_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id)
);
CREATE INDEX ON contacts (tenant_id, account_id);
CREATE INDEX ON contacts (tenant_id, phone_hash);

CREATE TABLE opportunities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL,
  pipeline_id      uuid NOT NULL,
  stage_id         uuid NOT NULL,
  title            text NOT NULL,
  owner_membership_id uuid,
  amount           numeric(14,2),
  currency         char(3) NOT NULL DEFAULT 'SAR',
  expected_close_date date,
  win_probability  numeric(4,3),
  probability_source text CHECK (probability_source IN ('stage_default','user','ai')),
  outcome_reason_id uuid,
  outcome_note     text,
  closed_at        timestamptz,
  custom_fields    jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES pipeline_stages(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES memberships(tenant_id, id)
);
CREATE INDEX ON opportunities (tenant_id, stage_id);
CREATE INDEX ON opportunities (tenant_id, owner_membership_id);

CREATE TABLE opportunity_stage_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  opportunity_id   uuid NOT NULL,
  from_stage_id    uuid,
  to_stage_id      uuid NOT NULL,
  changed_by_type  text NOT NULL CHECK (changed_by_type IN ('user','agent_confirmed','system_event')),
  changed_by_user_id uuid,
  evidence         jsonb,                      -- visit id / approval id / reason
  changed_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id)
);

CREATE TABLE outcome_reasons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('win','loss','postpone','disqualify')),
  label            text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true
);

CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  type             text NOT NULL DEFAULT 'todo'
                   CHECK (type IN ('todo','call','follow_up','send_proposal','meeting','payment_reminder')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_at           timestamptz,
  assignee_membership_id uuid,
  account_id       uuid,
  opportunity_id   uuid,
  visit_id         uuid,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at     timestamptz,
  created_by_type  text NOT NULL CHECK (created_by_type IN ('user','agent','system')),
  created_by_user_id uuid,
  agent_run_id     uuid,
  client_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_id),
  FOREIGN KEY (tenant_id, assignee_membership_id) REFERENCES memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id)
);
CREATE INDEX ON tasks (tenant_id, assignee_membership_id, status, due_at);

CREATE TABLE notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  body             text NOT NULL,
  author_user_id   uuid NOT NULL,
  client_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_id)
);

CREATE TABLE files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key      text NOT NULL,              -- tenants/{tenant_id}/...
  filename         text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       bigint NOT NULL,
  sha256           text NOT NULL,
  scan_status      text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','failed')),
  entity_type      text,
  entity_id        uuid,
  uploaded_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Unified timeline
CREATE TABLE activities (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id       uuid,
  opportunity_id   uuid,
  type             text NOT NULL,              -- visit_completed, note_added, stage_changed, message_sent, ai_insight, ...
  actor_type       text NOT NULL,
  actor_user_id    uuid,
  ref_type         text,
  ref_id           uuid,
  summary          text,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activities (tenant_id, account_id, occurred_at DESC);

CREATE TABLE products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  unit             text,
  list_price       numeric(14,2),
  currency         char(3) NOT NULL DEFAULT 'SAR',
  track_id         uuid,
  is_active        boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id)
);

CREATE TABLE quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opportunity_id   uuid NOT NULL,
  number           text NOT NULL,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','pending_approval','approved','sent','accepted','rejected','expired')),
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount_total   numeric(14,2) NOT NULL DEFAULT 0,
  vat_total        numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  currency         char(3) NOT NULL DEFAULT 'SAR',
  valid_until      date,
  approval_request_id uuid,
  file_id          uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id)
);

CREATE TABLE quote_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  quote_id         uuid NOT NULL,
  product_id       uuid,
  description      text NOT NULL,
  quantity         numeric(12,3) NOT NULL,
  unit_price       numeric(14,2) NOT NULL,
  discount_pct     numeric(5,2) NOT NULL DEFAULT 0,
  line_total       numeric(14,2) NOT NULL,
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id) ON DELETE CASCADE
);

-- =====================================================================
-- 5. IMPORTS
-- =====================================================================

CREATE TABLE import_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id          uuid NOT NULL,
  entity           text NOT NULL CHECK (entity IN ('account','contact','opportunity')),
  column_mapping   jsonb,
  default_values   jsonb,                      -- e.g. {track_id, territory_id}
  data_permission_confirmed boolean NOT NULL DEFAULT false, -- user attests lawful basis
  status           text NOT NULL DEFAULT 'uploaded'
                   CHECK (status IN ('uploaded','mapped','validating','review','importing','completed','failed','cancelled')),
  stats            jsonb NOT NULL DEFAULT '{}', -- {rows, valid, invalid, duplicates, created, merged, skipped}
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  UNIQUE (tenant_id, id)
);

CREATE TABLE import_rows (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  import_job_id    uuid NOT NULL,
  row_number       int NOT NULL,
  raw              jsonb NOT NULL,
  normalized       jsonb,
  errors           jsonb,
  duplicate_of     uuid,                       -- existing account id
  duplicate_reason text,                       -- cr_number | phone | name_city | domain
  resolution       text CHECK (resolution IN ('create','merge','skip')),
  result_entity_id uuid,
  FOREIGN KEY (tenant_id, import_job_id) REFERENCES import_jobs(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON import_rows (tenant_id, import_job_id, row_number);

-- =====================================================================
-- 6. VISITS (field)
-- =====================================================================

CREATE TABLE visits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL,
  opportunity_id   uuid,
  rep_membership_id uuid NOT NULL,
  purpose          text,
  scheduled_start  timestamptz NOT NULL,
  scheduled_end    timestamptz,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','in_progress','completed','cancelled','no_show','rescheduled')),
  check_in_at      timestamptz,
  check_in_lat     double precision,
  check_in_lng     double precision,
  check_in_accuracy_m real,
  check_out_at     timestamptz,
  check_out_lat    double precision,
  check_out_lng    double precision,
  outcome          text,                       -- tenant-configurable list
  interest_level   smallint CHECK (interest_level BETWEEN 1 AND 5),
  next_step        text,
  next_follow_up_at timestamptz,
  notes            text,
  recording_consent jsonb,                     -- {given:true, by:'verbal', text, at}
  brief_id         uuid,
  insights_id      uuid,
  client_id        uuid,
  client_updated_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_membership_id) REFERENCES memberships(tenant_id, id)
);
CREATE INDEX ON visits (tenant_id, rep_membership_id, scheduled_start);

CREATE TABLE visit_recordings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  visit_id         uuid NOT NULL,
  file_id          uuid NOT NULL,
  duration_sec     int,
  stt_provider     text,
  stt_status       text NOT NULL DEFAULT 'pending' CHECK (stt_status IN ('pending','processing','done','failed')),
  transcript       text,                       -- machine transcript
  transcript_edited text,                      -- rep-corrected version
  language         text,
  retention_until  timestamptz,                -- audio auto-delete after policy period
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE CASCADE
);

-- =====================================================================
-- 7. SALES BRAIN
-- =====================================================================

CREATE TABLE brain_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section          text NOT NULL CHECK (section IN (
                     'company_profile','products','pricing','differentiators','target_segments',
                     'target_regions','icp','non_fit','objections','discount_rules','rep_authority',
                     'tone','commercial_policy','sales_goals','competitors','proposal_templates',
                     'faq','forbidden','onboarding_process','contracting_process','other')),
  track_id         uuid,                       -- null = applies to all tracks
  title            text NOT NULL,
  content          jsonb NOT NULL,             -- section-specific structured schema (validated by Zod)
  content_text     text NOT NULL,              -- rendered text used for retrieval
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','pending_confirmation','approved','archived')),
  source_type      text NOT NULL DEFAULT 'user_input', -- user_input | document | website_extraction
  source_ref       text,
  version          int NOT NULL DEFAULT 1,
  approved_by      uuid,
  approved_at      timestamptz,
  conflict_ids     uuid[] NOT NULL DEFAULT '{}',
  embedding        vector(1024),
  embedding_model  text,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON brain_items (tenant_id, section, status);

CREATE TABLE brain_item_versions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  brain_item_id    uuid NOT NULL,
  version          int NOT NULL,
  content          jsonb NOT NULL,
  status           text NOT NULL,
  changed_by       uuid,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brain_item_id) REFERENCES brain_items(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE brain_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id          uuid NOT NULL,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('processing','ready','failed','quarantined')),
  trust_level      text NOT NULL DEFAULT 'unverified' CHECK (trust_level IN ('unverified','approved','suspicious')),
  injection_flags  jsonb,
  approved_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE brain_chunks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  document_id      uuid NOT NULL,
  ordinal          int NOT NULL,
  content          text NOT NULL,
  embedding        vector(1024),
  embedding_model  text NOT NULL,
  FOREIGN KEY (tenant_id, document_id) REFERENCES brain_documents(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON brain_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON brain_chunks (tenant_id, document_id);

-- Lead scoring configuration (editable from admin)
CREATE TABLE scoring_models (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  track_id         uuid,
  name             text NOT NULL,
  criteria         jsonb NOT NULL,             -- [{key, label, weight, method:'rule'|'ai', config}]
  tier_thresholds  jsonb NOT NULL DEFAULT '{"A":75,"B":55,"C":35}',
  is_active        boolean NOT NULL DEFAULT true,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 8. AI AGENTS, OUTPUTS, APPROVALS
-- =====================================================================

CREATE TABLE agent_settings (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent            text NOT NULL,              -- orchestrator | prospecting | lead_intel | field_sales | meeting_intel | follow_up | coach
  enabled          boolean NOT NULL DEFAULT true,
  autonomy         text NOT NULL DEFAULT 'suggest' CHECK (autonomy IN ('suggest','act_internal')),
  allowed_tools    text[],                     -- subset of the agent's hard-coded allow-list
  monthly_budget_sar numeric(10,2),
  config           jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, agent)
);

CREATE TABLE agent_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent            text NOT NULL,
  parent_run_id    uuid,
  trigger_type     text NOT NULL CHECK (trigger_type IN ('user','schedule','event')),
  triggered_by_user_id uuid,
  input            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','awaiting_approval','succeeded','failed','cancelled')),
  output           jsonb,
  error            jsonb,
  models_used      text[] NOT NULL DEFAULT '{}',
  input_tokens     int NOT NULL DEFAULT 0,
  output_tokens    int NOT NULL DEFAULT 0,
  cost_usd         numeric(12,6) NOT NULL DEFAULT 0,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON agent_runs (tenant_id, status, created_at DESC);

CREATE TABLE agent_steps (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  run_id           uuid NOT NULL,
  ordinal          int NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('model_call','tool_call','tool_result','guard_block','approval_wait')),
  tool_name        text,
  tool_risk        text,
  payload          jsonb NOT NULL,             -- PII-redacted
  latency_ms       int,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE CASCADE
);

-- Structured AI outputs (all carry reasons/sources/confidence)
CREATE TABLE lead_scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  account_id       uuid NOT NULL,
  scoring_model_id uuid NOT NULL,
  scoring_model_version int NOT NULL,
  score            int NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier             char(1) NOT NULL,
  criteria         jsonb NOT NULL,             -- [{key, score, reason, sources:[...]}]
  missing_data     text[] NOT NULL DEFAULT '{}',
  confidence       numeric(4,3) NOT NULL,
  agent_run_id     uuid,
  reviewed_by      uuid,
  review_status    text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','accepted','overridden')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id)
);

CREATE TABLE visit_briefs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  visit_id         uuid NOT NULL,
  content          jsonb NOT NULL,             -- summary, why_target, goals, questions, value_points, script, objections[{objection, approved_response, brain_item_id}]
  sources          jsonb NOT NULL,
  agent_run_id     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE meeting_insights (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  visit_id         uuid NOT NULL,
  summary          text NOT NULL,
  stated_facts     jsonb NOT NULL,             -- [{type:'need'|'objection'|'competitor'|'budget'|'decision_date'|'commitment'|'participant', value, quote, speaker}]
  ai_inferences    jsonb NOT NULL,             -- [{type, value, reasoning, confidence}]
  interest_level   smallint,
  progress_likelihood numeric(4,3),
  next_actions     jsonb NOT NULL,
  agent_run_id     uuid,
  reviewed_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE approval_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_type      text NOT NULL,              -- send_message | send_final_quote | grant_discount | send_contract | commitment | change_prices | delete_data | ...
  tool_name        text NOT NULL,
  payload          jsonb NOT NULL,             -- exact payload to execute after approval
  payload_hash     text NOT NULL,              -- integrity check at execution time
  reason           text,
  sources          jsonb,
  confidence       numeric(4,3),
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user','agent')),
  requested_by_user_id uuid,
  agent_run_id     uuid,
  entity_type      text,
  entity_id        uuid,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','expired','executed','execution_failed')),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_note    text,
  executed_at      timestamptz,
  execution_result jsonb,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON approval_requests (tenant_id, status, created_at DESC);

-- =====================================================================
-- 9. MESSAGING & CONSENT
-- =====================================================================

CREATE TABLE message_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL,
  account_id       uuid NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
  subject          text,
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','pending_approval','approved','sent','failed','cancelled')),
  approval_request_id uuid,
  forbidden_check  jsonb,
  agent_run_id     uuid,
  sent_at          timestamptz,
  provider_message_id text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id)
);

CREATE TABLE inbound_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel          text NOT NULL,
  contact_id       uuid,
  body             text NOT NULL,
  classification   jsonb,                      -- {intent:'opt_out'|'meeting'|'question'|..., confidence}
  received_at      timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 10. INTEGRATIONS, BILLING, USAGE
-- =====================================================================

CREATE TABLE integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider         text NOT NULL,              -- smtp | whatsapp_cloud | google_maps | ...
  status           text NOT NULL DEFAULT 'disconnected',
  config           jsonb NOT NULL DEFAULT '{}', -- non-secret
  secrets_enc      bytea,                      -- encrypted with tenant DEK
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id          uuid NOT NULL REFERENCES plans(id),
  billing_cycle    text NOT NULL CHECK (billing_cycle IN ('monthly','yearly')),
  seats            int NOT NULL DEFAULT 1,
  limits_override  jsonb,                      -- enterprise custom limits
  status           text NOT NULL CHECK (status IN ('trialing','active','past_due','paused','cancelled')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  provider         text,
  provider_ref     text,
  setup_fee        numeric(10,2),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric           text NOT NULL,              -- ai_credits | prospect_search | stt_minutes | storage_mb | messages
  quantity         numeric(14,4) NOT NULL,
  cost_usd         numeric(12,6),              -- actual provider cost (internal)
  agent_run_id     uuid,
  user_id          uuid,
  meta             jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_events (tenant_id, metric, occurred_at);

CREATE TABLE usage_counters (                   -- per billing period aggregate (source of truth for limits)
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start     date NOT NULL,
  metric           text NOT NULL,
  used             numeric(14,4) NOT NULL DEFAULT 0,
  limit_value      numeric(14,4),
  alerted_80_at    timestamptz,
  alerted_100_at   timestamptz,
  PRIMARY KEY (tenant_id, period_start, metric)
);

CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id  uuid REFERENCES subscriptions(id),
  number           text NOT NULL UNIQUE,
  amount           numeric(12,2) NOT NULL,
  vat_amount       numeric(12,2) NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'SAR',
  status           text NOT NULL CHECK (status IN ('draft','issued','paid','void')),
  zatca_status     text,
  issued_at        timestamptz,
  paid_at          timestamptz
);

-- Model routing (platform-level config, editable without deploy)
CREATE TABLE ai_model_routes (
  task_profile     text PRIMARY KEY,           -- extraction.ar | reasoning.ar | classification | embedding | stt.ar
  primary_provider text NOT NULL,
  primary_model    text NOT NULL,
  fallbacks        jsonb NOT NULL DEFAULT '[]',
  max_output_tokens int,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 11. ROW-LEVEL SECURITY
-- Applied to every tenant-owned table. FORCE so table owner is also bound
-- (migrations run as a separate migrator role).
-- =====================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','invitations','territories','territory_assignments',
    'tracks','pipelines','pipeline_stages','custom_field_defs',
    'accounts','data_sources','contacts','opportunities','opportunity_stage_history',
    'outcome_reasons','tasks','notes','files','activities','products','quotes','quote_items',
    'import_jobs','import_rows','visits','visit_recordings',
    'brain_items','brain_item_versions','brain_documents','brain_chunks','scoring_models',
    'agent_settings','agent_runs','agent_steps','lead_scores','visit_briefs','meeting_insights',
    'approval_requests','message_drafts','inbound_messages',
    'integrations','subscriptions','usage_events','usage_counters','invoices'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t);
  END LOOP;
END $$;

-- roles: tenant sees system roles (tenant_id IS NULL) + its own
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_read ON roles FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_tenant_id());
CREATE POLICY roles_write ON roles FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- audit_logs: insert for current tenant, read own tenant only
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (tenant_id IS NULL OR tenant_id = app_tenant_id());
CREATE POLICY audit_read   ON audit_logs FOR SELECT USING (tenant_id = app_tenant_id());
