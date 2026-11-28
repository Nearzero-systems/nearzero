-- 0450: what Nearzero knows about each Compose stack (spec 07): the files its last successful
-- deploy ran (the person's file and Nearzero's additions; neither ever holds a secret, values
-- reach Compose only through the env file on the server), what it was made from, and the
-- privileged options an instance administrator approved on the Nearzero host (spec 24 G3).

CREATE TABLE compose_stack (
  service_id            uuid        PRIMARY KEY REFERENCES service (id) ON DELETE CASCADE,
  -- The deployment the files below belong to, and a SHA-256 of what it was made from (the
  -- pasted file, or the repository, its commit and the Compose file's path), so the page can say
  -- when saved changes still need a deploy.
  deployment_id         uuid        REFERENCES deployment (id) ON DELETE SET NULL,
  source_fingerprint    text,
  compose_file          text,
  additions_file        text,
  -- The project directory inside the stack's folder on the server ("" or "repo/<folder>").
  project_directory     text        NOT NULL DEFAULT '',
  deployed_at           timestamptz,
  -- Privileged options (their stable keys) an instance administrator deployed on the host, who
  -- and when. Deploys by anyone else, and push deploys, may run exactly these again.
  approved_keys         text[]      NOT NULL DEFAULT '{}',
  approved_by           uuid        REFERENCES person (id) ON DELETE SET NULL,
  approved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
