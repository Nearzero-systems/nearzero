-- 0768: how a deploy's pipeline ended, written the moment it ends and before the deployment's
-- record and its service are updated (spec 23.1). A failure while recording a deploy that already
-- went live (the database dropping a connection, say) retries the recording only: the job sees
-- the saved outcome and never builds and starts the deploy a second time.
ALTER TABLE deployment ADD COLUMN pipeline_outcome jsonb;
