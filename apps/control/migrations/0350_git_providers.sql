-- 0350: Git providers (spec 16, spec 06 6.3 and 6.6, spec 22.3, spec 23.4, spec 24 G4): connected
-- GitHub Apps, GitLab and Gitea applications and Bitbucket API tokens; the short-lived states of
-- their connect flows; each service's provider webhook secret; and the GitHub deliveries already
-- handled.

-- One connected account. It belongs to the person who connected it (owner_person_id) and is
-- shared with the whole workspace only when its owner says so. Secrets (app private keys,
-- webhook secrets, OAuth secrets and tokens, API tokens) are sealed with the install key in
-- secrets_sealed and never leave the control plane. status 'pending' is "Action required": the
-- GitHub App isn't installed yet, or the GitLab / Gitea authorization hasn't finished.
CREATE TABLE git_provider (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  owner_person_id  uuid        REFERENCES person (id) ON DELETE SET NULL,
  kind             text        NOT NULL CHECK (kind IN ('github', 'gitlab', 'bitbucket', 'gitea')),
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  shared           boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  -- Not secret: addresses, application and client ids, the GitHub App's slug and owner, the
  -- group, organization or workspace filter, the Bitbucket user name and email.
  settings         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  secrets_sealed   text,
  -- GitHub: the app's id, and the installation it is bound to.
  github_app_id    bigint,
  installation_id  bigint,
  -- Who the connection reads as (a login, or the installation's account), for the list.
  account_login    text,
  last_error       text,
  connected_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX git_provider_workspace_idx ON git_provider (workspace_id, created_at);
-- An installation binds to one app record, and a GitHub App is connected once.
CREATE UNIQUE INDEX git_provider_installation_idx ON git_provider (installation_id)
  WHERE installation_id IS NOT NULL;
CREATE UNIQUE INDEX git_provider_github_app_idx ON git_provider (github_app_id)
  WHERE github_app_id IS NOT NULL;

-- A connect flow in progress: the OAuth state or the GitHub manifest and install states. Only
-- the SHA-256 of the state is kept. A flow belongs to the person who started it, works once, and
-- expires; return_to is the console path to come back to (spec 16.1).
CREATE TABLE git_provider_flow (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text        NOT NULL UNIQUE,
  workspace_id  uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  person_id     uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  provider_id   uuid        REFERENCES git_provider (id) ON DELETE CASCADE,
  purpose       text        NOT NULL CHECK (purpose IN ('github-manifest', 'github-install', 'oauth')),
  return_to     text,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX git_provider_flow_person_idx ON git_provider_flow (person_id, created_at DESC);
CREATE INDEX git_provider_flow_expires_idx ON git_provider_flow (expires_at);

-- The secret a GitLab, Bitbucket or Gitea webhook carries for one service's deploy webhook URL
-- (spec 6.6, G4), sealed, and where it was registered at the provider when that could be done
-- with the connected token. 'manual' means the person adds it at their Git host.
CREATE TABLE git_service_hook (
  service_id      uuid        PRIMARY KEY REFERENCES service (id) ON DELETE CASCADE,
  workspace_id    uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  provider_id     uuid        REFERENCES git_provider (id) ON DELETE SET NULL,
  kind            text        NOT NULL CHECK (kind IN ('gitlab', 'bitbucket', 'gitea')),
  repository      text        NOT NULL,
  secret_sealed   text        NOT NULL,
  remote_hook_id  text,
  registered_url  text,
  status          text        NOT NULL DEFAULT 'manual' CHECK (status IN ('registered', 'manual')),
  message         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- GitHub delivery ids already handled, so a redelivery never deploys twice. Pruned after a day.
CREATE TABLE git_push_delivery (
  provider_id  uuid        NOT NULL REFERENCES git_provider (id) ON DELETE CASCADE,
  delivery_id  text        NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, delivery_id)
);
