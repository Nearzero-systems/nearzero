-- 0200: deployments and their logs, deploy webhooks and uploaded archives (spec 06 6.3–6.6,
-- spec 08 8.2, spec 11, spec 23.1, spec 24 G4).

-- One run of building and starting a service. Rows outlive their service: deleting a service
-- marks them "removed" (service_id becomes null) and they are pruned after 30 days; the names
-- they show are kept beside them for that. Each service keeps its newest 50.
CREATE TABLE deployment (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  service_id       uuid        REFERENCES service (id) ON DELETE SET NULL,
  project_id       uuid,
  environment_id   uuid,
  service_kind     text        NOT NULL,
  service_name     text        NOT NULL,
  app_name         text        NOT NULL,
  project_name     text        NOT NULL,
  environment_name text        NOT NULL,
  -- Null is the Nearzero host. Checked by the control plane, not a foreign key: deleting a
  -- server deletes its rows (the retention job).
  server_id        uuid,
  server_name      text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued', 'building', 'active', 'previous',
                                                 'not_running', 'failed', 'cancelled', 'removed')),
  trigger          text        NOT NULL CHECK (trigger IN ('push', 'webhook', 'manual', 'agent')),
  requested_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  -- The commit subject once known, else what started it ("Manual deploy", "Make public"…).
  title            text        NOT NULL DEFAULT '',
  -- Where the code came from, for the detail page: { type, provider, repository, branch, path }.
  source           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- A push or webhook may ask for one commit or tag; otherwise the branch's newest is used.
  requested_commit text,
  requested_tag    text,
  commit_hash      text,
  builder          text,
  framework        text,
  image            text,
  container_name   text,
  error            text,
  clean_cache      boolean     NOT NULL DEFAULT false,
  cancel_requested_at timestamptz,
  job_id           bigint,
  log_bytes        integer     NOT NULL DEFAULT 0,
  log_lines        integer     NOT NULL DEFAULT 0,
  log_truncated    boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  removed_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployment_service_idx ON deployment (service_id, created_at DESC);
CREATE INDEX deployment_workspace_idx ON deployment (workspace_id, created_at DESC);
CREATE INDEX deployment_removed_idx ON deployment (removed_at) WHERE status = 'removed';
-- Exactly one deploy per service runs, and at most one waits (spec 6.5, 6.6, 23.1).
CREATE UNIQUE INDEX deployment_one_building_idx ON deployment (service_id) WHERE status = 'building';
CREATE UNIQUE INDEX deployment_one_queued_idx ON deployment (service_id) WHERE status = 'queued';
CREATE UNIQUE INDEX deployment_one_active_idx ON deployment (service_id)
  WHERE status IN ('active', 'not_running');

-- A deployment's log, in pieces as it was written. seq numbers each piece, so a viewer resumes
-- after the last one it saw.
CREATE TABLE deployment_log (
  deployment_id uuid        NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
  seq           integer     NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  text          text        NOT NULL,
  PRIMARY KEY (deployment_id, seq)
);

-- A service's generic deploy webhook (spec 6.6, G4). The token is nzw1.<id>.<secret>: the
-- secret's SHA-256 checks a call; a sealed copy lets people with deploy rights show the URL
-- again. Replacing it makes the old URL stop working at once.
CREATE TABLE deploy_webhook (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id     uuid        NOT NULL UNIQUE REFERENCES service (id) ON DELETE CASCADE,
  workspace_id   uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  secret_hash    text        NOT NULL,
  token_sealed   text        NOT NULL,
  created_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_called_at timestamptz
);

-- Uploaded .zip archives (spec 6.3, Upload), at most 200 MB, kept in 1 MB pieces until a newer
-- upload of the same service replaces them. The service's runner downloads them.
CREATE TABLE source_upload (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id   uuid        NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  file_name    text        NOT NULL DEFAULT 'upload.zip',
  size_bytes   bigint      NOT NULL CHECK (size_bytes BETWEEN 1 AND 209715200),
  sha256       text        NOT NULL,
  complete     boolean     NOT NULL DEFAULT false,
  created_by   uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX source_upload_service_idx ON source_upload (service_id, created_at DESC);

CREATE TABLE source_upload_part (
  upload_id uuid    NOT NULL REFERENCES source_upload (id) ON DELETE CASCADE,
  seq       integer NOT NULL,
  bytes     bytea   NOT NULL,
  PRIMARY KEY (upload_id, seq)
);
