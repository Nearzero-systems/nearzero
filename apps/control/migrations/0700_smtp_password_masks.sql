-- 0700: a workspace's SMTP password was shown "masked" with its first 3 and last 4 characters, which
-- for a short password is most or all of it (B1-50, spec 23.4.3). It now shows only "Saved".
-- The masks already stored are replaced, and the masks written into the audit trail when one
-- was saved are removed; the sealed passwords themselves don't change.
UPDATE workspace_secret SET masked = 'Saved' WHERE kind = 'email-smtp-password';

UPDATE audit_event
SET details = details - 'masked'
WHERE action = 'email-settings.saved'
  AND details ->> 'provider' = 'smtp'
  AND details ? 'masked';
