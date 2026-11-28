-- 0941: whether a workspace's own SMTP server may be a private or internal address (C1-05, spec
-- 23.9, the rule 0781 gives notification channels). Only an instance administrator can point a
-- workspace's email at this machine, a private network or a cloud's metadata address; the flag
-- records that one did when the server was last saved. Every send checks the address again.
ALTER TABLE workspace_email ADD COLUMN internal_allowed boolean NOT NULL DEFAULT false;

-- Settings saved before the rule in the instance administrators' own workspace keep working.
UPDATE workspace_email
   SET internal_allowed = true
 WHERE workspace_id IN (SELECT first_workspace_id FROM install_state);
