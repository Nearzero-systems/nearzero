-- 0002: people, their sessions, two-factor sign-in and attempt counters (spec 04 4.1, 4.6).
-- Passwords are argon2id hashes; session, challenge and backup-code tokens are stored only as
-- SHA-256 hashes; two-factor secrets are sealed with the install key (spec 23.4).

CREATE TABLE person (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Always stored lowercase and trimmed.
  email                   text        NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  -- When the person last proved they receive mail at this address (null after an unproven change).
  email_verified_at       timestamptz,
  -- Null only for accounts that can't sign in with a password (none are created in 1.0).
  password_hash           text,
  password_changed_at     timestamptz,
  first_name              text        CHECK (first_name IS NULL OR length(first_name) BETWEEN 1 AND 100),
  last_name               text        CHECK (last_name IS NULL OR length(last_name) <= 100),
  avatar_kind             text        NOT NULL DEFAULT 'initials' CHECK (avatar_kind IN ('initials', 'image', 'gravatar')),
  avatar_color            text        NOT NULL DEFAULT 'violet',
  -- The workspace a new session opens in. Its foreign key is added with the workspace table.
  last_workspace_id       uuid,
  -- The first-sign-in step still to do: the owner's workspace and invite steps, or an invited
  -- member's name step. Null once onboarding is finished.
  onboarding_step         text        CHECK (onboarding_step IN ('workspace', 'invite', 'name')),
  onboarding_completed_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX person_email_idx ON person (email);

-- An uploaded avatar image (under 2 MB), kept apart so loading a person never loads it.
CREATE TABLE person_avatar_image (
  person_id    uuid        PRIMARY KEY REFERENCES person (id) ON DELETE CASCADE,
  content_type text        NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  bytes        bytea       NOT NULL CHECK (octet_length(bytes) <= 2097152),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per signed-in browser. Lasts 7 days and is renewed on use.
CREATE TABLE person_session (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  token_hash          bytea       NOT NULL UNIQUE,
  -- Foreign key added with the workspace table.
  active_workspace_id uuid,
  client_address      text,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL
);

CREATE INDEX person_session_person_idx ON person_session (person_id);
CREATE INDEX person_session_expiry_idx ON person_session (expires_at);

-- A person's authenticator secret. enabled_at is null while set-up waits for the first code.
CREATE TABLE two_factor (
  person_id      uuid        PRIMARY KEY REFERENCES person (id) ON DELETE CASCADE,
  secret_sealed  text        NOT NULL,
  issuer         text        NOT NULL DEFAULT 'Nearzero',
  enabled_at     timestamptz,
  -- The last time step whose code was accepted, so a code works once.
  last_used_step bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Ten single-use backup codes, stored hashed. Replaced only when the person asks (spec 24 G12).
CREATE TABLE two_factor_backup_code (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id  uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  code_hash  bytea       NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, code_hash)
);

-- After a correct password with two-factor on: lasts 10 minutes, at most 3 tries per 10 seconds.
CREATE TABLE sign_in_challenge (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  token_hash         bytea       NOT NULL UNIQUE,
  client_address     text,
  window_started_at  timestamptz,
  attempts_in_window integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz
);

CREATE INDEX sign_in_challenge_expiry_idx ON sign_in_challenge (expires_at);

-- Failed attempts, counted by bucket and subject (for sign-in: the email and the client
-- address). Kept in the database so limits survive a restart (spec 24 G10).
CREATE TABLE attempt_record (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket       text        NOT NULL,
  subject      text        NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attempt_record_lookup_idx ON attempt_record (bucket, subject, attempted_at);
CREATE INDEX attempt_record_age_idx ON attempt_record (attempted_at);
