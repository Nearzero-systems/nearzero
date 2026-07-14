DO $$
DECLARE
	collision_summary text;
BEGIN
	SELECT string_agg(
		format('%s (%s rows)', normalized_name, row_count),
		', ' ORDER BY normalized_name
	)
	INTO collision_summary
	FROM (
		SELECT lower(rtrim(btrim("name"), '.')) AS normalized_name, count(*) AS row_count
		FROM "dns_zone"
		GROUP BY lower(rtrim(btrim("name"), '.'))
		HAVING count(*) > 1
		ORDER BY normalized_name
		LIMIT 20
	) AS collisions;

	IF collision_summary IS NOT NULL THEN
		RAISE EXCEPTION 'Cannot enforce global DNS zone uniqueness. Resolve duplicate normalized zones first: %', collision_summary
			USING ERRCODE = '23505';
	END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
	collision_summary text;
BEGIN
	SELECT string_agg(
		format('%s (%s rows)', normalized_host, row_count),
		', ' ORDER BY normalized_host
	)
	INTO collision_summary
	FROM (
		SELECT
			lower(rtrim(btrim("host"), '.')) AS normalized_host,
			count(*) AS row_count
		FROM "domain"
		GROUP BY lower(rtrim(btrim("host"), '.'))
		HAVING count(*) > 1
		ORDER BY normalized_host
		LIMIT 20
	) AS collisions;

	IF collision_summary IS NOT NULL THEN
		RAISE EXCEPTION 'Cannot enforce global hostname uniqueness. Resolve duplicate normalized domains first: %', collision_summary
			USING ERRCODE = '23505';
	END IF;
END $$;
--> statement-breakpoint
UPDATE "dns_zone"
SET "name" = lower(rtrim(btrim("name"), '.'));
--> statement-breakpoint
UPDATE "domain"
SET "host" = lower(rtrim(btrim("host"), '.'));
--> statement-breakpoint
CREATE UNIQUE INDEX "dns_zone_name_lower_unique_idx"
	ON "dns_zone" USING btree (lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "domain_host_lower_unique_idx"
	ON "domain" USING btree (lower("host"));
--> statement-breakpoint
DO $$
DECLARE
	collision_summary text;
BEGIN
	SELECT string_agg(
		format('%s/%s/%s (%s managed rows)', "dnsZoneId", "name", "type", row_count),
		', ' ORDER BY "dnsZoneId", "name", "type"
	)
	INTO collision_summary
	FROM (
		SELECT "dnsZoneId", "name", "type", count(*) AS row_count
		FROM "dns_record"
		WHERE "domainId" IS NOT NULL AND "type" IN ('A', 'AAAA', 'CNAME')
		GROUP BY "dnsZoneId", "name", "type"
		HAVING count(*) > 1
		ORDER BY "dnsZoneId", "name", "type"
		LIMIT 20
	) AS collisions;

	IF collision_summary IS NOT NULL THEN
		RAISE EXCEPTION 'Cannot enforce managed DNS owner uniqueness. Resolve duplicate managed address records first: %', collision_summary
			USING ERRCODE = '23505';
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "dns_record_managed_address_owner_unique_idx"
	ON "dns_record" USING btree ("dnsZoneId", "name", "type")
	WHERE "domainId" IS NOT NULL AND "type" IN ('A', 'AAAA', 'CNAME');
