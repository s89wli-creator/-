-- 0002 Core CRM: settings (tracks, pipelines, reasons, custom fields), accounts, contacts,
-- opportunities, tasks, notes, activities, visits, imports.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------

CREATE TABLE tracks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE pipelines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  track_id     uuid,
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, track_id) REFERENCES tracks(tenant_id, id) ON DELETE SET NULL (track_id)
);
CREATE UNIQUE INDEX pipelines_one_default ON pipelines (tenant_id) WHERE is_default;
CREATE UNIQUE INDEX pipelines_one_per_track ON pipelines (tenant_id, track_id) WHERE track_id IS NOT NULL;

CREATE TABLE pipeline_stages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  pipeline_id      uuid NOT NULL,
  key              text NOT NULL,
  name             text NOT NULL,
  position         int  NOT NULL,
  category         text NOT NULL CHECK (category IN ('open','won','lost','postponed')),
  win_probability  numeric(4,3),
  UNIQUE (tenant_id, pipeline_id, key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE outcome_reasons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('win','loss','postpone','disqualify')),
  label       text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, label)
);

CREATE TABLE custom_field_defs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity      text NOT NULL CHECK (entity IN ('account','contact','opportunity')),
  key         text NOT NULL,
  label       text NOT NULL,
  type        text NOT NULL CHECK (type IN ('text','number','date','select','boolean')),
  options     text[],
  track_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, key),
  FOREIGN KEY (tenant_id, track_id) REFERENCES tracks(tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Accounts & contacts
-- ---------------------------------------------------------------------

CREATE TABLE accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  track_id            uuid,
  name                text NOT NULL,
  name_normalized     text NOT NULL,
  legal_name          text,
  cr_number           text,
  vat_number          text,
  website_domain      text,
  phone               text,
  industry            text,
  size_band           text,
  region              text,
  city                text,
  address             text,
  lat                 double precision,
  lng                 double precision,
  owner_membership_id uuid,
  territory_id        uuid,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','customer','disqualified','archived')),
  disqualify_reason   text,
  lead_source         text NOT NULL DEFAULT 'manual',
  lead_source_detail  text,
  custom_fields       jsonb NOT NULL DEFAULT '{}',
  import_job_id       uuid,
  last_activity_at    timestamptz,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, track_id) REFERENCES tracks(tenant_id, id) ON DELETE SET NULL (track_id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL (owner_membership_id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id) ON DELETE SET NULL (territory_id)
);
CREATE INDEX accounts_owner_idx ON accounts (tenant_id, owner_membership_id) WHERE deleted_at IS NULL;
CREATE INDEX accounts_activity_idx ON accounts (tenant_id, last_activity_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX accounts_name_trgm ON accounts USING gin (name_normalized gin_trgm_ops);
CREATE INDEX accounts_cr_idx ON accounts (tenant_id, cr_number) WHERE cr_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX accounts_vat_idx ON accounts (tenant_id, vat_number) WHERE vat_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX accounts_domain_idx ON accounts (tenant_id, website_domain) WHERE website_domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX accounts_phone_idx ON accounts (tenant_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL,
  full_name         text NOT NULL,
  job_title         text,
  -- Personal data encrypted at the application layer (AES-256-GCM, per-tenant key);
  -- keyed HMAC hashes allow exact-match lookup and duplicate detection without decryption.
  phone_enc         text,
  phone_hash        text,
  email_enc         text,
  email_hash        text,
  preferred_channel text CHECK (preferred_channel IN ('phone','whatsapp','email','visit')),
  is_primary        boolean NOT NULL DEFAULT false,
  do_not_contact    boolean NOT NULL DEFAULT false,
  dnc_reason        text,
  dnc_at            timestamptz,
  custom_fields     jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX contacts_account_idx ON contacts (tenant_id, account_id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_phone_hash_idx ON contacts (tenant_id, phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX contacts_email_hash_idx ON contacts (tenant_id, email_hash) WHERE email_hash IS NOT NULL;

-- ---------------------------------------------------------------------
-- Opportunities
-- ---------------------------------------------------------------------

CREATE TABLE opportunities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id          uuid NOT NULL,
  pipeline_id         uuid NOT NULL,
  stage_id            uuid NOT NULL,
  title               text NOT NULL,
  owner_membership_id uuid,
  amount              numeric(14,2),
  currency            char(3) NOT NULL DEFAULT 'SAR',
  expected_close_date date,
  outcome_reason_id   uuid,
  outcome_note        text,
  closed_at           timestamptz,
  custom_fields       jsonb NOT NULL DEFAULT '{}',
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES pipeline_stages(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL (owner_membership_id),
  FOREIGN KEY (tenant_id, outcome_reason_id) REFERENCES outcome_reasons(tenant_id, id)
);
CREATE INDEX opportunities_stage_idx ON opportunities (tenant_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX opportunities_account_idx ON opportunities (tenant_id, account_id) WHERE deleted_at IS NULL;
CREATE INDEX opportunities_owner_idx ON opportunities (tenant_id, owner_membership_id) WHERE deleted_at IS NULL;

CREATE TABLE opportunity_stage_history (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  opportunity_id      uuid NOT NULL,
  from_stage_id       uuid,
  to_stage_id         uuid NOT NULL,
  changed_by_type     text NOT NULL CHECK (changed_by_type IN ('user','system_event','agent_confirmed')),
  changed_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  evidence            jsonb,
  changed_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_stage_id) REFERENCES pipeline_stages(tenant_id, id)
);
CREATE INDEX stage_history_opp_idx ON opportunity_stage_history (tenant_id, opportunity_id, id);
CREATE INDEX stage_history_time_idx ON opportunity_stage_history (tenant_id, changed_at);

-- ---------------------------------------------------------------------
-- Visits, tasks, notes, activities
-- ---------------------------------------------------------------------

CREATE TABLE visits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id          uuid NOT NULL,
  opportunity_id      uuid,
  rep_membership_id   uuid NOT NULL,
  purpose             text,
  scheduled_start     timestamptz NOT NULL,
  scheduled_end       timestamptz,
  status              text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  check_in_at         timestamptz,
  check_in_lat        double precision,
  check_in_lng        double precision,
  check_in_accuracy_m real,
  check_out_at        timestamptz,
  check_out_lat       double precision,
  check_out_lng       double precision,
  outcome             text CHECK (outcome IN ('interested','needs_follow_up','not_interested','not_met')),
  interest_level      smallint CHECK (interest_level BETWEEN 1 AND 5),
  next_step           text CHECK (next_step IN ('send_proposal','another_visit','call','none')),
  next_follow_up_at   timestamptz,
  notes               text,
  follow_up_task_id   uuid,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id) ON DELETE SET NULL (opportunity_id),
  FOREIGN KEY (tenant_id, rep_membership_id) REFERENCES memberships(tenant_id, id)
);
CREATE INDEX visits_rep_time_idx ON visits (tenant_id, rep_membership_id, scheduled_start);
CREATE INDEX visits_time_idx ON visits (tenant_id, scheduled_start);
CREATE INDEX visits_account_idx ON visits (tenant_id, account_id);

CREATE TABLE tasks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title                   text NOT NULL,
  description             text,
  type                    text NOT NULL DEFAULT 'todo'
                          CHECK (type IN ('todo','call','follow_up','send_proposal','meeting','payment_reminder')),
  priority                text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_at                  timestamptz,
  assignee_membership_id  uuid,
  account_id              uuid,
  opportunity_id          uuid,
  visit_id                uuid,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at            timestamptz,
  created_by_type         text NOT NULL DEFAULT 'user' CHECK (created_by_type IN ('user','agent','system')),
  created_by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL (assignee_membership_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id) ON DELETE SET NULL (opportunity_id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE SET NULL (visit_id)
);
CREATE INDEX tasks_assignee_idx ON tasks (tenant_id, assignee_membership_id, status, due_at);
CREATE INDEX tasks_account_idx ON tasks (tenant_id, account_id);

ALTER TABLE visits ADD FOREIGN KEY (tenant_id, follow_up_task_id) REFERENCES tasks(tenant_id, id) ON DELETE SET NULL (follow_up_task_id);

CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL,
  opportunity_id  uuid,
  body            text NOT NULL,
  author_user_id  uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notes_account_idx ON notes (tenant_id, account_id, created_at DESC);

CREATE TABLE activities (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL,
  opportunity_id  uuid,
  type            text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  ref_type        text,
  ref_id          uuid,
  summary         text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX activities_account_idx ON activities (tenant_id, account_id, id DESC);

-- ---------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------

CREATE TABLE import_jobs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity                     text NOT NULL DEFAULT 'account' CHECK (entity IN ('account')),
  filename                   text NOT NULL,
  headers                    text[] NOT NULL,
  mapping                    jsonb,
  defaults                   jsonb,
  data_permission_confirmed  boolean NOT NULL DEFAULT false,
  status                     text NOT NULL DEFAULT 'uploaded'
                             CHECK (status IN ('uploaded','review','completed','failed','cancelled')),
  stats                      jsonb NOT NULL DEFAULT '{}',
  created_by                 uuid NOT NULL REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  UNIQUE (tenant_id, id)
);

CREATE TABLE import_rows (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  import_job_id     uuid NOT NULL,
  row_number        int NOT NULL,
  raw               jsonb NOT NULL,
  normalized        jsonb,
  errors            jsonb,
  duplicate_of      uuid,
  duplicate_reason  text,
  in_file_duplicate_of int,
  resolution        text CHECK (resolution IN ('create','merge','skip')),
  result_entity_id  uuid,
  FOREIGN KEY (tenant_id, import_job_id) REFERENCES import_jobs(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX import_rows_job_idx ON import_rows (tenant_id, import_job_id, row_number);

ALTER TABLE accounts ADD FOREIGN KEY (tenant_id, import_job_id) REFERENCES import_jobs(tenant_id, id) ON DELETE SET NULL (import_job_id);

-- ---------------------------------------------------------------------
-- Default CRM configuration for a tenant (runs under the caller's RLS context).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seed_crm_defaults(p_tenant uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_pipeline uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM pipelines WHERE tenant_id = p_tenant) THEN
    RETURN;
  END IF;
  INSERT INTO pipelines (tenant_id, name, is_default) VALUES (p_tenant, 'خط المبيعات الرئيسي', true)
    RETURNING id INTO v_pipeline;
  INSERT INTO pipeline_stages (tenant_id, pipeline_id, key, name, position, category, win_probability) VALUES
    (p_tenant, v_pipeline, 'new',             'عميل محتمل جديد', 1,  'open',      0.05),
    (p_tenant, v_pipeline, 'analyzed',        'تم تحليل العميل', 2,  'open',      0.10),
    (p_tenant, v_pipeline, 'qualified',       'مؤهل',            3,  'open',      0.20),
    (p_tenant, v_pipeline, 'contacted',       'تم التواصل',      4,  'open',      0.30),
    (p_tenant, v_pipeline, 'visit_scheduled', 'زيارة مجدولة',    5,  'open',      0.40),
    (p_tenant, v_pipeline, 'visit_done',      'تمت الزيارة',     6,  'open',      0.50),
    (p_tenant, v_pipeline, 'proposal_sent',   'عرض تجاري مقدم',  7,  'open',      0.60),
    (p_tenant, v_pipeline, 'negotiation',     'تفاوض',           8,  'open',      0.75),
    (p_tenant, v_pipeline, 'won',             'فوز بالصفقة',     9,  'won',       1.00),
    (p_tenant, v_pipeline, 'lost',            'خسارة الصفقة',    10, 'lost',      0.00),
    (p_tenant, v_pipeline, 'postponed',       'مؤجل',            11, 'postponed', 0.10);
  INSERT INTO outcome_reasons (tenant_id, kind, label) VALUES
    (p_tenant, 'loss', 'السعر مرتفع'),
    (p_tenant, 'loss', 'اختار منافساً'),
    (p_tenant, 'loss', 'لا توجد حاجة حالياً'),
    (p_tenant, 'loss', 'تعذر الوصول لصاحب القرار'),
    (p_tenant, 'loss', 'توقيت غير مناسب'),
    (p_tenant, 'loss', 'أخرى'),
    (p_tenant, 'win', 'السعر مناسب'),
    (p_tenant, 'win', 'جودة الخدمة'),
    (p_tenant, 'win', 'الثقة والعلاقة'),
    (p_tenant, 'win', 'سرعة الاستجابة'),
    (p_tenant, 'win', 'أخرى'),
    (p_tenant, 'postpone', 'الميزانية'),
    (p_tenant, 'postpone', 'التوقيت'),
    (p_tenant, 'postpone', 'أخرى'),
    (p_tenant, 'disqualify', 'النشاط غير مناسب'),
    (p_tenant, 'disqualify', 'خارج المناطق المستهدفة'),
    (p_tenant, 'disqualify', 'بيانات غير صحيحة');
END $$;

-- Seed existing tenants (each under its own tenant context so RLS checks pass).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    PERFORM seed_crm_defaults(t.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ---------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tracks','pipelines','pipeline_stages','outcome_reasons','custom_field_defs',
    'accounts','contacts','opportunities','opportunity_stage_history',
    'visits','tasks','notes','activities','import_jobs','import_rows'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rakan_app', tbl);
  END LOOP;
END $$;

-- History and timeline are append-only for the application.
REVOKE UPDATE, DELETE ON opportunity_stage_history, activities FROM rakan_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rakan_app;
GRANT EXECUTE ON FUNCTION seed_crm_defaults(uuid) TO rakan_app;
