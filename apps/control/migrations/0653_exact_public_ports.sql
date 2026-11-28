-- 0653: a moved service keeps its exact public port (spec 29.5 "Public ports"), which can be
-- outside the range 1.0 picks new public ports from (20000 to 29999). New ones still come from
-- that range; the database only holds any valid port.
ALTER TABLE service DROP CONSTRAINT IF EXISTS service_public_port_check;
ALTER TABLE service ADD CONSTRAINT service_public_port_check
  CHECK (public_port IS NULL OR public_port BETWEEN 1 AND 65535);
