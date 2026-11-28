# 12. Tasks

A **task** runs a script on a schedule (cron), or on demand, in one place: inside a service's container, on a server, or on the Nearzero host.

Today the Tasks page shows only Nearzero-host tasks to instance administrators, has no place picker and does not check scripts; service and server tasks can only be made through the Agent and never appear on the page. 1.0 makes the page show every task the person can reach, with the same form and checks as the Agent.

## 12.1 List

Sidebar → **Tasks** (anyone who can see at least one task place: members for their services, owners and admins for their servers, instance administrators for the host).
- Title with **Add task** beside it; search "Search by name, schedule, time zone..."; filters: Status (All, Enabled, Disabled) and Place (All, Services, Servers, Nearzero host); page size 10, 25, 50, 100.
- Columns: Name, Runs on (service with project/environment, server, or "Nearzero host"), Schedule (the cron expression, with its meaning in words on hover, per 21.10), Time zone (UTC when empty), Next run, Last run (status and time, or "Never"), Status (Enabled/Disabled). Sortable by name, schedule, time zone, status, created.
- Row actions: **History**, **Run**, **Edit**, **Delete** (`Delete "<name>"?`).
- Empty: "No tasks found / Create your first scheduled task to automate workflows."

## 12.2 Create and edit

Dialog "Add task":

| Field | Rules |
| --- | --- |
| Name | Required, up to 100 characters |
| Description | Optional, up to 500 |
| Runs on | One of: a service's container (an app, or a Compose inner service when there are several), a server, the Nearzero host. Only places the person may use are offered. Fixed after creation. |
| Shell | For containers: bash or sh. Servers and the host: bash. |
| Schedule | Presets (Every minute, Every 15 minutes, Every hour, Every day at midnight, Every weekday at midnight, Every Sunday at midnight, Every month on the 1st at midnight) or a 5-field cron (syntax below) |
| Time zone | An IANA name; default UTC; the form shows the next run in that zone |
| Script | Required; for containers a command, for servers and the host a script |
| Enabled | Default on |

**Checks** before saving ("Check and save"):
- The script is syntax-checked by the shell without running it; Windows line endings are converted; null bytes are refused; at most 64 KB.
- A shebang for a non-shell interpreter gets a warning that the script still runs under the chosen shell.
- A container task's command of two or more lines (a line continued with "\" counts once; comments and blank lines don't count) gets a warning, unless it turns on errexit itself (`set -e`): "It runs as one shell command; lines run one after another and the task fails only if the last one does. Join them with && to stop at the first failure." (31c G3-15). Server and host scripts don't get it.
- The cron must have 5 valid fields and the time zone must exist; the next run is computed and shown.
- **Cron syntax** (the same for tasks and backup schedules, 31 "Cron syntax", 31c G3-14): five fields, minute (0–59), hour (0–23), day of month (1–31), month (1–12 or JAN–DEC) and day of week (0–7, where 0 and 7 are Sunday, or SUN–SAT). Each field takes `*`, a value, a range `a-b`, a step `*/n` or `a-b/n`, and comma lists of these. The day fields also take the forms 0.1.x ran:
  - `?` in either day field means any day, the same as `*`;
  - `L` in the day of month is the month's last day (`0 0 L * *`), also in a list (`1,L`);
  - `n#k` in the day of week is the k-th weekday n of the month, k from 1 to 5 (`0 9 * * 1#1`, the first Monday; names work too, `MON#1`);
  - `nL` in the day of week is the month's last weekday n (`0 9 * * 5L`, the last Friday).
  When both day fields are restricted, a day matching either one runs, as in every cron. Anything else (`W`, `L` alone in the day of week, `L-3`, a sixth field) is refused with a message naming the part. Schedules moved from 0.1.x that use these forms keep their rhythm. In words: "Every month on the last day at 00:00", "Every month on the first Monday at 09:00", "Every month on the last Friday at 09:00" (backup schedules: "On the last day of each month at 03:00").
- Warnings change the button to "Save anyway"; errors block saving and name the line.

Toasts: "Task created", "Task updated", "Task deleted". Tasks on production services also need production rights when created through the Agent.

## 12.3 Running and history

- **Run** starts the task in the background and opens the side panel ("Run history", task name, Refresh, Close); toast "Task started".
- Each run: status (Queued, Running, Succeeded, Failed, Stopped, Skipped), start time, age, duration. A run is "Queued" ("waiting to start") until a task lane takes it, and counts as running only from then: its start time is when it really started, and its duration leaves out the wait (31c C1-09). Task runs have job lanes of their own, so a run due now starts within a minute however many backups, setups or deletes are going (23.2). A run is stopped after 6 hours. Stop ends the whole process tree the run started. Expanding shows its log (last 1,000 lines). The panel updates every few seconds while a run is active.
- **Stop** on a queued or running run ends it ("Run stopped"); the run ends as "Stopped", and a queued one never starts.
- Empty: "No runs yet. Use Run to start this task now."
- A scheduled run that is still going when the next is due is skipped, not doubled, and the skip is recorded as a "Skipped" run: "Skipped: the previous run was still going when this one was due." When the run before it is still queued, the skip says "Skipped: the previous run was still waiting to start when this one was due."
- Each task keeps its last 100 runs.

## 12.4 Permissions

| Place | Who may create, edit, run, delete |
| --- | --- |
| A service's container | People with task rights on the service (members by default for their services) |
| A server | Owners and admins, and people with manage rights on that server |
| The Nearzero host | Instance administrators only ("Only instance administrators can manage host-level tasks.") |

**Acceptance**
- A task created by the Agent appears on the Tasks page with the same fields.
- A script with a syntax error on line 3 is refused with "line 3".
- A task scheduled every minute in "Asia/Kolkata" shows the correct next run and runs on time.
