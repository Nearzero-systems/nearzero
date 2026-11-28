-- 0300: backup destinations, backup schedules, backup and restore runs with their logs, and the
-- notification outbox the backup runs write to (spec 08 8.3, spec 15.3, spec 17, spec 23.1,
-- spec 23.2, spec 24 G1, G2, P4, P5).

-- S3-compatible storage a workspace backs up to. The keys are sealed with the install key and
-- never returned (spec 17.1, 23.4).
CREATE TABLE backup_destination (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  provider      text        NOT NULL CHECK (provider IN ('aws', 'cloudflare-r2', 'digitalocean',
                                                        'wasabi', 'scaleway', 'akamai', 'minio',
                                                        'other')),
  endpoint      text        NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 500),
  bucket        text        NOT NULL CHECK (length(bucket) BETWEEN 1 AND 255),
  region        text        NOT NULL DEFAULT 'auto' CHECK (length(region) <= 64),
  -- {"accessKeyId", "secretAccessKey"} as JSON, sealed.
  keys_sealed   text        NOT NULL,
  keys_saved_at timestamptz NOT NULL DEFAULT now(),
  keys_saved_by uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_by    uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX backup_destination_name_idx ON backup_destination (workspace_id, lower(name));

-- A database dump or a volume archive on a 5-field cron in the server's time zone, into
-- <app name>[_<inner service>]/<folder>/ on one destination, keeping the newest N files.
-- The service and the destination are always in the schedule's workspace (spec 02, 17.3);
-- deleting either removes the schedule (spec 17.1), and the files stay in the bucket.
CREATE TABLE backup_schedule (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL,
  service_id     uuid        NOT NULL,
  destination_id uuid        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('database', 'volume')),
  -- Databases: which database to dump; null is the service's own (MongoDB: all of them).
  database_name  text        CHECK (database_name IS NULL OR length(database_name) <= 64),
  -- Volume backups: the named volume, the Compose service using it, and whether to stop the
  -- service while copying.
  volume_name    text        CHECK (volume_name IS NULL OR length(volume_name) <= 255),
  inner_service  text        CHECK (inner_service IS NULL OR length(inner_service) <= 63),
  stop_service   boolean     NOT NULL DEFAULT false,
  folder         text        NOT NULL CHECK (length(folder) BETWEEN 1 AND 200),
  cron           text        NOT NULL CHECK (length(cron) BETWEEN 9 AND 200),
  -- Null keeps every file.
  keep           integer     CHECK (keep IS NULL OR keep BETWEEN 1 AND 1000),
  enabled        boolean     NOT NULL DEFAULT true,
  -- When the scheduler next starts a run; null while paused.
  next_run_at    timestamptz,
  created_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'volume') = (volume_name IS NOT NULL)),
  FOREIGN KEY (service_id, workspace_id) REFERENCES service (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (destination_id, workspace_id)
    REFERENCES backup_destination (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX backup_schedule_service_idx ON backup_schedule (service_id, created_at);
CREATE INDEX backup_schedule_destination_idx ON backup_schedule (destination_id);
CREATE INDEX backup_schedule_due_idx ON backup_schedule (next_run_at) WHERE enabled;
-- One schedule per folder of a service on a destination, so "keep N" only ever prunes the files
-- of the schedule that wrote them (spec 17.2).
CREATE UNIQUE INDEX backup_schedule_prefix_idx
  ON backup_schedule (service_id, destination_id, coalesce(inner_service, ''), folder);

-- One backup or restore. Rows outlive their schedule and service, keeping the names they show.
CREATE TABLE backup_run (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  schedule_id      uuid        REFERENCES backup_schedule (id) ON DELETE SET NULL,
  service_id       uuid        REFERENCES service (id) ON DELETE SET NULL,
  operation        text        NOT NULL CHECK (operation IN ('backup', 'restore')),
  kind             text        NOT NULL CHECK (kind IN ('database', 'volume')),
  service_kind     text        NOT NULL,
  service_name     text        NOT NULL,
  app_name         text        NOT NULL,
  project_name     text        NOT NULL,
  environment_name text        NOT NULL,
  -- Null is the Nearzero host.
  server_id        uuid,
  destination_id   uuid        REFERENCES backup_destination (id) ON DELETE SET NULL,
  destination_name text        NOT NULL,
  database_name    text,
  volume_name      text,
  -- The file written (backups) or read (restores), and its size once known.
  file_key         text,
  size_bytes       bigint,
  status           text        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued', 'running', 'succeeded', 'failed',
                                                 'cancelled')),
  trigger          text        NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  -- The Idempotency-Key a person's request carried: a retried request gets the same run.
  request_key      text        CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 100),
  -- The schedule's due time, for runs the scheduler started.
  due_at           timestamptz,
  error            text,
  requested_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  job_id           bigint,
  log_bytes        integer     NOT NULL DEFAULT 0,
  log_lines        integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX backup_run_service_idx ON backup_run (service_id, created_at DESC);
CREATE INDEX backup_run_schedule_idx ON backup_run (schedule_id, created_at DESC);
CREATE INDEX backup_run_open_idx ON backup_run (status) WHERE status IN ('queued', 'running');
-- Two runs of one schedule never overlap: one runs and at most one waits (spec 17.2).
CREATE UNIQUE INDEX backup_run_one_running_idx ON backup_run (schedule_id)
  WHERE status = 'running' AND schedule_id IS NOT NULL;
CREATE UNIQUE INDEX backup_run_one_queued_idx ON backup_run (schedule_id)
  WHERE status = 'queued' AND schedule_id IS NOT NULL;
-- A request sent twice (a proxy or a client retrying) starts one run (spec 23.1).
CREATE UNIQUE INDEX backup_run_request_schedule_idx ON backup_run (schedule_id, request_key)
  WHERE request_key IS NOT NULL AND schedule_id IS NOT NULL;
CREATE UNIQUE INDEX backup_run_request_service_idx ON backup_run (service_id, request_key)
  WHERE request_key IS NOT NULL AND schedule_id IS NULL;
-- One restore at a time into a service.
CREATE UNIQUE INDEX backup_run_one_restore_idx ON backup_run (service_id)
  WHERE operation = 'restore' AND status IN ('queued', 'running') AND service_id IS NOT NULL;

-- A run's log, in pieces stored in order.
CREATE TABLE backup_run_log (
  run_id uuid        NOT NULL REFERENCES backup_run (id) ON DELETE CASCADE,
  seq    integer     NOT NULL,
  at     timestamptz NOT NULL DEFAULT now(),
  text   text        NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Events for the notifications milestone (spec 15.3): written once when a backup run ends, read
-- and marked delivered by the notifications sender. Payloads never hold secrets.
CREATE TABLE notification_outbox (
  id           bigserial   PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  event        text        NOT NULL CHECK (event ~ '^[a-z][a-z0-9.-]{0,63}$'),
  -- One event per thing that happened, even if the run's job is retried.
  dedupe_key   text        NOT NULL UNIQUE,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX notification_outbox_pending_idx ON notification_outbox (created_at)
  WHERE delivered_at IS NULL;
