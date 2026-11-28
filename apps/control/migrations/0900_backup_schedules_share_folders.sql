-- 0900: volume backup schedules of one service may share a folder on a destination (31c G3-20).
-- Keep N already counts only the files each schedule wrote (backup_file), 0.1.x's files are
-- matched by volume, and 1.0's volume backups are named after their volume, so two volumes'
-- schedules writing to one folder never meet. One schedule per volume and folder, and one
-- database schedule per folder (database dumps aren't named after their database), stay.
DROP INDEX backup_schedule_prefix_idx;
CREATE UNIQUE INDEX backup_schedule_prefix_volume_idx
  ON backup_schedule (service_id, destination_id, coalesce(inner_service, ''), folder,
                      coalesce(volume_name, ''));
