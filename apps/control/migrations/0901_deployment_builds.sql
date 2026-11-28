-- 0901: whether a deployment builds anything (31b G2-05; spec 31's decision on the per-server
-- deploy limit). Only builds count toward a server's one-at-a-time limit; Reload, database
-- deploys, image-only deploys and Make public or Make private start at once. Deployments from
-- before this change count as builds.
ALTER TABLE deployment ADD COLUMN builds boolean NOT NULL DEFAULT true;
