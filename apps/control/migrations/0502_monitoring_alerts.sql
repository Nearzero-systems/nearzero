-- Server alerts (spec 14.3): CPU and memory thresholds per server (blank is off), and where
-- each alert stands. A target is a server id, or "host" for the Nearzero host. Samples
-- themselves are in server_metric (0151).

CREATE TABLE server_alert_setting (
  target           text        PRIMARY KEY CHECK (length(target) BETWEEN 1 AND 64),
  cpu_threshold    integer     CHECK (cpu_threshold BETWEEN 1 AND 100),
  memory_threshold integer     CHECK (memory_threshold BETWEEN 1 AND 100),
  updated_by       uuid        REFERENCES person (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Three samples in a row above the threshold fire an alert; then none for 30 minutes unless
-- the value drops and rises again.
CREATE TABLE server_alert_state (
  target         text        NOT NULL CHECK (length(target) BETWEEN 1 AND 64),
  metric         text        NOT NULL CHECK (metric IN ('cpu', 'memory')),
  streak         integer     NOT NULL DEFAULT 0,
  fired_at       timestamptz,
  dropped_since  boolean     NOT NULL DEFAULT true,
  last_value     real,
  last_sample_at timestamptz,
  PRIMARY KEY (target, metric)
);
