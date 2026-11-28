-- 0550: the Agent (spec 19, 20, 25 D4). Sessions private to their author unless shared with the
-- workspace; one row per turn (a question and its answer) with every streamed event saved as it
-- happens; what the model has been told, so a waiting turn can continue after a restart; files
-- attached to chats; and SSH keys added through a chat's secure form. No secret value is ever
-- stored here: forms post values to the normal APIs and the Agent learns only names and outcomes
-- (spec 23.4 rule 1).

CREATE SEQUENCE agent_session_position_seq;

CREATE TABLE agent_session (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  author_id        uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  title            text        CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 80),
  -- provisional: from the first question; generated: by the small model; person: renamed.
  title_source     text        CHECK (title_source IN ('provisional', 'generated', 'person')),
  shared           boolean     NOT NULL DEFAULT false,
  -- Higher is nearer the top; new sessions take the next number, moves swap numbers.
  position         bigint      NOT NULL DEFAULT nextval('agent_session_position_seq'),
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_session_author_idx ON agent_session (workspace_id, author_id, position DESC);
CREATE INDEX agent_session_shared_idx ON agent_session (workspace_id, last_message_at DESC) WHERE shared;

-- A person's question. The Agent's answer is the events of the turn that answers it.
CREATE TABLE agent_message (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES agent_session (id) ON DELETE CASCADE,
  author_id   uuid        REFERENCES person (id) ON DELETE SET NULL,
  text        text        NOT NULL DEFAULT '',
  quote       text,
  file_ids    uuid[]      NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_message_session_idx ON agent_message (session_id, created_at);

CREATE TABLE agent_turn (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid        NOT NULL REFERENCES agent_session (id) ON DELETE CASCADE,
  workspace_id       uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  person_id          uuid        REFERENCES person (id) ON DELETE SET NULL,
  message_id         uuid        NOT NULL REFERENCES agent_message (id) ON DELETE CASCADE,
  state              text        NOT NULL DEFAULT 'working'
                                 CHECK (state IN ('working', 'waiting', 'finished', 'stopped', 'failed')),
  deep_research      boolean     NOT NULL DEFAULT false,
  -- The process carrying the turn out ("<host>/<boot id>") and when it last said so.
  owner              text,
  heartbeat_at       timestamptz,
  stop_requested_at  timestamptz,
  stopped_by         text        CHECK (stopped_by IN ('person', 'restart')),
  -- While waiting: { formId, kind, label, ... } (never a value the person typed).
  wait               jsonb,
  -- Counters the loop keeps across restarts of a waiting turn.
  rounds             integer     NOT NULL DEFAULT 0,
  steps              integer     NOT NULL DEFAULT 0,
  failed_steps       integer     NOT NULL DEFAULT 0,
  deploys            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  failures           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  worked_ms          bigint      NOT NULL DEFAULT 0,
  work_started_at    timestamptz,
  answer_text        text        NOT NULL DEFAULT '',
  -- Hidden turns (the "add a key" reply once a key is saved) are left out of the chat and of
  -- what the model is told.
  hidden             boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  -- Set once nothing more will be written (after the follow-up suggestions).
  closed_at          timestamptz
);

CREATE INDEX agent_turn_session_idx ON agent_turn (session_id, created_at);
CREATE INDEX agent_turn_open_idx ON agent_turn (state) WHERE state IN ('working', 'waiting');
-- One working or waiting turn per session (spec 19.6, 22.4 rule 9).
CREATE UNIQUE INDEX agent_turn_one_open_idx ON agent_turn (session_id) WHERE state IN ('working', 'waiting');

CREATE TABLE agent_event (
  turn_id     uuid        NOT NULL REFERENCES agent_turn (id) ON DELETE CASCADE,
  seq         integer     NOT NULL,
  type        text        NOT NULL,
  data        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq)
);

-- What the model was sent and answered, in order, per session: questions, answers with their
-- action calls, action results (already redacted and cut), and notes from Nearzero.
CREATE TABLE agent_model_item (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES agent_session (id) ON DELETE CASCADE,
  turn_id     uuid        NOT NULL REFERENCES agent_turn (id) ON DELETE CASCADE,
  item        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_model_item_session_idx ON agent_model_item (session_id, id);

CREATE TABLE agent_file (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  uploader_id   uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  -- Set when the file is sent; a file is only ever sent in one session.
  session_id    uuid        REFERENCES agent_session (id) ON DELETE CASCADE,
  message_id    uuid        REFERENCES agent_message (id) ON DELETE SET NULL,
  name          text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('image', 'pdf', 'docx', 'text', 'video')),
  content_type  text        NOT NULL,
  size_bytes    integer     NOT NULL,
  bytes         bytea       NOT NULL,
  -- Extracted text (Word, text, PDF), and the PDF's text page by page.
  text_content  text,
  pages         jsonb,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_file_session_idx ON agent_file (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX agent_file_draft_idx ON agent_file (uploader_id, created_at) WHERE sent_at IS NULL;

-- SSH keys added through a chat's secure form: usable for that chat's server or Git setup
-- without the "Read SSH keys" policy (spec 19.8, 19.12).
CREATE TABLE agent_session_key (
  session_id  uuid        NOT NULL REFERENCES agent_session (id) ON DELETE CASCADE,
  ssh_key_id  uuid        NOT NULL REFERENCES ssh_key (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, ssh_key_id)
);
