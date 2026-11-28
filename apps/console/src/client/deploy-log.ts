import { firstFailureLine } from "@nearzero/shared/browser";
import { browserCopyEnvironment, COPY_REFUSED_MESSAGE, copyText } from "../lib/copy-text.ts";
import type { DeploymentLog } from "../lib/data/operations-types.ts";
import { asApiError, callApi } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * A deployment's log, live (spec 6.1, 6.5, 11.2): the stored text first (the last 500 lines, or
 * all of it after "Load all"), then the live stream from right after it, resumed with
 * Last-Event-ID when the connection drops, so nothing repeats or goes missing. The first failure
 * line is marked ("Failure detected on line N: …"), "Find in logs" marks matching lines, and Copy
 * copies the whole log ("Logs copied").
 *
 * Markup: an element with `data-deploy-log="<deployment id>"` holding
 *   [data-log-lines]   where lines go
 *   [data-log-failure] the failure note (hidden until there is one)
 *   [data-log-copy], [data-log-all], [data-log-find] (optional controls)
 *   [data-log-state]   optional text that follows the status ("Building", "Active"…)
 * It fires `nz:deploy-status` and `nz:deploy-end` (bubbling) with { status, statusLabel, error }.
 */

interface Viewer {
  root: HTMLElement;
  deploymentId: string;
  lines: string[];
  partial: string;
  source: EventSource | null;
  failureLine: number | null;
  /** The line number of lines[0] in the whole log. */
  firstLine: number;
  ended: boolean;
}

const viewers = new WeakMap<HTMLElement, Viewer>();

function linesBox(viewer: Viewer): HTMLElement | null {
  return viewer.root.querySelector<HTMLElement>("[data-log-lines]");
}

function lineElement(number: number, text: string, failure: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "nz-log-line";
  row.dataset.line = String(number);
  if (failure) row.dataset.failure = "true";
  row.textContent = text || " ";
  return row;
}

/** Shows the note and marks the line, the first time a failure is found. */
function markFailure(viewer: Viewer, line: number, text: string, message?: string): void {
  if (viewer.failureLine !== null) return;
  viewer.failureLine = line;
  const note = viewer.root.querySelector<HTMLElement>("[data-log-failure]");
  if (note) {
    const words = note.querySelector<HTMLElement>("[data-log-failure-text]") ?? note;
    words.textContent = message ?? `Failure detected on line ${line}: ${text.trim()}`;
    note.hidden = false;
    note.dataset.line = String(line);
  }
  linesBox(viewer)
    ?.querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute("data-failure", "true");
}

function stickToBottom(box: HTMLElement, run: () => void): void {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  run();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderAll(viewer: Viewer): void {
  const box = linesBox(viewer);
  if (!box) return;
  const all = viewer.partial ? [...viewer.lines, viewer.partial] : viewer.lines;
  box.replaceChildren(
    ...all.map((text, index) => {
      const number = viewer.firstLine + index;
      return lineElement(number, text, number === viewer.failureLine);
    }),
  );
  box.scrollTop = box.scrollHeight;
  box.closest("[data-deploy-log]")?.toggleAttribute("data-log-empty", all.length === 0);
}

/** Adds a piece of the live log: complete lines become rows; the open line keeps updating. */
function append(viewer: Viewer, text: string): void {
  const box = linesBox(viewer);
  if (!box) return;
  stickToBottom(box, () => {
    box.querySelector('[data-partial="true"]')?.remove();
    const parts = (viewer.partial + text).split("\n");
    viewer.partial = parts.pop() ?? "";
    for (const line of parts) {
      viewer.lines.push(line);
      const number = viewer.firstLine + viewer.lines.length - 1;
      box.append(lineElement(number, line, false));
    }
    if (viewer.partial) {
      const open = lineElement(viewer.firstLine + viewer.lines.length, viewer.partial, false);
      open.dataset.partial = "true";
      box.append(open);
    }
  });
  viewer.root.toggleAttribute("data-log-empty", viewer.lines.length === 0 && !viewer.partial);
}

function setState(viewer: Viewer, status: string, statusLabel: string): void {
  viewer.root.dataset.status = status;
  const scope =
    viewer.root.closest<HTMLElement>("[data-deploy-watch], [data-build-panel]") ?? viewer.root;
  scope.dataset.status = status;
  for (const slot of scope.querySelectorAll<HTMLElement>("[data-log-state]")) {
    slot.textContent = statusLabel;
  }
}

function stop(viewer: Viewer): void {
  viewer.source?.close();
  viewer.source = null;
}

function follow(viewer: Viewer, lastEventId: string | null): void {
  stop(viewer);
  const base = `/api/v1/deployments/${encodeURIComponent(viewer.deploymentId)}/events`;
  const url = lastEventId ? `${base}?lastEventId=${encodeURIComponent(lastEventId)}` : base;
  const source = new EventSource(url, { withCredentials: true });
  viewer.source = source;
  source.addEventListener("log", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as { text: string };
      append(viewer, data.text);
    } catch {
      // A piece that doesn't parse is skipped; the stored log still has it.
    }
  });
  source.addEventListener("status", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as {
        status: string;
        statusLabel: string;
      };
      setState(viewer, data.status, data.statusLabel);
      viewer.root.dispatchEvent(
        new CustomEvent("nz:deploy-status", { detail: data, bubbles: true }),
      );
    } catch {
      // Ignore a status that doesn't parse; the end event settles it.
    }
  });
  source.addEventListener("end", (event) => {
    stop(viewer);
    viewer.ended = true;
    let data = { status: "failed", statusLabel: "Failed", error: null as string | null };
    try {
      data = JSON.parse((event as MessageEvent).data);
    } catch {
      // Keep the default.
    }
    setState(viewer, data.status, data.statusLabel);
    if (data.status === "failed") {
      const found = firstFailureLine([...viewer.lines, viewer.partial].join("\n"));
      if (found) markFailure(viewer, viewer.firstLine + found.line - 1, found.text);
    }
    viewer.root.dispatchEvent(new CustomEvent("nz:deploy-end", { detail: data, bubbles: true }));
  });
}

async function load(viewer: Viewer, all: boolean): Promise<void> {
  const path = `/deployments/${encodeURIComponent(viewer.deploymentId)}/log${all ? "?lines=all" : ""}`;
  let log: DeploymentLog;
  try {
    log = await callApi<DeploymentLog>("GET", path);
  } catch (error) {
    const box = linesBox(viewer);
    if (box) box.replaceChildren(lineElement(1, asApiError(error).message, false));
    return;
  }
  const text = log.text.endsWith("\n") ? log.text.slice(0, -1) : log.text;
  viewer.lines = text ? text.split("\n") : [];
  viewer.partial = "";
  viewer.firstLine = Math.max(1, log.shownFrom || 1);
  viewer.failureLine = null;
  renderAll(viewer);
  const more = viewer.root.querySelector<HTMLElement>("[data-log-all]");
  if (more) more.hidden = !log.truncated && viewer.firstLine <= 1;
  if (log.failure) markFailure(viewer, log.failure.line, log.failure.text, log.failure.message);
  // A deployment still queued or building is never complete: the stream follows and ends it.
  if (!log.complete || viewer.root.dataset.live === "true") follow(viewer, log.lastEventId);
  else viewer.ended = true;
}

/** Starts (or restarts) one log view. */
export function openDeployLog(
  root: HTMLElement,
  deploymentId?: string,
  options: { live?: boolean } = {},
): void {
  if (options.live !== undefined) root.dataset.live = options.live ? "true" : "false";
  const existing = viewers.get(root);
  if (existing) stop(existing);
  const viewer: Viewer = {
    root,
    deploymentId: deploymentId ?? root.dataset.deployLog ?? "",
    lines: [],
    partial: "",
    source: null,
    failureLine: null,
    firstLine: 1,
    ended: false,
  };
  if (!viewer.deploymentId) return;
  root.dataset.deployLog = viewer.deploymentId;
  viewers.set(root, viewer);
  const note = root.querySelector<HTMLElement>("[data-log-failure]");
  if (note) note.hidden = true;
  void load(viewer, false);
}

export function closeDeployLog(root: HTMLElement): void {
  const viewer = viewers.get(root);
  if (viewer) stop(viewer);
}

function find(viewer: Viewer, needle: string): void {
  const box = linesBox(viewer);
  if (!box) return;
  const query = needle.trim().toLowerCase();
  let first: HTMLElement | null = null;
  let count = 0;
  for (const row of box.querySelectorAll<HTMLElement>(".nz-log-line")) {
    const hit = query !== "" && (row.textContent ?? "").toLowerCase().includes(query);
    row.toggleAttribute("data-match", hit);
    if (hit) {
      count++;
      first ??= row;
    }
  }
  const status = viewer.root.querySelector<HTMLElement>("[data-log-find-count]");
  if (status) status.textContent = query ? `${count} ${count === 1 ? "match" : "matches"}` : "";
  first?.scrollIntoView({ block: "nearest" });
}

async function copyAll(viewer: Viewer): Promise<void> {
  let text = [...viewer.lines, viewer.partial].join("\n");
  if (viewer.firstLine > 1) {
    try {
      const log = await callApi<DeploymentLog>(
        "GET",
        `/deployments/${encodeURIComponent(viewer.deploymentId)}/log?lines=all`,
      );
      text = log.text;
    } catch {
      // Copy what is shown.
    }
  }
  const ok = await copyText(text, browserCopyEnvironment());
  showToast(ok ? "Logs copied" : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" });
}

export function initDeployLogs(): void {
  document.addEventListener("astro:page-load", () => {
    for (const root of document.querySelectorAll<HTMLElement>(
      "[data-deploy-log][data-autostart]",
    )) {
      openDeployLog(root);
    }
  });
  document.addEventListener("astro:before-swap", () => {
    for (const root of document.querySelectorAll<HTMLElement>("[data-deploy-log]")) {
      closeDeployLog(root);
    }
  });
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const root = target?.closest<HTMLElement>("[data-deploy-log]");
    const viewer = root ? viewers.get(root) : undefined;
    if (!viewer) return;
    if (target?.closest("[data-log-copy]") && event.isTrusted) {
      event.preventDefault();
      void copyAll(viewer);
    } else if (target?.closest("[data-log-all]")) {
      event.preventDefault();
      stop(viewer);
      (target.closest("[data-log-all]") as HTMLElement).hidden = true;
      void load(viewer, true);
    } else if (target?.closest("[data-log-failure]")) {
      const line = viewer.failureLine;
      if (line !== null) {
        linesBox(viewer)
          ?.querySelector<HTMLElement>(`[data-line="${line}"]`)
          ?.scrollIntoView({ block: "center" });
      }
    }
  });
  document.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.("[data-log-find]")) return;
    const root = input.closest<HTMLElement>("[data-deploy-log]");
    const viewer = root ? viewers.get(root) : undefined;
    if (viewer) find(viewer, input.value);
  });
}
