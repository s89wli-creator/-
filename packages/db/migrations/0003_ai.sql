-- 0003 AI Intelligence: account security (MFA, email verification), Sales Brain, agent runs, approvals,
-- AI usage metering, and agent outputs (lead scores, visit briefs, meeting insights, message drafts).

-- ---------------------------------------------------------------------
-- Account security (platform tables, no tenant_id)
-- ---------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN mfa_secret_enc text,
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN mfa_recovery_hashes text[] NOT NULL DEFAULT '{}';

ALTER TABLE sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;

CREATE TABLE mfa_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  attempts     int NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_verification_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON mfa_challenges, email_verification_tokens TO rakan_app;

-- ---------------------------------------------------------------------
-- AI settings & metering
-- ---------------------------------------------------------------------

CREATE TABLE ai_settings (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT true,
  monthly_budget_usd  numeric(10,2) NOT NULL DEFAULT 20.00,
  agents              jsonb NOT NULL DEFAULT '{}',   -- { lead_intel: { enabled: true }, ... }
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_usage (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_run_id   uuid,
  provider       text NOT NULL,
  model          text NOT NULL,
  input_tokens   int NOT NULL DEFAULT 0,
  output_tokens  int NOT NULL DEFAULT 0,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_tenant_time_idx ON ai_usage (tenant_id, occurred_at);

-- ---------------------------------------------------------------------
-- Agent runs (every AI action is traceable: input, steps, output, cost, errors)
-- ---------------------------------------------------------------------

CREATE TABLE agent_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent               text NOT NULL,
  trigger_type        text NOT NULL CHECK (trigger_type IN ('user','schedule','event')),
  triggered_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type         text,
  entity_id           uuid,
  status              text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','succeeded','failed','awaiting_approval','cancelled')),
  input               jsonb NOT NULL DEFAULT '{}',
  output              jsonb,
  error               jsonb,
  model               text,
  input_tokens        int NOT NULL DEFAULT 0,
  output_tokens       int NOT NULL DEFAULT 0,
  cost_usd            numeric(12,6) NOT NULL DEFAULT 0,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX agent_runs_tenant_time_idx ON agent_runs (tenant_id, started_at DESC);
CREATE INDEX agent_runs_entity_idx ON agent_runs (tenant_id, entity_type, entity_id);

CREATE TABLE agent_steps (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  run_id      uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('context','model_call','validation','tool_call','guard_block','approval_wait','error')),
  name        text,
  detail      jsonb NOT NULL DEFAULT '{}',   -- PII-redacted
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_steps_run_idx ON agent_steps (tenant_id, run_id, id);

ALTER TABLE ai_usage ADD FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE SET NULL (agent_run_id);

-- ---------------------------------------------------------------------
-- Human approvals
-- ---------------------------------------------------------------------

CREATE TABLE approval_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_type          text NOT NULL,                 -- send_message | grant_discount | ...
  tool_name            text NOT NULL,
  risk                 text NOT NULL CHECK (risk IN ('EXTERNAL','IRREVERSIBLE')),
  payload              jsonb NOT NULL,                -- exactly what will be executed after approval
  payload_hash         text NOT NULL,
  summary              text,
  reason               text,
  sources              jsonb,
  confidence           numeric(4,3),
  requested_by_type    text NOT NULL CHECK (requested_by_type IN ('user','agent')),
  requested_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  agent_run_id         uuid,
  entity_type          text,
  entity_id            uuid,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','expired','executed','execution_failed')),
  decided_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at           timestamptz,
  decision_note        text,
  executed_at          timestamptz,
  execution_result     jsonb,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE SET NULL (agent_run_id)
);
CREATE INDEX approval_requests_status_idx ON approval_requests (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------
-- Sales Brain
-- ---------------------------------------------------------------------

CREATE TABLE brain_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section         text NOT NULL,
  track_id        uuid,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  fields          jsonb NOT NULL DEFAULT '{}',     -- section-specific structured data (price, objection/response, …)
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_confirmation','approved','archived')),
  source_type     text NOT NULL DEFAULT 'user_input' CHECK (source_type IN ('user_input','document','website')),
  source_ref      text,
  version         int NOT NULL DEFAULT 1,
  search_text     text NOT NULL DEFAULT '',        -- Arabic-normalized title + body + fields
  search_tsv      tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, track_id) REFERENCES tracks(tenant_id, id) ON DELETE SET NULL (track_id)
);
CREATE INDEX brain_items_section_idx ON brain_items (tenant_id, section, status);
CREATE INDEX brain_items_tsv_idx ON brain_items USING gin (search_tsv);

CREATE TABLE brain_item_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  brain_item_id   uuid NOT NULL,
  version         int NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  fields          jsonb NOT NULL,
  status          text NOT NULL,
  changed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brain_item_id) REFERENCES brain_items(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE brain_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title           text NOT NULL,
  filename        text,
  content         text NOT NULL,
  trust_level     text NOT NULL DEFAULT 'unverified' CHECK (trust_level IN ('unverified','approved','suspicious')),
  injection_flags jsonb NOT NULL DEFAULT '[]',
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE brain_chunks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  document_id   uuid NOT NULL,
  ordinal       int NOT NULL,
  content       text NOT NULL,
  search_text   text NOT NULL,
  search_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  FOREIGN KEY (tenant_id, document_id) REFERENCES brain_documents(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX brain_chunks_tsv_idx ON brain_chunks USING gin (search_tsv);
CREATE INDEX brain_chunks_doc_idx ON brain_chunks (tenant_id, document_id, ordinal);

-- ---------------------------------------------------------------------
-- Agent outputs
-- ---------------------------------------------------------------------

CREATE TABLE scoring_models (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  weights          jsonb NOT NULL,               -- { icp_fit: 30, need_size: 20, ... }
  tier_thresholds  jsonb NOT NULL DEFAULT '{"A":75,"B":55,"C":35}',
  version          int NOT NULL DEFAULT 1,
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL,
  score             int NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier              char(1) NOT NULL CHECK (tier IN ('A','B','C','D')),
  disqualified      boolean NOT NULL DEFAULT false,
  criteria          jsonb NOT NULL,              -- [{ key, score, weight, reason, evidence:[ref], method:'rule'|'ai' }]
  missing_data      text[] NOT NULL DEFAULT '{}',
  confidence        numeric(4,3) NOT NULL,
  summary           text,
  model_version     int NOT NULL,
  agent_run_id      uuid,
  review_status     text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','accepted','overridden')),
  override_tier     char(1),
  override_note     text,
  reviewed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE SET NULL (agent_run_id)
);
CREATE INDEX lead_scores_account_idx ON lead_scores (tenant_id, account_id, created_at DESC);

CREATE TABLE visit_briefs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visit_id       uuid NOT NULL,
  content        jsonb NOT NULL,
  removed        jsonb NOT NULL DEFAULT '[]',    -- statements dropped by validation (no source / forbidden phrase)
  agent_run_id   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE SET NULL (agent_run_id)
);
CREATE INDEX visit_briefs_visit_idx ON visit_briefs (tenant_id, visit_id, created_at DESC);

CREATE TABLE meeting_insights (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visit_id              uuid NOT NULL,
  summary               text NOT NULL,
  stated_facts          jsonb NOT NULL,          -- said by the customer, each with a verbatim quote
  inferences            jsonb NOT NULL,          -- Rakan's inferences, each with reasoning + confidence
  next_actions          jsonb NOT NULL,
  interest_level        smallint,
  progress_likelihood   numeric(4,3),
  removed               jsonb NOT NULL DEFAULT '[]',
  agent_run_id          uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE SET NULL (agent_run_id)
);
CREATE INDEX meeting_insights_visit_idx ON meeting_insights (tenant_id, visit_id, created_at DESC);

CREATE TABLE message_drafts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id            uuid NOT NULL,
  contact_id            uuid NOT NULL,
  visit_id              uuid,
  channel               text NOT NULL CHECK (channel IN ('email','whatsapp')),
  subject               text,
  body                  text NOT NULL,
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','pending_approval','approved','sent','rejected','cancelled')),
  forbidden_hits        text[] NOT NULL DEFAULT '{}',
  approval_request_id   uuid,
  agent_run_id          uuid,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE SET NULL (visit_id),
  FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approval_requests(tenant_id, id) ON DELETE SET NULL (approval_request_id),
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE SET NULL (agent_run_id)
);
CREATE INDEX message_drafts_account_idx ON message_drafts (tenant_id, account_id, created_at DESC);

ALTER TABLE accounts ADD COLUMN score int, ADD COLUMN score_tier char(1);

-- ---------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'ai_settings','ai_usage','agent_runs','agent_steps','approval_requests',
    'brain_items','brain_item_versions','brain_documents','brain_chunks',
    'scoring_models','lead_scores','visit_briefs','meeting_insights','message_drafts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rakan_app', tbl);
  END LOOP;
END $$;

-- Usage, steps and versions are append-only for the application (metering and audit integrity).
REVOKE UPDATE, DELETE ON ai_usage, agent_steps, brain_item_versions FROM rakan_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rakan_app;
