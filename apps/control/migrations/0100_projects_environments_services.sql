-- 0100: projects, environments, services and their variables (spec 02, spec 05, spec 06 6.1,
-- spec 08 8.1).

-- A group of related services. Names need not be unique. A workspace that still has projects
-- can't be deleted (spec 23.1); the control plane says so first, and the database refuses too.
CREATE TABLE project (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description  text        NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  created_by   uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE INDEX project_workspace_idx ON project (workspace_id, created_at);

-- One copy of a project's services, with its own variables, data and hostnames. Names are
-- already normalized (lowercase words joined by single dashes, at most 32 characters). An
-- environment named exactly "production" is production.
CREATE TABLE environment (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL,
  project_id   uuid        NOT NULL,
  name         text        NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 32),
  description  text        NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  is_default   boolean     NOT NULL DEFAULT false,
  created_by   uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX environment_one_default_idx ON environment (project_id) WHERE is_default;

-- One runnable thing in an environment, of eight kinds. Copies of a service in the project's
-- other environments share copy_group_id; services from before linking have none and match
-- their copies by name (spec 05 5.4).
CREATE TABLE service (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL,
  project_id       uuid        NOT NULL,
  environment_id   uuid        NOT NULL,
  copy_group_id    uuid,
  kind             text        NOT NULL CHECK (kind IN ('application', 'compose', 'postgres', 'mysql',
                                                        'mariadb', 'mongodb', 'redis', 'libsql')),
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- The internal app name: the chosen part, then a dash and 6 random characters.
  app_name_base    text        NOT NULL CHECK (app_name_base ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(app_name_base) <= 50),
  app_name         text        NOT NULL UNIQUE CHECK (app_name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(app_name) <= 57),
  description      text        NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  -- Null is the Nearzero host. Servers arrive in a later milestone, which adds the reference.
  server_id        uuid,
  status           text        NOT NULL DEFAULT 'idle'
                               CHECK (status IN ('idle', 'deploying', 'running', 'stopped', 'failed')),
  -- The kind's settings that are not secret.
  settings         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The kind's secrets (database passwords), sealed with the install key; never sent back.
  secrets_sealed   text,
  -- Databases: a port from 20000 to 29999, unique per server, or null (private).
  public_port      integer     CHECK (public_port IS NULL OR public_port BETWEEN 20000 AND 29999),
  public_port_note text,
  -- Set while a delete run is removing it (see 0101).
  deleting_run_id  uuid,
  created_by       uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  -- An environment with services can't be deleted; delete or move them first.
  FOREIGN KEY (environment_id, project_id, workspace_id)
    REFERENCES environment (id, project_id, workspace_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX service_name_idx ON service (environment_id, lower(name));
CREATE INDEX service_project_idx ON service (project_id, copy_group_id);
CREATE INDEX service_workspace_idx ON service (workspace_id);
-- The host belongs to no workspace, so its ports are shared by all of them.
CREATE UNIQUE INDEX service_public_port_idx
  ON service ((coalesce(server_id, '00000000-0000-0000-0000-000000000000'::uuid)), public_port)
  WHERE public_port IS NOT NULL;

-- Variables as the text people edit, sealed whole so comments survive byte for byte: an
-- environment's shared variables, or a service's own. Names are kept beside it (they are not
-- secret) so counts and lists don't need the key.
CREATE TABLE variable_set (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  environment_id uuid        UNIQUE REFERENCES environment (id) ON DELETE CASCADE,
  service_id     uuid        UNIQUE REFERENCES service (id) ON DELETE CASCADE,
  sealed         text        NOT NULL,
  names          text[]      NOT NULL DEFAULT '{}',
  size_bytes     integer     NOT NULL CHECK (size_bytes BETWEEN 0 AND 262144),
  -- Bumped on every save, so an editor that opened an older version can't overwrite a newer one.
  version        integer     NOT NULL DEFAULT 1,
  updated_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((environment_id IS NULL) <> (service_id IS NULL))
);
