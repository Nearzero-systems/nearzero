-- 0001: the background job queue.
-- Long work runs in the background and outlives the request that started it (spec 23.1);
-- the queue lives in PostgreSQL, with no separate queue store (spec 25, D1.2 and D5).

CREATE TABLE job (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$'),
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state           text        NOT NULL DEFAULT 'queued'
                              CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer     NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_at          timestamptz NOT NULL DEFAULT now(),
  -- A caller that retries the same request passes the same key and gets the same job back,
  -- so nothing runs twice because a proxy or client retried.
  idempotency_key text        UNIQUE,
  locked_by       text,
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  -- A job holds a lease exactly while it runs.
  CONSTRAINT job_lease_while_running CHECK ((state = 'running') = (locked_until IS NOT NULL))
);

-- Workers look for due work, oldest first.
CREATE INDEX job_due_idx ON job (run_at, id) WHERE state = 'queued';

-- Recovery looks for running jobs whose lease ran out.
CREATE INDEX job_lease_idx ON job (locked_until) WHERE state = 'running';

-- Pruning looks for finished jobs by age.
CREATE INDEX job_finished_idx ON job (finished_at) WHERE state IN ('succeeded', 'failed');
