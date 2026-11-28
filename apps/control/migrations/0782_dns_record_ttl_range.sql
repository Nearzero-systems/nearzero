-- 0782: a DNS record's TTL may be anything DNS allows, 1 second to 2^31 - 1 (RFC 2181), so the
-- week-long TTL common for NS and MX records saves (spec 10.8; R3-24).
ALTER TABLE dns_record DROP CONSTRAINT IF EXISTS dns_record_ttl_check;
ALTER TABLE dns_record ADD CONSTRAINT dns_record_ttl_check CHECK (ttl BETWEEN 1 AND 2147483647);
