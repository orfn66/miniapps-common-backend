-- Additive: existing tickets, installation tokens and service tokens are unchanged.
CREATE TABLE admin_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_account_id uuid NOT NULL UNIQUE REFERENCES service_accounts(id),
  email varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  token_hash char(64) PRIMARY KEY,
  credential_id uuid NOT NULL REFERENCES admin_credentials(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX admin_sessions_credential_idx ON admin_sessions(credential_id);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);

-- Persistent global login budget: survives API restarts, no IP/email stored.
CREATE TABLE admin_auth_budget (
  name text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  attempts integer NOT NULL
);
REVOKE ALL ON admin_credentials, admin_sessions, admin_auth_budget FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON admin_credentials, admin_sessions, admin_auth_budget TO miniapps_api;
