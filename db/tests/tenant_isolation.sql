-- Tenant isolation test for the reference schema.
-- Run as a superuser against a fresh database where db/schema.sql was applied:
--   psql -v ON_ERROR_STOP=1 -f db/tests/tenant_isolation.sql
-- Fails (raises) on any isolation breach.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;

BEGIN;

-- Fixtures (as superuser; FORCE RLS applies to table owner, superuser bypasses)
INSERT INTO tenants (id, name, slug) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Company A', 'company-a'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Company B', 'company-b');

INSERT INTO accounts (id, tenant_id, name, name_normalized, lead_source) VALUES
  ('aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'مصنع أ', 'مصنع ا', 'manual'),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'مصنع ب', 'مصنع ب', 'manual');

SET LOCAL ROLE app_user;

-- 1. No tenant context => fail closed (zero rows)
DO $$ BEGIN
  IF (SELECT count(*) FROM accounts) <> 0 THEN
    RAISE EXCEPTION 'FAIL: rows visible without tenant context';
  END IF;
END $$;

-- 2. Tenant A sees only its own rows, even by direct id lookup
SELECT set_config('app.tenant_id', 'aaaaaaaa-0000-0000-0000-000000000001', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM accounts) <> 1 THEN
    RAISE EXCEPTION 'FAIL: tenant A row count wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = 'bbbbbbbb-1111-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FAIL: tenant A can read tenant B account by id';
  END IF;
END $$;

-- 3. Tenant A cannot update/delete tenant B rows
DO $$ DECLARE n int; BEGIN
  UPDATE accounts SET name = 'hacked' WHERE id = 'bbbbbbbb-1111-0000-0000-000000000002';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: cross-tenant update'; END IF;
  DELETE FROM accounts WHERE id = 'bbbbbbbb-1111-0000-0000-000000000002';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: cross-tenant delete'; END IF;
END $$;

-- 4. Tenant A cannot insert rows tagged with tenant B
DO $$ BEGIN
  BEGIN
    INSERT INTO accounts (tenant_id, name, name_normalized, lead_source)
    VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'x', 'x', 'manual');
    RAISE EXCEPTION 'FAIL: cross-tenant insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: RLS WITH CHECK violation
  END;
END $$;

-- 5. Tenant A cannot link its contact to tenant B's account (composite FK)
DO $$ BEGIN
  BEGIN
    INSERT INTO contacts (tenant_id, account_id, full_name)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-1111-0000-0000-000000000002', 'x');
    RAISE EXCEPTION 'FAIL: cross-tenant FK reference allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- expected
  END;
END $$;

-- 6. Switching context to B shows only B
SELECT set_config('app.tenant_id', 'bbbbbbbb-0000-0000-0000-000000000002', true);
DO $$ BEGIN
  IF (SELECT name FROM accounts) <> 'مصنع ب' THEN
    RAISE EXCEPTION 'FAIL: tenant B data altered or not visible';
  END IF;
END $$;

-- 7. Audit logs: B cannot read A's audit entries
RESET ROLE;
INSERT INTO audit_logs (tenant_id, actor_type, action)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'system', 'test.event');
SET LOCAL ROLE app_user;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs) THEN
    RAISE EXCEPTION 'FAIL: tenant B reads tenant A audit logs';
  END IF;
END $$;

\echo 'TENANT ISOLATION: ALL CHECKS PASSED'
ROLLBACK;
