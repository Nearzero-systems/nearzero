-- 0845: what is still free for anyone but root on a server's root filesystem (statfs f_bavail,
-- df's "Available"), so Storage usage reads used / (used + available) as df does (30c R3-34).
-- Null for samples from older runners, which show used / total as before.
ALTER TABLE server_metric ADD COLUMN disk_available_bytes bigint CHECK (disk_available_bytes >= 0);
