import { durationText } from "@nearzero/shared/browser";
import {
  browserCopyEnvironment,
  COPIED_MESSAGE,
  COPY_REFUSED_MESSAGE,
  copyText,
} from "../lib/copy-text.ts";
import { type ChartSpec, chartTicks, timeText } from "../lib/line-chart.ts";
import { customRangeOfDays, localInputValue, localTime } from "../lib/m10.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * Analytics in the browser (spec 13.2): range and status chips apply at once, custom ranges in
 * the browser's own time, times shown in local time, and the request drawer with Copy JSON and
 * Download JSON (both work over plain HTTP, spec 21.9).
 */

interface RequestRow {
  id: string;
  at: string;
  method: string;
  host: string;
  path: string;
  status: number;
  durationMs: number;
  client: string;
  fields: Record<string, unknown>;
}

let current: RequestRow | null = null;

function text(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function bytes(value: unknown): string {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(size)) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function facts(slot: HTMLElement | null, rows: [string, string][]): void {
  if (!slot) return;
  slot.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      return [term, detail];
    }),
  );
}

function openDrawer(row: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>("[data-request-drawer]");
  if (!dialog) return;
  try {
    current = JSON.parse(row.dataset.request ?? "") as RequestRow;
  } catch {
    return;
  }
  const entry = current;
  const f = entry.fields;
  const summary = dialog.querySelector<HTMLElement>("[data-request-summary]");
  if (summary) summary.textContent = `${entry.method} ${entry.host}${entry.path}`;
  const slot = (name: string) =>
    dialog.querySelector<HTMLElement>(`[data-request-facts="${name}"]`);
  facts(slot("request"), [
    ["Time", localTime(entry.at, true)],
    ["Method", entry.method],
    ["Host", entry.host || "—"],
    ["Path", entry.path],
    ["Protocol", text(f.RequestProtocol)],
    ["Scheme", text(f.RequestScheme)],
    ["Size", bytes(f.RequestContentSize)],
  ]);
  facts(slot("response"), [
    ["Status", String(entry.status)],
    ["Duration", durationText(entry.durationMs)],
    ["Size", bytes(f.DownstreamContentSize)],
    ["App's status", text(f.OriginStatus)],
    [
      "App's time",
      typeof f.OriginDuration === "number" ? durationText(f.OriginDuration / 1e6) : "—",
    ],
  ]);
  facts(slot("client"), [
    ["Address", entry.client || "—"],
    ["Port", text(f.ClientPort)],
    ["User agent", text(f["request_User-Agent"])],
    ["Referer", text(f.request_Referer)],
  ]);
  facts(slot("routing"), [
    ["Router", text(f.RouterName)],
    ["Service", text(f.ServiceName)],
    ["Upstream", text(f.ServiceURL ?? f.ServiceAddr)],
    ["Entry point", text(f.entryPointName)],
    ["TLS", f.TLSVersion ? [f.TLSVersion, f.TLSCipher].filter(Boolean).map(text).join(" · ") : "—"],
    ["Retries", text(f.RetryAttempts)],
  ]);
  const json = dialog.querySelector<HTMLElement>("[data-request-json]");
  if (json) json.textContent = JSON.stringify(f, null, 2);
  openDialog(dialog, row);
}

function download(): void {
  if (!current) return;
  const blob = new Blob([`${JSON.stringify(current.fields, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `request-${current.at.replace(/[:.]/g, "-")}.json`;
  const host = document.querySelector("dialog[open]") ?? document.body;
  host.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Times drawn on the server are in its zone; show them in the browser's. */
function localize(): void {
  for (const cell of document.querySelectorAll<HTMLElement>("[data-local-iso]")) {
    cell.textContent = localTime(cell.dataset.localIso ?? "", true);
  }
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-local-time][data-utc]")) {
    const iso = input.dataset.utc;
    if (!iso || input.value) continue;
    // To the millisecond, so a range ending 23:59:59.999 keeps its last minute when the form
    // is sent again (G3-13).
    input.value = localInputValue(new Date(iso));
  }
  // The two date fields show the window's first and last days in the browser's zone.
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-analytics-day]")) {
    const iso = input.dataset.dayUtc;
    if (!iso) continue;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) continue;
    input.value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
  }
  for (const zone of document.querySelectorAll<HTMLInputElement>("[data-analytics-tz]")) {
    zone.value = String(new Date().getTimezoneOffset());
  }
  for (const chart of document.querySelectorAll<HTMLElement>(
    "[data-analytics-page] [data-line-chart]",
  )) {
    let spec: ChartSpec;
    try {
      spec = JSON.parse(chart.dataset.lineChart ?? "") as ChartSpec;
    } catch {
      continue;
    }
    const labels = chart.querySelectorAll<HTMLElement>(".nz-chart-x span");
    const ticks = chartTicks(spec.xs.length);
    labels.forEach((label, order) => {
      const index = ticks[order];
      if (index !== undefined) label.textContent = timeText(spec.xs[index] as number, spec.xLabel);
    });
  }
}

export function initAnalytics(): void {
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    const form = target?.closest<HTMLFormElement>("[data-analytics-filters]");
    if (form && target?.matches("[data-analytics-day]")) {
      // Picking a day makes a custom range from the start of the first day to the end of
      // the last, in the browser's own time.
      const day = (name: string) =>
        form.querySelector<HTMLInputElement>(`[data-analytics-day="${name}"]`)?.value ?? "";
      const from = day("from");
      const to = day("to");
      if (!from || !to) return;
      const set = (name: string, value: string) => {
        const input = form.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
        if (input) input.value = value;
      };
      // Through the last millisecond of the last day (G3-13).
      const range = customRangeOfDays(from, to);
      set("from", range.from);
      set("to", range.to);
      const custom = form.querySelector<HTMLInputElement>('[name="range"][value="custom"]');
      if (custom) custom.checked = true;
      form.requestSubmit();
      return;
    }
    if (!form || !target?.matches("[data-analytics-auto]")) return;
    if (target.name === "range") {
      const custom = form.querySelector<HTMLElement>("[data-analytics-custom]");
      for (const segment of form.querySelectorAll<HTMLElement>(".nz-segment")) {
        segment.toggleAttribute("data-active", segment.contains(target) && target.checked);
      }
      if (target.value === "custom") {
        if (custom) custom.hidden = false;
        form.querySelector<HTMLInputElement>("[data-analytics-day]")?.focus();
        return;
      }
      for (const input of form.querySelectorAll<HTMLInputElement>("[data-local-time]"))
        input.disabled = true;
    }
    form.requestSubmit();
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-analytics-filters]")) return;
    const range = form.querySelector<HTMLInputElement>('[name="range"]:checked')?.value;
    if (range !== "custom") {
      for (const input of form.querySelectorAll<HTMLInputElement>(
        "[data-local-time], [data-analytics-tz]",
      ))
        input.disabled = true;
    }
  });

  document.addEventListener("click", async (event) => {
    const target = event.target as Element | null;
    const row = target?.closest<HTMLElement>("[data-request]");
    if (row) {
      openDrawer(row);
      return;
    }
    if (target?.closest("[data-request-copy]") && current && event.isTrusted) {
      const ok = await copyText(JSON.stringify(current.fields, null, 2), browserCopyEnvironment());
      showToast(ok ? COPIED_MESSAGE : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" });
      return;
    }
    if (target?.closest("[data-request-download]")) download();
  });

  document.addEventListener("keydown", (event) => {
    const row = (event.target as Element | null)?.closest?.<HTMLElement>("[data-request]");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openDrawer(row);
    }
  });

  const routed = document.querySelector('meta[name="astro-view-transitions-enabled"]') !== null;
  if (routed) document.addEventListener("astro:page-load", localize);
  else if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", localize);
  else localize();
}
