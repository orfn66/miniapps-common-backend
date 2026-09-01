-- Additive Mema integration. The VPS never reads Mema business tables and
-- authenticates callers through Supabase Auth using the public project key.

INSERT INTO games(slug, name, app_type, platforms, current_version, status, active)
VALUES ('mema', 'Mema', 'pwa', ARRAY['web', 'android']::text[], '0.1.0-rc.1', 'active', true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  app_type = EXCLUDED.app_type,
  platforms = EXCLUDED.platforms,
  current_version = EXCLUDED.current_version,
  updated_at = now();

ALTER TABLE feedback
  ALTER COLUMN installation_id DROP NOT NULL,
  ALTER COLUMN comment TYPE varchar(4000),
  ADD COLUMN source_app text REFERENCES games(slug),
  ADD COLUMN source_feedback_id uuid,
  ADD COLUMN source_actor_hash char(64),
  ADD COLUMN source_kind varchar(32),
  ADD COLUMN source_status varchar(32),
  ADD COLUMN source_created_at timestamptz,
  ADD COLUMN source_status_updated_at timestamptz,
  ADD COLUMN imported_at timestamptz,
  ADD CONSTRAINT feedback_origin_check CHECK (
    (installation_id IS NOT NULL AND source_app IS NULL AND source_feedback_id IS NULL AND source_actor_hash IS NULL)
    OR
    (installation_id IS NULL AND source_app IS NOT NULL AND source_feedback_id IS NOT NULL AND source_actor_hash IS NOT NULL)
  ),
  ADD CONSTRAINT feedback_source_status_check CHECK (
    source_status IS NULL OR source_status IN ('new', 'in_progress', 'resolved')
  );

CREATE UNIQUE INDEX feedback_source_unique
  ON feedback(source_app, source_feedback_id)
  WHERE source_app IS NOT NULL AND source_feedback_id IS NOT NULL;
CREATE INDEX feedback_source_created_idx
  ON feedback(source_app, source_created_at DESC, source_feedback_id DESC)
  WHERE source_app IS NOT NULL;
CREATE UNIQUE INDEX feedback_attachment_live_sha_unique
  ON feedback_attachments(feedback_id, sha256)
  WHERE deleted_at IS NULL;

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_app text NOT NULL REFERENCES games(slug),
  source_actor_hash char(64) NOT NULL,
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 16 AND 4096),
  endpoint_hash char(64) NOT NULL,
  p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 16 AND 512),
  auth text NOT NULL CHECK (length(auth) BETWEEN 8 AND 256),
  expiration_time bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(source_app, endpoint_hash)
);

CREATE INDEX push_subscriptions_actor_idx
  ON push_subscriptions(source_app, source_actor_hash)
  WHERE revoked_at IS NULL;

REVOKE ALL ON push_subscriptions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON push_subscriptions TO miniapps_api;

COMMENT ON COLUMN feedback.source_actor_hash IS
  'App-scoped HMAC of the authenticated source user; never the Supabase UUID.';
COMMENT ON TABLE push_subscriptions IS
  'Private Web Push capabilities. Endpoints and encryption keys are never returned by admin APIs or logs.';
