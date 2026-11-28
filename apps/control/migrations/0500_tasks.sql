-- Tasks (spec 12, 20.12): a script that runs on a schedule (cron in an IANA time zone) or on
-- demand, in exactly one place: a service's container, a server, or the Nearzero host. Host
-- tasks belong to no workspace (they are for instance administrators, like the host itself).

CREATE TABLE task (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null for a Nearzero host task.
  workspace_id   uuid        REFERENCES workspace (id) ON DELETE CASCADE,
  name           text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description    text        NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  place          text        NOT NULL CHECK (place IN ('container', 'server', 'host')),
  -- Deleting the service or the server deletes its tasks.
  service_id     uuid        REFERENCES service (id) ON DELETE CASCADE,
  -- A Compose service's inner service, when the stack has several.
  inner_service  text        CHECK (inner_service IS NULL OR inner_service ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$'),
  server_id      uuid        REFERENCES server (id) ON DELETE CASCADE,
  shell          text        NOT NULL DEFAULT 'bash' CHECK (shell IN ('bash', 'sh')),
  cron           text        NOT NULL CHECK (length(cron) BETWEEN 9 AND 200),
  time_zone      text        NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64),
  script         text        NOT NULL CHECK (octet_length(script) BETWEEN 1 AND 65536 AND strpos(script, chr(13)) = 0),
  enabled        boolean     NOT NULL DEFAULT true,
  -- When the schedule next fires; null while disabled.
  next_run_at    timestamptz,
  created_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_via    text        NOT NULL DEFAULT 'console' CHECK (created_via IN ('console', 'agent')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((place = 'container') = (service_id IS NOT NULL)),
  CHECK ((place = 'server') = (server_id IS NOT NULL)),
  CHECK ((place = 'host') = (workspace_id IS NULL)),
  CHECK (place = 'container' OR inner_service IS NULL),
  CHECK (place <> 'container' OR shell IN ('bash', 'sh')),
  CHECK (place = 'container' OR shell = 'bash')
);

CREATE INDEX task_workspace_idx ON task (workspace_id, created_at);
CREATE INDEX task_due_idx ON task (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;
CREATE INDEX task_service_idx ON task (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX task_server_idx ON task (server_id) WHERE server_id IS NOT NULL;

-- One run of a task, started by its schedule, by Run, or by the Agent. Each task keeps its
-- newest 100 runs. The log holds the run's last 1,000 lines (spec 12.3).
CREATE TABLE task_run (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid        NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  status            text        NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'succeeded', 'failed', 'stopped', 'skipped')),
  trigger           text        NOT NULL CHECK (trigger IN ('schedule', 'manual', 'agent')),
  requested_by      uuid        REFERENCES person (id) ON DELETE SET NULL,
  -- The schedule's due time, for runs the schedule started (or skipped).
  due_at            timestamptz,
  exit_code         integer,
  error             text,
  log               text        NOT NULL DEFAULT '',
  log_lines         integer     NOT NULL DEFAULT 0,
  log_truncated     boolean     NOT NULL DEFAULT false,
  stop_requested_at timestamptz,
  job_id            bigint,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_run_task_idx ON task_run (task_id, started_at DESC);
CREATE INDEX task_run_running_idx ON task_run (updated_at) WHERE status = 'running';
-- A task runs once at a time: a schedule that comes due meanwhile is skipped (and recorded),
-- and Run waits for the running one (spec 12.3).
CREATE UNIQUE INDEX task_run_one_running_idx ON task_run (task_id) WHERE status = 'running';
-- Each due time of a schedule is handled once, however many processes look at it.
CREATE UNIQUE INDEX task_run_due_idx ON task_run (task_id, due_at) WHERE due_at IS NOT NULL;
