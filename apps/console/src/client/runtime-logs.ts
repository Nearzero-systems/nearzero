import { browserCopyEnvironment, COPY_REFUSED_MESSAGE, copyText } from "../lib/copy-text.ts";
import { logsUrl } from "../lib/runtime-rules.ts";
import { asApiError, callApi } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * The Logs tab in the browser (spec 6.7, 7.2, 8.2): one server-sent stream per choice of
 * container, line count, since, search and follow (GET /services/:id/logs). A dropped stream
 * resumes from its last event id (the browser sends Last-Event-ID itself); "gap" events say what
 * was lost. Copy and Download take what is shown (Download works on plain HTTP: a Blob link).
 * The Compose page's section (`data-logs-pick`) waits for a container to be picked: until then
 * the box says so and its tools stay hidden.
 */

interface Stream {
  source: EventSource | null;
  text: string;
  timer: number | undefined;
}

const streams = new WeakMap<HTMLElement, Stream>();
const MAX_SHOWN = 2_000_000;

function el<T extends HTMLElement>(panel: HTMLElement, selector: string): T | null {
  return panel.querySelector<T>(selector);
}

function setStatus(panel: HTMLElement, text: string): void {
  const slot = el(panel, "[data-logs-status]");
  if (slot) slot.textContent = text;
}

function write(panel: HTMLElement, stream: Stream, text: string): void {
  const box = el(panel, "[data-logs-lines]");
  if (!box) return;
  stream.text += text;
  if (stream.text.length > MAX_SHOWN) stream.text = stream.text.slice(-MAX_SHOWN);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.textContent = stream.text;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function stop(stream: Stream | undefined): void {
  stream?.source?.close();
  if (stream) stream.source = null;
}

/** A Compose section with no container picked: the box's line, no tools, no stream. */
function waitingForPick(panel: HTMLElement): boolean {
  if (!panel.hasAttribute("data-logs-pick")) return false;
  const picked = el<HTMLSelectElement>(panel, "[data-logs-container]")?.value ?? "";
  const tools = el(panel, "[data-logs-tools]");
  if (tools) tools.hidden = picked === "";
  if (picked !== "") return false;
  const previous = streams.get(panel);
  stop(previous);
  streams.set(panel, { source: null, text: "", timer: previous?.timer });
  const box = el(panel, "[data-logs-lines]");
  if (box) box.textContent = box.dataset.logsPlaceholder ?? "";
  setStatus(panel, "");
  return true;
}

function open(panel: HTMLElement): void {
  const serviceId = panel.dataset.runtimeLogs;
  if (!serviceId) return;
  if (waitingForPick(panel)) return;
  const previous = streams.get(panel);
  stop(previous);
  const stream: Stream = { source: null, text: "", timer: previous?.timer };
  streams.set(panel, stream);
  const box = el(panel, "[data-logs-lines]");
  if (box) box.textContent = "";
  const url = logsUrl(serviceId, {
    tail: el<HTMLSelectElement>(panel, "[data-logs-tail]")?.value ?? "100",
    since: el<HTMLInputElement>(panel, "[data-logs-since]")?.value ?? "",
    search: el<HTMLInputElement>(panel, "[data-logs-search]")?.value ?? "",
    follow: el<HTMLInputElement>(panel, "[data-logs-follow]")?.checked ?? true,
    container: el<HTMLSelectElement>(panel, "[data-logs-container]")?.value ?? "",
  });
  setStatus(panel, "Connecting…");
  const source = new EventSource(url, { withCredentials: true });
  stream.source = source;
  let received = false;
  source.addEventListener("open", () => setStatus(panel, ""));
  source.addEventListener("output", (event) => {
    received = true;
    try {
      write(panel, stream, (JSON.parse((event as MessageEvent).data) as { text: string }).text);
    } catch {
      // Skip a piece that doesn't parse.
    }
  });
  source.addEventListener("status", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as {
        connected: boolean;
        message: string;
      };
      setStatus(panel, data.connected ? "" : data.message);
    } catch {
      // Ignore.
    }
  });
  source.addEventListener("gap", (event) => {
    try {
      write(
        panel,
        stream,
        `\n[${(JSON.parse((event as MessageEvent).data) as { message: string }).message}]\n`,
      );
    } catch {
      // Ignore.
    }
  });
  source.addEventListener("end", (event) => {
    stop(stream);
    let message = received ? "" : "No output yet.";
    try {
      const data = JSON.parse((event as MessageEvent).data) as { error: string | null };
      if (data.error) message = data.error;
    } catch {
      // Keep the default.
    }
    setStatus(panel, message);
  });
  source.addEventListener("error", () => {
    if (source.readyState === EventSource.CLOSED) {
      stop(stream);
      // Ask the runtime endpoint why, in the API's words ("The runner on … isn't connected").
      void callApi("GET", `/services/${encodeURIComponent(serviceId)}/runtime`).then(
        () => setStatus(panel, "The log stream closed. Change a filter to open it again."),
        (error) => setStatus(panel, asApiError(error).message),
      );
    }
  });
}

async function fillContainers(panel: HTMLElement): Promise<void> {
  const serviceId = panel.dataset.runtimeLogs;
  const select = el<HTMLSelectElement>(panel, "[data-logs-container]");
  if (!serviceId || !select) return;
  try {
    const runtime = await callApi<{
      containers: { id: string; name: string; state: string; current: boolean }[];
    }>("GET", `/services/${encodeURIComponent(serviceId)}/runtime`);
    if (panel.hasAttribute("data-logs-pick")) {
      // Every container after "Select a container"; one picked from the table stays picked.
      const picked = select.value;
      const known = new Set([...select.options].map((option) => option.value));
      for (const container of runtime.containers) {
        if (known.has(container.id)) continue;
        const option = document.createElement("option");
        option.value = container.id;
        option.textContent = `${container.name} · ${container.state}`;
        select.append(option);
      }
      select.value = picked;
    } else if (runtime.containers.length > 1) {
      select.replaceChildren(
        ...runtime.containers.map((container) => {
          const option = document.createElement("option");
          option.value = container.id;
          option.textContent = `${container.name} · ${container.state}${container.current ? " (current)" : ""}`;
          option.selected = container.current;
          return option;
        }),
      );
      const wrap = el(panel, "[data-logs-container-wrap]");
      if (wrap) wrap.hidden = false;
    }
  } catch {
    // The stream says why when it can't open.
  }
}

function download(panel: HTMLElement): void {
  const text = streams.get(panel)?.text ?? "";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  link.download = `${panel.dataset.serviceName ?? "service"}-${stamp}.log`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

export function initRuntimeLogs(): void {
  document.addEventListener("astro:page-load", () => {
    for (const panel of document.querySelectorAll<HTMLElement>("[data-runtime-logs]")) {
      open(panel);
      void fillContainers(panel);
    }
  });
  document.addEventListener("astro:before-swap", () => {
    for (const panel of document.querySelectorAll<HTMLElement>("[data-runtime-logs]")) {
      stop(streams.get(panel));
    }
  });
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    const panel = target?.closest<HTMLElement>("[data-runtime-logs]");
    if (!panel || !target?.matches("select, input")) return;
    if (target.matches("[data-logs-search]")) return;
    open(panel);
  });
  document.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    const panel = target?.closest<HTMLElement>("[data-runtime-logs]");
    if (!panel || !target?.matches("[data-logs-search]")) return;
    const stream = streams.get(panel);
    window.clearTimeout(stream?.timer);
    const timer = window.setTimeout(() => open(panel), 400);
    if (stream) stream.timer = timer;
  });
  document.addEventListener("click", async (event) => {
    const target = event.target as Element | null;
    const panel = target?.closest<HTMLElement>("[data-runtime-logs]");
    if (!panel) return;
    if (target?.closest("[data-logs-copy]") && event.isTrusted) {
      const ok = await copyText(streams.get(panel)?.text ?? "", browserCopyEnvironment());
      showToast(ok ? "Logs copied" : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" });
    } else if (target?.closest("[data-logs-download]")) {
      download(panel);
    }
  });
}
