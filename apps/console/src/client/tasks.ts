import {
  deleteTaskTitle,
  describeTaskSchedule,
  nextTaskRun,
  parseCron,
  TASK_MESSAGES,
  TASK_SCHEDULE_PRESETS,
  type TaskRunStatus,
  timeZoneProblem,
  zonedTimeText,
} from "@nearzero/shared/browser";
import { localTime, RUN_PILLS, shortDuration } from "../lib/m10.ts";
import { relativeTime } from "../lib/time.ts";
import { asApiError, callApi, clearErrors, refreshPage, showErrors, showFormError } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * The Tasks page in the browser (spec 12): the Add/Edit dialog with "Check and save" (warnings
 * turn it into "Save anyway"; errors name the line), the next run shown in the task's zone as
 * the schedule is typed, Run (in the background, then the Run history panel opens), Delete, and
 * the panel itself, which follows active runs every few seconds and shows each run's log.
 */

interface TaskPlacesData {
  services: { id: string; label: string; kind: string; innerServices: string[] }[];
  servers: { id: string; name: string }[];
  host: boolean;
}

interface CheckNote {
  field: string;
  line: number | null;
  message: string;
}

interface TaskCheckView {
  ok: boolean;
  errors: CheckNote[];
  warnings: CheckNote[];
  nextRunText: string | null;
  converted: boolean;
}

interface RunView {
  id: string;
  status: TaskRunStatus;
  statusLabel: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  open: boolean;
  logLines: number;
  logTruncated: boolean;
  log?: string;
}

const POLL_MS = 3_000;

function q<T extends Element>(root: ParentNode | null | undefined, selector: string): T | null {
  return root?.querySelector<T>(selector) ?? null;
}

function form(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>("[data-task-form]");
}

function places(target: HTMLFormElement): TaskPlacesData {
  try {
    return JSON.parse(target.dataset.places ?? "{}") as TaskPlacesData;
  } catch {
    return { services: [], servers: [], host: false };
  }
}

function setValue(target: HTMLFormElement, name: string, value: string): void {
  const input = target.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[name="${CSS.escape(name)}"]`,
  );
  if (input) input.value = value;
}

function field<T extends HTMLElement = HTMLInputElement>(
  target: HTMLFormElement,
  name: string,
): T | null {
  return target.querySelector<T>(`[name="${CSS.escape(name)}"]`);
}

/** Shows the shell choice and the Compose service picker only where they apply. */
function syncPlace(target: HTMLFormElement): void {
  const key = field<HTMLSelectElement>(target, "placeKey")?.value ?? "";
  const shell = q<HTMLElement>(target, "[data-task-shell]");
  const isService = key.startsWith("service:");
  if (shell) shell.hidden = !isService;
  if (!isService) {
    const bash = target.querySelector<HTMLInputElement>('input[name="shell"][value="bash"]');
    if (bash) bash.checked = true;
  }
  const service = places(target).services.find((item) => `service:${item.id}` === key);
  const inner = q<HTMLElement>(target, "[data-task-inner]");
  const select = field<HTMLSelectElement>(target, "innerService");
  const choices = service?.innerServices ?? [];
  if (inner && select) {
    inner.hidden = choices.length < 2;
    const current = select.value;
    select.replaceChildren(
      ...choices.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        option.selected = name === current;
        return option;
      }),
    );
  }
}

/** The schedule in words and the next run in the task's zone, as the person types. */
function syncNext(target: HTMLFormElement): void {
  const cron = (field(target, "cron")?.value ?? "").trim();
  const zone = (field(target, "timeZone")?.value ?? "").trim() || "UTC";
  const slot = q<HTMLElement>(target, "[data-task-next]");
  const preset = q<HTMLSelectElement>(target, "[data-task-preset]");
  if (preset) {
    const match = TASK_SCHEDULE_PRESETS.find((item) => item.cron === cron.replace(/\s+/g, " "));
    preset.value = match ? match.cron : "";
  }
  if (!slot) return;
  const parsed = parseCron(cron);
  const zoneProblem = timeZoneProblem(zone);
  if (!parsed.ok) slot.textContent = parsed.message;
  else if (zoneProblem) slot.textContent = zoneProblem;
  else {
    const next = nextTaskRun(cron, zone, Date.now());
    slot.textContent =
      next === null
        ? describeTaskSchedule(cron)
        : `${describeTaskSchedule(cron)}. Next run: ${zonedTimeText(next, zone)}`;
  }
  slot.dataset.problem = parsed.ok && !zoneProblem ? "" : "true";
}

function setSubmit(target: HTMLFormElement, force: boolean): void {
  target.dataset.force = force ? "true" : "";
  const button = q<HTMLButtonElement>(target, "[data-task-submit]");
  if (button) button.textContent = force ? TASK_MESSAGES.saveAnyway : TASK_MESSAGES.checkAndSave;
}

function showNotes(
  target: HTMLFormElement,
  notes: { tone: "error" | "warning" | "info"; text: string }[],
): void {
  const list = q<HTMLUListElement>(target, "[data-task-notes]");
  if (!list) return;
  list.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li");
      item.dataset.tone = note.tone;
      item.textContent = note.text;
      return item;
    }),
  );
  list.hidden = notes.length === 0;
}

function resetForm(target: HTMLFormElement): void {
  target.reset();
  clearErrors(target);
  showNotes(target, []);
  setSubmit(target, false);
  const place = field<HTMLSelectElement>(target, "placeKey");
  if (place) place.disabled = false;
  const hint = q<HTMLElement>(target, "[data-task-place-hint]");
  if (hint) hint.textContent = "Where it runs can't be changed later.";
  setValue(target, "cron", "0 0 * * *");
  syncPlace(target);
  syncNext(target);
}

interface TaskDetail {
  id: string;
  name: string;
  description: string;
  place: "container" | "server" | "host";
  runsOn: {
    label: string;
    service: { id: string; innerService: string | null } | null;
    server: { id: string } | null;
  };
  shell: "bash" | "sh";
  cron: string;
  timeZone: string;
  enabled: boolean;
  script?: string;
}

async function openEditor(
  mode: "add" | "edit",
  taskId: string | null,
  opener: Element | null,
): Promise<void> {
  const target = form();
  const dialog = target?.closest("dialog");
  if (!target || !(dialog instanceof HTMLDialogElement)) return;
  resetForm(target);
  const title = dialog.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = mode === "add" ? "Add task" : "Edit task";
  setValue(target, "id", taskId ?? "");
  if (mode === "edit" && taskId) {
    let task: TaskDetail;
    try {
      task = (await callApi<{ task: TaskDetail }>("GET", `/tasks/${encodeURIComponent(taskId)}`))
        .task;
    } catch (error) {
      showToast(asApiError(error).message, { tone: "error" });
      return;
    }
    setValue(target, "name", task.name);
    setValue(target, "description", task.description);
    const place = field<HTMLSelectElement>(target, "placeKey");
    if (place) {
      const key =
        task.place === "host"
          ? "host"
          : task.place === "server"
            ? `server:${task.runsOn.server?.id}`
            : `service:${task.runsOn.service?.id}`;
      if (![...place.options].some((option) => option.value === key)) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = task.runsOn.label;
        place.append(option);
      }
      place.value = key;
      place.disabled = true;
    }
    const hint = q<HTMLElement>(target, "[data-task-place-hint]");
    if (hint) hint.textContent = TASK_MESSAGES.placeFixed;
    syncPlace(target);
    const inner = field<HTMLSelectElement>(target, "innerService");
    if (inner && task.runsOn.service?.innerService) inner.value = task.runsOn.service.innerService;
    const shell = target.querySelector<HTMLInputElement>(
      `input[name="shell"][value="${task.shell}"]`,
    );
    if (shell) shell.checked = true;
    setValue(target, "cron", task.cron);
    setValue(target, "timeZone", task.timeZone === "UTC" ? "" : task.timeZone);
    setValue(target, "script", task.script ?? "");
    const enabled = field(target, "enabled");
    if (enabled) enabled.checked = task.enabled;
    syncNext(target);
  }
  openDialog(dialog, opener);
}

function bodyOf(target: HTMLFormElement): Record<string, unknown> {
  const key = field<HTMLSelectElement>(target, "placeKey")?.value ?? "";
  const [kind, id] = key.split(":");
  const place = kind === "service" ? "container" : kind === "server" ? "server" : "host";
  const shell =
    target.querySelector<HTMLInputElement>('input[name="shell"]:checked')?.value ?? "bash";
  const inner = q<HTMLElement>(target, "[data-task-inner]");
  return {
    name: field(target, "name")?.value.trim() ?? "",
    description: field<HTMLTextAreaElement>(target, "description")?.value.trim() ?? "",
    place,
    ...(place === "container" ? { serviceId: id, shell } : {}),
    ...(place === "container" && inner && !inner.hidden
      ? { innerService: field<HTMLSelectElement>(target, "innerService")?.value }
      : {}),
    ...(place === "server" ? { serverId: id } : {}),
    cron: field(target, "cron")?.value.trim() ?? "",
    timeZone: field(target, "timeZone")?.value.trim() ?? "",
    script: field<HTMLTextAreaElement>(target, "script")?.value ?? "",
    enabled: field(target, "enabled")?.checked ?? true,
    force: target.dataset.force === "true",
  };
}

async function submit(target: HTMLFormElement): Promise<void> {
  if (target.hasAttribute("data-busy")) return;
  const id = field(target, "id")?.value ?? "";
  const body = bodyOf(target);
  if (id) {
    delete body.place;
    delete body.serviceId;
    delete body.serverId;
    delete body.innerService;
  }
  target.setAttribute("data-busy", "");
  const button = q<HTMLButtonElement>(target, "[data-task-submit]");
  button?.setAttribute("aria-busy", "true");
  clearErrors(target);
  showNotes(target, []);
  try {
    const answer = id
      ? await callApi<{ saved: boolean; check: TaskCheckView; message?: string }>(
          "PATCH",
          `/tasks/${encodeURIComponent(id)}`,
          body,
        )
      : await callApi<{ saved: boolean; check: TaskCheckView; message?: string }>(
          "POST",
          "/tasks",
          body,
        );
    if (!answer.saved) {
      const notes: { tone: "error" | "warning" | "info"; text: string }[] =
        answer.check.warnings.map((note) => ({ tone: "warning" as const, text: note.message }));
      if (answer.check.converted)
        notes.push({ tone: "info", text: "Windows line endings will be converted." });
      showNotes(target, notes);
      setSubmit(target, true);
      return;
    }
    showToast(answer.message ?? (id ? TASK_MESSAGES.updated : TASK_MESSAGES.created), {
      tone: "success",
    });
    target.closest("dialog")?.close();
    await refreshPage();
  } catch (error) {
    const problem = asApiError(error);
    showErrors(target, problem);
    // showErrors puts each field's message under it (the script's names the line).
    if (Object.keys(problem.fields).length === 0) showFormError(target, problem.message);
    setSubmit(target, false);
  } finally {
    target.removeAttribute("data-busy");
    button?.removeAttribute("aria-busy");
  }
}

// ---- Run history panel

let panelTask: string | null = null;
let panelTimer: ReturnType<typeof setTimeout> | null = null;
const expanded = new Set<string>();

function panel(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("[data-task-panel]");
}

function pill(status: TaskRunStatus, label: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "nz-pill";
  span.dataset.status = RUN_PILLS[status];
  span.textContent = label;
  return span;
}

function runRow(run: RunView): HTMLElement {
  const item = document.createElement("div");
  item.className = "nz-run";
  item.dataset.runId = run.id;
  const head = document.createElement("div");
  head.className = "nz-run-head";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "nz-run-toggle";
  toggle.dataset.runToggle = run.id;
  toggle.setAttribute("aria-expanded", expanded.has(run.id) ? "true" : "false");
  const when = document.createElement("span");
  when.className = "nz-run-when";
  const started = document.createElement("span");
  started.textContent = localTime(run.startedAt, true);
  const meta = document.createElement("span");
  meta.className = "nz-small nz-dim";
  meta.textContent = `${relativeTime(new Date(run.startedAt))} · ${run.status === "skipped" ? "not run" : run.status === "queued" ? "waiting to start" : shortDuration(run.durationMs)}${run.trigger === "schedule" ? " · scheduled" : run.trigger === "agent" ? " · by the Agent" : ""}`;
  when.append(started, meta);
  toggle.append(pill(run.status, run.statusLabel), when);
  head.append(toggle);
  if (run.open) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "nz-btn nz-btn--outline";
    stop.dataset.runStop = run.id;
    stop.textContent = "Stop";
    head.append(stop);
  }
  item.append(head);
  if (run.error && run.status !== "succeeded") {
    const error = document.createElement("p");
    error.className = "nz-small nz-run-error";
    error.textContent = run.error;
    item.append(error);
  }
  const log = document.createElement("pre");
  log.className = "nz-log nz-run-log";
  log.dataset.runLog = run.id;
  log.hidden = !expanded.has(run.id);
  log.tabIndex = 0;
  item.append(log);
  return item;
}

async function loadLog(runId: string): Promise<void> {
  const slot = panel()?.querySelector<HTMLElement>(`[data-run-log="${CSS.escape(runId)}"]`);
  if (!slot) return;
  try {
    const { run } = await callApi<{ run: RunView }>(
      "GET",
      `/task-runs/${encodeURIComponent(runId)}`,
    );
    const atBottom = slot.scrollTop + slot.clientHeight >= slot.scrollHeight - 8;
    const text = run.log ?? "";
    slot.textContent = text
      ? `${run.logTruncated ? `… (showing the last 1,000 of ${run.logLines} lines)\n` : ""}${text}`
      : run.open
        ? "Waiting for output…"
        : "This run printed nothing.";
    if (atBottom) slot.scrollTop = slot.scrollHeight;
  } catch (error) {
    slot.textContent = asApiError(error).message;
  }
}

async function loadRuns(): Promise<void> {
  const dialog = panel();
  const taskId = panelTask;
  if (!dialog || !taskId) return;
  if (panelTimer) clearTimeout(panelTimer);
  panelTimer = null;
  const list = dialog.querySelector<HTMLElement>("[data-task-runs]");
  try {
    const { runs } = await callApi<{ runs: RunView[] }>(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/runs`,
    );
    if (panelTask !== taskId || !list) return;
    if (runs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "nz-dim nz-run-empty";
      empty.textContent = TASK_MESSAGES.noRuns;
      list.replaceChildren(empty);
    } else {
      const logs = new Map<string, string>();
      for (const slot of list.querySelectorAll<HTMLElement>("[data-run-log]"))
        logs.set(slot.dataset.runLog ?? "", slot.textContent ?? "");
      list.replaceChildren(...runs.map(runRow));
      for (const run of runs) {
        if (!expanded.has(run.id)) continue;
        const slot = list.querySelector<HTMLElement>(`[data-run-log="${CSS.escape(run.id)}"]`);
        if (slot) slot.textContent = logs.get(run.id) ?? "Loading…";
        void loadLog(run.id);
      }
    }
    // The panel follows active runs every few seconds.
    if (runs.some((run) => run.open) && dialog.open)
      panelTimer = setTimeout(() => void loadRuns(), POLL_MS);
  } catch (error) {
    if (list) list.textContent = asApiError(error).message;
  }
}

function openPanel(
  taskId: string,
  name: string,
  opener: Element | null,
  expandRun: string | null = null,
): void {
  const dialog = panel();
  if (!dialog) return;
  panelTask = taskId;
  expanded.clear();
  if (expandRun) expanded.add(expandRun);
  const label = dialog.querySelector<HTMLElement>("[data-task-panel-name]");
  if (label) label.textContent = name;
  dialog.querySelector<HTMLElement>("[data-task-runs]")?.replaceChildren();
  if (!dialog.open) openDialog(dialog, opener);
  void loadRuns();
}

async function runNow(button: HTMLButtonElement): Promise<void> {
  const taskId = button.dataset.taskRun ?? "";
  if (button.disabled) return;
  button.disabled = true;
  try {
    const answer = await callApi<{ run: RunView; message: string }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/run`,
      {},
    );
    showToast(answer.message, { tone: "success" });
    openPanel(taskId, button.dataset.taskName ?? "", button, answer.run.id);
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  } finally {
    button.disabled = false;
  }
}

export function initTasks(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const open = target?.closest<HTMLElement>("[data-task-open]");
    if (open) {
      event.preventDefault();
      void openEditor(
        open.dataset.taskOpen === "edit" ? "edit" : "add",
        open.dataset.taskId ?? null,
        open,
      );
      return;
    }
    const run = target?.closest<HTMLButtonElement>("[data-task-run]");
    if (run) {
      void runNow(run);
      return;
    }
    const history = target?.closest<HTMLElement>("[data-task-history]");
    if (history) {
      openPanel(history.dataset.taskHistory ?? "", history.dataset.taskName ?? "", history);
      return;
    }
    const remove = target?.closest<HTMLElement>("[data-task-delete]");
    if (remove) {
      const dialog = document.querySelector<HTMLDialogElement>("#nz-task-delete");
      const deleteForm = dialog?.querySelector<HTMLFormElement>("[data-task-delete-form]");
      if (!dialog || !deleteForm) return;
      setValue(deleteForm, "id", remove.dataset.taskDelete ?? "");
      const title = deleteForm.querySelector<HTMLElement>('[data-fill-text="title"]');
      if (title) title.textContent = deleteTaskTitle(remove.dataset.taskName ?? "");
      clearErrors(deleteForm);
      openDialog(dialog, remove);
      return;
    }
    const toggle = target?.closest<HTMLElement>("[data-run-toggle]");
    if (toggle) {
      const runId = toggle.dataset.runToggle ?? "";
      const slot = panel()?.querySelector<HTMLElement>(`[data-run-log="${CSS.escape(runId)}"]`);
      if (!slot) return;
      const show = slot.hidden;
      slot.hidden = !show;
      toggle.setAttribute("aria-expanded", show ? "true" : "false");
      if (show) {
        expanded.add(runId);
        slot.textContent = "Loading…";
        void loadLog(runId);
      } else expanded.delete(runId);
      return;
    }
    const stop = target?.closest<HTMLButtonElement>("[data-run-stop]");
    if (stop && !stop.disabled) {
      stop.disabled = true;
      void callApi<{ message: string }>(
        "POST",
        `/task-runs/${encodeURIComponent(stop.dataset.runStop ?? "")}/stop`,
        {},
      )
        .then((answer) => {
          showToast(answer.message, { tone: "success" });
          return loadRuns();
        })
        .catch((error: unknown) => {
          showToast(asApiError(error).message, { tone: "error" });
          stop.disabled = false;
        });
      return;
    }
    if (target?.closest("[data-task-panel-refresh]")) void loadRuns();
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    const taskForm = target?.closest<HTMLFormElement>("[data-task-form]");
    if (taskForm) {
      if (target?.matches("[data-task-place]")) syncPlace(taskForm);
      if (target?.matches("[data-task-preset]")) {
        const preset = (target as HTMLSelectElement).value;
        if (preset) setValue(taskForm, "cron", preset);
        else field(taskForm, "cron")?.focus();
      }
      syncNext(taskForm);
      return;
    }
    const filters = target?.closest<HTMLFormElement>("[data-tasks-filters]");
    if (filters && target?.matches("[data-tasks-filter]")) filters.requestSubmit();
  });

  document.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    const taskForm = target?.closest<HTMLFormElement>("[data-task-form]");
    if (!taskForm) return;
    if (target?.matches('[name="cron"], [name="timeZone"]')) syncNext(taskForm);
    // A changed script needs checking again.
    if (target?.matches('[name="script"], [name="shell"]')) setSubmit(taskForm, false);
  });

  document.addEventListener("submit", (event) => {
    const target = event.target;
    if (target instanceof HTMLFormElement && target.matches("[data-task-form]")) {
      event.preventDefault();
      void submit(target);
    } else if (target instanceof HTMLFormElement && target.matches("[data-task-delete-form]")) {
      event.preventDefault();
      const id = field(target, "id")?.value ?? "";
      void callApi<{ message: string }>("DELETE", `/tasks/${encodeURIComponent(id)}`)
        .then(async (answer) => {
          showToast(answer.message, { tone: "success" });
          target.closest("dialog")?.close();
          await refreshPage();
        })
        .catch((error: unknown) => showFormError(target, asApiError(error).message));
    }
  });

  document.addEventListener(
    "close",
    (event) => {
      if (event.target === panel()) {
        panelTask = null;
        if (panelTimer) clearTimeout(panelTimer);
        panelTimer = null;
      }
    },
    true,
  );
}
