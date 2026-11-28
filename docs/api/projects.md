# Projects, environments, services and variables API (M3b)

The control plane's endpoints for projects, environments, services as records (all eight kinds), copies across environments, variables and delete plans. Implements spec 02, 05 (all), 06 6.1 (app names), 07 7.1 (Compose records), 08 8.1 (database fields and passwords), 22.3 and 22.4 (for these objects) and 23.1 ("Teardown is complete", as an interface).

Everything is JSON under `/api/v1`, acts on the session's **active workspace**, and goes through the permission module (`apps/control/src/access/`). Request schemas and the editor rules live in `packages/shared/src/projects.ts` and `packages/shared/src/variables.ts`; import them from `@nearzero/shared` so forms use the same words.

## Conventions

The error shape, codes and cookies are those of [identity.md](identity.md). Codes used here:

| Code | Status | Meaning here |
| --- | --- | --- |
| `invalid_request` | 400 | A field is wrong; `fields` names it. Variables errors use `lines.N` (text mode) or `rows.N` (form mode, 1-based); create-time variable rows use `variables.N` (0-based). A typed confirmation that doesn't match uses `fields.confirm`. |
| `unauthenticated` | 401 | No live session |
| `forbidden` | 403 | The object is visible but the action isn't allowed; the message names the capability (`it needs the "Create services" permission`) or the rule (`Only Nearzero administrators can use the Nearzero host.`) |
| `not_found` | 404 | Doesn't exist, is in another workspace, or the person can't see it. These look the same on purpose (spec 22.4 rules 1 and 3), for owners too. |
| `conflict` | 409 | The current state refuses it: duplicate names, a non-empty environment, deploying services, a stale delete plan, a delete already running, a newer saved version of variables (also when two first saves of the same set race: one saves, the other gets this), a workspace with projects |

**Ids** are lowercase UUIDs. Anything else is answered as not found. The Nearzero host is the server id `"host"`.

**Who may do what** (owners and admins: everything in their workspace; members: what is listed):

| Action | Member needs |
| --- | --- |
| See a project, environment, service | it in their scope (policy or direct access) |
| Create projects | "Create projects" |
| Rename or describe a project | "Create projects" and the project in scope (not a row of 22.3; see Spec questions) |
| Delete a project | "Delete projects" and the project in scope; every service in it in scope ("No access" otherwise) |
| Create environments; rename or describe one | "Create environments" (project, resp. environment, in scope) |
| Delete an environment | "Delete environments" |
| Create services; change a service's settings | "Create services" |
| Delete services | "Delete services" |
| See the names of shared variables | the environment in scope |
| See the values of shared variables, and edit them | the whole environment in scope: all its services, not only some (an environment ticked only as the parent of a granted service doesn't count), since its shared values reach every service in it (decision on B1-33) |
| Read and edit a service's variables; show a database password | the service in scope |
| Put a service on the Nearzero host | instance administrator (spec 22.2, G3) |
| Put a service on a server | the server in scope (servers register with the permission module in M6) |

Something a member creates (a project, a service and its copies) is added to their direct access when their scope wouldn't otherwise reach it, so they can open what they just made.

**Shapes**

```ts
type ServiceKind = "application" | "compose" | "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" | "libsql";
type ServiceStatus = "idle" | "deploying" | "running" | "stopped" | "failed";   // idle: never deployed

interface EnvironmentBrief { id: string; name: string; isDefault: boolean; isProduction: boolean }

interface ProjectView {
  id: string; name: string; description: string; createdAt: string; updatedAt: string;
  serviceCount: number;             // across all environments, only services the viewer can see
  environments: EnvironmentBrief[]; // the ones the viewer can open, oldest first
  openEnvironmentId: string | null; // "development", else the default, else the first; null: "No environments available"
  can: { update: boolean; delete: boolean; createEnvironment: boolean };
}

interface EnvironmentView {
  id: string; projectId: string; name: string; description: string;
  isDefault: boolean; isProduction: boolean;   // production: named exactly "production"
  serviceCount: number; createdAt: string; updatedAt: string;
  can: { rename: boolean; delete: boolean; createService: boolean; sharedVariables: boolean };
}

interface ServiceView {
  id: string; projectId: string; environmentId: string;
  kind: ServiceKind; kindLabel: string; name: string;
  appName: string;               // internal name: chosen part + "-" + 6 random characters
  description: string; status: ServiceStatus;
  serverId: string; onHost: boolean;   // serverId "host" for the Nearzero host
  settings: object;              // only what the kind lists as public (below); never secrets
  publicPort: number | null; publicPortNote: string | null;   // databases
  copyGroupId: string | null;    // shared by a service's copies; null for services from before linking
  deleting: boolean;
  createdAt: string; updatedAt: string;
  can: { configure: boolean; delete: boolean; deploy: boolean; variables: boolean };
}
```

Public settings per kind (`apps/control/src/services/kinds/`):

| Kind | `settings` |
| --- | --- |
| application | `source` (`null` or `{ type: "image", image }`; Git sources arrive later under the same key), `build` (`{ type: "automatic" }`), `servicePort` (default 3000) |
| compose | `format` (`"compose"` or `"stack"`, fixed), `source` (`null` or `{ type: "raw", composeFile }`) |
| postgres, mysql, mariadb | `image`, `databaseName`, `user`, `port`, `dataVolume` |
| mongodb | `image`, `user`, `port`, `dataVolume`, `replicaSet` |
| redis | `image`, `port`, `dataVolume` |
| libsql | `image`, `user`, `port`, `dataVolume`, `nodeRole`, `primaryUrl`, `namespaces` |

Defaults (spec 8.1): images `postgres:18`, `mysql:8`, `mariadb:11`, `mongo:8`, `redis:8`, `ghcr.io/tursodatabase/libsql-server:v0.24.32`; database names `postgres` / `app` / `mariadb` (MySQL's own `mysql` schema is a system schema); users `postgres` / `mysql` / `mariadb` / `mongo` / `libsql`. Passwords (and MySQL/MariaDB root passwords) are generated as 24 letters and digits when left empty, sealed with the install key and never part of any service answer. The data volume is `<appName>-data`.

## Projects (spec 5.1)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /projects?search=&sort=` | `sort`: `name-asc`, `name-desc`, `newest` (default), `oldest`, `most-services`, `least-services`. `search`: case-insensitive over name and description. Both done on the server. | `{ projects: ProjectView[], total, matching, search, sort, can: { create } }`: "N total" is `total`, "N of M total" is `matching` of `total` |
| `POST /projects` | `{ name, description? }` | 201 `{ project: ProjectView, environmentId, message: "Project created" }`; `environmentId` is the new "development" environment to open. Empty name: 400 "Project name is required". Names need not be unique; at most 100 characters, description 1,000. |
| `GET /projects/:projectId` | | `{ project: ProjectView }` |
| `PATCH /projects/:projectId` | `{ name?, description? }` | `{ project, message: "Project updated" }` |
| `GET /projects/:projectId/delete-plan` | | `{ plan: DeletePlan }` (below); needs project delete rights |
| `POST /projects/:projectId/delete` | `{ fingerprint, confirm }`: the plan's fingerprint and the project name as typed | 202 `{ run: DeleteRunView }`. 400 when `confirm` doesn't match ("Type the project name, X, to confirm."); 409 when the project changed since the plan ("…Review the new plan and try again."; reload the plan) or "X is already being deleted."; 403 with the blockers when anything can't be deleted |
| `GET /projects/:projectId/delete-run` | | `{ run: DeleteRunView \| null }`: the latest whole-project delete, for "X is already being deleted." and its results after the project is gone |
| `GET /delete-runs/:runId` | | `{ run: DeleteRunView }` (any delete; for its requester, owners and admins, and people who can see its project) |

```ts
interface DeletePlan {
  scope: "project" | "services";
  project: { id: string; name: string };
  services: {
    id: string | null; name: string | null; kind: ServiceKind | null; kindLabel: string | null; // null: "No access"
    environment: { id: string; name: string } | null;   // null when the viewer can't see it
    serverId: string | null; production: boolean; access: boolean; status: ServiceStatus | null;
    deploying: boolean; willStop: boolean; beingDeleted: boolean;
  }[];
  counts: { services; noAccess; production; deploying; running; beingDeleted };
  canDelete: boolean;           // false: nothing will be deleted; hide the confirm field
  blockers: string[];           // "You can't delete N services in this list, so nothing will be deleted. Ask an owner or admin.", deploying, already being deleted
  warnings: string[];           // "N services run in production.", "N services are running and will be stopped first."
  summary: string;              // "Delete X and remove its N services from their servers? …" / "Delete X? It has no services."
  confirmLabel: string;         // "Delete project and N services"
  confirmText: string;          // what to type: the project name
  fingerprint: string;
  inProgress: { runId: string; message: string } | null;   // "X is already being deleted."
}

interface DeleteRunView {
  id: string; scope: "project" | "services";
  state: "running" | "succeeded" | "failed";
  tracked: boolean;             // false while running: the platform stopped carrying it out; offer to start again
  project: { id: string; name: string; kept: boolean };   // kept: "The project was kept"
  items: { serviceId: string | null; name: string | null; kind: ServiceKind | null; environmentName: string;
           production: boolean; state: "waiting" | "removing" | "removed" | "not_removed"; reason: string | null }[];
  counts: { waiting; removing; removed; notRemoved };
  message: string;  // "You can close this; the delete keeps going." / "X was deleted." / "The project was kept. …" /
                    // "Service removed" / "N services removed" / "Service removed, but not everywhere" / "Nothing was removed."
  createdAt: string; finishedAt: string | null;
}
```

A delete runs as the background job `deletion.remove-services`: each service is torn down from its server, then its records (and variables) are deleted; the project goes only when every service went. If any fails, the project is kept with each reason, and a new plan plus delete retries the rest. A run whose job is gone or gave up shows `tracked: false`; starting the delete again closes it.

## Environments (spec 5.3)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /projects/:projectId/environments` | | `{ environments: EnvironmentView[], can: { create } }` |
| `POST /projects/:projectId/environments` | `{ name, description?, variables?: { from: environmentId \| null, values?: boolean } }` | 201 `{ environment, message: "Created <name>", copiedServices, notCopied: { name, reason }[] }` |
| `GET /environments/:environmentId` | | `{ environment: EnvironmentView & { project: { id, name } } }` |
| `PATCH /environments/:environmentId` | `{ name?, description? }` | `{ environment }` |
| `DELETE /environments/:environmentId` | | `{ deleted: true }`; 409 "Delete or move its N services first." or for the default environment |

Names are trimmed and lowercased, spaces and underscores become dashes, repeated dashes collapse; at most 32 letters, numbers and dashes ("Use letters, numbers and dashes, like staging or qa-2."). "prod" and "prd" are refused (`Name it "production" instead…`). Duplicates: 409 `This project already has an environment called "x".` The live hint is `environmentNameHint()` in shared.

Creating an environment copies **every** service of the project into it: idle, never deployed, each with its own app name, volume, passwords and public port, and its own variables with **names only**. `variables.from` copies the source's shared variable names (empty values); with `values: true` the values too, secrets included, but only what the person can read themselves (the source's shared variables, and the own variables of source services they can see). A service's copy takes its settings from the source environment's copy, else the default environment's, else the oldest. Services from before linking are linked by name and kind on the way.

## Services (spec 5.2, 5.4, 6.1, 7.1, 8.1)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /environments/:environmentId/services` | | `{ services: ServiceView[], can: { create } }` |
| `POST /environments/:environmentId/services` | `{ kind, name, serverId, appName?, description?, settings?, variables?: { name, value }[] }`, settings per kind below | 201 `{ service, alsoAddedTo: { environmentId, environmentName, serviceId }[], notAddedTo: { environmentId, environmentName, reason }[], message, notes }` |
| `GET /services/:serviceId` | | `{ service: ServiceView & { environment: { id, name, isProduction }, project: { id, name }, copies: { id, environmentId, environmentName, status }[] } }`; copies are the ones the viewer can open |
| `PATCH /services/:serviceId` | `{ description?, settings? }`: application `{ image?, servicePort? }`, compose `{ composeFile? }`, databases `{ image? }` | `{ service, notes }`; a database image change notes that it applies on the next deploy and may need a manual data upgrade |
| `POST /services/:serviceId/credentials/reveal` | | `{ credentials: { user, password, rootPassword, databaseName } }`, databases only ("Show password") |
| `GET /services/:serviceId/delete-plan` | | `{ plan: { service, canDelete, blockers, copies: { id, environmentId, environmentName, label: "env (name)", production, canDelete, deploying }[], copiesHint, confirmText } }` |
| `POST /services/:serviceId/delete` | `{ confirm, alsoDeleteCopyIds?: string[] }`: the service name as typed; ticked copies (none by default) | 202 `{ run: DeleteRunView }` |
| `POST /environments/:environmentId/services/delete-plan` | `{ serviceIds }` | `{ plan: DeletePlan }` with `scope: "services"`, `confirmLabel: "Delete N services"` |
| `POST /environments/:environmentId/services/delete` | `{ serviceIds, fingerprint, confirm }`: the project name as typed | 202 `{ run: DeleteRunView }` |

Create settings (`serviceSettingsInputSchemas`): application `{ image?, servicePort? }`; compose `{ format?, composeFile? }`; postgres `{ databaseName?, user?, password?, image? }`; mysql and mariadb the same plus `rootPassword?`; mongodb `{ user?, password?, image?, replicaSet? }`; redis `{ password?, image? }`; libsql `{ user?, password?, image?, nodeRole?, primaryUrl?, namespaces? }` (a replica needs `primaryUrl`). Empty strings mean "use the default" or "generate".

Rules:
- **Names** are unique per environment, case-insensitive: 409 `This environment already has a service called "x". Pick another name.`
- **App names** (6.1): lowercase letters, numbers and single dashes, starting with a letter and ending with a letter or number, at most 50; without one, it comes from the project's name and the service's. A dash and 6 random characters are added; every copy gets its own.
- **Copies** (5.4): the service is added to every other environment of the project where the person may create services, with the same name and settings, variable names only, its own app name, passwords and public port, no hostnames, never deployed. `message` is "Also added to staging and production, not deployed yet. Each environment has its own variables and URL." (null when there were none). Environments the person can see but not add to, or where the name is taken, are in `notAddedTo`. All of it is one transaction.
- **Public ports** (8.1): each database gets the lowest free port from 20000 to 29999 on its server (the host's range is shared by every workspace); a port counts as taken when another database has it or an app or a Compose file on that server publishes it over TCP (a pasted file as saved, a repository's as its last deploy or Preview read it), and an app can't publish a port a Compose file there publishes. With none free it is created private: `publicPort: null` and `publicPortNote` ("No free port between 20000 and 29999 on this server, so it was created private. Free a port, then make it public."), also in `notes`.
- **Typed passwords** may not contain `$ ! ' " \ /` or spaces, and are 8 to 128 characters.
- Applications are refused when a variable has a secret-looking name with a public prefix (NEXT_PUBLIC_, NUXT_PUBLIC_, REACT_APP_, VITE_, PUBLIC_).
- **Deleting** is refused while a service is deploying ("Wait for the deployment to finish before deleting this service."), for single and bulk deletes alike; a running service is stopped as part of its deletion.

## Variables (spec 5.5)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /environments/:environmentId/variables` | | `{ environment: { id, name, isProduction }, shared: MaskedVariables, notice, services: { id, name, kind, count }[], can: { edit }, message }`; `notice` on production: "This is production. Saved changes reach services when they next deploy." Anyone who can see the environment gets the names; without access to the whole environment `can.edit` is false and `message` says "You can see the names. Their values reach every service in this environment, so seeing and editing them needs access to all of it. Ask an owner or admin."; reveal and save then answer 403 "You can't read or edit this environment's shared variables: they reach every service in it, and your access covers only some of them. …" |
| `POST /environments/:environmentId/variables/reveal` | | `RevealedVariables` ("Show values") |
| `PUT /environments/:environmentId/variables` | `SaveVariables` | `{ message: "Variables saved", detail: "They reach the service on its next deploy.", variables: MaskedVariables }` |
| `GET /services/:serviceId/variables` | | `{ service, environment, own: MaskedVariables, shared: { variables: { name, empty, overridden }[], count } \| null, can: { edit, editShared } }`; `overridden` is "(its own wins)"; `shared` (names only) is null when the environment can't be seen; `editShared` needs the whole environment |
| `POST /services/:serviceId/variables/reveal` | | `RevealedVariables` |
| `PUT /services/:serviceId/variables` | `SaveVariables` | as for shared |

```ts
interface MaskedVariables {
  variables: { name: string; empty: boolean }[];    // never values
  count: number; sizeBytes: number; version: number;
  updatedAt: string | null; updatedBy: { id: string; name: string } | null;
  unreadable: string | null;   // saved with another install secret: names known, values lost
  warnings: { name: string; prefix: string; message: string }[];   // secret-looking names with a public prefix
}
interface RevealedVariables {
  text: string;                // exactly as saved
  rows: { name: string; value: string; line: number; above: string[] }[];   // above: comment and empty lines, exactly
  trailing: string[];
  formProblem: string | null;  // the form can't hold this text exactly: open it as text ("…so nothing is changed or lost.")
  version: number;
}
type SaveVariables =
  | { text: string; baseVersion?: number }                                     // text mode: stored byte for byte
  | { rows: { name: string; value?: string; keep?: boolean }[]; baseVersion?: number };   // form mode
```

- Text is stored sealed, exactly as sent: a round trip in text mode is byte for byte. Form saves keep comments and every unchanged line exactly; changed and new rows are written fresh; comments above a removed row stay above the next one. `keep: true` keeps a row's saved value without sending it.
- Blocking errors, each with its line (`checkEnvText`, `checkRows`): a line that isn't NAME=value; a name set twice ("X is set twice, on lines A and B. Keep one."); a value over several lines; a value with no name; an invalid name (a letter or `_`, then letters, digits, `_`, `.` or `-`); a value with all three quote characters; text after a closing quote; `export`. At most 256 KB per service and per environment.
- `baseVersion` older than the saved version: 409, so two editors never overwrite each other.
- Grammar: `NAME=value`, split at the first `=`, spaces around both ignored; a value wrapped in matching `"`, `'` or `` ` `` is the text between, literally (no escapes); otherwise the value is as written, `#` included.
- Editor helpers in shared: `parseEnv`, `formFromText`, `textFromRows`, `mergePaste` ("Added N variables and updated M from the paste.", "Left out lines …: not one-line NAME=value.", "Comments in the paste were left out."), `looksLikeEnvFile`, `publicSecretWarnings`, `blankValues`.

**At deploy** (for later milestones): `variablesForDeploy(db, secrets, serviceId, "runtime" | "build")` in `apps/control/src/variables/deploy.ts` calls the pure `resolveVariables` from shared: shared variables, then the service's own (its own win); `${{environment.NAME}}` is a shared variable and `${{NAME}}` the service's own; `${{project.NAME}}`, from 0.1.x, is the shared `NAME` (unless the service has a variable literally called `project.NAME`); an unknown reference in a service's own value fails with its name, a loop fails; inside a shared value a reference that can't be worked out stays exactly as written, as 0.1.x passed shared values on; a value may grow to 256 KB once its references are filled in and a service's variables to 1 MB in all, beyond which the deploy (and Compose Preview) fails naming the variable; builds get only names of letters, digits and `_`; Compose services never take `DOCKER_*`, `COMPOSE_*`, `PATH` or `HOME` from shared variables.

## For later milestones

- **Teardown** (`apps/control/src/deletion/teardown.ts`): `ServiceTeardown.remove(target, { stopFirst, removeVolumes, signal })` returns `{ removed: true }` or `{ removed: false, reason }`. It must be safe to repeat and never report "removed" while anything of the service is left running or routed. Since M3c the job catalog uses `runnerTeardown` (see [deploys.md](deploys.md), Teardown); `recordsOnlyTeardown` remains for tests.
- **Servers** register `server` objects with the permission module; service creation already resolves `serverId` through it. Add the `service.server_id` foreign key when the server table exists.
- **Settings**: Git sources, builders, ports and mounts extend the kind modules (`apps/control/src/services/kinds/`); each module lists what is public.
- **Workspace deletion** is refused while projects exist (`projectsBlockWorkspaceDeletion`, also enforced by the database).
