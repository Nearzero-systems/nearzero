-- What started a deployment (spec 6.3: Manual, Push, Tag, Webhook, Agent, Redeploy): a tag
-- push and a redeploy of an earlier deployment get their own values.

ALTER TABLE deployment DROP CONSTRAINT IF EXISTS deployment_trigger_check;
ALTER TABLE deployment
  ADD CONSTRAINT deployment_trigger_check
  CHECK (trigger IN ('push', 'tag', 'webhook', 'manual', 'agent', 'redeploy'));
