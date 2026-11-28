-- 0760: Reload (30b R2-02) is a deployment of its own: the running version's image started again
-- with the saved variables, mounts, ports and start command, with nothing fetched or built.
ALTER TABLE deployment DROP CONSTRAINT IF EXISTS deployment_trigger_check;
ALTER TABLE deployment
  ADD CONSTRAINT deployment_trigger_check
  CHECK (trigger IN ('push', 'tag', 'webhook', 'manual', 'agent', 'redeploy', 'reload'));
