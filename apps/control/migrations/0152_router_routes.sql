-- 0152: the routes the runner writes into each server's router folder (spec 10.1, 10.2, 10.7).
-- The control plane keeps them so a re-set-up server, or a runner that lost its files, gets them
-- all back on its next connection.

CREATE TABLE router_route (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A server id, or "host" for the Nearzero host.
  target     text        NOT NULL CHECK (length(target) BETWEEN 1 AND 64),
  key        text        NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  -- A hostname routes to at most one place on the install.
  hostnames  text[]      NOT NULL CHECK (cardinality(hostnames) BETWEEN 1 AND 50),
  -- The route as the runner takes it (see packages/shared, routeSpecSchema).
  spec       jsonb       NOT NULL,
  written_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target, key)
);

CREATE INDEX router_route_hostnames_idx ON router_route USING gin (hostnames);
