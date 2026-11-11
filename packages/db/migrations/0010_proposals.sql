-- Commercial proposals (quotations): priced from the approved Sales Brain price list, 15% VAT, approval
-- before anything reaches the customer, and a private link where the customer accepts or declines.

CREATE TABLE proposal_sequences (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last       int NOT NULL DEFAULT 0
);

CREATE TABLE proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,                      -- e.g. Q-2026-0001 (per company)
  account_id        uuid NOT NULL,
  opportunity_id    uuid,
  contact_id        uuid,
  owner_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  title             text NOT NULL,
  intro             text NOT NULL DEFAULT '',
  terms             text NOT NULL DEFAULT '',
  currency          char(3) NOT NULL DEFAULT 'SAR',
  vat_rate          numeric(5,2) NOT NULL DEFAULT 15,
  subtotal          numeric(14,2) NOT NULL DEFAULT 0,   -- after line discounts, before VAT
  discount_total    numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount        numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  valid_until       date NOT NULL,
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending_approval','sent','accepted','declined','cancelled')),
  version           int NOT NULL DEFAULT 1,
  source            text NOT NULL DEFAULT 'user' CHECK (source IN ('user','agent')),
  agent_run_id      uuid,
  approval_request_id uuid,
  share_token_hash  text UNIQUE,                        -- sha256 of the customer link token
  share_token_enc   text,                               -- the token, encrypted (to show the link again)
  sent_at           timestamptz,
  viewed_at         timestamptz,
  decided_at        timestamptz,
  decision_by_name  text,                               -- name the customer typed when deciding
  decision_note     text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id) ON DELETE SET NULL (opportunity_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX proposals_status_idx ON proposals (tenant_id, status, updated_at DESC);
CREATE INDEX proposals_account_idx ON proposals (tenant_id, account_id, created_at DESC);

CREATE TABLE proposal_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  proposal_id     uuid NOT NULL,
  sort            int NOT NULL,
  name            text NOT NULL,
  description     text,
  unit            text,
  quantity        numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit_price      numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  discount_pct    numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  line_total      numeric(14,2) NOT NULL,
  price_source    text NOT NULL CHECK (price_source IN ('price_list','manual')),
  brain_item_id   uuid,                                 -- the approved price this line uses
  brain_version   int,
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX proposal_items_idx ON proposal_items (tenant_id, proposal_id, sort);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['proposal_sequences','proposals','proposal_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rakan_app', tbl);
  END LOOP;
END $$;

-- The customer link carries no tenant context: resolve the token hash to its company and proposal only.
-- Returns nothing for an unknown hash; the caller then reads the proposal inside that company's context.
CREATE FUNCTION proposal_by_token(p_hash text) RETURNS TABLE (tenant_id uuid, proposal_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.tenant_id, p.id FROM proposals p WHERE p.share_token_hash = p_hash AND length(p_hash) = 64
$$;
REVOKE ALL ON FUNCTION proposal_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_by_token(text) TO rakan_app;
