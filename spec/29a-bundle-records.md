# 29a. The export bundle, field by field

This file completes [29-migration.md](29-migration.md): it fixes the exact contents of the bundle the final 0.1.x release writes (format version 1), so the 1.0 importer can be built from it alone. Everything is in 1.0's words; no 0.1.x name appears in a bundle.

## 29a.1 Conventions

- **Ref**: an opaque string, unique within the bundle, that names one record. Today's refs look like a short lowercase prefix, an underscore and 26 lowercase base32 characters (for example `svc_…`), but the importer must not read meaning into them. The same install exports the same refs every time, so importing a newer bundle of the same install matches records one to one.
- **Time**: an ISO 8601 date and time in UTC, as text.
- **Variables text**: dotenv text, one `NAME=value` per line, with `#` comments kept. A value may be quoted with single quotes (taken as is), back quotes (taken as is, may span lines) or double quotes (where `\n` and `\r` become line breaks).
- **Labels**: fields that name a choice hold one of the exact labels in 29a.6. A label outside those lists is unknown: the importer reports it in the dry run and uses the 1.0 default.
- **Presence**: in the tables, *required* means always present with a value; *may be null* means always present but possibly null; *may be absent* means the field can be missing. Fields the importer doesn't know are ignored (29.3).
- **Secrets** are plain text inside the bundle; the whole bundle is encrypted.

## 29a.2 Bytes on disk

One file, read from the start:

| Bytes | Content |
| --- | --- |
| 0 to 7 | The ASCII text `NZEXPORT` |
| 8 to 11 | The length L of the header that follows, an unsigned 32-bit big-endian number (at most 65,536) |
| 12 to 12 + L | The clear header: UTF-8 JSON (29a.2.1) |
| then | The ciphertext: the whole tar archive (29a.3), encrypted |
| last 16 | The authentication tag |

- Cipher: AES-256-GCM, one message for the whole archive, with the 12-byte nonce from the header and a 16-byte tag. The additional authenticated data is every byte before the ciphertext (the magic text, the length and the header), so changing the header breaks decryption.
- Key: scrypt over the passphrase, with the parameters and salt from the header, 32 bytes long. The passphrase is normalized to Unicode NFC and then taken as UTF-8 bytes.
- A plaintext archive is at most 64 GiB (the AES-GCM limit); the exporter refuses larger bundles.
- A wrong passphrase and a changed file both fail the tag check; the importer says "Wrong passphrase, or the bundle was changed."

### 29a.2.1 Clear header

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| format | number | Bundle format version: 1. A newer number is refused. | required |
| cipher | text | `aes-256-gcm` | required |
| kdf.name | text | `scrypt` | required |
| kdf.input | text | `utf8-nfc`: how the passphrase becomes bytes | required |
| kdf.N | number | scrypt cost, 131072 (2^17) | required |
| kdf.r | number | scrypt block size, 8 | required |
| kdf.p | number | scrypt parallelism, 1 | required |
| kdf.keyLength | number | 32 | required |
| kdf.salt | text | 16 random bytes, base64 | required |
| iv | text | The 12-byte GCM nonce, base64 | required |
| tagLength | number | 16 | required |

An importer accepts only scrypt with N a power of two up to 2^20, r up to 32 and p up to 16, so a crafted header can't exhaust memory.

## 29a.3 The archive

A POSIX tar archive (ustar). Paths longer than 99 bytes, paths with non-ASCII characters and files over 8 GiB use pax extended headers. Only regular files; folders are implied by paths. Order: `manifest.json`, `install.json`, the record files in the order of 29a.5, the certificate stores, then the volume archives.

| Path | Content |
| --- | --- |
| `manifest.json` | The manifest (29a.4) |
| `install.json` | The install record (29a.5.22) |
| `<kind>.jsonl` | One JSON object per line, one file per record kind (29a.5) |
| `acme/host/acme.json` | The Nearzero host's router certificate store, exactly as the router (Traefik) keeps it: the certificate authority account and every certificate with its private key |
| `acme/<server ref>/acme.json` | The same for each server |
| `volumes/<service ref>/<volume name>.tar` | With `--volumes` only: a tar of one data volume's contents, rooted at the volume |

## 29a.4 Manifest

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| format | number | 1 | required |
| sourceVersion | text | The 0.1.x release that wrote the bundle | required |
| exportedAt | time | When the snapshot was taken | required |
| options.deployments | yes/no | Deployments were included | required |
| options.volumes | yes/no | Volume archives were included | required |
| counts | object | Number of records per kind, keyed by the kind names of 29a.5 (people, workspaces, memberships, policies, invitations, servers, sshKeys, gitProviders, projects, environments, services, hostnames, zones, certificates, destinations, backupSchedules, tasks, channels, agentSessions, deployments), plus acme (stores carried) and volumes (archives carried) | required |
| files | list | Every file except the manifest: path, sha256 (hex) and bytes (size). The importer checks each and refuses a bundle whose files don't match or that holds a file not listed. | required |
| acme | list | One entry per certificate store: path, serverRef (null for the host), host (yes/no), certificates (how many) | required |
| volumes | list | One entry per volume archive: path, serviceRef, volume (its name), serverRef (null for the host), bytes | required |
| notes | list | Everything that doesn't map, each with kind, ref (may be absent), name (may be absent) and reason (a sentence for the dry-run report). Kinds: install, person, workspace, membership, policy, project, environment, service, hostname, backup-schedule, task, channel, acme, volume, deployment. | required |

## 29a.5 Record kinds

### 29a.5.1 Shapes used by several kinds

**Place**: where something runs. Exactly one of:

| Field | Type | Meaning |
| --- | --- | --- |
| serverRef | ref | One of the workspace's servers |
| host | yes | The Nearzero host |

**Scope**: what a membership or policy reaches.

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| allProjects | yes/no | Every project, environment and service, including new ones | required |
| projectRefs | list of refs | Projects granted | required |
| environmentRefs | list of refs | Environments granted | required |
| serviceRefs | list of refs | Services granted | required |
| allServers | yes/no | Every server, including new ones | required |
| serverRefs | list of refs | Servers granted | required |
| allGitProviders | yes/no | Every Git account, including other people's private ones | required |
| gitProviderRefs | list of refs | Git accounts granted | required |

**Password hash**: one of three shapes, chosen by `algorithm`.

| algorithm | encoded | params | How to check a password |
| --- | --- | --- | --- |
| `scrypt` | The stored text, `<salt>:<key>` | N 16384, r 16, p 1, keyLength 64, salt (text), saltEncoding `utf8`, key (hex), keyEncoding `hex`, passwordNormalization `NFKC` | Normalize the typed password to NFKC, take its UTF-8 bytes, run scrypt with the salt *text's* UTF-8 bytes as salt (the salt is not hex-decoded) and the given N, r, p and length, and compare the result with the hex key in constant time |
| `bcrypt` | The bcrypt text (`$2a$`, `$2b$` …) | variant, cost | Standard bcrypt comparison |
| `unknown` | The stored text | none | Can't be checked: the person resets their password; the notes say so |

On the first successful sign-in 1.0 replaces the hash with its own (29.5).

**Two-factor**: null when off. When on, either readable:

| Field | Type | Meaning |
| --- | --- | --- |
| enabled | yes | Always yes |
| secret | text | The TOTP key as text; the HMAC key is this text's UTF-8 bytes |
| secretBase32 | text | The same bytes in base32 without padding, as authenticator apps hold them |
| totp | object | algorithm `SHA1`, digits 6, periodSeconds 30, keyEncoding `utf8` |
| backupCodes | object | algorithm `sha256`, encoding `hex`, hashes: one hex SHA-256 per unused code (of the code's UTF-8 bytes, exactly as shown to the person) |

or unreadable: `enabled` yes and `unreadable` yes. 1.0 then asks the person to set up two-factor again at their next sign-in (after the password).

### 29a.5.2 people.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| email | text | | required |
| emailVerified | yes/no | | required |
| firstName, lastName | text | May be empty | required |
| password | password hash | Null when the person never set a password | may be null |
| twoFactor | two-factor | | may be null |
| avatar | text | The person's avatar choice | may be null |
| otherSignIns | list of labels | Other ways they signed in (29a.6.13); not carried, they connect them again | required |
| banned | yes/no | | required |
| createdAt | time | | may be null |

### 29a.5.3 workspaces.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| name | text | | required |
| slug | text | The web address segment, kept exactly | may be null |
| oldSlugs | list of text | Earlier slugs that still redirect (empty from 0.1.x) | required |
| logo | text | | may be null |
| ownerRef | ref | Person who owns it | required |
| personal | yes/no | The owner's personal workspace | required |
| firstWorkspace | yes/no | Its owners and admins are the instance administrators | required |
| hostsAllowed | yes/no | May deploy to the Nearzero host | required |
| agentPolicies | object | Every Agent policy by its label (29a.6.1), yes or no | required |
| modelKey | text | OpenRouter key | may be null |
| researchKey | text | Firecrawl key | may be null |
| invitationEmail.resendKey | text | Resend key for invitation emails | may be null |
| invitationEmail.sender | text | Sender address | may be null |
| createdAt | time | | may be null |

### 29a.5.4 memberships.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| personRef, workspaceRef | ref | | required |
| role | label | 29a.6.3 | required |
| capabilities | list of labels | Granted directly (29a.6.2) | required |
| scope | scope | Granted directly | required |
| policyRefs | list of refs | Attached policies | required |
| defaultWorkspace | yes/no | Where the person lands after signing in | required |
| createdAt | time | Joined | may be null |

### 29a.5.5 policies.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| workspaceRef | ref | | required |
| name | text | | required |
| description | text | May be empty | required |
| capabilities | list of labels | 29a.6.2 | required |
| scope | scope | | required |

### 29a.5.6 invitations.jsonl

Only pending invitations that haven't expired. Tokens are not carried.

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| workspaceRef | ref | | required |
| email | text | | required |
| role | label | `Admin` or `Member` | required |
| policyRefs | list of refs | | required |
| invitedByRef | ref | | may be null |
| expiresAt | time | | required |

### 29a.5.7 servers.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| workspaceRef | ref | | required |
| name | text | | required |
| description | text | | may be null |
| address | text | IP address or host name | required |
| port | number | SSH port | required |
| sshUser | text | | required |
| sshKeyRef | ref | | may be null |
| hostKeyFingerprint | text | The trusted SSH host key, `SHA256:` and unpadded base64 | may be null |
| hostnameLabel | text | The server's fixed label for its hostnames, kept exactly | may be null |
| dailyCleanup | yes/no | | required |
| alertThresholds | object | cpuPercent and memoryPercent; 0 means off | required |
| createdAt | time | | may be null |

### 29a.5.8 ssh-keys.jsonl

| Field | Type | Presence |
| --- | --- | --- |
| ref, workspaceRef | ref | required |
| name | text | required |
| description | text | may be null |
| publicKey, privateKey | text (OpenSSH) | required |
| createdAt, lastUsedAt | time | may be null |

### 29a.5.9 git-providers.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, workspaceRef | ref | | required |
| ownerRef | ref | The person who connected it | may be null |
| shared | yes/no | Shared with the workspace | required |
| kind | label | 29a.6.7 | required |
| name | text | | required |
| connection | label | `Own app` (the workspace registered its own) or `Shared app` (the install's) | required |
| urls | object | web, internal (address used from the server), redirect (OAuth callback) | required |
| app | object | GitHub only: appId, appName, clientId, clientSecret, privateKey, webhookSecret | may be null |
| oauth | object | GitLab and Gitea: clientId, clientSecret; Gitea also scopes | may be null |
| installationIds | list of text | GitHub App installations | required |
| tokens | object | accessToken, refreshToken, expiresAt (time); Bitbucket also appPassword and apiToken | may be null |
| account | object | GitLab: group; Bitbucket: username, email, workspace | may be null |
| createdAt | time | | may be null |

### 29a.5.10 projects.jsonl

| Field | Type | Presence |
| --- | --- | --- |
| ref, workspaceRef | ref | required |
| name | text | required |
| description | text | may be null |
| createdAt | time | may be null |

### 29a.5.11 environments.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, projectRef | ref | | required |
| name | text | "production" makes it production | required |
| description | text | | may be null |
| default | yes/no | The project's first environment | required |
| sharedVariables | variables text | The environment's shared variables. 0.1.x project-level variables not set in the environment follow, after a comment line, in the same text | required |
| hostnameDefaults.source | label | 29a.6.9 | required |
| hostnameDefaults.zoneRef | ref | When the source is a zone | may be null |
| hostnameDefaults.prefix | text | Label added to generated hostnames | may be null |
| createdAt | time | | may be null |

### 29a.5.12 services.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, environmentRef | ref | | required |
| copyGroupRef | ref | Shared by the copies of the same service across the project's environments; not a record of its own | required |
| kind | label | 29a.6.4 | required |
| name | text | | required |
| appName | text | Internal app name: names its containers, network aliases and volumes; kept exactly | required |
| description | text | | may be null |
| place | place | | required |
| variables | variables text | Own variables | required |
| settings | object | By kind, below | required |
| volumes | list of text | Names of its data volumes on its server | required |
| createdAt | time | | may be null |

Settings every kind may have:

| Field | Type | Meaning |
| --- | --- | --- |
| mounts | list | Each with type (29a.6.6), path in the container, and volume (volume name), hostPath (host folder) or filePath and content (file contents) as the type needs |
| replicas | number | |
| resources | object | memoryReservationBytes, memoryLimitBytes, cpuReservationCores, cpuLimitCores; null means no limit |

**Application** settings:

| Field | Type | Meaning |
| --- | --- | --- |
| source | object | type (29a.6.5) and, by type: GitHub, Gitea: gitProviderRef, owner, repository, branch, path; GitLab: also projectId and namespace; Bitbucket: also repositorySlug; Git URL: url, branch, path, sshKeyRef; Container image: image, registryUrl, username, password; Uploaded archive: path (the archive itself isn't carried) |
| builder | object | type (29a.6.8), selection (`Automatic` or `Chosen`), runsOn (`Its server` or `Nearzero host`), dockerfile, contextPath, buildStage, railpackVersion, herokuVersion, publishDirectory, staticSpa, buildArgs (variables text), buildSecrets (variables text), cleanCache, submodules |
| commands | object | install, build, start, command, args (list) |
| ports | list | published, target, protocol (`TCP` or `UDP`) |
| autodeploy | yes/no | Deploy on push |
| trigger | label | `Push` or `Tag` |
| watchPaths | list of text | Paths whose changes trigger a deploy |
| webhookToken | text | The deploy webhook's secret part, kept so webhook URLs keep working (re-hashed on import) |
| createEnvFile | yes/no | |

**Compose** settings: source (as for applications without path; or type `Pasted Compose file`), format (`Compose` or `Stack`), composeFile (the file text when pasted, or the last fetched copy), composePath (path in the repository), command, autodeploy, trigger, watchPaths, webhookToken, submodules, and how names are made unique: suffix, randomizeNames, isolatedNetwork, isolatedVolumes.

**Databases**: image, command, args, credentials, publicPort (kept exactly; null when not published).

| Kind | credentials | Extra |
| --- | --- | --- |
| Postgres | database, user, password | |
| MySQL, MariaDB | database, user, password, rootPassword | |
| MongoDB | user, password | replicaSet (yes/no) |
| Redis | password | |
| libSQL | user, password | libsql: node (`Primary` or `Replica`), primaryUrl, namespaces (yes/no); publicPorts: http, grpc, admin |

### 29a.5.13 hostnames.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| serviceRef | ref | Connected service | may be null |
| innerService | text | Compose: the inner service it routes to | may be null |
| place | place | Only when connected to no service | may be null |
| host | text | Kept exactly | required |
| port | number | Container port | may be null |
| path | text | Public path | required |
| internalPath | text | Path forwarded to the container | required |
| stripPath | yes/no | | required |
| https | yes/no | | required |
| certificate | label | 29a.6.10 | required |
| source | label | 29a.6.9 | required |
| zoneRef | ref | | may be null |
| serverRef | ref | The server it routes to (null for the host) | may be null |
| generated | yes/no | Made by Nearzero rather than typed by a person | required |
| createdAt | time | | may be null |

### 29a.5.14 zones.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, workspaceRef | ref | | required |
| domain | text | | required |
| adminEmail | text | | required |
| nameservers | list of text | | required |
| ttl | number | Default record TTL, seconds | required |
| records | list | Records people added by hand: name, type (A, AAAA, CNAME, TXT, MX, CAA, NS), value, ttl (may be null), priority (may be null). Records Nearzero writes for hostnames are not listed; 1.0 writes them again | required |
| createdAt | time | | may be null |

### 29a.5.15 certificates.jsonl

| Field | Type | Presence |
| --- | --- | --- |
| ref, workspaceRef | ref | required |
| name | text | required |
| place | place | required |
| certificatePem, privateKeyPem | text | required |
| autoRenew | yes/no | required |

### 29a.5.16 destinations.jsonl

| Field | Type | Presence |
| --- | --- | --- |
| ref, workspaceRef | ref | required |
| name | text | required |
| provider | text (as the person chose it, for example "AWS", "Cloudflare") | may be null |
| endpoint, bucket, region | text | required |
| accessKey, secretKey | text | required |
| extraFlags | list of text (extra options for the S3 client) | required |
| createdAt | time | may be null |

### 29a.5.17 backup-schedules.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref | ref | | required |
| serviceRef, destinationRef | ref | | required |
| kind | label | `Database` or `Volume` | required |
| name | text | Volume schedules | may be null |
| database | text | Database to dump | may be null |
| composeDatabase | object | A database inside a Compose stack: innerService, type (a database kind label, 29a.6.4) and credentials (user, password, rootPassword as that type needs) | may be null |
| volume | text | Volume to archive | may be null |
| innerService | text | Compose: the inner service | may be null |
| folder | text | Folder in the destination | required |
| cron | text | Five-field cron | required |
| timeZone | text | IANA zone; null means the server's (UTC) | may be null |
| keep | number | Keep the newest N; null keeps all | may be null |
| enabled | yes/no | | required |
| stopWhileCopying | yes/no | Volume schedules: stop the service during the copy | required |
| createdAt | time | | may be null |

### 29a.5.18 tasks.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, workspaceRef | ref | Tasks on the host belong to the first workspace | required |
| place | object | One of: serviceRef with innerService (may be null); serverRef; host (yes) | required |
| name | text | | required |
| description | text | | may be null |
| cron | text | | required |
| timeZone | text | IANA zone | may be null |
| shell | text | `bash` or `sh` | required |
| script | text | What runs (in the container for a service task) | required |
| enabled | yes/no | | required |
| createdAt | time | | may be null |

### 29a.5.19 channels.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, workspaceRef | ref | | required |
| kind | label | 29a.6.11 | required |
| name | text | | required |
| fields | object | Settings by label (29a.6.11) | required |
| secrets | object | Secrets by label (29a.6.11) | required |
| events | list of labels | 29a.6.12 | required |
| createdAt | time | | may be null |

### 29a.5.20 agent-sessions.jsonl

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, workspaceRef | ref | | required |
| authorRef | ref | The person who started it, or the workspace owner when that person is gone | required |
| shared | yes/no | Yes when the author is gone and the owner received it | required |
| parentRef | ref | The session it was branched from | may be null |
| title | text | | may be null |
| position | number | Order in the sessions list, largest first | required |
| messages | list | In order. Each: role (`Person` or `Agent`), text, steps (each an action in words and an outcome `Done`, `Failed` or `Unknown`; tool inputs and outputs are not carried), attachments (how many the person added; files not carried), createdAt. Consecutive Agent messages of one turn are joined | required |
| createdAt, updatedAt | time | | may be null |

### 29a.5.21 deployments.jsonl

Optional file (left out with `--no-deployments`). The newest 50 per service, oldest first.

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| ref, serviceRef | ref | | required |
| status | label | 29a.6.14 | required |
| title | text | Commit subject or what started it | required |
| commit | text | Commit hash | may be null |
| trigger | label | 29a.6.15 | may be null |
| error | text | | may be null |
| createdAt | time | | required |
| startedAt, finishedAt | time | | may be null |
| log | text | The end of the log, up to 1 MiB | required |
| logTruncated | yes/no | The log was longer | required |
| logMissing | yes/no | The log couldn't be read (the text is then empty) | required |

### 29a.5.22 install.json

One JSON object.

| Field | Type | Meaning | Presence |
| --- | --- | --- | --- |
| sourceVersion | text | | required |
| platformDomain | text | | may be null |
| platformDomainSharedEdge | yes/no | The platform domain is served through a shared edge | required |
| consoleHostname | text | | may be null |
| consoleHttps | yes/no | | required |
| letsEncryptEmail | text | | may be null |
| managedZone | object | domain, zoneRef (may be null), adminEmail (may be null) | may be null |
| managedDnsEnabled | yes/no | | required |
| publicIp | text | | may be null |
| dataMode | label | 29a.6.16 | may be null |
| registrationMode | label | 29a.6.16 | required |
| adminEmail | text | | may be null |
| ownerClaimedAt | time | When the first owner was created | may be null |
| monitoring | object | refreshSeconds, retentionDays, cron (each may be null), thresholds: cpuPercent, memoryPercent | required |
| analytics.requestLogging | yes/no | The host router keeps a request log; null when unknown | may be null |
| hostDailyCleanup | yes/no | | required |
| logCleanupCron | text | | may be null |

## 29a.6 Labels

### 29a.6.1 Agent policies

Exactly the policy names of [19-agent.md](19-agent.md) section 19.9, without the explanations in brackets: Create projects · Rename and describe projects · Delete projects without production · Create and configure services · Import from Git · Assign domains · Deploy and run services · Create and run tasks · Add SSH keys · Read SSH keys · Rename SSH keys · Delete SSH keys · Add and set up servers · Remove servers · Ask for the OpenRouter key in chat · Change production environments.

Every workspace carries all sixteen. A 0.1.x permission without a 1.0 policy isn't carried; when it was on, the notes say so.

### 29a.6.2 Capabilities

Exactly the 1.0 catalog of [04-identity-and-access.md](04-identity-and-access.md) section 4.7: Create projects · Delete projects · Create environments · Delete environments · Create services · Delete services · Connect their own Git accounts · Use the workspace's SSH keys · Add and remove SSH keys · Add and remove servers · Back up to the workspace's destinations · Add and remove backup destinations · Manage notification channels · Manage certificates · Manage DNS · See Traefik files.

The capabilities 1.0 dropped ("Manage container registries", "See the Docker tab", "Use the API and CLI") never appear in a record; a membership or policy that had them gets a note naming them.

### 29a.6.3 to 29a.6.16 Other choices

| Section | Field | Labels |
| --- | --- | --- |
| 29a.6.3 | Role | Owner · Admin · Member |
| 29a.6.4 | Service kind (also database types) | Application · Compose · Postgres · MySQL · MariaDB · MongoDB · Redis · libSQL |
| 29a.6.5 | Source type | GitHub · GitLab · Gitea · Bitbucket · Git URL · Container image · Uploaded archive · Pasted Compose file |
| 29a.6.6 | Mount type | Volume · Host folder · File |
| 29a.6.7 | Git provider kind | GitHub · GitLab · Gitea · Bitbucket |
| 29a.6.8 | Builder | Dockerfile · Nixpacks · Railpack · Heroku buildpacks · Paketo buildpacks · Static site · Automatic |
| 29a.6.9 | Hostname source (environment defaults use Managed DNS zone, Platform domain or None) | Platform domain · Server wildcard · Managed DNS zone · Own domain |
| 29a.6.10 | Certificate | Let's Encrypt · Uploaded · None |
| 29a.6.12 | Channel event | Deployment succeeded · Deployment failed · Database backup · Volume backup · Nearzero restarted · Nearzero backup · Server cleanup · Server over its alert threshold |
| 29a.6.13 | Other sign-ins | GitHub · GitLab · Google · Microsoft · Single sign-on |
| 29a.6.14 | Deployment status | Running · Succeeded · Failed · Cancelled |
| 29a.6.15 | Deployment trigger | Manual · Push · Tag · Agent · Redeploy · Preview · Rollback (other text may appear for very old deployments) |
| 29a.6.16 | Data mode / registration mode | Bundled database · External database / Invitations only · Open sign-up |

### 29a.6.11 Channel kinds and their settings

| Kind | fields | secrets |
| --- | --- | --- |
| Slack | Channel | Webhook URL |
| Telegram | Chat ID, Topic thread ID | Bot token |
| Discord | Rich formatting | Webhook URL |
| Email (SMTP) | SMTP server, SMTP port, Username, From, To (list) | Password |
| Email (Resend) | From, To (list) | API key |
| Gotify | Server URL, Priority, Rich formatting | App token |
| ntfy | Server URL, Topic, Priority | Access token |
| Mattermost | Channel, Username | Webhook URL |
| Pushover | Priority, Retry seconds, Expire seconds | User key, API token |
| Webhook | URL | Headers (header name to value) |
| Lark | (none) | Webhook URL |
| Microsoft Teams | (none) | Webhook URL |

A setting with no value is null.

## 29a.7 Not in format 1

Swarm settings (health checks, placement, update order and the like), registries used to push build images, pull-request preview settings, per-app basic-auth users, redirect rules and file patches, router middlewares and custom certificate resolvers, project tags, single sign-on providers, API keys, uploaded source archives, and backups of the control plane itself. Each one present on the install appears in the notes with a reason, so the dry run (29.5) can list it.

## 29a.9 Additions after the first import build (format version stays 1; all optional)

These fields let 1.0 move an install in place. Exporters write them; importers must tolerate their absence.

| Where | Field | Meaning |
| --- | --- | --- |
| manifest | `installId` | A random id generated once per 0.1.x install and kept across exports, so refs from two different installs never mix. Importers refuse a bundle whose `installId` differs from an earlier import into the same 1.0 install. |
| `install.json` | `controlPlane` | A list of what runs the 0.1.x control plane on the host, each entry `{kind, name}` with kind `container`, `swarm-service` or `compose-project`. The move stops exactly these. |
| `install.json` | `controlPlaneDetails` | The Compose project, folder and ports the 0.1.x control plane uses, for the dry-run report and rollback. It also holds `composeFiles`: the Compose file names in that folder, in the order Compose reads them. 0.1.x doesn't use Compose's default file names. And `envFile`: the file the project reads its variables from. It is a name in that folder or, when 0.1.x keeps it elsewhere (as it does for a service's stack), an absolute path on that server. 1.0 accepts an absolute `envFile` only when it is a regular file under the 0.1.x install's data folders, and never writes to it. On every server those folders are `/opt/nearzero` and `/etc/nearzero`, where 0.1.x keeps app, Compose and secret files on remote servers. On the Nearzero host they also include the control plane's folder and the folders of the volumes in `controlPlaneVolumes`. When both are given, rollback passes each file with `-f`, in order, and the env file with `--env-file`. |
| `install.json` | `controlPlaneVolumes` | The names of the volumes holding the 0.1.x control plane's data, so rollback can bring it back. |
| `install.json` | `legacyWebhookPaths` | The URL paths 0.1.x used for deploy webhooks and for the GitHub App's webhook, with the token placeholder written as `{token}`. 1.0 keeps answering these paths for moved services. |
| `servers[]` | `legacy` | The 0.1.x router on that server: its container or service name, so the move can stop it before 1.0's router takes ports 80 and 443. |
| `services[]` | `legacy` | What runs the service today: kind (`swarm-service`, `swarm-stack`, `container`, `compose-project`) and name. For `compose-project` it also has `folder`, `composeFiles` and `envFile`, read from Compose's own labels on the project's containers. These have the same meaning as in `controlPlaneDetails`, so 1.0 can start 0.1.x's copy again from its own files. |
| `services[]` (applications) | `servicePort` | The container port the app listens on. Without it, importers use the first hostname's port, else 3000. |
| `services[]` mounts | `containerPath` | Every mount names its path inside the container in this field. A file mount carries `containerPath` and `content`; it has no separate file path. |
| `services[]` (Redis) `settings` | `persistence` | What the 0.1.x Redis writes to its volume: `Snapshot`, `Append-only` or `Both`, read from how it is started. When missing, importers assume `Snapshot`. 29.5 says how 1.0 loads it. |

The final 0.1.x release that carries `nearzero export` is **0.1.80**; the exporter refuses on any other version and the 1.0 installer asks older installs to update to it. Both sides read the number from one constant.

### 29a.9.1 Old console addresses

So bookmarks and links in old notification messages keep working, these records may carry `legacyConsolePath`: the path (without host) at which 0.1.x showed that object.

| Record | `legacyConsolePath` example shape |
| --- | --- |
| projects | the project's page |
| environments | the environment's page |
| services | the service's page (any kind) |
| deployments | the deployment's detail link |
| servers | the servers page entry for it, if any |

1.0 stores these and redirects a request for any of them (with or without the old workspace prefix) to the object's 1.0 page. Fixed 0.1.x pages with no object (the old settings pages, sign-in, registration, invitation acceptance, the old home and getting-started pages) redirect by the table in [18-settings.md](18-settings.md) 18.1 and to the matching 1.0 pages.
