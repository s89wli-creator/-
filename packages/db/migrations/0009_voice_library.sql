-- Spokesperson voice can also be a ready-made voice from the provider's voice library (e.g. a male voice with
-- a general Saudi accent), chosen by the platform. Such voices need no owner consent from us (licensed by the
-- provider) and are never deleted at the provider by Rakan.
ALTER TABLE platform_voice ADD COLUMN kind text NOT NULL DEFAULT 'cloned' CHECK (kind IN ('cloned','library'));
ALTER TABLE platform_voice ALTER COLUMN consent_statement DROP NOT NULL;
ALTER TABLE platform_voice ALTER COLUMN sample_sha256 DROP NOT NULL;
ALTER TABLE platform_voice ALTER COLUMN sample_bytes DROP NOT NULL;
ALTER TABLE platform_voice ADD CONSTRAINT platform_voice_cloned_consent
  CHECK (kind <> 'cloned' OR (consent_statement IS NOT NULL AND sample_sha256 IS NOT NULL AND sample_bytes IS NOT NULL));

-- Platform-wide settings (key/value). First use: how Rakan speaks in Ask Rakan ('saudi' general dialect or 'msa').
CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON platform_settings TO rakan_app;
INSERT INTO platform_settings (key, value) VALUES ('speech_style', '"saudi"');
