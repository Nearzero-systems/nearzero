-- 0740: what an instance administrator approved for an application on the Nearzero host
-- (spec 24 G3, 06 6.8; 30b R2-07). Bind mounts there are root on Nearzero itself, so only an
-- administrator's deploy runs them. Each key names one bind mount together with a fingerprint
-- of the application's definition (source, builder, commands, bind mounts), so a changed image,
-- repository or start command needs an administrator again. Deploys by anyone else, and push
-- and webhook deploys, may run exactly these again.

CREATE TABLE host_approval (
  service_id    uuid        PRIMARY KEY REFERENCES service (id) ON DELETE CASCADE,
  approved_keys text[]      NOT NULL DEFAULT '{}',
  approved_by   uuid        REFERENCES person (id) ON DELETE SET NULL,
  approved_at   timestamptz NOT NULL DEFAULT now()
);
