-- Phase 6 (part 1) — Platform administration: plans, subscriptions, limits, platform audit.
-- Platform tables (no tenant_id RLS) are only reachable through the platform module, behind the
-- platform-admin guard. The platform admin sees aggregates per company, never customer content.

CREATE TABLE plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                 citext NOT NULL UNIQUE,
  name_ar             text NOT NULL,
  name_en             text NOT NULL,
  price_sar_monthly   numeric(10,2),             -- NULL = custom (Enterprise)
  -- { users, aiMonthlyUsd, storageMb, recordingMinutes } ; null = unlimited
  limits              jsonb NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  sort                int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id              uuid NOT NULL REFERENCES plans(id),
  trial_ends_at        timestamptz,
  current_period_end   timestamptz,
  notes                text,
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Actions taken by platform administrators (append-only for the application).
CREATE TABLE platform_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,
  before          jsonb,
  after           jsonb,
  ip              inet,
  user_agent      text,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_time_idx ON platform_audit (created_at DESC);

GRANT SELECT, INSERT, UPDATE ON plans, subscriptions TO rakan_app;
GRANT SELECT, INSERT ON platform_audit TO rakan_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rakan_app;

-- Starting plans (from docs/06; editable from the platform console).
INSERT INTO plans (key, name_ar, name_en, price_sar_monthly, limits, sort) VALUES
  ('solo',       'Solo',       'Solo',       399,  '{"users":1,"aiMonthlyUsd":10,"storageMb":2048,"recordingMinutes":120}', 1),
  ('team',       'Team',       'Team',       899,  '{"users":5,"aiMonthlyUsd":40,"storageMb":10240,"recordingMinutes":600}', 2),
  ('business',   'Business',   'Business',   1799, '{"users":15,"aiMonthlyUsd":120,"storageMb":51200,"recordingMinutes":2000}', 3),
  ('enterprise', 'Enterprise', 'Enterprise', NULL, '{"users":null,"aiMonthlyUsd":null,"storageMb":null,"recordingMinutes":null}', 4);

-- Existing companies start on Team with a 14-day trial.
INSERT INTO subscriptions (tenant_id, plan_id, trial_ends_at)
SELECT t.id, p.id, now() + interval '14 days' FROM tenants t CROSS JOIN plans p WHERE p.key = 'team'
ON CONFLICT DO NOTHING;

-- Aggregate usage per company for the platform console. Runs with the owner's rights (it must count
-- across companies) but returns numbers only — no names, contacts, notes or any customer content.
CREATE OR REPLACE FUNCTION platform_tenant_stats(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (
  tenant_id uuid, active_users int, pending_invitations int, accounts int, visits_30d int,
  ai_usd_month numeric, ai_runs_month int, storage_bytes bigint, last_activity_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH month_start AS (SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh') AS t)
  SELECT
    t.id,
    (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active'),
    (SELECT count(*)::int FROM invitations i WHERE i.tenant_id = t.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()),
    (SELECT count(*)::int FROM accounts a WHERE a.tenant_id = t.id AND a.deleted_at IS NULL),
    (SELECT count(*)::int FROM visits v WHERE v.tenant_id = t.id AND v.scheduled_start > now() - interval '30 days'),
    (SELECT coalesce(sum(u.cost_usd), 0) FROM ai_usage u, month_start ms WHERE u.tenant_id = t.id AND u.occurred_at >= ms.t),
    (SELECT count(*)::int FROM agent_runs r, month_start ms WHERE r.tenant_id = t.id AND r.started_at >= ms.t),
    (SELECT coalesce(sum(r.size_bytes), 0)::bigint FROM visit_recordings r WHERE r.tenant_id = t.id AND r.status <> 'deleted'),
    (SELECT max(a.last_activity_at) FROM accounts a WHERE a.tenant_id = t.id)
  FROM tenants t
  WHERE p_tenant IS NULL OR t.id = p_tenant
$$;
REVOKE ALL ON FUNCTION platform_tenant_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_stats(uuid) TO rakan_app;
