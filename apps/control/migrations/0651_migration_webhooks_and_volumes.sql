-- 0651: what an import keeps beyond the records (spec 29.5, 29a.9): the 0.1.x webhook addresses
-- 1.0 keeps answering, and the volume archives (export --volumes) restored into each service's
-- new volume before its first deploy on another machine.

-- An old webhook path, with "{token}" where its token goes (deploy webhooks) or none (the GitHub
-- App's address). Requests to it reach the same handler as 1.0's own address.
CREATE TABLE migration_webhook_path (
  pattern    text        PRIMARY KEY CHECK (pattern ~ '^/' AND length(pattern) BETWEEN 2 AND 500),
  kind       text        NOT NULL CHECK (kind IN ('deploy', 'github')),
  import_id  uuid        REFERENCES migration_import (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One volume's archive from the bundle, waiting to be restored on the service's server.
CREATE TABLE migration_volume_archive (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id   uuid        NOT NULL REFERENCES migration_import (id) ON DELETE CASCADE,
  service_id  uuid        NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  -- The Docker volume it fills on the service's server.
  volume      text        NOT NULL CHECK (volume ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$'),
  size_bytes  bigint      NOT NULL,
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  restored_at timestamptz,
  UNIQUE (service_id, volume)
);

-- The archive in pieces, each sealed with a key derived from the install's (AES-256-GCM: the
-- nonce, the ciphertext and the tag), so the plain data never rests on disk.
CREATE TABLE migration_volume_archive_part (
  archive_id uuid    NOT NULL REFERENCES migration_volume_archive (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  bytes      bytea   NOT NULL,
  PRIMARY KEY (archive_id, seq)
);
