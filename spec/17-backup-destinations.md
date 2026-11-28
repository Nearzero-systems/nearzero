# 17. Backup destinations and volume backups

Backups go to S3-compatible storage the workspace configures as **destinations**. Database backups are described in [08-databases.md](08-databases.md) 8.3; this file covers destinations, volume backups, and the rules shared by both.

## 17.1 Destinations

Settings → **Backups** (page title "Backup destinations"), for people with destination rights.
- Table: Name, Provider, Bucket, Endpoint, with **Test**, **Edit**, **Delete**. **Add destination** (create rights).
- Provider choices, each prefilling a sample endpoint: Amazon S3, Cloudflare R2, DigitalOcean Spaces, Wasabi, Scaleway, Akamai (Linode), MinIO, Other S3-compatible.
- Fields: Name, Provider, Endpoint (URL), Bucket, Region ("or auto"), Access key ID, Secret access key. Hint: "Use a key that can only reach this bucket. Nearzero never shows the keys again."
- Keys are encrypted, never returned to the page, and never included in any service's details. On edit, blank keys keep the saved ones ("Saved, leave blank to keep").
- **Test** lists the bucket within 10 seconds: "Connected. Nearzero can list <bucket>." or "Could not reach the bucket. Check the endpoint, bucket, region and keys."
- **Delete**: "Backup schedules that write to it are removed too. Files already in the bucket stay there."

## 17.2 Shared rules for every backup

- Every run is recorded with a log, in the background; "Run now" returns at once.
- A run that uploads nothing, or whose any step fails, is "Failed", never "Succeeded". Steps never read from standard input (see [23-non-functional.md](23-non-functional.md) 23.1).
- "Keep N" prunes older files of that schedule only after a successful run.
- Two runs of the same schedule never overlap; a new one cancels a waiting one, not a running one.
- Listing and restoring files is limited to the service's own backups (G1 and G2 in [24-known-gaps.md](24-known-gaps.md)).
- Each run sends the matching notification event.

## 17.3 Volume backups

Where: an app's **Backups** tab, a Compose service's "Volume backups" section, and a Redis database's Backups tab.

- **Volume list**: the named volumes mounted by this service (its saved mounts, its containers' mounts, and for Compose the volumes declared by its own file plus those its containers carry labels for). Never chosen by name prefix. The section says which volumes it found; none: guidance on adding a volume mount.
- **Add backup**: Volume, Destination, Folder, Schedule (preset or 5-field cron with the syntax of 12.2, server time zone), Keep, and "Stop the service while copying" (for consistent copies; for Compose refused when it can't tell which inner service uses the volume).
- Files are tar archives in `<app name>[_<inner service>]/<folder>/`.
- Rows show schedule, destination, folder, keep, last run; actions **Run now**, **Edit**, **Delete** ("Backups already in the bucket stay").
- **Restore**: "Find backups" → pick a file → "Restore into volume" → type the service name ("This overwrites the volume. It can't be undone.") → live log. Restore stops this service's containers that use the volume, empties it, unpacks the archive and starts them again even if the restore failed, and reports its real result. A volume another service also uses is refused.
- Rules: the service must actually mount the volume, and the destination must be in the same workspace.
- With no destination: "Add a destination first".

**Acceptance**
- An app with a volume mount backs it up, the file is deleted inside the volume, a restore brings it back, and the app is running afterwards.
- A member can't back up a volume their service doesn't mount, or send it to another workspace's destination.

## 17.4 The control plane's own data

Whole-instance backups from the console are not in 1.0 (no screen exists today). The control-plane database is backed up with `sudo nearzero backup-db` and restored with `sudo nearzero restore-db` ([03](03-install-and-cli.md) 3.4). A later release may add scheduled control-plane backups to a destination, for instance administrators only.

## 17.5 Permissions

| Action | Needs |
| --- | --- |
| See destinations, choose one in a schedule | "Back up to the workspace's destinations" (owners and admins by default) |
| Add, edit, delete destinations | "Add and remove backup destinations" |
| Add, run, edit, delete backup schedules of a service | Backup rights on the service (members by default for their services) plus a destination they can use |
| Restore | Restore rights on the service |
