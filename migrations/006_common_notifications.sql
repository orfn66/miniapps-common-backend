-- Common, app-scoped notification queue. Delivery capabilities and payloads
-- are encrypted by the API before they reach PostgreSQL.

ALTER TABLE service_accounts DROP CONSTRAINT service_accounts_scopes_check;
ALTER TABLE service_accounts ADD CONSTRAINT service_accounts_scopes_check CHECK (scopes <@ ARRAY[
  'apps:read', 'apps:write', 'feedback:read', 'feedback:write',
  'attachments:read', 'attachments:delete', 'logs:read',
  'notifications:devices:write', 'notifications:send', 'notifications:read'
]::text[]);

CREATE TABLE notification_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL REFERENCES games(slug),
  recipient_hash char(64) NOT NULL,
  device_reference_hash char(64) NOT NULL,
  transport varchar(16) NOT NULL CHECK (transport IN ('fcm', 'web_push')),
  platform varchar(16) NOT NULL CHECK (platform IN ('android', 'pwa', 'web')),
  capability_hash char(64) NOT NULL,
  capability_ciphertext bytea NOT NULL,
  capability_iv bytea NOT NULL CHECK (octet_length(capability_iv) = 12),
  capability_tag bytea NOT NULL CHECK (octet_length(capability_tag) = 16),
  permission varchar(16) NOT NULL CHECK (permission IN ('granted', 'denied')),
  state varchar(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'invalid')),
  last_error_code varchar(80),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(app_id, device_reference_hash)
);

CREATE UNIQUE INDEX notification_devices_capability_unique
  ON notification_devices(app_id, capability_hash) WHERE revoked_at IS NULL;
CREATE INDEX notification_devices_recipient_idx
  ON notification_devices(app_id, recipient_hash) WHERE state='active' AND revoked_at IS NULL;

CREATE TABLE notification_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  app_id text NOT NULL REFERENCES games(slug),
  event_type varchar(80) NOT NULL,
  recipient_hash char(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  payload_hash char(64) NOT NULL,
  payload_ciphertext bytea NOT NULL,
  payload_iv bytea NOT NULL CHECK (octet_length(payload_iv) = 12),
  payload_tag bytea NOT NULL CHECK (octet_length(payload_tag) = 16),
  deep_link varchar(512),
  status varchar(16) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'delivered', 'partial', 'failed')),
  device_count integer NOT NULL DEFAULT 0 CHECK (device_count >= 0),
  delivered_count integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(app_id, idempotency_key)
);

CREATE INDEX notification_messages_app_created_idx ON notification_messages(app_id, created_at DESC);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES notification_messages(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES notification_devices(id),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code varchar(80),
  provider_message_id varchar(256),
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(message_id, device_id)
);

CREATE INDEX notification_deliveries_ready_idx
  ON notification_deliveries(next_attempt_at, id) WHERE status='pending';

REVOKE ALL ON notification_devices, notification_messages, notification_deliveries FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON notification_devices, notification_messages, notification_deliveries TO miniapps_api;
GRANT DELETE ON notification_devices, notification_messages TO miniapps_api;

COMMENT ON TABLE notification_devices IS 'Encrypted FCM/Web Push capabilities, strictly scoped to app_id.';
COMMENT ON TABLE notification_messages IS 'Transport-only queue; encrypted payload is never exposed by admin APIs.';
COMMENT ON COLUMN notification_messages.idempotency_key IS 'Caller key, unique inside one application.';
