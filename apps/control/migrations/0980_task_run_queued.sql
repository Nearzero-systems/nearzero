-- A task run waits as "queued" until a task lane takes it, and counts as "running" only from
-- then on (C1-09, R4-03): a run that hasn't started never makes a later due time "Skipped:
-- the previous run was still going", and its start time and duration leave out its wait.
ALTER TABLE task_run DROP CONSTRAINT task_run_status_check;
ALTER TABLE task_run ADD CONSTRAINT task_run_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'stopped', 'skipped'));

-- Still one open run per task, queued or running (spec 12.3).
DROP INDEX task_run_one_running_idx;
CREATE UNIQUE INDEX task_run_one_open_idx ON task_run (task_id) WHERE status IN ('queued', 'running');

DROP INDEX task_run_running_idx;
CREATE INDEX task_run_open_idx ON task_run (updated_at) WHERE status IN ('queued', 'running');
