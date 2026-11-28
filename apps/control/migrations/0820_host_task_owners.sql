-- 0820: a Nearzero host task belongs to the instance administrator who made it (spec 12.4,
-- spec 30 "Host tasks belong to their creator", 30c R3-29). Other instance administrators don't
-- see it, only its owner may manage it, and it is deleted with its owner's account.
ALTER TABLE task ADD COLUMN owner_id uuid REFERENCES person (id) ON DELETE CASCADE;

UPDATE task SET owner_id = created_by WHERE place = 'host';

-- A host task whose maker's account is already gone goes to the install's owner.
UPDATE task
   SET owner_id = (
     SELECT m.person_id
       FROM install_state s
       JOIN membership m ON m.workspace_id = s.first_workspace_id AND m.role = 'owner'
      LIMIT 1
   )
 WHERE place = 'host' AND owner_id IS NULL;

-- Without an owner at all there is nobody who could ever see or manage it.
DELETE FROM task WHERE place = 'host' AND owner_id IS NULL;

ALTER TABLE task ADD CONSTRAINT task_host_owner CHECK ((place = 'host') = (owner_id IS NOT NULL));

CREATE INDEX task_owner_idx ON task (owner_id) WHERE owner_id IS NOT NULL;
