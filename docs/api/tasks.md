# Tasks (M10)

Scheduled and on-demand scripts in one place each: a service's container, a server, or the Nearzero host. Implements spec 12 (all), 20.12 (the functions the Agent calls), 22.2 (host tasks for instance administrators), 22.3 (the task rows), 23.1 ("long work outlives requests", the stdin rule), 23.2 (one scheduler) and 25 D1 (the runner carries runs out).

Conventions (errors, cookies, `Cache-Control: no-store`, ids, `"host"`) are those of [identity.md](identity.md) and [projects.md](projects.md). Request schemas are in `packages/shared/src/tasks.ts`; the words and pure rules (presets, the schedule in words, script checks, the shell's syntax error read as a line, zones and the next run) are in `packages/shared/src/task-rules.ts`, also exported from `@nearzero/shared/browser`.

## Who may do what (spec 12.4)

| Place | Create, edit, run, stop, delete, see |
| --- | --- |
| A service's container (apps and Compose stacks; not databases) | Task rights on the service (`service.tasks`; members: their own services) |
| A server | Owners and admins, and people with "Add and remove servers" on that server (`server.tasks`) |
| The Nearzero host | Instance administrators only: 403 "Only instance administrators can manage host-level tasks." |

A task whose place the person can't use is "not found" (404), like one that doesn't exist. Host tasks belong to no workspace (`workspace_id` null) but to the instance administrator who made them (`owner_id`, migration 0820): they are listed only for their owner, in every workspace, and anyone else who reads, edits, runs, stops or deletes one gets 403 "You can only manage your own host-level schedules." A host task is deleted with its owner's account. One moved from 0.1.x keeps its 0.1.x owner (`ownerRef`, when the export carries it and that person moved), else it goes to the install's owner, who runs the move.

## Endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /tasks?search=&status=all\|enabled\|disabled&place=all\|services\|servers\|host&sort=name\|schedule\|timezone\|status\|created&order=asc\|desc&page=&pageSize=10\|25\|50\|100&serviceId=&serverId=` | | `{ tasks: TaskView[], total, page, pageSize, can: { create } }` |
| `GET /tasks/places` | | `{ places: { services: { id, name, kind, projectName, environmentName, label, innerServices }[], servers: { id, name }[], host } }`: only places the person may use |
| `POST /tasks/check` | `{ place, serviceId?, innerService?, serverId?, taskId?, shell, cron, timeZone, script }` | `{ check: TaskCheck }` (nothing is saved or run) |
| `POST /tasks` | `{ name, description?, place, serviceId?, innerService?, serverId?, shell?, cron, timeZone?, script, enabled?, force? }` | 201 `{ saved: true, task, check, message: "Task created" }`; 200 `{ saved: false, check }` when the checks warned and `force` is false ("Save anyway" resends with `force: true`); 400 with `fields.script` / `fields.cron` / `fields.timeZone` when they found errors |
| `GET /tasks/:id` | | `{ task }` with `script` |
| `GET /tasks/:id/review` | | `{ task (script cut to 6,000 characters), scriptTruncated, runs (last 10) }`: the Agent's review (20.12) |
| `PATCH /tasks/:id` | any of `name, description, shell, cron, timeZone, script, enabled, force` | as `POST /tasks` with `message: "Task updated"`; `place` (or any place field) is refused: "Where a task runs can't be changed after it's created. Create a new task instead." The shell reads the script again only when the script or shell changed |
| `DELETE /tasks/:id` | | `{ deleted: true, message: "Task deleted" }`; a running run is stopped |
| `POST /tasks/:id/run` | | 202 `{ run, message: "Task started" }`; 409 while a run of the task is going |
| `GET /tasks/:id/runs` | | `{ runs: TaskRunView[] }`, newest first, at most 100, without logs |
| `GET /task-runs/:runId` | | `{ run }` with `log`: the run's last 1,000 lines |
| `POST /task-runs/:runId/stop` | | `{ run, message: "Run stopped" }` for a queued or running run; 409 when it has ended |

```ts
type TaskView = {
  id; name; description; place: "container" | "server" | "host"; placeLabel: "Service" | "Server" | "Nearzero host";
  runsOn: { label; service: { id, name, projectId, projectName, environmentId, environmentName, innerService } | null; server: { id, name } | null };
  shell: "bash" | "sh"; cron; scheduleText; timeZone /* "UTC" when empty */; enabled; statusLabel: "Enabled" | "Disabled";
  nextRunAt: string | null; nextRunText /* "Thu, Nov 26, 00:00 (Asia/Kolkata)" */; lastRun: { id, status, statusLabel, at } | null;
  running; createdVia: "console" | "agent"; createdAt; updatedAt; script?;
};
type TaskCheck = {
  ok; errors: Note[]; warnings: Note[]; script /* as saved */; converted /* CRLF → LF */; shell; cron; scheduleText;
  timeZone; nextRunAt; nextRunText; syntax: "checked" | "unchecked" | "skipped";
};
type Note = { field: "script" | "cron" | "timeZone"; line: number | null; message: string };
type TaskRunView = {
  id; taskId; status: "queued" | "running" | "succeeded" | "failed" | "stopped" | "skipped"; statusLabel; trigger: "schedule" | "manual" | "agent";
  dueAt; startedAt; finishedAt; durationMs; exitCode; error; open; logLines; logTruncated; log?;
};
```

## The checks (spec 12.2, "Check and save")

- **No shell needed**: Windows line endings are converted (and saved converted); a null byte is refused with its line ("Line 3 contains a null byte…"); at most 64 KB; an empty script is refused; a `#!` for an interpreter that isn't a shell warns that the script still runs under the chosen shell.
- **The place's own shell** reads the script without running it: `<shell> -n -c <script>` in the service's running container, on the server, or on the host. Its complaint is read for the line: "The shell found a syntax error on line 3: …". When the shell can't be reached (the service isn't running, the runner is away) the check warns "Nearzero couldn't check the script's syntax: <reason>", which needs "Save anyway".
- **Schedule**: 5 fields (`parseCron`, shared with backups), a time zone that is an IANA name or UTC (`"Mars/Base" isn't a time zone. …`), and the next run in that zone.
- **Shell**: bash or sh in containers; bash on servers and the host.
- **Quotes**: the script reaches the shell as one argument (`<shell> -c <script>`, through Docker exec or the runner's own process start), never through another shell, so the single-quote rule of 12.2 doesn't apply.

## Runs (spec 12.3, 23.1, 23.2)

- **The scheduler** is one job chain (`tasks.tick`) on the control plane's queue: it claims due tasks with `FOR UPDATE SKIP LOCKED`, moves `next_run_at` forward and records the run in the same transaction (`(task_id, due_at)` is unique), then books the next tick at the next due time or within a minute. A due time that passed while Nearzero was stopped (before this control plane started its schedules) is skipped: the task next runs at its next scheduled time, and nothing runs at start just because a time was missed. Backup schedules follow the same rule. A run that was already going when Nearzero stopped is followed again or reported as before.
- **Overlap**: one open run per task, queued or running (a unique index). A run is `queued` from when it is due (or Run was pressed) until a task lane takes its job; then it is `running`, with `started_at` set to that moment, so its duration leaves out the wait (C1-09). A schedule that comes due while a run is going records a run with status `skipped` and the error "Skipped: the previous run was still going when this one was due."; while the run before it is still queued, "Skipped: the previous run was still waiting to start when this one was due."; Run answers 409 either way.
- **The run** is the `tasks.run` job (one attempt): it finds the service's running container (Compose: the inner service's), sends `task.run` to the place's runner and writes the output to the run's row about once a second, keeping the last 1,000 lines (at most 256 KB). Exit 0 is Succeeded; anything else Failed ("The script exited with code 3."); a run longer than 6 hours is stopped and Failed. If the control plane stops mid-run, the run ends Failed: "Nearzero restarted while this run was in progress, so it was stopped. Run it again." (never run twice).
- **Stop** marks the run, aborts it at once when this process carries it, and also sends `task.stop`. On a server the shell runs in its own process group, so TERM (then KILL after 5 seconds) reaches what it started; in a container every process of the run carries `NEARZERO_TASK_RUN=<run id>` and is signalled by that; on the host the helper container is killed.
- Each task keeps its newest 100 runs.

## Runner commands (`packages/shared/src/runner-tasks.ts`)

| Kind | Params | Answer |
| --- | --- | --- |
| `task.check` | `{ place: "container" \| "server", container?, shell, script }` | `{ ok, exitCode, output }` (output ≤ 8 KB) |
| `task.run` (streams) | `{ runId, place, container?, shell, script, timeoutSeconds }` | `{ exitCode, stopped, timedOut }` |
| `task.stop` | `{ runId, place, container? }` | `{ stopped }` |

Standard input is always closed. On the Nearzero host (the runner runs in a container) "server" means the host itself: a short-lived privileged helper container from the runner's own image enters PID 1's namespaces with `nsenter` and runs the shell there; it is removed when the run ends.

## For the Agent (spec 20.12)

`apps/control/src/tasks/area.ts` exports the functions the routes use, taking the asking person's `WorkspaceActor`: `listTasks`, `getTask`, `reviewTask`, `placeChoices`, `checkTaskRequest`, `createTask(…, { via: "agent" })`, `updateTask`, `deleteTask`, `runTaskNow(…, { trigger: "agent" })`, `stopTaskRun`, `taskRuns`, `taskRun`. The Agent applies its own policies on top ("Create and run tasks", and "production" when `resolvePlace` reports `service.production`); a task it creates shows on the Tasks page with the same fields and `createdVia: "agent"`.

## Code map

`apps/control/src/tasks/`: `tables.ts`, `places.ts` (places and rights), `checks.ts`, `area.ts`, `runs.ts` (records, log, `tasks.run`), `scheduler.ts` (`tasks.tick`), `routes.ts`. Migration 0500. `runner/src/tasks/`: `handlers.ts`, `process.ts`. Console: `src/pages/[workspace]/dashboard/tasks/index.astro`, `src/components/tasks/TaskDialogs.astro`, `src/client/tasks.ts`. Tests: `packages/shared/test/tasks.test.ts`, `runner/test/tasks.test.ts`, `apps/control/test/tasks.test.ts`, `apps/console/e2e/m10.e2e.ts`, `e2e/m10/m10.e2e.ts`.
