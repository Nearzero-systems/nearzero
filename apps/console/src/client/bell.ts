import { bellDeployments, bellStatus, bellTime } from "../lib/deploys.ts";
import { dateTime, fullDate } from "../lib/time.ts";

/**
 * The notifications bell's badge (spec 11.5): pending invitations plus failed deployments since
 * the person last opened the bell (on a first visit, failures from the last 24 hours), at most
 * "9+". What was seen is remembered per browser and workspace.
 *
 * The list reloads while a page stays open (30a R1-06): every 60 seconds while the tab shows
 * and the panel is closed, when the tab shows again after more than 60 seconds, and when the
 * panel opens on data older than 15 seconds. So a deploy that fails while someone sits on the
 * Agent page reaches the badge within a minute, with no navigation.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const BELL_REFRESH_MS = 60_000;
export const BELL_STALE_ON_OPEN_MS = 15_000;

export type BellRefreshReason = "tick" | "visible" | "open";

/** Whether the bell reloads its list now, for a reason and the age of what it shows. */
export function bellRefreshDue(
  reason: BellRefreshReason,
  ageMs: number,
  state: { visible: boolean; open: boolean },
): boolean {
  if (reason === "open") return ageMs > BELL_STALE_ON_OPEN_MS;
  if (!state.visible) return false;
  if (reason === "visible") return ageMs > BELL_REFRESH_MS;
  return !state.open;
}

function storageKey(workspace: string): string {
  return `nz.bell.seen.${workspace}`;
}

function readSeen(workspace: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey(workspace));
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSeen(workspace: string, at: number): void {
  try {
    localStorage.setItem(storageKey(workspace), String(at));
  } catch {
    // Private windows may refuse storage; the badge just counts again next time.
  }
}

export function badgeCount(
  invitations: number,
  failures: number[],
  seen: number | null,
  now: number,
): number {
  const since = seen ?? now - DAY_MS;
  return invitations + failures.filter((at) => at > since).length;
}

function paint(bell: HTMLElement, count: number): void {
  const badge = bell.querySelector<HTMLElement>("[data-bell-count]");
  const button = bell.querySelector<HTMLElement>("[data-bell-button]");
  if (badge) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.hidden = count === 0;
  }
  button?.setAttribute("aria-label", count > 0 ? `Notifications (${count} new)` : "Notifications");
}

/** Failures since a moment, asked of the API (GET /deployments/recent?since=), kept 15 s. */
const asked = new Map<string, { at: number; count: number }>();

async function failuresSince(seen: number): Promise<number | null> {
  const key = String(seen);
  const cached = asked.get(key);
  if (cached && Date.now() - cached.at < 15_000) return cached.count;
  try {
    const response = await fetch(
      `/api/v1/deployments/recent?since=${encodeURIComponent(new Date(seen).toISOString())}`,
      { headers: { accept: "application/json" }, credentials: "same-origin" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { failedSince?: number };
    const count = typeof body.failedSince === "number" ? body.failedSince : 0;
    asked.set(key, { at: Date.now(), count });
    return count;
  } catch {
    return null;
  }
}

/** The blue dot on each failure the person hasn't seen yet (spec 21.10). */
function paintDots(bell: HTMLElement, since: number): void {
  for (const card of bell.querySelectorAll<HTMLElement>("[data-bell-failure]")) {
    const dot = card.querySelector<HTMLElement>(".nz-bell-unread");
    if (dot) dot.hidden = !(Number(card.dataset.bellFailure) > since);
  }
}

function update(bell: HTMLElement, dots = true): void {
  const workspace = bell.dataset.workspace ?? "";
  const invitations = Number(bell.dataset.invitations ?? "0");
  const failures = (bell.dataset.failures ?? "")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const seen = readSeen(workspace);
  const now = Date.now();
  if (dots) paintDots(bell, seen ?? now - DAY_MS);
  if (seen === null) {
    // A first visit counts the last 24 hours' failures, which the page already knows.
    const day = Number(bell.dataset.failedDay ?? "0");
    paint(bell, invitations + Math.max(day, badgeCount(0, failures, null, now)));
    return;
  }
  paint(bell, badgeCount(invitations, failures, seen, now));
  // The list holds the newest 8; older failures since the last look come from the API.
  void failuresSince(seen).then((count) => {
    if (count !== null) paint(bell, invitations + count);
  });
}

interface RecentAnswer {
  deployments: {
    id: string;
    status: string;
    title: string;
    createdAt: string;
    finishedAt: string | null;
    service: { name: string };
    project: { name: string };
    environment: { name: string };
  }[];
  failedSince: number;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Draws the deployments part of the panel as Bell.astro does. */
function drawDeployments(bell: HTMLElement, answer: RecentAnswer | null): void {
  const slot = bell.querySelector<HTMLElement>("[data-bell-deployments]");
  if (!slot) return;
  const workspace = bell.dataset.workspace ?? "";
  const invitations = Number(bell.dataset.invitations ?? "0");
  if (answer === null) {
    slot.replaceChildren(
      element("p", "nz-inline-error m-1", "Recent deployments are not available right now."),
    );
    return;
  }
  const list = bellDeployments(answer.deployments);
  if (list.length === 0) {
    if (invitations > 0) {
      slot.replaceChildren(element("p", "nz-dim px-2 py-3 text-center", "No recent deployments."));
    } else {
      const empty = element("div", "px-2 py-3 text-center");
      empty.append(
        element("p", "font-medium", "You're all caught up."),
        element("p", "nz-dim", "Deployments will show up here."),
      );
      slot.replaceChildren(empty);
    }
    return;
  }
  const wrap = element("div", "nz-bell-list");
  wrap.append(element("p", "nz-bell-eyebrow", "Recent deployments"));
  for (const item of list) {
    const at = bellTime(item);
    const status = bellStatus(item.status);
    const card = element("a", "nz-bell-card");
    card.href = `/${encodeURIComponent(workspace)}/dashboard/deployments/${encodeURIComponent(item.id)}`;
    card.title = `${item.service.name} in ${item.project.name} / ${item.environment.name}`;
    if (item.status === "failed") card.dataset.bellFailure = String(at.getTime());
    const pill = element("span", "", status.label);
    pill.dataset.status = status.pill;
    const time = element("time", "nz-dim", dateTime(at));
    time.dateTime = at.toISOString();
    time.dataset.timeFormat = "full";
    time.title = fullDate(at);
    const line = element("span", "nz-bell-card-status");
    line.append(pill, time);
    const dot = element("span", "nz-bell-unread");
    dot.setAttribute("aria-label", "Unread");
    dot.hidden = true;
    card.append(
      element("span", "nz-bell-card-name nz-truncate", item.service.name),
      element("span", "nz-bell-card-title nz-truncate", item.title),
      line,
      dot,
    );
    wrap.append(card);
  }
  slot.replaceChildren(wrap);
}

const loading = new WeakMap<HTMLElement, Promise<void>>();

function ageOf(bell: HTMLElement): number {
  const loaded = Number(bell.dataset.loadedAt ?? "0");
  return Number.isFinite(loaded) && loaded > 0 ? Date.now() - loaded : Number.POSITIVE_INFINITY;
}

/** Loads the latest deployments again and redraws the list and the badge. */
function reload(bell: HTMLElement, dotsSince?: number): Promise<void> {
  const running = loading.get(bell);
  if (running) return running;
  const task = (async () => {
    let answer: RecentAnswer | null = null;
    try {
      const response = await fetch("/api/v1/deployments/recent", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) return;
      answer = (await response.json()) as RecentAnswer;
    } catch {
      // Offline for a moment: keep what the panel shows and try again on the next tick.
      return;
    }
    if (!bell.isConnected || !answer || !Array.isArray(answer.deployments)) return;
    const shown = bellDeployments(answer.deployments);
    bell.dataset.failures = shown
      .filter((item) => item.status === "failed")
      .map((item) => bellTime(item).getTime())
      .join(",");
    bell.dataset.failedDay = String(answer.failedSince ?? 0);
    bell.dataset.loadedAt = String(Date.now());
    asked.clear();
    drawDeployments(bell, answer);
    if (dotsSince !== undefined) paintDots(bell, dotsSince);
    update(bell, dotsSince === undefined);
  })().finally(() => loading.delete(bell));
  loading.set(bell, task);
  return task;
}

function isOpen(bell: HTMLElement): boolean {
  const panel = bell.querySelector<HTMLElement>("[data-bell-panel]");
  try {
    return panel?.matches(":popover-open") ?? false;
  } catch {
    return false;
  }
}

function refreshAll(reason: BellRefreshReason): void {
  for (const bell of document.querySelectorAll<HTMLElement>("[data-bell]")) {
    const state = { visible: document.visibilityState === "visible", open: isOpen(bell) };
    if (bellRefreshDue(reason, ageOf(bell), state)) void reload(bell);
  }
}

export function initBell(): void {
  document.addEventListener("astro:page-load", () => {
    for (const bell of document.querySelectorAll<HTMLElement>("[data-bell]")) {
      // The page's data is as old as the page; timed by this browser's own clock.
      bell.dataset.loadedAt = String(Date.now());
      update(bell);
    }
  });
  window.setInterval(() => refreshAll("tick"), BELL_REFRESH_MS);
  document.addEventListener("visibilitychange", () => refreshAll("visible"));
  document.addEventListener(
    "toggle",
    (event) => {
      const panel = event.target;
      if (!(panel instanceof HTMLElement) || !panel.matches("[data-bell-panel]")) return;
      if ((event as ToggleEvent).newState !== "open") return;
      const bell = panel.closest<HTMLElement>("[data-bell]");
      if (!bell) return;
      const workspace = bell.dataset.workspace ?? "";
      const seenBefore = readSeen(workspace) ?? Date.now() - DAY_MS;
      // The dots stay while the panel is open; the badge clears.
      writeSeen(workspace, Date.now());
      update(bell, false);
      // Data older than 15 seconds is loaded again first; the new cards keep the dots of what
      // wasn't seen before this opening.
      if (bellRefreshDue("open", ageOf(bell), { visible: true, open: true })) {
        void reload(bell, seenBefore);
      }
    },
    true,
  );
}
