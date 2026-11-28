-- 0942: which next link certificate each runner holds while the pair is being replaced
-- (`nearzero runner-link rotate`, C4-10), so `nearzero runner-link status` can list the servers
-- that don't have it yet. Null when there is no next pair, or the runner hasn't taken it.
ALTER TABLE runner ADD COLUMN link_next text CHECK (link_next IS NULL OR link_next ~ '^[0-9a-f]{64}$');
