-- Phase 4 completion: Prospecting agent and the "Ask Rakan" assistant.

-- A search for new potential customers (web search through the AI provider, or text the user supplies).
CREATE TABLE prospect_searches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  query          text NOT NULL,
  city           text,
  source         text NOT NULL CHECK (source IN ('web_search','manual')),
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  found          int NOT NULL DEFAULT 0,
  dropped        jsonb NOT NULL DEFAULT '[]',      -- candidates rejected by validation, with the reason
  agent_run_id   uuid,
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs(tenant_id, id) ON DELETE SET NULL (agent_run_id)
);
CREATE INDEX prospect_searches_time_idx ON prospect_searches (tenant_id, created_at DESC);

-- A proposed company. Never becomes an account without a human accepting it.
CREATE TABLE prospects (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  search_id                uuid NOT NULL,
  name                     text NOT NULL,
  website_domain           text,
  city                     text,
  region                   text,
  industry                 text,
  phone                    text,                        -- public company number only, as published by the source
  why_fit                  text NOT NULL,
  fit_evidence             jsonb NOT NULL DEFAULT '[]', -- [{ text, ref }] refs to approved Sales Brain items
  source_url               text NOT NULL,               -- where it was found (or 'manual:<search id>')
  source_title             text,
  retrieved_at             timestamptz NOT NULL DEFAULT now(),
  confidence               numeric(4,3) NOT NULL,
  duplicate_of_account_id  uuid,
  status                   text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','accepted','rejected')),
  account_id               uuid,
  reviewed_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at              timestamptz,
  reject_reason            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, search_id) REFERENCES prospect_searches(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, duplicate_of_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL (duplicate_of_account_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL (account_id)
);
CREATE INDEX prospects_status_idx ON prospects (tenant_id, status, created_at DESC);

-- "Ask Rakan" conversations: one per user thread. Messages keep the tool calls for the audit trail.
CREATE TABLE assistant_conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX assistant_conversations_user_idx ON assistant_conversations (tenant_id, user_id, updated_at DESC);

CREATE TABLE assistant_messages (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  role             text NOT NULL CHECK (role IN ('user','assistant')),
  content          text NOT NULL,
  tool_calls       jsonb NOT NULL DEFAULT '[]',   -- [{ tool, input, ok, summary }]
  links            jsonb NOT NULL DEFAULT '[]',   -- [{ label, href }] records referenced in the answer
  agent_run_id     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES assistant_conversations(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX assistant_messages_conv_idx ON assistant_messages (tenant_id, conversation_id, id);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['prospect_searches','prospects','assistant_conversations','assistant_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rakan_app', tbl);
  END LOOP;
END $$;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rakan_app;
