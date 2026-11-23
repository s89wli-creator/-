-- Attachments on customers, visits and proposals; Web Push subscriptions per device.

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('account','visit','proposal')),
  entity_id     uuid NOT NULL,
  account_id    uuid NOT NULL,                     -- record scope: who may see it follows the customer
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  storage_key   text NOT NULL,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX attachments_entity_idx ON attachments (tenant_id, entity_type, entity_id, created_at DESC) WHERE deleted_at IS NULL;

-- A browser/phone that agreed to receive notifications for this person in this company.
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  UNIQUE (tenant_id, endpoint)
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (tenant_id, user_id);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['attachments','push_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rakan_app', tbl);
  END LOOP;
END $$;

-- Storage used now counts attachments too (plan limit + platform console).
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
    ((SELECT coalesce(sum(r.size_bytes), 0) FROM visit_recordings r WHERE r.tenant_id = t.id AND r.status <> 'deleted')
      + (SELECT coalesce(sum(f.size_bytes), 0) FROM attachments f WHERE f.tenant_id = t.id AND f.deleted_at IS NULL))::bigint,
    (SELECT max(a.last_activity_at) FROM accounts a WHERE a.tenant_id = t.id)
  FROM tenants t
  WHERE p_tenant IS NULL OR t.id = p_tenant
$$;
