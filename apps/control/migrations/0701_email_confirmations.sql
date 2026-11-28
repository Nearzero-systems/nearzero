-- 0701: confirming an email address (spec 04 4.6, 30a R1-02, B1-63). A changed address counts
-- only once the person opens a link sent to it, and until then the old address stays in use; an
-- account whose address was never proven can ask for a link to it. One link per account at a
-- time, kept only as a SHA-256 hash, for 24 hours.
CREATE TABLE email_confirmation (
  person_id    uuid        PRIMARY KEY REFERENCES person (id) ON DELETE CASCADE,
  -- The address the link proves: a new one, or the account's own unproven one.
  email        text        NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  token_hash   bytea       NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE INDEX email_confirmation_expiry_idx ON email_confirmation (expires_at);

-- Accounts moved from 0.1.x count as confirmed (decision for R1-02): 0.1.x never checked an
-- address, so its "not verified" flag said nothing. Accounts an earlier 1.0 import left
-- unconfirmed are confirmed here, unless their address was changed since.
UPDATE person
SET email_verified_at = now()
WHERE email_verified_at IS NULL
  AND id::text IN (SELECT object_id FROM migration_record WHERE kind = 'people')
  AND NOT EXISTS (
    SELECT 1 FROM audit_event
    WHERE audit_event.action = 'person.email-changed'
      AND audit_event.target_id = person.id::text
  );
