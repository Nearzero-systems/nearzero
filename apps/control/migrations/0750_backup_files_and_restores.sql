-- 0750: what Keep N may prune, schedules moved from 0.1.x, and what a restore loads into
-- (spec 08 8.3, 17.2, 17.3, 29; B1-52, R2-06, R3-44, R3-45, R3-48).

-- The files each schedule's runs wrote. Keep N prunes only these (and, for a schedule moved from
-- 0.1.x, 0.1.x's files in its folder), so two schedules whose destinations point at the same
-- bucket never prune each other's files. Rows go with their schedule; the files stay.
CREATE TABLE backup_file (
  schedule_id uuid        NOT NULL REFERENCES backup_schedule (id) ON DELETE CASCADE,
  key         text        NOT NULL CHECK (length(key) BETWEEN 1 AND 1024),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, key)
);

INSERT INTO backup_file (schedule_id, key, created_at)
SELECT schedule_id, file_key, max(coalesce(finished_at, created_at))
  FROM backup_run
 WHERE operation = 'backup' AND status = 'succeeded'
   AND schedule_id IS NOT NULL AND file_key IS NOT NULL
 GROUP BY schedule_id, file_key;

-- A schedule moved from 0.1.x: the files 0.1.x wrote in its folder count as its own, and its
-- folder may be empty (0.1.x then wrote straight under the app name).
ALTER TABLE backup_schedule ADD COLUMN legacy_files boolean NOT NULL DEFAULT false;
UPDATE backup_schedule SET legacy_files = true
 WHERE id::text IN (SELECT object_id FROM migration_record WHERE kind = 'backupSchedules');
ALTER TABLE backup_schedule DROP CONSTRAINT backup_schedule_folder_check;
ALTER TABLE backup_schedule ADD CONSTRAINT backup_schedule_folder_check
  CHECK (length(folder) <= 200 AND (length(folder) >= 1 OR legacy_files));

-- A restore's file was dumped from this database, when known (MongoDB restores rename it into
-- the database asked for).
ALTER TABLE backup_run ADD COLUMN source_database text
  CHECK (source_database IS NULL OR length(source_database) <= 64);

-- Runs that stop the service (volume backups that stop it while copying) and restores: one at a
-- time per service, whichever schedule they come from.
ALTER TABLE backup_run ADD COLUMN exclusive boolean NOT NULL DEFAULT false;
CREATE INDEX backup_run_exclusive_idx ON backup_run (service_id, created_at)
  WHERE exclusive AND status IN ('queued', 'running');
