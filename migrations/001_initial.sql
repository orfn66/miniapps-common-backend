CREATE TABLE games (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE installations (
  id uuid PRIMARY KEY,
  game_slug text NOT NULL REFERENCES games(slug),
  token_hash char(64) NOT NULL UNIQUE,
  client_version varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE feedback (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id),
  type varchar(16) NOT NULL CHECK (type IN ('like', 'neutral', 'dislike', 'bug', 'idea')),
  comment varchar(1000) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'check', 'fixed', 'ignored')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_installation_created_idx ON feedback(installation_id, created_at DESC);

CREATE TABLE play_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id),
  idempotency_key varchar(64) NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 0 AND 86400),
  score bigint CHECK (score BETWEEN -1000000000 AND 1000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, idempotency_key)
);

CREATE INDEX play_sessions_installation_created_idx ON play_sessions(installation_id, created_at DESC);

INSERT INTO games(slug, name) VALUES ('perfect-tap', 'Perfect Tap');

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
GRANT SELECT ON games TO miniapps_api;
GRANT SELECT, INSERT ON installations, feedback, play_sessions TO miniapps_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO miniapps_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
