-- 0250: hostnames, managed DNS zones and their records, environment defaults, uploaded
-- certificates, what each server's router reported about certificates, and the console's
-- address settings (spec 10, spec 18.2).

-- A zone whose nameservers point at Nearzero's built-in DNS server (spec 10.8). One workspace
-- manages a zone on the whole install.
CREATE TABLE dns_zone (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  name                 text        NOT NULL UNIQUE
                                   CHECK (name ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
                                          AND length(name) <= 253),
  admin_email          text        NOT NULL CHECK (length(admin_email) BETWEEN 3 AND 254),
  nameservers          text[]      NOT NULL CHECK (cardinality(nameservers) BETWEEN 1 AND 13),
  -- The zone file's SOA serial: raised whenever a record changes (see the trigger below).
  serial               bigint      NOT NULL DEFAULT 1,
  -- The serial last published to the built-in DNS server, and when.
  applied_serial       bigint,
  -- The zone file as last published, so applying one zone republishes the others unchanged.
  applied_content      text,
  applied_at           timestamptz,
  apply_error          text,
  -- A record Nearzero manages changed: publish without waiting for Apply.
  auto_apply           boolean     NOT NULL DEFAULT false,
  -- The last health check: what the DNS server answered.
  health               jsonb,
  health_checked_at    timestamptz,
  created_by           uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE INDEX dns_zone_workspace_idx ON dns_zone (workspace_id, created_at);

-- Every hostname (spec 10.1, 10.4): connected to at most one service, or pointing at a server
-- without serving anything. A hostname is unique on the install, as routes are.
CREATE TABLE hostname (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  host            text        NOT NULL UNIQUE CHECK (length(host) BETWEEN 3 AND 253),
  source          text        NOT NULL CHECK (source IN ('platform', 'server', 'zone', 'own')),
  -- A zone with hostnames can't be removed (checked first, with the services named); NO ACTION
  -- lets a deleted workspace take both with it.
  zone_id         uuid        REFERENCES dns_zone (id),
  -- Assigned by Nearzero (a generated label or an environment default), not typed in.
  automatic       boolean     NOT NULL DEFAULT false,
  -- Deleting a service removes its hostnames (spec 10.6); their routes and records follow.
  service_id      uuid        REFERENCES service (id) ON DELETE CASCADE,
  compose_service text        CHECK (compose_service IS NULL OR compose_service ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$'),
  -- Null: the service's own port.
  port            integer     CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  path            text        NOT NULL DEFAULT '/' CHECK (path ~ '^/' AND length(path) <= 1024),
  -- Where its DNS should point: a server id, or "host" for the Nearzero host.
  target          text        NOT NULL CHECK (length(target) BETWEEN 1 AND 64),
  -- The route written for it on `target`, while connected.
  route_key       text,
  -- The last DNS check (status, addresses, provider…).
  dns             jsonb,
  dns_checked_at  timestamptz,
  -- When Retry or Check DNS last asked Let's Encrypt.
  last_attempt_at timestamptz,
  -- An automatic hostname whose environment default changed while it couldn't be updated:
  -- the next deploy replaces it (spec 10.8).
  replace_on_deploy boolean   NOT NULL DEFAULT false,
  created_by      uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'zone') = (zone_id IS NOT NULL)),
  CHECK (service_id IS NOT NULL OR (compose_service IS NULL AND route_key IS NULL))
);

CREATE INDEX hostname_workspace_idx ON hostname (workspace_id, created_at);
CREATE INDEX hostname_service_idx ON hostname (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX hostname_zone_idx ON hostname (zone_id) WHERE zone_id IS NOT NULL;
CREATE INDEX hostname_target_idx ON hostname (target);

-- A record in a managed zone (spec 10.8). Names are relative to the zone ("@" is the apex).
CREATE TABLE dns_record (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id     uuid        NOT NULL REFERENCES dns_zone (id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 253),
  type        text        NOT NULL CHECK (type IN ('A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'NS')),
  value       text        NOT NULL CHECK (length(value) BETWEEN 1 AND 4000),
  ttl         integer     NOT NULL DEFAULT 300 CHECK (ttl BETWEEN 60 AND 86400),
  priority    integer     CHECK (priority IS NULL OR priority BETWEEN 0 AND 65535),
  -- Records Nearzero manages (the zone's nameservers and hostnames' records): read-only here.
  managed     boolean     NOT NULL DEFAULT false,
  hostname_id uuid        REFERENCES hostname (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dns_record_zone_idx ON dns_record (zone_id, name);
CREATE INDEX dns_record_hostname_idx ON dns_record (hostname_id) WHERE hostname_id IS NOT NULL;

-- Any change to a record raises its zone's serial; a change to a managed record (a hostname
-- added or removed, also through a deleted service) asks for the zone to be published at once.
CREATE FUNCTION dns_record_touch_zone() RETURNS trigger AS $$
DECLARE
  zone uuid;
  managed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    zone := OLD.zone_id;
    managed := OLD.managed;
  ELSE
    zone := NEW.zone_id;
    managed := NEW.managed OR (TG_OP = 'UPDATE' AND OLD.managed);
  END IF;
  UPDATE dns_zone
     SET serial = serial + 1,
         auto_apply = auto_apply OR managed,
         updated_at = now()
   WHERE id = zone;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dns_record_touch_zone_trigger
  AFTER INSERT OR UPDATE OR DELETE ON dns_record
  FOR EACH ROW EXECUTE FUNCTION dns_record_touch_zone();

-- Where an environment's apps get automatic hostnames (spec 10.8 Environment defaults). No row:
-- the workspace's first zone if it has one, otherwise the platform domain.
CREATE TABLE environment_hostname_default (
  environment_id uuid        PRIMARY KEY REFERENCES environment (id) ON DELETE CASCADE,
  workspace_id   uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  source         text        NOT NULL CHECK (source IN ('platform', 'none', 'zone')),
  -- Removing a zone drops the defaults that named it, which fall back to the rule above.
  zone_id        uuid        REFERENCES dns_zone (id) ON DELETE CASCADE,
  prefix         text        NOT NULL DEFAULT '' CHECK (length(prefix) <= 100),
  updated_by     uuid        REFERENCES person (id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'zone') = (zone_id IS NOT NULL))
);

-- A person removed a service's automatic hostname: deploys don't add another until they ask
-- (Give it a hostname, Generate a domain).
CREATE TABLE service_hostname_state (
  service_id         uuid        PRIMARY KEY REFERENCES service (id) ON DELETE CASCADE,
  automatic_declined boolean     NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A certificate someone uploaded for one server (spec 10.7): for wildcards or their own CA. The
-- private key is sealed with the install key and never sent back.
CREATE TABLE uploaded_certificate (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- A server id, or "host". Fixed after upload.
  target          text        NOT NULL CHECK (length(target) BETWEEN 1 AND 64),
  certificate_pem text        NOT NULL CHECK (length(certificate_pem) BETWEEN 1 AND 65536),
  key_sealed      text        NOT NULL,
  names           text[]      NOT NULL CHECK (cardinality(names) BETWEEN 1 AND 500),
  not_before      timestamptz NOT NULL,
  not_after       timestamptz NOT NULL,
  issuer          text        NOT NULL,
  fingerprint     text        NOT NULL,
  created_by      uuid        REFERENCES person (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX uploaded_certificate_workspace_idx ON uploaded_certificate (workspace_id, name);
CREATE INDEX uploaded_certificate_target_idx ON uploaded_certificate (target);

-- What each server's runner last said about its certificates (names and dates only, never keys).
CREATE TABLE certificate_snapshot (
  target  text        PRIMARY KEY CHECK (length(target) BETWEEN 1 AND 64),
  status  jsonb,
  -- Why it couldn't be read this time; the older status is kept.
  error   text,
  read_at timestamptz NOT NULL DEFAULT now()
);

-- The console's address settings instance administrators change under About Nearzero
-- (spec 18.2, 10.9): a corrected server IP, and a console hostname with its certificate email.
CREATE TABLE address_setting (
  key        text        PRIMARY KEY CHECK (key IN ('public_ipv4', 'console_hostname', 'console_acme_email')),
  value      text        NOT NULL CHECK (length(value) BETWEEN 1 AND 253),
  updated_by uuid        REFERENCES person (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
