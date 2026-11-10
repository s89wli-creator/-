-- Defense in depth for the platform tables that carry tenant_id (the RLS meta-test requires it).
-- Platform operations run with no tenant in context (app.tenant_id empty); company requests run with
-- their own tenant and may only read their subscription (and create it once, at sign-up).

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant_read ON subscriptions FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY subscriptions_tenant_create ON subscriptions FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY subscriptions_platform ON subscriptions FOR ALL USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);

ALTER TABLE platform_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_platform_only ON platform_audit FOR ALL USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);
