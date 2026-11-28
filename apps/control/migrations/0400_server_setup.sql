-- 0400: setting servers up over SSH (spec 09 9.3, 9.4, 9.6; 14.4; 15.3; 25 D1 option C).

-- One run of setup on a server: its numbered steps, where it stopped and why. A run is followed
-- live through its log below; the newest run is what the setup dialog shows.
CREATE TABLE server_setup_run (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id        uuid        NOT NULL REFERENCES server (id) ON DELETE CASCADE,
  workspace_id     uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  state            text        NOT NULL DEFAULT 'running'
                               CHECK (state IN ('running', 'succeeded', 'failed')),
  -- The step running now, or the one the run stopped at.
  step             integer     CHECK (step BETWEEN 1 AND 15),
  -- Per step: { state, note }, in step order.
  steps            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Why it stopped, in plain words, with what the dialog offers next (never secrets).
  failure          jsonb,
  -- True when this run replaced one that stopped responding.
  retried_stalled  boolean     NOT NULL DEFAULT false,
  ssh_user         text        NOT NULL,
  job_id           bigint,
  requested_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  log_seq          integer     NOT NULL DEFAULT 0,
  started_at       timestamptz NOT NULL DEFAULT now(),
  -- Moves with every log line and at least every 30 seconds while the run works.
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);

CREATE INDEX server_setup_run_server_idx ON server_setup_run (server_id, started_at DESC);
-- At most one running setup per server.
CREATE UNIQUE INDEX server_setup_run_one_running_idx ON server_setup_run (server_id)
  WHERE state = 'running';

-- The run's log, line by line, cleaned of secrets before it is written.
CREATE TABLE server_setup_log (
  run_id uuid        NOT NULL REFERENCES server_setup_run (id) ON DELETE CASCADE,
  seq    integer     NOT NULL,
  at     timestamptz NOT NULL DEFAULT now(),
  text   text        NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- What Nearzero last found on a server: the setup validation and the security audit (spec 9.4).
CREATE TABLE server_inspection (
  server_id     uuid        PRIMARY KEY REFERENCES server (id) ON DELETE CASCADE,
  validation    jsonb,
  validation_at timestamptz,
  audit         jsonb,
  audit_at      timestamptz
);

-- The daily Docker cleanup (spec 9.4, 14.4). target is a server id or "host". Servers keep
-- their switch in server.docker_cleanup; the host's is here (on unless an administrator turned it
-- off).
CREATE TABLE docker_cleanup (
  target           text        PRIMARY KEY CHECK (length(target) BETWEEN 1 AND 64),
  enabled          boolean,
  -- The server's own date (in its time zone) of the last cleanup, so each day runs once.
  last_local_date  text,
  last_at          timestamptz,
  last_freed_bytes bigint,
  last_error       text
);

-- Deleting a server together with its services (spec 9.6): the services go through the usual
-- delete runs (one per project), then the server. It outlives the server it names.
CREATE TABLE server_removal (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  server_id    uuid        NOT NULL,
  server_name  text        NOT NULL,
  state        text        NOT NULL DEFAULT 'running'
                           CHECK (state IN ('running', 'succeeded', 'failed')),
  run_ids      uuid[]      NOT NULL DEFAULT '{}',
  message      text,
  job_id       bigint,
  requested_by uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE INDEX server_removal_server_idx ON server_removal (server_id, created_at DESC);
CREATE UNIQUE INDEX server_removal_one_running_idx ON server_removal (server_id)
  WHERE state = 'running';
