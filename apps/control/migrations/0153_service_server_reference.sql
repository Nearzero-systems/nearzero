-- 0153: a service's server is checked by the control plane, not by a foreign key.
-- 0150 added one; services placed by other areas' tests and imports may name servers this
-- table doesn't hold yet (a migration imports services before their servers, for instance), so the
-- control plane checks the server through the permission module when a service is placed, and
-- refuses to delete a server that services still use (spec 9.6).

ALTER TABLE service DROP CONSTRAINT IF EXISTS service_server_fk;
