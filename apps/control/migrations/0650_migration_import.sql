-- 0650: moving a 0.1.x install to 1.0 (spec 29, decision D3 in spec 25).
-- An import reads an export bundle into 1.0's tables. These tables remember what each bundle
-- record became (so a second import of the same bundle changes nothing), the report people saw,
-- and the move of every service onto the 1.0 runner, server by server.

-- One row per import that was applied (dry runs leave nothing behind).
CREATE TABLE migration_import (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The source install's id from the bundle's manifest (or the manifest's digest without one).
  source_install text        NOT NULL CHECK (length(source_install) BETWEEN 1 AND 200),
  bundle_sha256  text        NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  format_version integer     NOT NULL,
  source_version text        NOT NULL,
  exported_at    timestamptz,
  -- True when the 0.1.x install ran on this server, so its workloads are stopped as they move.
  in_place       boolean     NOT NULL DEFAULT false,
  report         jsonb       NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT now()
);

-- What each bundle record became: the ref (opaque, unique within a source install's bundles)
-- and the 1.0 id. The key makes a second import of the same records find them.
CREATE TABLE migration_record (
  source_install text        NOT NULL,
  kind           text        NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  ref            text        NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
  object_id      text        NOT NULL,
  import_id      uuid        NOT NULL REFERENCES migration_import (id) ON DELETE CASCADE,
  PRIMARY KEY (source_install, kind, ref)
);

-- The move of one server onto the 1.0 runner: set up again over SSH (remote servers), and its
-- certificate authority state placed in its router's store before any route switches.
CREATE TABLE migration_server_move (
  -- A server id, or "host" for the Nearzero host.
  target                 text        PRIMARY KEY CHECK (length(target) BETWEEN 1 AND 64),
  import_id              uuid        NOT NULL REFERENCES migration_import (id) ON DELETE CASCADE,
  position               integer     NOT NULL,
  -- The 0.1.x workloads to stop before setup (its router, which holds ports 80 and 443).
  legacy                 jsonb,
  state                  text        NOT NULL DEFAULT 'waiting'
                                     CHECK (state IN ('waiting', 'setting_up', 'ready', 'failed')),
  reason                 text,
  setup_run_id           uuid,
  certificates_placed_at timestamptz,
  started_at             timestamptz,
  finished_at            timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- The move of one service: its 0.1.x workload stopped, the service redeployed through the deploy
-- engine with its volumes, and the old workload started again when the deploy fails.
CREATE TABLE migration_move (
  service_id      uuid        PRIMARY KEY REFERENCES service (id) ON DELETE CASCADE,
  import_id       uuid        NOT NULL REFERENCES migration_import (id) ON DELETE CASCADE,
  target          text        NOT NULL CHECK (length(target) BETWEEN 1 AND 64),
  -- Oldest-deployed first (spec 29.2 step 5).
  position        integer     NOT NULL,
  -- How the 0.1.x workload is found on its server: { kind, name }; null when there is none.
  legacy          jsonb,
  state           text        NOT NULL DEFAULT 'waiting'
                              CHECK (state IN ('waiting', 'moving', 'moved', 'failed', 'skipped')),
  reason          text,
  deployment_id   uuid,
  legacy_stopped  boolean     NOT NULL DEFAULT false,
  legacy_removed_at timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX migration_move_order_idx ON migration_move (state, target, position);

-- Each server's certificate authority account and issued certificates with their keys, sealed
-- with the install key until the move places them in the server's router store.
CREATE TABLE migration_acme_state (
  target            text        PRIMARY KEY CHECK (length(target) BETWEEN 1 AND 64),
  import_id         uuid        NOT NULL REFERENCES migration_import (id) ON DELETE CASCADE,
  sealed            text        NOT NULL,
  certificate_count integer     NOT NULL DEFAULT 0,
  placed_at         timestamptz
);

-- Where the whole move stands. One row once something was imported in place.
CREATE TABLE migration_state (
  singleton      boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  phase          text        NOT NULL DEFAULT 'imported'
                             CHECK (phase IN ('imported', 'moving', 'moved', 'finalized')),
  job_id         bigint,
  finalized_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
