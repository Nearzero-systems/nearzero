-- Analytics (spec 13): the Nearzero host's router logs every request, on by default. The log
-- itself is a file on the host that the runner reads; this is its one row of settings.
--
-- Installs that had request logging off by default get it turned on once, here, at upgrade;
-- an administrator who later turns it off keeps it off (this file never runs again).

CREATE TABLE analytics_setting (
  id                 boolean     PRIMARY KEY DEFAULT true CHECK (id),
  enabled            boolean     NOT NULL DEFAULT true,
  -- The cleanup schedule, in the host's time zone; each run keeps the newest 10,000 requests.
  cleanup_cron       text        NOT NULL DEFAULT '0 0 * * *' CHECK (length(cleanup_cron) BETWEEN 9 AND 200),
  next_cleanup_at    timestamptz,
  last_cleanup_at    timestamptz,
  last_cleanup_error text,
  changed_by         uuid        REFERENCES person (id) ON DELETE SET NULL,
  changed_at         timestamptz,
  -- When the host's runner last confirmed the router runs with this setting.
  applied_at         timestamptz,
  apply_error        text
);

INSERT INTO analytics_setting (id, enabled) VALUES (true, true);
