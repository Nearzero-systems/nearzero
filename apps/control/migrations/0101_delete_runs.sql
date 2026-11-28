-- 0101: deleting projects and services in the background, with a state per service
-- (spec 05 5.1, 5.2; spec 23.1 "Teardown is complete").

-- One delete: a whole project, or chosen services. It outlives what it deletes, so the project
-- and services it names are plain values, not references.
CREATE TABLE delete_run (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  scope        text        NOT NULL CHECK (scope IN ('project', 'services')),
  project_id   uuid        NOT NULL,
  project_name text        NOT NULL,
  -- running until every service has a result; failed when any was not removed (the project, if
  -- any, is kept).
  state        text        NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed')),
  fingerprint  text,
  job_id       bigint,
  requested_by uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE INDEX delete_run_project_idx ON delete_run (project_id, created_at);
-- At most one delete of a whole project at a time.
CREATE UNIQUE INDEX delete_run_one_project_idx ON delete_run (project_id)
  WHERE state = 'running' AND scope = 'project';

CREATE TABLE delete_run_item (
  run_id           uuid    NOT NULL REFERENCES delete_run (id) ON DELETE CASCADE,
  position         integer NOT NULL,
  service_id       uuid    NOT NULL,
  environment_id   uuid    NOT NULL,
  environment_name text    NOT NULL,
  service_name     text    NOT NULL,
  kind             text    NOT NULL,
  app_name         text    NOT NULL,
  server_id        uuid,
  production       boolean NOT NULL DEFAULT false,
  -- A running service is stopped as part of its deletion.
  stop_first       boolean NOT NULL DEFAULT false,
  state            text    NOT NULL DEFAULT 'waiting'
                           CHECK (state IN ('waiting', 'removing', 'removed', 'not_removed')),
  reason           text,
  PRIMARY KEY (run_id, service_id)
);

ALTER TABLE service
  ADD CONSTRAINT service_deleting_run_fk
  FOREIGN KEY (deleting_run_id) REFERENCES delete_run (id) ON DELETE SET NULL;
