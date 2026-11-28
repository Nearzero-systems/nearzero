-- Notification channels (spec 15): where a workspace's events are sent. Settings hold what may
-- be shown again; tokens, passwords, keys, provider webhook URLs and custom headers are sealed
-- with the install key and never sent back.

CREATE TABLE notification_channel (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  type            text        NOT NULL CHECK (type IN ('slack', 'telegram', 'discord', 'lark', 'teams',
                                                       'email', 'resend', 'gotify', 'ntfy',
                                                       'mattermost', 'pushover', 'webhook')),
  settings        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  secrets_sealed  text,
  events          text[]      NOT NULL DEFAULT '{}',
  last_delivery_at timestamptz,
  -- The last delivery that failed after its retries, until one succeeds again.
  last_failure_at timestamptz,
  last_failure    text,
  created_by      uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notification_channel_name_idx ON notification_channel (workspace_id, lower(name));
CREATE INDEX notification_channel_events_idx ON notification_channel USING gin (events);

-- One delivery per channel per event (spec 15.3), retried 3 times with back-off. An outbox row
-- (0300) gets its deliveries once, then its delivered_at is set.
CREATE TABLE notification_delivery (
  id              bigserial   PRIMARY KEY,
  outbox_id       bigint      NOT NULL REFERENCES notification_outbox (id) ON DELETE CASCADE,
  channel_id      uuid        NOT NULL REFERENCES notification_channel (id) ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, channel_id)
);

CREATE INDEX notification_delivery_due_idx ON notification_delivery (next_attempt_at)
  WHERE status = 'pending';

-- Each start of the control plane, so the next start can say whether the last one stopped or
-- crashed ("Nearzero restart", spec 15.3).
CREATE TABLE control_plane_start (
  id         bigserial   PRIMARY KEY,
  version    text        NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz
);
