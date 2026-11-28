-- 0652: old console addresses (spec 29a.9.1). The path at which 0.1.x showed a project,
-- environment, service, deployment or server, so bookmarks and links in old notification messages
-- open the object's 1.0 page, with or without the old workspace prefix.
CREATE TABLE migration_console_path (
  path       text        PRIMARY KEY CHECK (path ~ '^/' AND length(path) BETWEEN 2 AND 2000),
  -- The path without its first segment (the old workspace prefix), when it has more than one.
  tail       text,
  kind       text        NOT NULL
             CHECK (kind IN ('project', 'environment', 'service', 'deployment', 'server')),
  -- Not a foreign key (it names one of several tables); a deleted object's path leads nowhere.
  object_id  uuid        NOT NULL,
  import_id  uuid        REFERENCES migration_import (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX migration_console_path_tail ON migration_console_path (tail);
