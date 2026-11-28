import { restoreIntoWarning } from "@nearzero/shared/browser";
import { apiErrorFrom, unreachableError } from "../lib/api-error.ts";
import { pillOfRun, sizeText } from "../lib/backups.ts";
import type { BackupRunView } from "../lib/data/backups.ts";
import { randomId } from "../lib/random-id.ts";
import { asApiError, callApi, clearErrors, refreshPage, showErrors } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * Backups in the browser (spec 08 8.3, 17): the destination dialog (add or edit, the provider's
 * sample endpoint, Test), the schedule dialog (presets and cron), Run now (answers at once; the
 * row then follows the run live), each run's log, and the restore steps with their live log.
 * Requests that start a run carry an Idempotency-Key, so a retry never starts a second one.
 */

interface ProviderPreset {
  label: string;
  endpoint: string;
  region: string;
}

/** POST with an Idempotency-Key header (the shared callApi has no header option). */
async function startRun<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": randomId(24, "nz"),
      },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw unreachableError();
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw apiErrorFrom(response.status, parsed);
  return parsed as T;
}

// ---------- Destinations (Settings → Backups)

function destinationDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("#nz-destination");
}

function setValue(form: HTMLFormElement, name: string, value: string): void {
  const field = form.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[name="${CSS.escape(name)}"]`,
  );
  if (field) field.value = value;
}

function openDestination(trigger: HTMLElement): void {
  const dialog = destinationDialog();
  const form = dialog?.querySelector<HTMLFormElement>("[data-destination-form]");
  if (!dialog || !form) return;
  const edit = trigger.dataset.destinationOpen === "edit";
  form.reset();
  clearErrors(form);
  let values: Record<string, string> = {};
  try {
    values = JSON.parse(trigger.dataset.dialogFill ?? "{}") as Record<string, string>;
  } catch {
    values = {};
  }
  for (const [name, value] of Object.entries(values)) setValue(form, name, String(value ?? ""));
  if (!edit) setValue(form, "id", "");
  form.dataset.api = edit ? "PATCH /backup-destinations/{id}" : "POST /backup-destinations";
  form.dataset.apiToast = edit ? "Destination saved" : "Destination added";
  const title = dialog.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = edit ? "Edit destination" : "Add destination";
  const submit = form.querySelector<HTMLElement>("[data-destination-submit]");
  if (submit) submit.textContent = edit ? "Save destination" : "Add destination";
  for (const key of form.querySelectorAll<HTMLInputElement>("[data-destination-key]")) {
    key.value = "";
    // Blank keeps the saved keys when editing (spec 17.1).
    if (edit) {
      key.placeholder = "Saved, leave blank to keep";
      key.dataset.keepRequired = key.dataset.required ?? key.dataset.keepRequired ?? "";
      delete key.dataset.required;
    } else {
      key.placeholder = "";
      if (key.dataset.keepRequired) key.dataset.required = key.dataset.keepRequired;
    }
  }
  form.dataset.lastPreset =
    form.querySelector<HTMLSelectElement>("[data-destination-provider]")?.value ?? "";
  const check = form.querySelector<HTMLElement>("[data-destination-check]");
  if (check) {
    check.hidden = true;
    check.textContent = "";
  }
  openDialog(dialog, trigger);
}

function presetsOf(form: HTMLFormElement): Record<string, ProviderPreset> {
  try {
    return JSON.parse(form.dataset.presets ?? "{}") as Record<string, ProviderPreset>;
  } catch {
    return {};
  }
}

/** Picking a provider fills its sample endpoint and region, unless the person typed their own. */
function providerChanged(select: HTMLSelectElement): void {
  const form = select.closest<HTMLFormElement>("[data-destination-form]");
  if (!form) return;
  const presets = presetsOf(form);
  const endpoint = form.querySelector<HTMLInputElement>("[data-destination-endpoint]");
  const region = form.querySelector<HTMLInputElement>("[data-destination-region]");
  const samples = Object.values(presets);
  const next = presets[select.value];
  if (!next) return;
  if (
    endpoint &&
    (endpoint.value.trim() === "" ||
      samples.some((item) => item.endpoint === endpoint.value.trim()))
  ) {
    endpoint.value = next.endpoint;
  }
  if (
    region &&
    (region.value.trim() === "" || samples.some((item) => item.region === region.value.trim()))
  ) {
    region.value = next.region;
  }
}

async function testDestination(button: HTMLElement): Promise<void> {
  const id = button.dataset.destinationTest ?? "";
  const result = document.querySelector<HTMLElement>(
    `[data-destination-result="${CSS.escape(id)}"]`,
  );
  button.setAttribute("aria-disabled", "true");
  const before = button.textContent;
  button.textContent = "Testing…";
  try {
    const answer = await callApi<{
      ok: boolean;
      message: string;
      detail: string | null;
      server: string;
    }>("POST", `/backup-destinations/${encodeURIComponent(id)}/test`, {});
    if (result) {
      result.hidden = false;
      result.dataset.ok = String(answer.ok);
      result.textContent = answer.ok
        ? `${answer.message} (from ${answer.server})`
        : `${answer.message}${answer.detail ? ` ${answer.detail}` : ""}`;
    }
    showToast(answer.message, { tone: answer.ok ? "success" : "error" });
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  } finally {
    button.removeAttribute("aria-disabled");
    button.textContent = before;
  }
}

/**
 * Test connection in the Add / Edit dialog (spec 17.1): the typed values, before saving; on edit
 * blank keys use the saved ones (POST /backup-destinations/test). Nothing is saved.
 */
async function testTypedDestination(button: HTMLElement): Promise<void> {
  const form = button.closest<HTMLFormElement>("[data-destination-form]");
  const result = form?.querySelector<HTMLElement>("[data-destination-check]");
  if (!form || !result || button.getAttribute("aria-disabled") === "true") return;
  const field = (name: string) =>
    form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";
  const id = field("id").trim();
  clearErrors(form);
  button.setAttribute("aria-disabled", "true");
  const before = button.textContent;
  button.textContent = "Testing…";
  result.hidden = false;
  result.removeAttribute("data-ok");
  result.textContent = "Listing the bucket…";
  try {
    const answer = await callApi<{
      ok: boolean;
      message: string;
      detail: string | null;
      server: string;
    }>("POST", "/backup-destinations/test", {
      ...(id ? { destinationId: id } : {}),
      provider: field("provider"),
      endpoint: field("endpoint").trim(),
      bucket: field("bucket").trim(),
      region: field("region").trim() || "auto",
      accessKeyId: field("accessKeyId"),
      secretAccessKey: field("secretAccessKey"),
    });
    result.dataset.ok = String(answer.ok);
    result.textContent = answer.ok
      ? `${answer.message} (from ${answer.server})`
      : `${answer.message}${answer.detail ? ` ${answer.detail}` : ""}`;
  } catch (error) {
    const problem = asApiError(error);
    result.hidden = true;
    showErrors(form, problem);
  } finally {
    button.removeAttribute("aria-disabled");
    button.textContent = before;
  }
}

// ---------- Schedules

function scheduleDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("#nz-schedule");
}

function cronPresets(form: HTMLFormElement): Record<string, string> {
  try {
    return JSON.parse(form.dataset.cronPresets ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * The preset and the cron field stay in step: picking a preset writes its cron, and a cron typed
 * by hand picks the preset it matches, or Custom. The cron field is always there (and sent).
 */
function syncPreset(form: HTMLFormElement, fromPreset: boolean): void {
  const preset = form.querySelector<HTMLSelectElement>("[data-schedule-preset]");
  const cron = form.querySelector<HTMLInputElement>("[data-schedule-cron]");
  if (!preset || !cron) return;
  const crons = cronPresets(form);
  if (fromPreset && preset.value !== "custom" && crons[preset.value]) {
    cron.value = crons[preset.value] as string;
  }
  if (!fromPreset) {
    const typed = cron.value.trim().replace(/\s+/g, " ");
    const match = Object.entries(crons).find(([, value]) => value === typed);
    preset.value = match ? match[0] : "custom";
  }
  if (fromPreset && preset.value === "custom") cron.focus();
}

function openSchedule(trigger: HTMLElement): void {
  const dialog = scheduleDialog();
  const form = dialog?.querySelector<HTMLFormElement>("[data-schedule-form]");
  if (!dialog || !form) return;
  trigger.closest<HTMLElement>("[popover]")?.hidePopover();
  const edit = trigger.dataset.scheduleOpen === "edit";
  form.reset();
  clearErrors(form);
  if (edit) {
    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(trigger.dataset.dialogFill ?? "{}") as Record<string, unknown>;
    } catch {
      values = {};
    }
    for (const [name, value] of Object.entries(values)) {
      const field = form.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[name="${CSS.escape(name)}"]`,
      );
      if (!field) continue;
      if (field instanceof HTMLInputElement && field.type === "checkbox")
        field.checked = value === true;
      else field.value = String(value ?? "");
    }
  } else {
    setValue(form, "id", "");
  }
  const serviceId = form.dataset.serviceId ?? "";
  form.dataset.api = edit
    ? "PATCH /backup-schedules/{id}"
    : `POST /services/${serviceId}/backup-schedules`;
  form.dataset.apiToast = edit ? "Backup schedule saved" : "Backup schedule added";
  const title = dialog.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = edit ? "Edit backup" : "Add backup";
  const submit = form.querySelector<HTMLElement>("[data-schedule-submit]");
  if (submit) submit.textContent = edit ? "Save backup" : "Add backup";
  syncPreset(form, !edit);
  openDialog(dialog, trigger);
}

// ---------- Rows that follow their runs

function setRow(run: BackupRunView): void {
  if (!run.scheduleId || run.operation !== "backup") return;
  const row = document.querySelector<HTMLElement>(
    `[data-schedule-row="${CSS.escape(run.scheduleId)}"]`,
  );
  const cell = row?.querySelector<HTMLElement>("[data-schedule-last]");
  if (!cell) return;
  // A finished older run never replaces a newer one on the row.
  const shown = cell.dataset.runId ?? "";
  if (shown && shown !== run.id && !run.open && cell.dataset.runOpen === "true") return;
  cell.dataset.runId = run.id;
  cell.dataset.runOpen = String(run.open);
  const pill = cell.querySelector<HTMLElement>("[data-run-pill] .nz-pill");
  if (pill) {
    pill.dataset.status = pillOfRun(run);
    pill.textContent = run.statusLabel;
  }
  const when = cell.querySelector<HTMLElement>("[data-run-when]");
  if (when) {
    when.textContent = run.open
      ? "In progress"
      : run.file?.sizeBytes
        ? `Just now · ${sizeText(run.file.sizeBytes)}`
        : "Just now";
  }
  const error = cell.querySelector<HTMLElement>("[data-run-error]");
  if (error) {
    error.hidden = !(run.status === "failed" && run.error);
    error.textContent = run.status === "failed" ? (run.error ?? "") : "";
  }
  for (const link of row?.querySelectorAll<HTMLElement>("[data-run-log]") ?? [])
    link.dataset.runLog = run.id;
}

let rowEvents: EventSource | null = null;

function followRows(): void {
  rowEvents?.close();
  rowEvents = null;
  const panel = document.querySelector<HTMLElement>("[data-backups-panel][data-live]");
  const serviceId = panel?.dataset.serviceId;
  if (!serviceId || typeof EventSource === "undefined") return;
  rowEvents = new EventSource(
    `/api/v1/services/${encodeURIComponent(serviceId)}/backup-runs/events`,
  );
  rowEvents.addEventListener("run", (event) => {
    try {
      const { run } = JSON.parse((event as MessageEvent).data) as { run: BackupRunView };
      setRow(run);
    } catch {
      // A malformed event changes nothing.
    }
  });
}

async function runNow(button: HTMLElement): Promise<void> {
  if (button.getAttribute("aria-disabled") === "true") return;
  const id = button.dataset.backupRun ?? "";
  button.setAttribute("aria-disabled", "true");
  try {
    const answer = await startRun<{ run: BackupRunView; message: string }>(
      `/backup-schedules/${encodeURIComponent(id)}/run`,
      {},
    );
    setRow(answer.run);
    showToast(answer.message, { tone: "success" });
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  } finally {
    button.removeAttribute("aria-disabled");
  }
}

// ---------- Live logs

interface LogTarget {
  text: HTMLElement;
  state: HTMLElement;
  onEnd?: (run: BackupRunView) => void;
}

let logEvents: EventSource | null = null;

function followLog(runId: string, target: LogTarget): void {
  logEvents?.close();
  target.text.textContent = "";
  target.state.textContent = "Loading the log…";
  const events = new EventSource(`/api/v1/backup-runs/${encodeURIComponent(runId)}/events`);
  logEvents = events;
  const append = (text: string) => {
    const atEnd = target.text.scrollTop + target.text.clientHeight >= target.text.scrollHeight - 8;
    target.text.append(document.createTextNode(text));
    if (atEnd) target.text.scrollTop = target.text.scrollHeight;
  };
  events.addEventListener("log", (event) => {
    try {
      append((JSON.parse((event as MessageEvent).data) as { text: string }).text);
    } catch {
      // Skipped.
    }
  });
  const status = (event: Event) => {
    try {
      const { run } = JSON.parse((event as MessageEvent).data) as { run: BackupRunView };
      target.state.textContent = run.statusLabel;
      target.state.dataset.status = pillOfRun(run);
      if (event.type === "end") {
        events.close();
        if (run.error) target.state.textContent = `${run.statusLabel}: ${run.error}`;
        target.onEnd?.(run);
      }
    } catch {
      // Skipped.
    }
  };
  events.addEventListener("status", status);
  events.addEventListener("end", status);
  events.addEventListener("open", () => {
    if (target.state.textContent === "Loading the log…") target.state.textContent = "";
  });
}

function openRunLog(trigger: HTMLElement): void {
  trigger.closest<HTMLElement>("[popover]")?.hidePopover();
  const runId = trigger.dataset.runLog ?? "";
  const dialog = document.querySelector<HTMLDialogElement>("#nz-run-log");
  const text = dialog?.querySelector<HTMLElement>("[data-run-log-text]");
  const state = dialog?.querySelector<HTMLElement>("[data-run-log-state]");
  if (!dialog || !text || !state) return;
  if (!runId) {
    text.textContent = "";
    state.textContent = "This schedule hasn't run yet.";
    openDialog(dialog, trigger);
    return;
  }
  const title = dialog.querySelector<HTMLElement>(".nz-dialog-title");
  if (title)
    title.textContent = trigger.dataset.runLogTitle
      ? `Run log · ${trigger.dataset.runLogTitle}`
      : "Run log";
  followLog(runId, { text, state });
  openDialog(dialog, trigger);
}

// ---------- Restore

function restoreRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-restore]");
}

function restoreStep(root: HTMLElement, step: "find" | "files" | "confirm" | "progress"): void {
  const files = root.querySelector<HTMLElement>("[data-restore-files]");
  const confirm = root.querySelector<HTMLElement>("[data-restore-confirm]");
  const progress = root.querySelector<HTMLElement>("[data-restore-progress]");
  const find = root.querySelector<HTMLFormElement>("[data-restore-find]");
  if (find) find.hidden = step === "confirm" || step === "progress";
  if (files) files.hidden = step !== "files";
  if (confirm) confirm.hidden = step !== "confirm";
  if (progress) progress.hidden = step !== "progress";
}

interface RestoreFill {
  destinationId?: string;
  folder?: string;
  database?: string;
  volume?: string;
}

/**
 * Opens Restore. From a schedule's row (R3-46) it starts on that schedule's destination, folder
 * and database or volume; from the header, on the first destination and schedule.
 */
function openRestore(trigger: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>("#nz-restore");
  const root = restoreRoot();
  if (!dialog || !root) return;
  logEvents?.close();
  restoreStep(root, "find");
  const list = root.querySelector<HTMLElement>("[data-restore-list]");
  for (const item of list?.querySelectorAll(".nz-choice") ?? []) item.remove();
  const confirm = root.querySelector<HTMLInputElement>("#nz-restore-confirm");
  if (confirm) confirm.value = "";
  let fill: RestoreFill = {};
  try {
    fill = trigger.dataset.restoreFill
      ? (JSON.parse(trigger.dataset.restoreFill) as RestoreFill)
      : {};
  } catch {
    fill = {};
  }
  const find = root.querySelector<HTMLFormElement>("[data-restore-find]");
  if (find) {
    // The header's Restore starts from what the page rendered.
    if (!trigger.dataset.restoreFill) find.reset();
    const destination = find.querySelector<HTMLSelectElement>('[name="destinationId"]');
    if (destination && fill.destinationId) destination.value = fill.destinationId;
    const folder = find.querySelector<HTMLInputElement>('[name="folder"]');
    if (folder && fill.folder !== undefined) folder.value = fill.folder;
    const volume = find.querySelector<HTMLSelectElement>('[name="volume"]');
    if (volume && fill.volume) volume.value = fill.volume;
  }
  root.dataset.fillDatabase = fill.database ?? "";
  openDialog(dialog, trigger);
}

/** Names the database the restore goes into in the confirm step (R3-45). */
function showRestoreTarget(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("[data-restore-database]");
  if (!input) return;
  const name = input.value.trim() || input.placeholder;
  const into = root.querySelector<HTMLElement>("[data-restore-into]");
  if (into) into.textContent = name;
  const warning = root.querySelector<HTMLElement>("[data-restore-warning]");
  if (warning) warning.textContent = restoreIntoWarning(name);
}

async function findBackups(form: HTMLFormElement): Promise<void> {
  const root = restoreRoot();
  if (!root) return;
  const serviceId = root.dataset.serviceId ?? "";
  const data = new FormData(form);
  const query = new URLSearchParams();
  for (const key of ["destinationId", "folder", "volume"]) {
    const value = data.get(key);
    if (typeof value === "string" && value.trim() !== "") query.set(key, value.trim());
  }
  const button = form.querySelector<HTMLElement>("[data-restore-find-button]");
  button?.setAttribute("aria-disabled", "true");
  clearErrors(form);
  try {
    const answer = await callApi<{
      prefix: string;
      files: {
        key: string;
        name: string;
        sizeBytes: number;
        modifiedAt: string;
        database: string | null;
      }[];
    }>("GET", `/services/${encodeURIComponent(serviceId)}/backup-files?${query.toString()}`);
    const list = root.querySelector<HTMLElement>("[data-restore-list]");
    const empty = root.querySelector<HTMLElement>("[data-restore-empty]");
    const next = root.querySelector<HTMLButtonElement>("[data-restore-next]");
    for (const item of list?.querySelectorAll(".nz-choice") ?? []) item.remove();
    for (const [index, file] of answer.files.entries()) {
      const label = document.createElement("label");
      label.className = "nz-choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "restoreKey";
      input.value = file.key;
      input.dataset.name = file.name;
      input.dataset.database = file.database ?? "";
      if (index === 0) input.checked = true;
      const text = document.createElement("span");
      const name = document.createElement("span");
      name.className = "font-medium nz-code";
      name.textContent = file.name;
      const meta = document.createElement("span");
      meta.className = "nz-dim";
      meta.textContent = `${sizeText(file.sizeBytes)} · ${new Date(file.modifiedAt).toLocaleString()}`;
      text.append(name, meta);
      label.append(input, text);
      list?.append(label);
    }
    if (empty) empty.hidden = answer.files.length > 0;
    if (next) next.disabled = answer.files.length === 0;
    restoreStep(root, "files");
    root.dataset.destinationId = String(data.get("destinationId") ?? "");
    root.dataset.volume = String(data.get("volume") ?? "");
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    button?.removeAttribute("aria-disabled");
  }
}

function chosenKey(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('input[name="restoreKey"]:checked');
}

async function startRestore(form: HTMLFormElement): Promise<void> {
  const root = restoreRoot();
  const chosen = root ? chosenKey(root) : null;
  if (!root || !chosen) return;
  const confirm = form.querySelector<HTMLInputElement>('[name="confirm"]');
  const database = form.querySelector<HTMLInputElement>("[data-restore-database]");
  const go = form.querySelector<HTMLButtonElement>("[data-restore-go]");
  if (go) go.disabled = true;
  clearErrors(form);
  try {
    const answer = await startRun<{ run: BackupRunView; message: string }>(
      `/services/${encodeURIComponent(root.dataset.serviceId ?? "")}/restores`,
      {
        destinationId: root.dataset.destinationId,
        key: chosen.value,
        confirm: confirm?.value ?? "",
        ...(root.dataset.volume ? { volume: root.dataset.volume } : {}),
        ...(database?.value.trim() ? { database: database.value.trim() } : {}),
      },
    );
    restoreStep(root, "progress");
    const text = root.querySelector<HTMLElement>("[data-restore-log]");
    const state = root.querySelector<HTMLElement>("[data-restore-state]");
    if (text && state) {
      followLog(answer.run.id, {
        text,
        state,
        onEnd: (run) => {
          showToast(
            run.status === "succeeded"
              ? "Restored"
              : `Restore failed${run.error ? `: ${run.error}` : ""}`,
            {
              tone: run.status === "succeeded" ? "success" : "error",
            },
          );
        },
      });
    }
  } catch (error) {
    showErrors(form, asApiError(error));
    if (go) go.disabled = false;
  }
}

export function initBackups(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const destination = target?.closest<HTMLElement>("[data-destination-open]");
    if (destination) {
      event.preventDefault();
      openDestination(destination);
      return;
    }
    const typed = target?.closest<HTMLElement>("[data-destination-check-run]");
    if (typed) {
      event.preventDefault();
      void testTypedDestination(typed);
      return;
    }
    const test = target?.closest<HTMLElement>("[data-destination-test]");
    if (test) {
      event.preventDefault();
      void testDestination(test);
      return;
    }
    const remove = target?.closest<HTMLElement>("[data-destination-delete]");
    if (remove) {
      const note = document.querySelector<HTMLElement>("[data-destination-delete-count]");
      const count = Number(remove.dataset.destinationDelete ?? "0");
      if (note) {
        note.hidden = count === 0;
        note.textContent =
          count === 1
            ? "1 backup schedule writes to it."
            : `${count} backup schedules write to it.`;
      }
      return;
    }
    const schedule = target?.closest<HTMLElement>("[data-schedule-open]");
    if (schedule) {
      event.preventDefault();
      if (schedule.hasAttribute("disabled")) return;
      openSchedule(schedule);
      return;
    }
    const run = target?.closest<HTMLElement>("[data-backup-run]");
    if (run) {
      event.preventDefault();
      void runNow(run);
      return;
    }
    const log = target?.closest<HTMLElement>("[data-run-log]");
    if (log) {
      event.preventDefault();
      openRunLog(log);
      return;
    }
    const restore = target?.closest<HTMLElement>("[data-restore-open]");
    if (restore) {
      event.preventDefault();
      openRestore(restore);
      return;
    }
    const next = target?.closest<HTMLElement>("[data-restore-next]");
    if (next) {
      event.preventDefault();
      const root = restoreRoot();
      const chosen = root ? chosenKey(root) : null;
      if (!root || !chosen) return;
      const name = root.querySelector<HTMLElement>("[data-restore-chosen]");
      if (name) name.textContent = chosen.value;
      // The database the file was dumped from, or the schedule's, or the service's own.
      const database = root.querySelector<HTMLInputElement>("[data-restore-database]");
      if (database) {
        const source =
          chosen.dataset.database ||
          root.dataset.fillDatabase ||
          root.dataset.defaultDatabase ||
          "";
        database.value = source;
        database.placeholder = source || "every database in the backup";
        showRestoreTarget(root);
      }
      restoreStep(root, "confirm");
      root.querySelector<HTMLInputElement>("#nz-restore-confirm")?.focus();
      return;
    }
    const back = target?.closest<HTMLElement>("[data-restore-back]");
    if (back) {
      event.preventDefault();
      const root = restoreRoot();
      if (root) restoreStep(root, "files");
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches("[data-destination-provider]")) {
      providerChanged(target);
    }
    if (target instanceof HTMLSelectElement && target.matches("[data-schedule-preset]")) {
      const form = target.closest<HTMLFormElement>("[data-schedule-form]");
      if (form) syncPreset(form, true);
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches("[data-schedule-cron]")) {
      const form = target.closest<HTMLFormElement>("[data-schedule-form]");
      if (form) syncPreset(form, false);
      return;
    }
    if (target instanceof HTMLInputElement && target.matches("[data-restore-database]")) {
      const root = restoreRoot();
      if (root) showRestoreTarget(root);
      return;
    }
    if (!(target instanceof HTMLInputElement) || target.id !== "nz-restore-confirm") return;
    const root = restoreRoot();
    const go = root?.querySelector<HTMLButtonElement>("[data-restore-go]");
    if (go) go.disabled = target.value.trim() !== (root?.dataset.serviceName ?? "");
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-restore-find]")) {
      event.preventDefault();
      void findBackups(form);
    } else if (form.matches("[data-restore-confirm]")) {
      event.preventDefault();
      void startRestore(form);
    }
  });

  // The rows follow runs while the Backups panel is on the page.
  document.addEventListener("astro:page-load", followRows);
  document.addEventListener("astro:before-swap", () => {
    rowEvents?.close();
    rowEvents = null;
    logEvents?.close();
    logEvents = null;
  });
  if (!document.querySelector('meta[name="astro-view-transitions-enabled"]')) followRows();

  // A restore that finished refreshes the panel when its dialog closes.
  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement)) return;
      if (dialog.id === "nz-run-log") logEvents?.close();
      if (dialog.id === "nz-restore") {
        const progress = dialog.querySelector<HTMLElement>("[data-restore-progress]");
        logEvents?.close();
        if (progress && !progress.hidden) void refreshPage();
      }
    },
    true,
  );
}
