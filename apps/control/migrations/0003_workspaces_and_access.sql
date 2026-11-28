-- 0003: workspaces, members, invitations, access policies and workspace settings
-- (spec 04 4.3 to 4.8, spec 22).

CREATE TABLE workspace (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- The web address segment: lowercase words joined by dashes, at most 48 characters.
  slug        text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 48),
  logo_url    text        CHECK (logo_url IS NULL OR length(logo_url) <= 2048),
  -- True while this is a person's untouched "My Workspace".
  is_personal boolean     NOT NULL DEFAULT false,
  created_by  uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Slugs a workspace had before a rename keep pointing at it, and are never given to another.
CREATE TABLE workspace_old_slug (
  slug         text        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  retired_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_old_slug_workspace_idx ON workspace_old_slug (workspace_id);

-- One row for the whole install. The first workspace's owners and admins are the instance
-- administrators (spec 22.1).
CREATE TABLE install_state (
  singleton          boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  first_workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  owner_created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE person
  ADD CONSTRAINT person_last_workspace_fk
  FOREIGN KEY (last_workspace_id) REFERENCES workspace (id) ON DELETE SET NULL;

ALTER TABLE person_session
  ADD CONSTRAINT person_session_active_workspace_fk
  FOREIGN KEY (active_workspace_id) REFERENCES workspace (id) ON DELETE SET NULL;

CREATE TABLE membership (
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  person_id    uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  role         text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, person_id)
);

-- Exactly one owner per workspace, enforced by the database.
CREATE UNIQUE INDEX membership_one_owner_idx ON membership (workspace_id) WHERE role = 'owner';
CREATE INDEX membership_person_idx ON membership (person_id);

-- A reusable bundle of capabilities plus a scope, attached to many members.
CREATE TABLE access_policy (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description      text        NOT NULL DEFAULT '' CHECK (length(description) <= 240),
  capabilities     text[]      NOT NULL DEFAULT '{}',
  -- "All …, including new ones."
  all_projects     boolean     NOT NULL DEFAULT false,
  all_servers      boolean     NOT NULL DEFAULT false,
  all_git_accounts boolean     NOT NULL DEFAULT false,
  created_by       uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX access_policy_name_idx ON access_policy (workspace_id, lower(name));

-- What is given to one member directly, beside their policies.
CREATE TABLE member_access (
  workspace_id     uuid        NOT NULL,
  person_id        uuid        NOT NULL,
  capabilities     text[]      NOT NULL DEFAULT '{}',
  all_projects     boolean     NOT NULL DEFAULT false,
  all_servers      boolean     NOT NULL DEFAULT false,
  all_git_accounts boolean     NOT NULL DEFAULT false,
  updated_by       uuid        REFERENCES person (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, person_id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES membership (workspace_id, person_id) ON DELETE CASCADE
);

-- The objects a policy or a member's direct access names. Object ids are not foreign keys:
-- the tables they point at arrive in later milestones, and an id whose object was deleted
-- simply matches nothing.
CREATE TABLE access_scope_item (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid   NOT NULL,
  policy_id    uuid,
  person_id    uuid,
  object_kind  text   NOT NULL CHECK (object_kind IN ('project', 'environment', 'service', 'server', 'git_account')),
  object_id    text   NOT NULL CHECK (length(object_id) BETWEEN 1 AND 64),
  -- The project of an environment, the environment of a service; null for the other kinds.
  -- With it, "a ticked node with ticked children covers only those children" is decided
  -- without loading the objects themselves.
  parent_id    text   CHECK (parent_id IS NULL OR length(parent_id) BETWEEN 1 AND 64),
  CHECK ((policy_id IS NULL) <> (person_id IS NULL)),
  CHECK ((object_kind IN ('environment', 'service')) = (parent_id IS NOT NULL)),
  FOREIGN KEY (policy_id, workspace_id) REFERENCES access_policy (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, person_id) REFERENCES member_access (workspace_id, person_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX access_scope_item_policy_idx
  ON access_scope_item (policy_id, object_kind, object_id) WHERE policy_id IS NOT NULL;
CREATE UNIQUE INDEX access_scope_item_member_idx
  ON access_scope_item (workspace_id, person_id, object_kind, object_id) WHERE person_id IS NOT NULL;

-- Policies given to members. The composite keys keep a policy inside its own workspace.
CREATE TABLE policy_attachment (
  policy_id    uuid        NOT NULL,
  workspace_id uuid        NOT NULL,
  person_id    uuid        NOT NULL,
  attached_by  uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, person_id),
  FOREIGN KEY (policy_id, workspace_id) REFERENCES access_policy (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, person_id) REFERENCES membership (workspace_id, person_id) ON DELETE CASCADE
);

CREATE INDEX policy_attachment_member_idx ON policy_attachment (workspace_id, person_id);

-- A 7-day link for one email address to join a workspace with a role and policies.
CREATE TABLE invitation (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  email           text        NOT NULL CHECK (email = lower(btrim(email))),
  role            text        NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash      bytea       NOT NULL UNIQUE,
  -- Sealed so "Copy link" and "Resend" can rebuild the same link.
  token_sealed    text        NOT NULL,
  invited_by      uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- Set only when an email actually went out.
  last_emailed_at timestamptz,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  closed_at       timestamptz,
  accepted_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX invitation_one_pending_idx ON invitation (workspace_id, email) WHERE status = 'pending';
CREATE INDEX invitation_email_idx ON invitation (email) WHERE status = 'pending';

CREATE TABLE invitation_policy (
  invitation_id uuid NOT NULL,
  policy_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  PRIMARY KEY (invitation_id, policy_id),
  FOREIGN KEY (invitation_id, workspace_id) REFERENCES invitation (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id, workspace_id) REFERENCES access_policy (id, workspace_id) ON DELETE CASCADE
);

-- Workspace settings that are not secrets. agent_policies is null until the page is saved,
-- so defaults apply (spec 19.9).
CREATE TABLE workspace_settings (
  workspace_id           uuid        PRIMARY KEY REFERENCES workspace (id) ON DELETE CASCADE,
  agent_policies         jsonb,
  agent_policies_saved_by uuid       REFERENCES person (id) ON DELETE SET NULL,
  agent_policies_saved_at timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Secrets a workspace keeps: the model key, the research key, and its email key or SMTP
-- password. Sealed with the install key; only the masked form is ever shown.
CREATE TABLE workspace_secret (
  workspace_id uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('model-key', 'research-key', 'email-resend-key', 'email-smtp-password')),
  sealed       text        NOT NULL,
  masked       text        NOT NULL,
  added_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind)
);

-- How a workspace sends invitation emails: through Resend or an SMTP server (decision D4).
CREATE TABLE workspace_email (
  workspace_id  uuid        PRIMARY KEY REFERENCES workspace (id) ON DELETE CASCADE,
  provider      text        NOT NULL CHECK (provider IN ('resend', 'smtp')),
  sender        text        NOT NULL CHECK (length(sender) BETWEEN 3 AND 320),
  smtp_host     text,
  smtp_port     integer     CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
  smtp_security text        CHECK (smtp_security IS NULL OR smtp_security IN ('tls', 'starttls', 'none')),
  smtp_username text,
  saved_by      uuid        REFERENCES person (id) ON DELETE SET NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (provider <> 'smtp' OR (smtp_host IS NOT NULL AND smtp_port IS NOT NULL AND smtp_security IS NOT NULL))
);
