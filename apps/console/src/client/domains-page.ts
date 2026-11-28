import type { HostnameEntry } from "../lib/data/operations-types.ts";
import {
  dnsPill,
  httpsPill,
  httpsStepMessage,
  WIZARD_CHECK_MS,
  WIZARD_STEPS,
  type WizardStep,
  wizardDnsLabel,
} from "../lib/domains.ts";
import {
  asApiError,
  callApi,
  clearErrors,
  refreshPage,
  sendForm,
  showErrors,
  showFormError,
} from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { recordRow } from "./records.ts";
import { showToast } from "./toasts.ts";

/**
 * The Domains page in the browser (spec 10.3–10.8): the Automatic hostnames card's Check again
 * and Give N a hostname, the Hostnames tab's Refresh, row actions and Details, Connect a service,
 * the Add domain wizard (Hostname → Service → DNS → HTTPS, checking every 8 seconds), and the DNS
 * zones' Apply, Records and Connect a DNS zone. Every refusal shows the API's words.
 */

// ---------- Small helpers

function element<T extends HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

async function act(path: string, body?: unknown): Promise<{ message?: string } | null> {
  try {
    const answer = await callApi<{ message?: string }>("POST", path, body);
    if (answer?.message) showToast(answer.message, { tone: "success" });
    return answer;
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
    return null;
  }
}

// ---------- Project → Environment → Service pickers

interface PickedService {
  id: string;
  kind: string;
  settings: Record<string, unknown>;
}

const pickerServices = new WeakMap<HTMLElement, Map<string, PickedService>>();

async function fillServices(
  picker: HTMLElement,
  environmentId: string,
  chosen?: string,
): Promise<void> {
  const select = element<HTMLSelectElement>(picker, '[data-pick="service"]');
  if (!select) return;
  select.replaceChildren(option("", "Loading…"));
  try {
    const { services } = await callApi<{ services: (PickedService & { name: string })[] }>(
      "GET",
      `/environments/${encodeURIComponent(environmentId)}/services`,
    );
    const routable = services.filter(
      (item) => item.kind === "application" || item.kind === "compose",
    );
    pickerServices.set(picker, new Map(routable.map((item) => [item.id, item])));
    select.replaceChildren(
      ...(routable.length === 0 ? [option("", "No apps or Compose services here")] : []),
      ...routable.map((item) => option(item.id, item.name)),
    );
    if (chosen && routable.some((item) => item.id === chosen)) select.value = chosen;
    await serviceChosen(picker);
  } catch (error) {
    select.replaceChildren(option("", asApiError(error).message));
  }
}

async function fillEnvironments(
  picker: HTMLElement,
  projectId: string,
  preset?: { environmentId?: string; serviceId?: string },
): Promise<void> {
  const select = element<HTMLSelectElement>(picker, '[data-pick="environment"]');
  if (!select) return;
  select.replaceChildren(option("", "Loading…"));
  try {
    const { environments } = await callApi<{ environments: { id: string; name: string }[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/environments`,
    );
    select.replaceChildren(...environments.map((item) => option(item.id, item.name)));
    if (preset?.environmentId) select.value = preset.environmentId;
    if (select.value) await fillServices(picker, select.value, preset?.serviceId);
  } catch (error) {
    select.replaceChildren(option("", asApiError(error).message));
  }
}

async function serviceChosen(picker: HTMLElement): Promise<void> {
  const id = element<HTMLSelectElement>(picker, '[data-pick="service"]')?.value ?? "";
  const service = pickerServices.get(picker)?.get(id);
  const composeWrap = element<HTMLElement>(picker, "[data-pick-compose-wrap]");
  const compose = element<HTMLSelectElement>(picker, '[data-pick="compose"]');
  const port = element<HTMLInputElement>(picker, '[data-pick="port"]');
  if (composeWrap) composeWrap.hidden = service?.kind !== "compose";
  if (port) {
    const servicePort = service?.settings?.servicePort;
    port.value =
      service?.kind === "application"
        ? String(typeof servicePort === "number" ? servicePort : 3000)
        : "";
  }
  if (service?.kind === "compose" && compose) {
    compose.replaceChildren(option("", "Loading…"));
    try {
      const answer = await callApi<{ composeServices: { name: string; port: number | null }[] }>(
        "GET",
        `/services/${encodeURIComponent(service.id)}/hostnames`,
      );
      compose.replaceChildren(
        option("", "Choose a service"),
        ...answer.composeServices.map((item) =>
          option(item.name, item.port ? `${item.name} (port ${item.port})` : item.name),
        ),
      );
    } catch {
      compose.replaceChildren(option("", "Couldn't read the Compose file's services"));
    }
  }
}

async function initPicker(picker: HTMLElement, serviceId?: string): Promise<void> {
  const select = element<HTMLSelectElement>(picker, '[data-pick="project"]');
  if (!select) return;
  let preset: { projectId?: string; environmentId?: string; serviceId?: string } = {};
  if (serviceId) {
    try {
      const { service } = await callApi<{ service: { projectId: string; environmentId: string } }>(
        "GET",
        `/services/${encodeURIComponent(serviceId)}`,
      );
      preset = { projectId: service.projectId, environmentId: service.environmentId, serviceId };
    } catch {
      // Pick by hand.
    }
  }
  try {
    const { projects } = await callApi<{
      projects: { id: string; name: string; openEnvironmentId: string | null }[];
    }>("GET", "/projects");
    select.replaceChildren(
      ...(projects.length === 0 ? [option("", "No projects yet")] : []),
      ...projects.map((item) => option(item.id, item.name)),
    );
    if (preset.projectId) select.value = preset.projectId;
    const project = projects.find((item) => item.id === select.value);
    if (project) {
      await fillEnvironments(picker, project.id, {
        environmentId: preset.environmentId ?? project.openEnvironmentId ?? undefined,
        serviceId: preset.serviceId,
      });
    }
  } catch (error) {
    select.replaceChildren(option("", asApiError(error).message));
  }
}

function placement(picker: HTMLElement): Record<string, unknown> {
  const body: Record<string, unknown> = {
    serviceId: element<HTMLSelectElement>(picker, '[data-pick="service"]')?.value ?? "",
  };
  const port = element<HTMLInputElement>(picker, '[data-pick="port"]')?.value.trim();
  if (port) body.port = Number(port);
  const path = element<HTMLInputElement>(picker, '[data-pick="path"]')?.value.trim();
  if (path) body.path = path;
  const composeWrap = element<HTMLElement>(picker, "[data-pick-compose-wrap]");
  const compose = element<HTMLSelectElement>(picker, '[data-pick="compose"]')?.value;
  if (composeWrap && !composeWrap.hidden && compose) body.composeService = compose;
  return body;
}

// ---------- The Add domain wizard (spec 10.5)

interface Preview {
  valid: boolean;
  hostname: string;
  message: string;
  managedChoice: { managed: string; external: string } | null;
  record: { type: string; name: string; fullName?: string; value: string | null } | null;
  hint: string | null;
  proxyWarning: string | null;
  /** The same shape as a hostname's DNS column (HostnameEntry["dns"]). */
  dns: HostnameEntry["dns"] | null;
  target: { id: string; name: string; address: string | null } | null;
  canAdd: boolean;
  addressHelp: string | null;
}

interface Wizard {
  step: WizardStep;
  timer: number | undefined;
  preview: Preview | null;
  added: HostnameEntry | null;
  tries: number;
  changed: boolean;
}

const wizard: Wizard = {
  step: "hostname",
  timer: undefined,
  preview: null,
  added: null,
  tries: 0,
  changed: false,
};

function wizardDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("[data-domain-wizard]");
}

function showStep(dialog: HTMLElement, step: WizardStep): void {
  wizard.step = step;
  for (const panel of dialog.querySelectorAll<HTMLElement>("[data-wizard-step]")) {
    panel.hidden = panel.dataset.wizardStep !== step;
  }
  for (const mark of dialog.querySelectorAll<HTMLElement>("[data-wizard-mark]")) {
    if (mark.dataset.wizardMark === step) mark.setAttribute("aria-current", "step");
    else mark.removeAttribute("aria-current");
  }
  const at = WIZARD_STEPS.indexOf(step);
  const toggle = (selector: string, shown: boolean) => {
    const item = element<HTMLElement>(dialog, selector);
    if (item) item.hidden = !shown;
  };
  toggle("[data-wizard-back]", at > 0 && step !== "https");
  toggle("[data-wizard-cancel]", step !== "https");
  toggle("[data-wizard-next]", step === "hostname" || step === "service");
  toggle("[data-wizard-add]", step === "dns");
  toggle("[data-wizard-done]", step === "https");
}

function stopTimer(): void {
  window.clearInterval(wizard.timer);
  wizard.timer = undefined;
}

function hostnameValue(dialog: HTMLElement): string {
  return element<HTMLInputElement>(dialog, "[data-wizard-host]")?.value.trim() ?? "";
}

function connecting(dialog: HTMLElement): boolean {
  return element<HTMLInputElement>(dialog, "[data-wizard-connect]")?.checked ?? true;
}

function fieldError(dialog: HTMLElement, selector: string, message: string | null): void {
  const field = element<HTMLElement>(dialog, selector);
  const slot = field?.closest("[data-field]")?.querySelector<HTMLElement>("[data-field-error]");
  if (message) field?.setAttribute("aria-invalid", "true");
  else field?.removeAttribute("aria-invalid");
  if (slot) {
    slot.textContent = message ?? "";
    slot.hidden = !message;
  }
}

async function askPreview(dialog: HTMLElement, withTarget: boolean): Promise<Preview | null> {
  const body: Record<string, unknown> = { hostname: hostnameValue(dialog) };
  if (withTarget) {
    const picker = element<HTMLElement>(dialog, "[data-service-picker]");
    if (connecting(dialog) && picker) body.serviceId = placement(picker).serviceId;
    else body.serverId = element<HTMLSelectElement>(dialog, "[data-wizard-server]")?.value;
  }
  try {
    return await callApi<Preview>("POST", "/domains/hostnames/preview", body);
  } catch (error) {
    const form = element<HTMLFormElement>(dialog, "[data-wizard-form]");
    if (form) showFormError(form, asApiError(error).message);
    return null;
  }
}

function dnsChoice(dialog: HTMLElement): "managed" | "external" {
  return element<HTMLInputElement>(dialog, 'input[name="dns"]:checked')?.value === "external"
    ? "external"
    : "managed";
}

function paintPreview(dialog: HTMLElement, preview: Preview): void {
  wizard.preview = preview;
  const managed = element<HTMLElement>(dialog, "[data-wizard-managed]");
  if (managed) managed.hidden = !preview.managedChoice;
  if (preview.managedChoice) {
    for (const label of dialog.querySelectorAll<HTMLElement>("[data-wizard-managed-label]")) {
      label.textContent =
        label.dataset.wizardManagedLabel === "managed"
          ? preview.managedChoice.managed
          : preview.managedChoice.external;
    }
  }
  const external = !preview.managedChoice || dnsChoice(dialog) === "external";
  const card = element<HTMLElement>(dialog, "[data-wizard-record]");
  if (card) card.hidden = !preview.record || !external;
  if (preview.record) {
    element(dialog, "[data-wizard-record-row]")?.replaceChildren(
      recordRow({
        type: preview.record.type,
        name: preview.record.name,
        value: preview.record.value,
      }),
    );
  }
  const hint = element<HTMLElement>(dialog, "[data-wizard-hint]");
  if (hint) hint.textContent = preview.hint ?? "";
  const proxy = element<HTMLElement>(dialog, "[data-wizard-proxy]");
  if (proxy) {
    proxy.textContent = preview.proxyWarning ?? "";
    proxy.hidden = !preview.proxyWarning;
  }
  const status = element<HTMLElement>(dialog, "[data-wizard-dns-status]");
  if (status) {
    status.textContent =
      preview.managedChoice && !external
        ? preview.message
        : preview.dns
          ? [
              `${wizardDnsLabel(preview.dns.status, preview.dns.proxiedBy, Boolean(preview.target?.address))}. ${preview.dns.note}`,
              ...(preview.dns.aliasOf ? [`Alias of ${preview.dns.aliasOf}.`] : []),
              // Points here, with what could still send Let's Encrypt elsewhere (R3-17).
              ...(preview.dns.warnings ?? []),
            ].join(" ")
          : preview.message;
    status.dataset.status = dnsPill(preview.dns?.status ?? "unknown");
  }
  const address = element<HTMLElement>(dialog, "[data-wizard-address]");
  if (address) {
    address.hidden = !preview.addressHelp;
    const text = element<HTMLElement>(address, "[data-wizard-address-text]");
    if (text) text.textContent = preview.addressHelp ?? "";
  }
  const add = element<HTMLButtonElement>(dialog, "[data-wizard-add]");
  const pointsHere = preview.dns?.status === "points_here";
  if (add)
    add.disabled = !(preview.managedChoice && !external
      ? preview.canAdd
      : pointsHere || (!preview.managedChoice && preview.canAdd));
}

async function nextStep(dialog: HTMLElement): Promise<void> {
  const form = element<HTMLFormElement>(dialog, "[data-wizard-form]");
  if (form) clearErrors(form);
  if (wizard.step === "hostname") {
    const hostname = hostnameValue(dialog);
    if (!hostname) {
      fieldError(dialog, "[data-wizard-host]", "Enter a hostname, like app.example.com.");
      return;
    }
    const preview = await askPreview(dialog, false);
    if (!preview) return;
    if (!preview.valid) {
      fieldError(dialog, "[data-wizard-host]", preview.message);
      return;
    }
    fieldError(dialog, "[data-wizard-host]", null);
    showStep(dialog, "service");
    return;
  }
  if (wizard.step === "service") {
    const picker = element<HTMLElement>(dialog, "[data-service-picker]");
    if (connecting(dialog) && picker && !placement(picker).serviceId) {
      if (form) showFormError(form, 'Pick a service, or untick "Connect it to a service now".');
      return;
    }
    const preview = await askPreview(dialog, true);
    if (!preview) return;
    if (!preview.valid) {
      if (form) showFormError(form, preview.message);
      return;
    }
    showStep(dialog, "dns");
    paintPreview(dialog, preview);
    stopTimer();
    // Live status every 8 seconds (spec 10.5 step 3).
    wizard.timer = window.setInterval(async () => {
      if (wizard.step !== "dns") return stopTimer();
      const again = await askPreview(dialog, true);
      if (again && wizard.step === "dns") paintPreview(dialog, again);
    }, WIZARD_CHECK_MS);
  }
}

async function followHttps(dialog: HTMLElement, id: string): Promise<void> {
  const status = element<HTMLElement>(dialog, "[data-wizard-https-status]");
  const open = element<HTMLElement>(dialog, "[data-wizard-open]");
  const link = element<HTMLAnchorElement>(dialog, "[data-wizard-open-link]");
  try {
    const { hostname } = await callApi<{ hostname: HostnameEntry }>(
      "GET",
      `/domains/hostnames/${encodeURIComponent(id)}`,
    );
    wizard.tries++;
    const step = httpsStepMessage(hostname, wizard.tries);
    if (status) {
      status.textContent = step.message;
      status.dataset.status = httpsPill(hostname.https.state);
    }
    if (step.done) {
      stopTimer();
      if (hostname.service && link && open) {
        link.href = hostname.url;
        link.textContent = `Open ${hostname.url}`;
        open.hidden = false;
      }
    }
  } catch (error) {
    if (status) status.textContent = asApiError(error).message;
  }
}

async function addFromWizard(dialog: HTMLElement): Promise<void> {
  const form = element<HTMLFormElement>(dialog, "[data-wizard-form]");
  if (!form || form.hasAttribute("data-busy")) return;
  clearErrors(form);
  const picker = element<HTMLElement>(dialog, "[data-service-picker]");
  const body: Record<string, unknown> = { hostname: hostnameValue(dialog) };
  if (connecting(dialog) && picker) body.connect = placement(picker);
  else body.serverId = element<HTMLSelectElement>(dialog, "[data-wizard-server]")?.value;
  if (wizard.preview?.managedChoice) body.dns = dnsChoice(dialog);
  form.setAttribute("data-busy", "");
  try {
    const answer = await callApi<{ hostname: HostnameEntry; message: string }>(
      "POST",
      "/domains/hostnames",
      body,
    );
    wizard.changed = true;
    wizard.added = answer.hostname;
    stopTimer();
    showStep(dialog, "https");
    const status = element<HTMLElement>(dialog, "[data-wizard-https-status]");
    if (status) status.textContent = answer.message;
    showToast(answer.message, { tone: "success" });
    if (answer.hostname.service) {
      wizard.tries = 0;
      wizard.timer = window.setInterval(
        () => void followHttps(dialog, answer.hostname.id),
        WIZARD_CHECK_MS,
      );
      void followHttps(dialog, answer.hostname.id);
    }
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    form.removeAttribute("data-busy");
  }
}

function openWizard(opener: HTMLElement): void {
  const dialog = wizardDialog();
  if (!dialog) return;
  stopTimer();
  wizard.preview = null;
  wizard.added = null;
  wizard.changed = false;
  const form = element<HTMLFormElement>(dialog, "[data-wizard-form]");
  form?.reset();
  if (form) clearErrors(form);
  fieldError(dialog, "[data-wizard-host]", null);
  const connect = element<HTMLInputElement>(dialog, "[data-wizard-connect]");
  if (connect) connect.checked = true;
  syncConnect(dialog);
  showStep(dialog, "hostname");
  openDialog(dialog, opener);
  const picker = element<HTMLElement>(dialog, "[data-service-picker]");
  if (picker) void initPicker(picker, opener.dataset.wizardService);
}

function syncConnect(dialog: HTMLElement): void {
  const on = connecting(dialog);
  const shown = element<HTMLElement>(dialog, "[data-wizard-connect-on]");
  const off = element<HTMLElement>(dialog, "[data-wizard-connect-off]");
  if (shown) shown.hidden = !on;
  if (off) off.hidden = on;
}

// ---------- Hostname details (spec 10.4)

function section(title: string, rows: [string, string | Node][]): HTMLElement {
  const box = document.createElement("section");
  box.className = "nz-stack-sm";
  const heading = document.createElement("h3");
  heading.className = "nz-subtitle";
  heading.textContent = title;
  const list = document.createElement("dl");
  list.className = "nz-detail-list";
  for (const [label, value] of rows) {
    const item = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.append(value);
    item.append(term, detail);
    list.append(item);
  }
  box.append(heading, list);
  return box;
}

async function showDetails(id: string, opener: Element): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>("#nz-hostname-details");
  const body = dialog ? element<HTMLElement>(dialog, "[data-details-body]") : null;
  if (!dialog || !body) return;
  body.replaceChildren(
    Object.assign(document.createElement("p"), { className: "nz-dim", textContent: "Loading…" }),
  );
  openDialog(dialog, opener);
  try {
    const { hostname } = await callApi<{ hostname: HostnameEntry }>(
      "GET",
      `/domains/hostnames/${encodeURIComponent(id)}`,
    );
    const title = element<HTMLElement>(dialog, ".nz-dialog-title");
    if (title) title.textContent = hostname.hostname;
    const service = hostname.service;
    const parts: HTMLElement[] = [
      section(
        "Service",
        service
          ? [
              [
                "Service",
                `${service.name}${service.composeService ? ` · ${service.composeService}` : ""}`,
              ],
              ["Project", `${service.projectName} / ${service.environmentName}`],
              ["Port and path", `${service.port ?? "—"} · ${service.path}`],
              ["Server", hostname.target.name],
            ]
          : [
              ["Service", "Not connected"],
              ["Points at", hostname.target.name],
            ],
      ),
      section("DNS", [
        ["Status", hostname.dns.label],
        ["Check", hostname.dns.note],
        ["Source", hostname.sourceLabel],
        ["Addresses", hostname.dns.addresses.join(", ") || "—"],
        ...(hostname.dns.aliasOf ? [["Alias of", hostname.dns.aliasOf] as [string, string]] : []),
        // What could still send Let's Encrypt elsewhere though it points here (R3-17).
        ...(hostname.dns.warnings ?? []).map((warning) => ["Warning", warning] as [string, string]),
      ]),
    ];
    if (hostname.dns.record && hostname.dns.status !== "points_here") {
      parts[1]?.append(recordRow(hostname.dns.record));
    }
    const https: [string, string][] = [
      ["Status", hostname.https.label],
      ["Note", hostname.https.note],
    ];
    if (hostname.https.certificate) {
      https.push(["Issuer", hostname.https.certificate.issuer]);
      https.push(["Valid until", new Date(hostname.https.certificate.notAfter).toLocaleString()]);
    }
    if (hostname.https.lastError) https.push(["Last error", hostname.https.lastError]);
    if (hostname.https.retryRefusal) https.push(["Retry", hostname.https.retryRefusal]);
    parts.push(section("HTTPS", https));
    body.replaceChildren(...parts);
  } catch (error) {
    body.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "nz-inline-error",
        textContent: asApiError(error).message,
      }),
    );
  }
}

// ---------- Zones and records (spec 10.8)

let recordsZone: string | null = null;

async function loadRecords(dialog: HTMLElement, zoneId: string): Promise<void> {
  recordsZone = zoneId;
  const rows = element<HTMLElement>(dialog, "[data-records-rows]");
  const status = element<HTMLElement>(dialog, "[data-records-status]");
  if (!rows) return;
  try {
    const answer = await callApi<{
      zone: { name: string; statusLabel: string; health: string };
      records: {
        id: string;
        name: string;
        type: string;
        value: string;
        ttl: number;
        priority: number | null;
        managed: boolean;
        managedNote: string | null;
      }[];
    }>("GET", `/domains/zones/${encodeURIComponent(zoneId)}`);
    if (status)
      status.textContent = `${answer.zone.name} · ${answer.zone.statusLabel} · ${answer.zone.health}`;
    rows.replaceChildren(
      ...answer.records.map((record) => {
        const row = document.createElement("tr");
        for (const text of [
          record.name,
          record.type,
          record.priority === null ? record.value : `${record.priority} ${record.value}`,
          String(record.ttl),
        ]) {
          const cell = document.createElement("td");
          cell.textContent = text;
          if (text === record.value) cell.className = "nz-code nz-small";
          row.append(cell);
        }
        const actions = document.createElement("td");
        actions.className = "nz-col-actions";
        if (record.managed) {
          actions.textContent = record.managedNote ?? "Managed by Nearzero";
          actions.classList.add("nz-small", "nz-dim");
        } else {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "nz-btn nz-btn--ghost";
          remove.textContent = "Delete";
          remove.dataset.recordDelete = record.id;
          actions.append(remove);
        }
        row.append(actions);
        return row;
      }),
    );
  } catch (error) {
    if (status) status.textContent = asApiError(error).message;
  }
}

async function addRecord(form: HTMLFormElement): Promise<void> {
  if (!recordsZone) return;
  clearErrors(form);
  const read = (name: string) =>
    form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value.trim() ??
    "";
  const body: Record<string, unknown> = {
    name: read("name") || "@",
    type: read("type"),
    value: read("value"),
  };
  if (read("ttl")) body.ttl = Number(read("ttl"));
  if (read("type") === "MX" && read("priority")) body.priority = Number(read("priority"));
  try {
    await callApi("POST", `/domains/zones/${encodeURIComponent(recordsZone)}/records`, body);
    showToast("Record added. Press Apply to publish it.", { tone: "success" });
    form.reset();
    const dialog = form.closest<HTMLElement>("dialog");
    if (dialog) await loadRecords(dialog, recordsZone);
  } catch (error) {
    showErrors(form, asApiError(error));
  }
}

// ---------- Wiring

/** "Checked at HH:MM" in the viewer's own clock (the page renders it in UTC). */
function localCheckedAt(): void {
  for (const slot of document.querySelectorAll<HTMLElement>("[data-checked-at]")) {
    const at = new Date(slot.dataset.checkedAt ?? "");
    if (Number.isNaN(at.getTime())) continue;
    slot.textContent = `Checked at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  }
}

export function initDomainsPage(): void {
  document.addEventListener("astro:page-load", localCheckedAt);
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const wizardOpener = target?.closest<HTMLElement>("[data-wizard-open]");
    if (wizardOpener) {
      event.preventDefault();
      openWizard(wizardOpener);
      return;
    }
    const auto = target?.closest<HTMLElement>("[data-auto-action]");
    if (auto) {
      event.preventDefault();
      const id = encodeURIComponent(auto.dataset.targetId ?? "");
      const row = auto.closest<HTMLElement>("[data-auto-row]");
      if (auto.dataset.autoAction === "check") {
        void callApi<{
          row: { badge: string; badgeLabel: string; subtitle: string };
          message: string;
        }>("POST", `/domains/targets/${id}/check`).then(
          (answer) => {
            const pill = row?.querySelector<HTMLElement>(".nz-pill");
            if (pill) {
              pill.textContent = answer.row.badgeLabel;
              pill.dataset.status =
                answer.row.badge === "points_here"
                  ? "ok"
                  : answer.row.badge === "points_elsewhere"
                    ? "fail"
                    : answer.row.badge === "not_set_up"
                      ? "warn"
                      : "idle";
            }
            const message = row?.querySelector<HTMLElement>("[data-auto-message]");
            if (message) message.textContent = answer.message;
            if (answer.row.badge === "points_here") void refreshPage();
          },
          (error) => showToast(asApiError(error).message, { tone: "error", persist: true }),
        );
      } else {
        void act(`/domains/targets/${id}/give-hostnames`).then((answer) => {
          const problems = (answer as { problems?: string[] } | null)?.problems ?? [];
          for (const problem of problems) showToast(problem, { tone: "error", persist: true });
          if (answer) void refreshPage();
        });
      }
      return;
    }
    if (target?.closest("[data-hostnames-refresh]")) {
      event.preventDefault();
      const button = target.closest<HTMLElement>("[data-hostnames-refresh]");
      button?.setAttribute("aria-disabled", "true");
      void callApi("GET", "/domains/hostnames?refresh=1")
        .then(() => refreshPage())
        .catch((error) => showToast(asApiError(error).message, { tone: "error" }))
        .finally(() => button?.removeAttribute("aria-disabled"));
      return;
    }
    const action = target?.closest<HTMLElement>("[data-hostname-action]");
    if (action) {
      event.preventDefault();
      const id = encodeURIComponent(action.dataset.hostnameId ?? "");
      void act(`/domains/hostnames/${id}/${action.dataset.hostnameAction}`).then((answer) => {
        if (answer) void refreshPage();
      });
      return;
    }
    const details = target?.closest<HTMLElement>("[data-hostname-details]");
    if (details) {
      event.preventDefault();
      void showDetails(details.dataset.hostnameDetails ?? "", details);
      return;
    }
    const connect = target?.closest<HTMLElement>("[data-connect-service]");
    if (connect) {
      const picker = document.querySelector<HTMLElement>(
        "#nz-connect-service [data-service-picker]",
      );
      if (picker) void initPicker(picker);
      return;
    }
    const records = target?.closest<HTMLElement>("[data-zone-records]");
    if (records) {
      event.preventDefault();
      const dialog = document.querySelector<HTMLDialogElement>("#nz-zone-records");
      if (!dialog) return;
      const title = element<HTMLElement>(dialog, ".nz-dialog-title");
      if (title) title.textContent = `Records · ${records.dataset.zoneName ?? ""}`;
      openDialog(dialog, records);
      void loadRecords(dialog, records.dataset.zoneRecords ?? "");
      return;
    }
    const apply = target?.closest<HTMLElement>("[data-zone-apply]");
    if (apply) {
      event.preventDefault();
      void act(`/domains/zones/${encodeURIComponent(apply.dataset.zoneApply ?? "")}/apply`).then(
        (answer) => {
          if (answer) void refreshPage();
        },
      );
      return;
    }
    if (target?.closest("[data-zone-apply-all]")) {
      event.preventDefault();
      void act("/domains/zones/apply-all").then((answer) => {
        if (answer) void refreshPage();
      });
      return;
    }
    if (target?.closest("[data-records-apply]") && recordsZone) {
      event.preventDefault();
      const zone = recordsZone;
      void act(`/domains/zones/${encodeURIComponent(zone)}/apply`).then(() => {
        const dialog = document.querySelector<HTMLElement>("#nz-zone-records");
        if (dialog) void loadRecords(dialog, zone);
      });
      return;
    }
    const removeRecord = target?.closest<HTMLElement>("[data-record-delete]");
    if (removeRecord && recordsZone) {
      event.preventDefault();
      const zone = recordsZone;
      void callApi(
        "DELETE",
        `/domains/zones/${encodeURIComponent(zone)}/records/${encodeURIComponent(removeRecord.dataset.recordDelete ?? "")}`,
      )
        .then(() => {
          showToast("Record deleted. Press Apply to publish the change.", { tone: "success" });
          const dialog = document.querySelector<HTMLElement>("#nz-zone-records");
          if (dialog) void loadRecords(dialog, zone);
        })
        .catch((error) => showToast(asApiError(error).message, { tone: "error", persist: true }));
      return;
    }
    // The wizard's own buttons.
    const dialog = target?.closest<HTMLElement>("[data-domain-wizard]");
    if (!dialog) return;
    const parent = target?.closest<HTMLElement>("[data-wizard-parent]");
    if (parent) {
      const host = element<HTMLInputElement>(dialog, "[data-wizard-host]");
      if (host) {
        const label = host.value.trim().split(".")[0] || "app";
        host.value = `${label}.${parent.dataset.wizardParent}`;
        host.focus();
        host.setSelectionRange(0, label.length);
      }
      return;
    }
    if (target?.closest("[data-wizard-next]")) {
      event.preventDefault();
      void nextStep(dialog);
    } else if (target?.closest("[data-wizard-back]")) {
      event.preventDefault();
      stopTimer();
      const at = WIZARD_STEPS.indexOf(wizard.step);
      showStep(dialog, WIZARD_STEPS[Math.max(0, at - 1)] ?? "hostname");
    } else if (target?.closest("[data-wizard-check]")) {
      event.preventDefault();
      void askPreview(dialog, true).then((preview) => {
        if (preview) paintPreview(dialog, preview);
      });
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    const picker = target?.closest<HTMLElement>("[data-service-picker]");
    if (picker && target instanceof HTMLSelectElement) {
      if (target.dataset.pick === "project") void fillEnvironments(picker, target.value);
      else if (target.dataset.pick === "environment") void fillServices(picker, target.value);
      else if (target.dataset.pick === "service") void serviceChosen(picker);
    }
    const dialog = target?.closest<HTMLElement>("[data-domain-wizard]");
    if (dialog && target?.matches("[data-wizard-connect]")) syncConnect(dialog);
    if (dialog && target?.matches('input[name="dns"]') && wizard.preview)
      paintPreview(dialog, wizard.preview);
    if (target?.matches("[data-record-type]")) {
      const priority = target.closest("form")?.querySelector<HTMLElement>("[data-record-priority]");
      if (priority) priority.hidden = (target as HTMLSelectElement).value !== "MX";
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-wizard-form]")) {
      event.preventDefault();
      const dialog = form.closest<HTMLElement>("[data-domain-wizard]");
      if (!dialog) return;
      if (wizard.step === "dns") void addFromWizard(dialog);
      else void nextStep(dialog);
    } else if (form.matches("[data-connect-form]")) {
      event.preventDefault();
      const picker = element<HTMLElement>(form, "[data-service-picker]");
      const id = form.querySelector<HTMLInputElement>('[name="hostnameId"]')?.value ?? "";
      if (!picker) return;
      const body = placement(picker);
      if (!body.serviceId) {
        showFormError(form, "Pick a service to connect.");
        return;
      }
      void callApi<{ message: string }>(
        "POST",
        `/domains/hostnames/${encodeURIComponent(id)}/connect`,
        body,
      ).then(
        (answer) => {
          showToast(answer.message || "Service connected", { tone: "success" });
          form.closest("dialog")?.close();
          void refreshPage();
        },
        (error) => showErrors(form, asApiError(error)),
      );
    } else if (form.matches("[data-zone-connect-form]")) {
      event.preventDefault();
      const read = (name: string) =>
        form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? "";
      const nameservers = read("nameservers")
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      void sendForm(form, {
        domain: read("domain"),
        adminEmail: read("adminEmail"),
        ...(nameservers.length > 0 ? { nameservers } : {}),
      });
    } else if (form.matches("[data-record-form]")) {
      event.preventDefault();
      void addRecord(form);
    }
  });

  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target as Element | null;
      if (!dialog?.matches?.("[data-domain-wizard]")) return;
      stopTimer();
      if (wizard.changed) void refreshPage();
    },
    true,
  );
}
