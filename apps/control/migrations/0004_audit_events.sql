-- 0004: the audit record (spec 22.4, rule 8). Sign-ins, member and policy changes, key changes
-- and more, with who, when and from where. Kept 90 days. Rows outlive the workspace and person
-- they name, so those ids are plain values, not foreign keys.

CREATE TABLE audit_event (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  workspace_id    uuid,
  -- person: someone signed in; agent: the Agent acting for actor_person_id; command: the
  -- nearzero server command; system: Nearzero itself.
  actor_kind      text        NOT NULL CHECK (actor_kind IN ('person', 'agent', 'command', 'system')),
  actor_person_id uuid,
  -- The actor's email at the time, so the record still reads after the account is gone.
  actor_label     text,
  action          text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
  target_kind     text,
  target_id       text,
  client_address  text,
  details         jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_event_time_idx ON audit_event (occurred_at);
CREATE INDEX audit_event_workspace_idx ON audit_event (workspace_id, occurred_at);
