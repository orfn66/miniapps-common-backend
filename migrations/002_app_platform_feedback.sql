-- Additive evolution of the mini-app pilot into the transversal App Platform.
-- Existing games, installations, feedback and play-session clients remain valid.

ALTER TABLE games
  ADD COLUMN app_type varchar(32) NOT NULL DEFAULT 'mini_game',
  ADD COLUMN platforms text[] NOT NULL DEFAULT ARRAY['web']::text[],
  ADD COLUMN current_version varchar(64),
  ADD COLUMN status varchar(16) NOT NULL DEFAULT 'active',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT games_app_type_check CHECK (app_type IN (
    'pwa', 'web', 'mini_game', 'android', 'capacitor', 'cloudflare_worker',
    'supabase', 'firebase', 'wordpress', 'service', 'other'
  )),
  ADD CONSTRAINT games_status_check CHECK (status IN ('active', 'archived'));

UPDATE games
SET current_version = CASE WHEN slug = 'perfect-tap' THEN '0.2.0' ELSE current_version END,
    platforms = CASE WHEN slug = 'perfect-tap' THEN ARRAY['web', 'android', 'capacitor']::text[] ELSE platforms END,
    status = CASE WHEN slug = 'perfect-tap' THEN 'archived' ELSE status END,
    active = CASE WHEN slug = 'perfect-tap' THEN false ELSE active END;

-- The product boundary is the Hub. Individual games are modules supplied as
-- feedback context (technical_context.module), never separate registry apps.
INSERT INTO games(slug, name, app_type, platforms, current_version, status, active)
VALUES ('minigames-hub', 'MiniGames Hub', 'pwa', ARRAY['web']::text[], '0.1.0', 'active', true)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE feedback
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN title varchar(160),
  ADD COLUMN priority varchar(16) NOT NULL DEFAULT 'normal',
  ADD COLUMN client_version varchar(64),
  ADD COLUMN client_occurred_at timestamptz,
  ADD COLUMN route varchar(256),
  ADD COLUMN device varchar(160),
  ADD COLUMN os varchar(120),
  ADD COLUMN browser varchar(120),
  ADD COLUMN resolution varchar(32),
  ADD COLUMN technical_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN pseudonymous_user_id char(64),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN closed_at timestamptz,
  ADD CONSTRAINT feedback_public_id_unique UNIQUE (public_id),
  ADD CONSTRAINT feedback_priority_check CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  ADD CONSTRAINT feedback_technical_context_object CHECK (jsonb_typeof(technical_context) = 'object');

ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_type_check;

UPDATE feedback SET type = CASE type
  WHEN 'idea' THEN 'suggestion'
  WHEN 'like' THEN 'review'
  WHEN 'neutral' THEN 'review'
  WHEN 'dislike' THEN 'review'
  ELSE type
END;

ALTER TABLE feedback
  ADD CONSTRAINT feedback_type_check CHECK (type IN ('bug', 'improvement', 'suggestion', 'review'));

UPDATE feedback f
SET client_version = i.client_version,
    title = CASE
      WHEN f.type = 'bug' THEN 'Bug signalé'
      WHEN f.type = 'suggestion' THEN 'Idée proposée'
      ELSE 'Avis utilisateur'
    END
FROM installations i
WHERE i.id = f.installation_id;

ALTER TABLE feedback ALTER COLUMN client_version SET NOT NULL;
ALTER TABLE feedback ALTER COLUMN title SET NOT NULL;

ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_status_check;

UPDATE feedback SET status = CASE status
  WHEN 'check' THEN 'to_analyze'
  WHEN 'fixed' THEN 'fixed'
  WHEN 'ignored' THEN 'closed'
  ELSE 'new'
END;

ALTER TABLE feedback
  ALTER COLUMN status TYPE varchar(24),
  ADD CONSTRAINT feedback_status_check CHECK (status IN (
    'new', 'to_analyze', 'confirmed', 'in_progress', 'to_test', 'fixed', 'closed'
  ));

CREATE INDEX feedback_status_created_idx ON feedback(status, created_at DESC);
CREATE INDEX feedback_priority_created_idx ON feedback(priority, created_at DESC);
CREATE INDEX feedback_metadata_gin_idx ON feedback USING gin(technical_context);

CREATE TABLE feedback_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feedback_id bigint NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  from_status varchar(24),
  to_status varchar(24) NOT NULL,
  changed_by varchar(120) NOT NULL,
  note varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_history_ticket_idx ON feedback_status_history(feedback_id, created_at DESC);

CREATE TABLE feedback_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id bigint NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  storage_name varchar(96) NOT NULL UNIQUE,
  original_name varchar(255),
  media_type varchar(32) NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  sha256 char(64) NOT NULL,
  consent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  deleted_at timestamptz
);

CREATE INDEX feedback_attachments_ticket_idx ON feedback_attachments(feedback_id) WHERE deleted_at IS NULL;
CREATE INDEX feedback_attachments_expiry_idx ON feedback_attachments(expires_at) WHERE deleted_at IS NULL;

CREATE TABLE service_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL UNIQUE,
  token_hash char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  app_ids text[],
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT service_accounts_scopes_check CHECK (scopes <@ ARRAY[
    'apps:read', 'apps:write', 'feedback:read', 'feedback:write',
    'attachments:read', 'attachments:delete', 'logs:read'
  ]::text[])
);

CREATE TABLE platform_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor varchar(120) NOT NULL,
  action varchar(80) NOT NULL,
  target_type varchar(40) NOT NULL,
  target_id varchar(120),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_audit_created_idx ON platform_audit_log(created_at DESC);

REVOKE ALL ON feedback_status_history, feedback_attachments, service_accounts, platform_audit_log FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON games, feedback, feedback_status_history, feedback_attachments, service_accounts, platform_audit_log TO miniapps_api;
GRANT DELETE ON feedback_attachments TO miniapps_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO miniapps_api;
