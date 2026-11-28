-- Subscription payments through Moyasar (hosted invoice page: card data never reaches Rakan's servers).

ALTER TABLE plans ADD COLUMN price_sar_yearly numeric(10,2);   -- NULL = no yearly option

CREATE SEQUENCE billing_invoice_seq;

CREATE TABLE billing_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number               text NOT NULL UNIQUE,                 -- RKN-2026-000001 (Rakan's own numbering)
  plan_id              uuid NOT NULL REFERENCES plans(id),
  plan_key             text NOT NULL,
  plan_name            text NOT NULL,
  period               text NOT NULL CHECK (period IN ('month','year')),
  subtotal_halalas     int NOT NULL CHECK (subtotal_halalas > 0),
  vat_halalas          int NOT NULL CHECK (vat_halalas >= 0),
  total_halalas        int NOT NULL CHECK (total_halalas = subtotal_halalas + vat_halalas),
  currency             char(3) NOT NULL DEFAULT 'SAR',
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired','canceled')),
  provider             text NOT NULL,
  provider_invoice_id  text UNIQUE,
  provider_payment_id  text,
  provider_status      text,
  payment_url          text,
  period_start         timestamptz NOT NULL,
  period_end           timestamptz NOT NULL,
  paid_at              timestamptz,
  failure_reason       text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX billing_invoices_tenant_idx ON billing_invoices (tenant_id, created_at DESC);

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices FORCE ROW LEVEL SECURITY;
-- A company sees and creates its own invoices; marking paid and changing the subscription happen in the
-- platform context (no tenant set), after the payment is confirmed with Moyasar.
CREATE POLICY billing_invoices_tenant ON billing_invoices FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY billing_invoices_tenant_create ON billing_invoices FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY billing_invoices_platform ON billing_invoices FOR ALL USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);
GRANT SELECT, INSERT, UPDATE ON billing_invoices TO rakan_app;

-- Notifications received from the payment provider (idempotency + audit trail). Platform-only.
CREATE TABLE billing_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      text NOT NULL,
  event_id      text NOT NULL,
  type          text NOT NULL,
  ref           text,                          -- provider invoice id it concerns
  live          boolean,
  outcome       text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
GRANT SELECT, INSERT, UPDATE ON billing_events TO rakan_app;
GRANT USAGE, SELECT ON SEQUENCE billing_invoice_seq TO rakan_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rakan_app;
