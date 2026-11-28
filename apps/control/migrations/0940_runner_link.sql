-- 0940: where each runner reaches the control plane, and what is wrong with that, for the
-- server's page (spec 31 "Remote runners are always encrypted", 31c G3-01). Null for runners
-- that haven't connected since, and for older runners, which don't say where they are.
ALTER TABLE runner ADD COLUMN link_url text CHECK (link_url IS NULL OR length(link_url) <= 300);
ALTER TABLE runner ADD COLUMN link_problem text CHECK (link_problem IS NULL OR length(link_problem) <= 2000);
