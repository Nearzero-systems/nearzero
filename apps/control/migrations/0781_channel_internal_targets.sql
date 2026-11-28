-- 0781: whether a notification channel may send to a private or internal address (spec 23.9:
-- outbound calls go only to providers people configured). Only an instance administrator can
-- point a channel at this machine, a private network or a cloud's metadata address; the flag
-- records that one did when the channel's destination was last saved.
ALTER TABLE notification_channel ADD COLUMN internal_allowed boolean NOT NULL DEFAULT false;

-- Channels that exist already were set up before the rule; those of the instance
-- administrators' own workspace keep working.
UPDATE notification_channel
   SET internal_allowed = true
 WHERE workspace_id IN (SELECT first_workspace_id FROM install_state);
