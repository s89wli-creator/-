-- Rakan's spokesperson voice: one AI voice (cloned from a consenting person) used to read Ask Rakan replies aloud.
-- Platform data (no tenant_id): only the platform console writes it. The audio sample itself is not kept:
-- it is sent to the voice provider once, and only its hash is stored as evidence of what was cloned.
CREATE TABLE platform_voice (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider           text NOT NULL,
  voice_id           text NOT NULL,
  display_name       text NOT NULL,
  consent_statement  text NOT NULL,
  consented_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  consented_at       timestamptz NOT NULL DEFAULT now(),
  sample_sha256      text NOT NULL,
  sample_bytes       int NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_voice TO rakan_app;

-- Per-company switch (voice costs money per use; owners can turn it off).
ALTER TABLE ai_settings ADD COLUMN voice_enabled boolean NOT NULL DEFAULT true;
