-- 0654: the containers each runner last reported (spec 29.5 "Finalize": `migrate status` reports
-- what is actually running), so commands outside the control plane's process can read them.
-- Only each container's id, Docker state and the service it belongs to are kept.
ALTER TABLE runner ADD COLUMN containers jsonb;
ALTER TABLE runner ADD COLUMN containers_at timestamptz;
