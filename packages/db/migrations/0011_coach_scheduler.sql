-- Sales Coach + scheduled agents + in-app notifications.

-- In-app notifications (per user, per company). Scheduled agents deliver here (and by email when enabled).
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,                       -- morning_brief | visit_briefs | coach_report | ...
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  links       jsonb NOT NULL DEFAULT '[]',         -- [{ label, href }]
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);

-- A company's scheduled agents. Times are Riyadh local time; days are 0 = Sunday … 6 = Saturday.
CREATE TABLE scheduled_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job          text NOT NULL CHECK (job IN ('morning_brief','visit_briefs','weekly_coach')),
  enabled      boolean NOT NULL DEFAULT false,
  hour         smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  minute       smallint NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
  days         smallint[] NOT NULL,
  email        boolean NOT NULL DEFAULT false,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  last_status  text CHECK (last_status IN ('succeeded','failed','skipped')),
  last_detail  jsonb,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job)
);
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (next_run_at) WHERE enabled;

CREATE TABLE job_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job          text NOT NULL,
  trigger      text NOT NULL CHECK (trigger IN ('schedule','manual')),
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL CHECK (status IN ('succeeded','failed','skipped')),
  detail       jsonb NOT NULL DEFAULT '{}',
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_runs_idx ON job_runs (tenant_id, id DESC);

-- Sales Coach reports: numbers computed by code, coaching text by the model (validated against the numbers).
CREATE TABLE coach_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id  uuid NOT NULL,
  period_from    date NOT NULL,
  period_to      date NOT NULL,
  metrics        jsonb NOT NULL,
  team           jsonb NOT NULL,
  output         jsonb NOT NULL,
  dropped        jsonb NOT NULL DEFAULT '[]',
  agent_run_id   uuid,
  trigger        text NOT NULL CHECK (trigger IN ('user','schedule')),
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX coach_reports_member_idx ON coach_reports (tenant_id, membership_id, created_at DESC);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['notifications','scheduled_jobs','job_runs','coach_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rakan_app', tbl);
  END LOOP;
END $$;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rakan_app;

-- The scheduler has no tenant context: claim due jobs across companies (active or trial only).
-- Each claimed job is leased for 15 minutes, so two API instances never run it twice; the worker then
-- runs it inside that company's context and sets the real next run time.
CREATE FUNCTION claim_due_jobs(p_limit int) RETURNS TABLE (tenant_id uuid, job_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT j.id FROM scheduled_jobs j JOIN tenants t ON t.id = j.tenant_id
    WHERE j.enabled AND j.next_run_at <= now() AND t.status IN ('trial','active')
    ORDER BY j.next_run_at
    LIMIT p_limit
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE scheduled_jobs j SET next_run_at = now() + interval '15 minutes' FROM due WHERE j.id = due.id
  RETURNING j.tenant_id, j.id
$$;
REVOKE ALL ON FUNCTION claim_due_jobs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_jobs(int) TO rakan_app;
