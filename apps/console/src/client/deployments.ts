import { navigate } from "astro:transitions/client";
import type { DeploymentView } from "../lib/data/operations-types.ts";
import { deploymentPill, deploymentPillLabel, durationLabel } from "../lib/deploys.ts";
import { refreshPage } from "./api.ts";

/**
 * The Deployments page in the browser (spec 11.1): the search applies after a short pause and
 * the filters at once (both change the address, so a view can be shared), and running and queued
 * rows update live from GET /deployments/stream. A deployment that isn't on the page yet (a new
 * one) reloads the first page; "… so far" durations tick while building.
 */

let source: EventSource | null = null;
let searchTimer: number | undefined;
let tick: number | undefined;
let reloadTimer: number | undefined;
let refocus = false;

function submit(form: HTMLFormElement): void {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) {
    const text = String(value).trim();
    if (!text) continue;
    if ((key === "status" || key === "type") && text === "all") continue;
    if (key === "pageSize" && text === "50") continue;
    params.set(key, text);
  }
  const query = params.toString();
  refocus = document.activeElement?.matches?.("[data-deployments-search]") ?? false;
  void navigate(`${form.action.replace(/\?.*$/, "")}${query ? `?${query}` : ""}`, {
    history: "replace",
  });
}

function updateRow(row: HTMLElement, deployment: DeploymentView): void {
  row.dataset.status = deployment.status;
  const pill = row.querySelector<HTMLElement>("[data-status-cell] .nz-pill");
  if (pill) {
    pill.dataset.status = deploymentPill(deployment.status);
    pill.textContent = deploymentPillLabel(deployment.status, deployment.statusLabel);
  }
  const duration = row.querySelector<HTMLElement>("[data-duration-ms]");
  if (duration) {
    duration.dataset.durationMs = String(deployment.durationMs ?? "");
    if (deployment.running) duration.dataset.duration = "running";
    else delete duration.dataset.duration;
    duration.textContent = durationLabel(deployment.durationMs, deployment.running);
  }
  if (deployment.startedAt) row.dataset.started = deployment.startedAt;
}

function tickDurations(page: HTMLElement): void {
  for (const cell of page.querySelectorAll<HTMLElement>('[data-duration="running"]')) {
    const row = cell.closest<HTMLElement>("[data-deployment-row]");
    const started = row?.dataset.started ? new Date(row.dataset.started).getTime() : Number.NaN;
    if (Number.isFinite(started)) cell.textContent = durationLabel(Date.now() - started, true);
  }
}

function follow(page: HTMLElement): void {
  source?.close();
  source = new EventSource("/api/v1/deployments/stream", { withCredentials: true });
  source.addEventListener("deployment", (event) => {
    let deployment: DeploymentView;
    try {
      deployment = (JSON.parse((event as MessageEvent).data) as { deployment: DeploymentView })
        .deployment;
    } catch {
      return;
    }
    const row = page.querySelector<HTMLElement>(
      `[data-deployment-row="${CSS.escape(deployment.id)}"]`,
    );
    if (row) {
      updateRow(row, deployment);
      return;
    }
    // A new deployment shows on the first page of an unfiltered or matching view.
    const params = new URLSearchParams(location.search);
    if ((params.get("page") ?? "1") !== "1") return;
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void refreshPage(), 800);
  });
}

function stop(): void {
  source?.close();
  source = null;
  window.clearInterval(tick);
  tick = undefined;
}

export function initDeploymentsPage(): void {
  document.addEventListener("astro:page-load", () => {
    stop();
    const page = document.querySelector<HTMLElement>("[data-deployments-page]");
    if (!page) return;
    if (refocus) {
      refocus = false;
      const search = page.querySelector<HTMLInputElement>("[data-deployments-search]");
      search?.focus();
      search?.setSelectionRange(search.value.length, search.value.length);
    }
    follow(page);
    tick = window.setInterval(() => tickDurations(page), 1000);
  });
  document.addEventListener("astro:before-swap", stop);
  document.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.("[data-deployments-search]")) return;
    const form = input.closest<HTMLFormElement>("form");
    window.clearTimeout(searchTimer);
    if (form) searchTimer = window.setTimeout(() => submit(form), 400);
  });
  document.addEventListener("change", (event) => {
    const select = event.target as HTMLElement | null;
    if (!select?.matches?.("[data-deployments-filter]")) return;
    const form = select.closest<HTMLFormElement>("form");
    if (form) submit(form);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-deployments-filters]")) return;
    event.preventDefault();
    submit(form);
  });
}
