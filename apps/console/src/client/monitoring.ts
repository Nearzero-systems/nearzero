import {
  type MetricsReporting,
  MONITORING_MESSAGES,
  memoryPercent,
  monitoringCards,
} from "@nearzero/shared/browser";
import { chartHtml } from "../lib/line-chart.ts";
import { asApiError, callApi, clearErrors, showErrors } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * Monitoring panels in the browser (spec 14.2, 14.3): each `[data-monitoring]` loads its
 * target's samples (GET /servers/:id/metrics) and alert settings, refreshes every 5, 10, 20 or
 * 30 seconds (never with "All"), and stops when it is no longer on screen (its dialog closed,
 * or the page changed). The server Details dialog points a panel at a server with the
 * `nz:monitoring-target` event.
 */

interface Sample {
  at: number;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  /** df's "Available"; older runners don't send it (30c R3-34). */
  diskAvailableBytes?: number;
  uptimeSeconds: number;
}

interface SystemInfo {
  hostname?: string;
  os?: string;
  kernel?: string;
  architecture?: string;
  cpuModel?: string;
  cpuCores?: number;
  cpuThreads?: number;
  cpuMhz?: number;
  dockerVersion?: string | null;
}

interface AlertsView {
  cpuThreshold: number | null;
  memoryThreshold: number | null;
  canEdit: boolean;
  channels: number;
}

interface PanelState {
  target: string;
  timer: ReturnType<typeof setTimeout> | null;
  generation: number;
}

const panels = new WeakMap<HTMLElement, PanelState>();

function q<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function setText(root: ParentNode, selector: string, value: string): void {
  const slot = q<HTMLElement>(root, selector);
  if (slot) slot.textContent = value;
}

function meter(root: ParentNode, name: string, percent: number): void {
  const bar = q<HTMLElement>(root, `[data-meter="${name}"]`);
  if (bar) {
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.dataset.level = percent >= 90 ? "high" : percent >= 70 ? "mid" : "low";
  }
}

function system(root: ParentNode, info: SystemInfo | null): void {
  const list = q<HTMLElement>(root, "[data-monitoring-system]");
  if (!list) return;
  const rows: [string, string][] = info
    ? [
        ["Host name", info.hostname || "—"],
        ["Operating system", info.os || "—"],
        ["Kernel", info.kernel ? `${info.kernel} (${info.architecture ?? "?"})` : "—"],
        ["CPU", info.cpuModel || "—"],
        [
          "Cores",
          info.cpuCores
            ? `${info.cpuCores} cores, ${info.cpuThreads ?? info.cpuCores} threads`
            : "—",
        ],
        ["Clock", info.cpuMhz ? `${(info.cpuMhz / 1000).toFixed(2)} GHz` : "—"],
        ["Docker", info.dockerVersion || "—"],
      ]
    : [["Status", "Not reported yet"]];
  list.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      return [term, detail];
    }),
  );
}

function render(
  root: HTMLElement,
  samples: Sample[],
  info: SystemInfo | null,
  reporting: MetricsReporting | undefined,
): void {
  q<HTMLElement>(root, "[data-monitoring-empty]")?.toggleAttribute("hidden", samples.length > 0);
  // A server that stopped reporting shows its samples as history only, never as its current
  // state (30c R3-33). Older control planes send no `reporting`: their newest sample counts.
  const current = reporting?.current !== false;
  const stale = q<HTMLElement>(root, "[data-monitoring-stale]");
  if (stale) {
    stale.textContent = current ? "" : (reporting?.message ?? "");
    stale.hidden = current || !reporting?.message;
  }
  const latest = samples.at(-1);
  if (latest || !current) {
    const cards = monitoringCards(current ? (latest ?? null) : null);
    setText(root, '[data-metric="uptime"]', cards.uptime);
    setText(root, '[data-metric="cpu"]', cards.cpu);
    setText(root, '[data-metric="memory"]', cards.memory);
    setText(root, '[data-metric="memory-detail"]', cards.memoryDetail);
    setText(root, '[data-metric="disk"]', cards.disk);
    setText(root, '[data-metric="disk-detail"]', cards.diskDetail);
    meter(root, "cpu", cards.meters.cpu);
    meter(root, "memory", cards.meters.memory);
    meter(root, "disk", cards.meters.disk);
  }
  system(root, info);
  const xs = samples.map((sample) => sample.at);
  const cpu = q<HTMLElement>(root, '[data-monitoring-chart="cpu"]');
  const ram = q<HTMLElement>(root, '[data-monitoring-chart="memory"]');
  // Keep a chart the person is reading with the keyboard as it is.
  if (cpu && !cpu.contains(document.activeElement)) {
    cpu.innerHTML = chartHtml(
      {
        xs,
        unit: "percent",
        xLabel: "time",
        series: [{ label: "CPU", values: samples.map((s) => s.cpuPercent), tone: "accent" }],
      },
      "CPU history",
    );
  }
  if (ram && !ram.contains(document.activeElement)) {
    ram.innerHTML = chartHtml(
      {
        xs,
        unit: "percent",
        xLabel: "time",
        series: [
          {
            label: "RAM",
            values: samples.map((s) => memoryPercent(s.memoryUsedBytes, s.memoryTotalBytes)),
            tone: "accent",
          },
        ],
      },
      "RAM history",
    );
  }
}

function visible(root: HTMLElement): boolean {
  if (!root.isConnected) return false;
  const dialog = root.closest("dialog");
  if (dialog && !dialog.open) return false;
  return true;
}

async function refresh(root: HTMLElement): Promise<void> {
  const state = panels.get(root);
  if (!state?.target) return;
  const generation = state.generation;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const points = q<HTMLSelectElement>(root, "[data-monitoring-points]")?.value ?? "50";
  const seconds = Number(q<HTMLSelectElement>(root, "[data-monitoring-refresh]")?.value ?? "5");
  const error = q<HTMLElement>(root, "[data-monitoring-error]");
  try {
    const answer = await callApi<{
      samples: Sample[];
      system: SystemInfo | null;
      reporting?: MetricsReporting;
    }>(
      "GET",
      `/servers/${encodeURIComponent(state.target)}/metrics?points=${encodeURIComponent(points)}`,
    );
    if (panels.get(root)?.generation !== generation) return;
    if (error) error.hidden = true;
    render(root, answer.samples, answer.system, answer.reporting);
  } catch (problem) {
    if (panels.get(root)?.generation !== generation) return;
    // "Error fetching metrics", and under it why, in the platform's words (30c R3-33).
    if (error) {
      setText(error, "[data-monitoring-error-reason]", asApiError(problem).message);
      error.hidden = false;
    }
  }
  if (points !== "all" && visible(root) && panels.get(root)?.generation === generation) {
    state.timer = setTimeout(() => {
      if (visible(root)) void refresh(root);
    }, seconds * 1000);
  }
}

async function loadAlerts(root: HTMLElement): Promise<void> {
  const state = panels.get(root);
  const form = q<HTMLFormElement>(root, "[data-monitoring-alerts]");
  if (!state || !form) return;
  form.hidden = true;
  try {
    const { alerts } = await callApi<{ alerts: AlertsView }>(
      "GET",
      `/servers/${encodeURIComponent(state.target)}/alerts`,
    );
    if (panels.get(root) !== state) return;
    const cpu = q<HTMLInputElement>(form, '[name="cpuThreshold"]');
    const memory = q<HTMLInputElement>(form, '[name="memoryThreshold"]');
    if (cpu) cpu.value = alerts.cpuThreshold === null ? "" : String(alerts.cpuThreshold);
    if (memory)
      memory.value = alerts.memoryThreshold === null ? "" : String(alerts.memoryThreshold);
    setText(
      form,
      "[data-monitoring-channels]",
      alerts.channels === 0
        ? MONITORING_MESSAGES.noChannels
        : `${alerts.channels === 1 ? "1 channel subscribes" : `${alerts.channels} channels subscribe`} to Server alerts.`,
    );
    form.hidden = !alerts.canEdit;
  } catch {
    form.hidden = true;
  }
}

export function startMonitoring(root: HTMLElement, target: string): void {
  const previous = panels.get(root);
  if (previous?.timer) clearTimeout(previous.timer);
  panels.set(root, { target, timer: null, generation: (previous?.generation ?? 0) + 1 });
  for (const slot of root.querySelectorAll<HTMLElement>("[data-metric]"))
    slot.textContent = slot.dataset.metric?.endsWith("detail") ? "" : "—";
  q<HTMLElement>(root, "[data-monitoring-stale]")?.toggleAttribute("hidden", true);
  void refresh(root);
  void loadAlerts(root);
}

function stop(root: HTMLElement): void {
  const state = panels.get(root);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.generation++;
}

function startAll(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-monitoring]")) {
    const target = root.dataset.target;
    if (target) startMonitoring(root, target);
  }
}

function intValue(input: HTMLInputElement | null): number | null {
  const value = input?.value.trim() ?? "";
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function initMonitoring(): void {
  document.addEventListener("nz:monitoring-target", (event) => {
    const root = event.target;
    const target = (event as CustomEvent<{ target: string }>).detail?.target;
    if (root instanceof HTMLElement && root.matches("[data-monitoring]") && target)
      startMonitoring(root, target);
  });

  document.addEventListener("change", (event) => {
    const target = event.target as Element | null;
    const root = target?.closest<HTMLElement>("[data-monitoring]");
    if (root && target?.matches("[data-monitoring-points], [data-monitoring-refresh]")) {
      const refreshSelect = q<HTMLSelectElement>(root, "[data-monitoring-refresh]");
      const points = q<HTMLSelectElement>(root, "[data-monitoring-points]")?.value;
      if (refreshSelect) refreshSelect.disabled = points === "all";
      const state = panels.get(root);
      if (state) {
        state.generation++;
        void refresh(root);
      }
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-monitoring-alerts]")) return;
    event.preventDefault();
    const root = form.closest<HTMLElement>("[data-monitoring]");
    const state = root ? panels.get(root) : undefined;
    if (!root || !state) return;
    clearErrors(form);
    try {
      const answer = await callApi<{ message: string }>(
        "PUT",
        `/servers/${encodeURIComponent(state.target)}/alerts`,
        {
          cpuThreshold: intValue(q<HTMLInputElement>(form, '[name="cpuThreshold"]')),
          memoryThreshold: intValue(q<HTMLInputElement>(form, '[name="memoryThreshold"]')),
        },
      );
      showToast(answer.message, { tone: "success" });
      void loadAlerts(root);
    } catch (error) {
      showErrors(form, asApiError(error));
    }
  });

  document.addEventListener("click", async (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "[data-monitoring-test]",
    );
    if (!button || button.disabled) return;
    event.preventDefault();
    const root = button.closest<HTMLElement>("[data-monitoring]");
    const state = root ? panels.get(root) : undefined;
    if (!state) return;
    button.disabled = true;
    try {
      const answer = await callApi<{ message: string; channels: number }>(
        "POST",
        `/servers/${encodeURIComponent(state.target)}/alerts/test`,
        {},
      );
      showToast(answer.message, { tone: answer.channels > 0 ? "success" : "info" });
    } catch (error) {
      showToast(asApiError(error).message, { tone: "error" });
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement)) return;
      for (const root of dialog.querySelectorAll<HTMLElement>("[data-monitoring]")) stop(root);
    },
    true,
  );

  const routed = document.querySelector('meta[name="astro-view-transitions-enabled"]') !== null;
  if (routed) document.addEventListener("astro:page-load", startAll);
  else if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", startAll);
  else startAll();
}
