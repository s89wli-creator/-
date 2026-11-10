-- Phase 5 — Field: idempotent offline sync and visit voice recordings.

-- Every mutation sent by the field app carries an Idempotency-Key. The first successful response is kept
-- and replayed for retries, so an action queued offline and sent twice is applied once.
CREATE TABLE idempotency_keys (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key            text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  request_hash   text NOT NULL,
  status         text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','done')),
  response_code  int,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Voice notes recorded during a visit (company opt-in + customer consent per recording).
-- Audio is stored encrypted outside the database; only metadata lives here.
CREATE TABLE visit_recordings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visit_id           uuid NOT NULL,
  uploaded_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  consent_confirmed  boolean NOT NULL CHECK (consent_confirmed),
  mime_type          text NOT NULL,
  total_chunks       int NOT NULL CHECK (total_chunks BETWEEN 1 AND 200),
  received_chunks    int[] NOT NULL DEFAULT '{}',
  size_bytes         bigint NOT NULL DEFAULT 0,
  duration_sec       int,
  storage_key        text,
  status             text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','deleted')),
  transcript         text,
  transcript_status  text NOT NULL DEFAULT 'none' CHECK (transcript_status IN ('none','pending','ready','failed','manual')),
  delete_after       timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX visit_recordings_visit_idx ON visit_recordings (tenant_id, visit_id, created_at DESC);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['idempotency_keys','visit_recordings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rakan_app', tbl);
  END LOOP;
END $$;
