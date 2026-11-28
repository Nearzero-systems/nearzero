-- 0151: the runner on every server and on the Nearzero host, its join tokens, and the metrics it
-- reports (spec 25 D1 option C, spec 14.1).

-- One runner per server; the row with no server is the Nearzero host's.
CREATE TABLE runner (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id            uuid        UNIQUE REFERENCES server (id) ON DELETE CASCADE,
  -- SHA-256 (hex) of the credential's secret. Null when none was issued or it was revoked.
  credential_hash      text        CHECK (credential_hash IS NULL OR credential_hash ~ '^[0-9a-f]{64}$'),
  credential_issued_at timestamptz,
  revoked_at           timestamptz,
  runner_version       text,
  protocol             integer,
  -- System information and the checks from the runner's last hello or state report.
  system               jsonb,
  checks               jsonb,
  connected_at         timestamptz,
  last_seen_at         timestamptz,
  disconnected_at      timestamptz,
  -- Why the last connection was refused (an outdated runner), in plain words; null when fine.
  refusal              text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX runner_one_host_idx ON runner ((server_id IS NULL)) WHERE server_id IS NULL;

-- One-time tokens a runner trades for its credential. Stored hashed; used once.
CREATE TABLE runner_join_token (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null is the Nearzero host.
  server_id  uuid        REFERENCES server (id) ON DELETE CASCADE,
  token_hash text        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_by uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runner_join_token_server_idx ON runner_join_token (server_id);

-- One sample every 5 seconds per server, kept for 2 days (spec 14.1). target is a server id, or
-- "host" for the Nearzero host.
CREATE TABLE server_metric (
  target             text        NOT NULL CHECK (length(target) BETWEEN 1 AND 64),
  at                 timestamptz NOT NULL,
  cpu_percent        real        NOT NULL,
  memory_used_bytes  bigint      NOT NULL,
  memory_total_bytes bigint      NOT NULL,
  disk_used_bytes    bigint      NOT NULL,
  disk_total_bytes   bigint      NOT NULL,
  uptime_seconds     bigint      NOT NULL,
  PRIMARY KEY (target, at)
);

CREATE INDEX server_metric_at_idx ON server_metric (at);
