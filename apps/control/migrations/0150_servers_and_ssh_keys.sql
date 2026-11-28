-- 0150: SSH keys, servers, and the workspaces allowed on the Nearzero host
-- (spec 09 9.2, 9.4, 9.7; spec 10.2; spec 24 G3).

-- A key pair stored in the workspace. The private key is sealed with the install key and never
-- sent back; the public key and its fingerprint are not secret.
CREATE TABLE ssh_key (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  name               text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description        text        NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  key_type           text        NOT NULL CHECK (key_type IN ('rsa', 'ed25519')),
  public_key         text        NOT NULL CHECK (length(public_key) BETWEEN 1 AND 8192),
  -- SHA256:<base64>, as ssh-keygen -l shows it.
  fingerprint        text        NOT NULL,
  private_key_sealed text        NOT NULL,
  created_by         uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE INDEX ssh_key_workspace_idx ON ssh_key (workspace_id, created_at);

-- A Linux machine Nearzero deploys onto. The Nearzero host is not a row here: it belongs to no
-- workspace.
CREATE TABLE server (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A workspace with servers can't be deleted; the control plane says so first.
  workspace_id         uuid        NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  name                 text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description          text        NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  address              text        NOT NULL CHECK (length(address) BETWEEN 1 AND 253 AND address !~ '[\s/]'),
  port                 integer     NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  ssh_user             text        NOT NULL CHECK (ssh_user ~ '^[A-Za-z_][A-Za-z0-9_-]{0,31}$'),
  ssh_key_id           uuid        NOT NULL,
  -- The label its hostnames live under (spec 10.2): chosen once from the name, never changed,
  -- unique on the install because hostnames are.
  label                text        NOT NULL UNIQUE
                                   CHECK (label ~ '^[a-z]([a-z0-9-]*[a-z0-9])?$' AND length(label) <= 40),
  host_key_fingerprint text,
  setup_state          text        NOT NULL DEFAULT 'not_started'
                                   CHECK (setup_state IN ('not_started', 'running', 'ready', 'failed')),
  setup_error          text,
  setup_started_at     timestamptz,
  setup_finished_at    timestamptz,
  -- The nightly Docker cleanup (spec 9.4): off by default for servers.
  docker_cleanup       boolean     NOT NULL DEFAULT false,
  created_by           uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  -- A key a server uses can't be deleted (spec 2.3).
  FOREIGN KEY (ssh_key_id, workspace_id) REFERENCES ssh_key (id, workspace_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX server_name_idx ON server (workspace_id, lower(name));
CREATE UNIQUE INDEX server_address_idx ON server (workspace_id, lower(address), port);
CREATE INDEX server_ssh_key_idx ON server (ssh_key_id);

-- A service runs on one of its workspace's servers, or on the host (null). With MATCH SIMPLE a
-- null server_id isn't checked, so host services are unaffected.
ALTER TABLE service
  ADD CONSTRAINT service_server_fk
  FOREIGN KEY (server_id, workspace_id) REFERENCES server (id, workspace_id) ON DELETE RESTRICT;

CREATE INDEX service_server_idx ON service (server_id) WHERE server_id IS NOT NULL;

-- Workspaces an instance administrator lets deploy to the Nearzero host (spec 24 G3).
CREATE TABLE host_allowed_workspace (
  workspace_id uuid        PRIMARY KEY REFERENCES workspace (id) ON DELETE CASCADE,
  allowed_by   uuid        REFERENCES person (id) ON DELETE SET NULL,
  allowed_at   timestamptz NOT NULL DEFAULT now()
);
