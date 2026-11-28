import { asApiError, callApi, clearErrors, refreshPage, showErrors } from "./api.ts";
import { rememberLiveAt } from "./deploys.ts";
import { recordRow } from "./records.ts";
import { showToast } from "./toasts.ts";

/**
 * A service's Add domain dialog (spec 10.6). Generate asks GET …/hostnames/suggestion ("It will
 * be live at https://…", the server's missing record with Check again, or nothing to generate
 * under with "Open Domains"); Use my own domain previews the name (POST /domains/hostnames/preview:
 * the A record, and whether it already points at the service's server). Port and path come from
 * the service; Compose services pick the inner service. Adding is all or nothing: a route that
 * can't be written saves nothing, and the reason is shown.
 */

interface Suggestion {
  available: boolean;
  hostname?: string;
  message: string;
  record?: { type: string; name: string; value: string | null; message: string; status: string };
  composeServices?: { name: string; port: number | null }[];
  servicePort?: number | null;
}

let ticket = 0;
let previewTimer: number | undefined;

function form(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>("[data-add-domain]");
}

function serviceOf(box: HTMLFormElement): { id: string; kind: string; port: string } {
  const option = box.querySelector<HTMLSelectElement>("[data-domain-service]")?.selectedOptions[0];
  return {
    id: option?.value ?? "",
    kind: option?.dataset.kind ?? "",
    port: option?.dataset.port ?? "",
  };
}

function modeOf(box: HTMLFormElement): "generate" | "own" {
  return box.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value === "own"
    ? "own"
    : "generate";
}

function fillCompose(
  box: HTMLFormElement,
  services: { name: string; port: number | null }[],
): void {
  const select = box.querySelector<HTMLSelectElement>("[data-domain-compose-select]");
  if (!select) return;
  const current = select.value;
  select.replaceChildren(
    new Option("Choose a service", ""),
    ...services.map(
      (item) => new Option(item.port ? `${item.name} (port ${item.port})` : item.name, item.name),
    ),
  );
  if (services.some((item) => item.name === current)) select.value = current;
  else if (services.length === 1) select.value = services[0]?.name ?? "";
}

async function loadSuggestion(box: HTMLFormElement): Promise<void> {
  const service = serviceOf(box);
  const mine = ++ticket;
  const text = box.querySelector<HTMLElement>("[data-domain-suggestion]");
  const recordCard = box.querySelector<HTMLElement>("[data-domain-record]");
  const openDomains = box.querySelector<HTMLElement>("[data-domain-open]");
  const submit = box.querySelector<HTMLButtonElement>("[data-domain-submit]");
  if (!service.id) return;
  try {
    const suggestion = await callApi<Suggestion>(
      "GET",
      `/services/${encodeURIComponent(service.id)}/hostnames/suggestion`,
    );
    if (mine !== ticket) return;
    if (text) text.textContent = suggestion.message;
    if (openDomains) openDomains.hidden = suggestion.available;
    if (submit && modeOf(box) === "generate") submit.disabled = !suggestion.available;
    if (recordCard) {
      recordCard.hidden = !suggestion.record;
      if (suggestion.record) {
        const message = box.querySelector<HTMLElement>("[data-domain-record-message]");
        if (message) message.textContent = suggestion.record.message;
        box
          .querySelector("[data-domain-record-row]")
          ?.replaceChildren(recordRow(suggestion.record));
      }
    }
    fillCompose(box, suggestion.composeServices ?? []);
    const port = box.querySelector<HTMLInputElement>("[data-domain-port]");
    if (port && !port.dataset.edited && suggestion.servicePort)
      port.value = String(suggestion.servicePort);
  } catch (error) {
    if (mine !== ticket) return;
    if (text) text.textContent = asApiError(error).message;
    if (submit && modeOf(box) === "generate") submit.disabled = true;
  }
}

async function preview(box: HTMLFormElement): Promise<void> {
  const host = box.querySelector<HTMLInputElement>("[data-domain-host]");
  const card = box.querySelector<HTMLElement>("[data-domain-own-record]");
  const status = box.querySelector<HTMLElement>("[data-domain-own-status]");
  const submit = box.querySelector<HTMLButtonElement>("[data-domain-submit]");
  const hostname = host?.value.trim() ?? "";
  if (!host || !card) return;
  if (!hostname) {
    card.hidden = true;
    return;
  }
  const mine = ++ticket;
  try {
    const answer = await callApi<{
      valid: boolean;
      message: string;
      record: { type: string; name: string; fullName?: string; value: string | null } | null;
      canAdd: boolean;
      hint?: string | null;
      proxyWarning?: string | null;
      addressHelp?: string | null;
    }>("POST", "/domains/hostnames/preview", { hostname, serviceId: serviceOf(box).id });
    if (mine !== ticket) return;
    const slot = host.closest("[data-field]")?.querySelector<HTMLElement>("[data-field-error]");
    if (!answer.valid) {
      card.hidden = true;
      if (slot) {
        slot.textContent = answer.message;
        slot.hidden = false;
      }
      if (submit) submit.disabled = true;
      return;
    }
    if (slot) slot.hidden = true;
    card.hidden = !answer.record;
    if (answer.record) {
      box
        .querySelector("[data-domain-own-record-row]")
        ?.replaceChildren(
          recordRow({ ...answer.record, name: answer.record.fullName ?? answer.record.name }),
        );
    }
    if (status)
      status.textContent = [answer.message, answer.proxyWarning, answer.addressHelp]
        .filter(Boolean)
        .join(" ");
    if (submit) submit.disabled = !answer.canAdd;
  } catch (error) {
    if (mine !== ticket) return;
    if (status) status.textContent = asApiError(error).message;
  }
}

function sync(box: HTMLFormElement, serviceChanged: boolean): void {
  const service = serviceOf(box);
  const compose = box.querySelector<HTMLElement>("[data-domain-compose]");
  if (compose) compose.hidden = service.kind !== "compose";
  const port = box.querySelector<HTMLInputElement>("[data-domain-port]");
  if (port && serviceChanged) {
    port.value = service.port;
    delete port.dataset.edited;
  }
  const mode = modeOf(box);
  for (const panel of box.querySelectorAll<HTMLElement>("[data-domain-panel]")) {
    panel.hidden = panel.dataset.domainPanel !== mode;
  }
  const submit = box.querySelector<HTMLButtonElement>("[data-domain-submit]");
  if (submit) {
    submit.textContent = mode === "own" ? "Add domain" : "Generate domain";
    submit.disabled = mode === "own";
  }
  clearErrors(box);
  if (mode === "generate") void loadSuggestion(box);
  else void preview(box);
}

function placement(box: HTMLFormElement): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const port = box.querySelector<HTMLInputElement>("[data-domain-port]")?.value.trim();
  if (port) body.port = Number(port);
  const path = box.querySelector<HTMLInputElement>('input[name="path"]')?.value.trim();
  if (path) body.path = path;
  if (serviceOf(box).kind === "compose") {
    const inner = box.querySelector<HTMLSelectElement>("[data-domain-compose-select]")?.value;
    if (inner) body.composeService = inner;
  }
  return body;
}

async function submit(box: HTMLFormElement): Promise<void> {
  const service = serviceOf(box);
  const mode = modeOf(box);
  box.setAttribute("data-busy", "");
  try {
    const answer =
      mode === "generate"
        ? await callApi<{
            hostname: { url: string };
            message: string;
            missingRecord: { message: string } | null;
          }>(
            "POST",
            `/services/${encodeURIComponent(service.id)}/hostnames/generate`,
            placement(box),
          )
        : await callApi<{ hostname: { url: string }; message: string; missingRecord?: null }>(
            "POST",
            "/domains/hostnames",
            {
              hostname:
                box.querySelector<HTMLInputElement>("[data-domain-host]")?.value.trim() ?? "",
              connect: { serviceId: service.id, ...placement(box) },
            },
          );
    showToast(answer.message, { tone: "success" });
    if (answer.missingRecord)
      showToast(answer.missingRecord.message, { tone: "info", persist: true });
    rememberLiveAt(service.id, answer.hostname.url);
    box.closest("dialog")?.close();
    await refreshPage();
  } catch (error) {
    const problem = asApiError(error);
    showErrors(box, problem);
  } finally {
    box.removeAttribute("data-busy");
  }
}

export function initAddDomain(): void {
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    const box = target?.closest<HTMLFormElement>("[data-add-domain]");
    if (box && !target?.matches("[data-domain-host], [data-domain-port], input[name='path']")) {
      sync(box, target?.matches("[data-domain-service]") ?? false);
    }
  });
  document.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    const box = target?.closest<HTMLFormElement>("[data-add-domain]");
    if (!box) return;
    if (target?.matches("[data-domain-port]")) (target as HTMLInputElement).dataset.edited = "true";
    if (target?.matches("[data-domain-host]")) {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => void preview(box), 500);
    }
  });
  // Runs after dialogs.ts filled the service and mode from the opener.
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest('[data-dialog-open="nz-add-domain"]')) {
      const box = form();
      if (box) sync(box, true);
      return;
    }
    const box = target?.closest<HTMLFormElement>("[data-add-domain]");
    if (!box) return;
    if (target?.closest("[data-domain-check]")) {
      event.preventDefault();
      void loadSuggestion(box);
    } else if (target?.closest("[data-domain-own-check]")) {
      event.preventDefault();
      void preview(box);
    }
  });
  document.addEventListener("submit", (event) => {
    const box = event.target;
    if (!(box instanceof HTMLFormElement) || !box.matches("[data-add-domain]")) return;
    event.preventDefault();
    if (!box.hasAttribute("data-busy")) void submit(box);
  });
}
