import { mergePaste, publicSecretWarnings, suggestAppNameBase } from "@nearzero/shared/browser";
import { iconSvg } from "../lib/icons.ts";
import { isPublicGitUrl, portProblem, repositoryName } from "../lib/new-application.ts";
import { asApiError, callApi } from "./api.ts";

/**
 * The new-application page (spec 06 6.1): "Create without Git" swaps in the image form (sent by
 * client/create-service.ts); otherwise the Provider → Repository → Configure steps, with the
 * public repository URL check, the app name that follows the display name, and the variable rows
 * with Show, remove, "+ Add variable" and "Paste .env format".
 */

type Step = "provider" | "repository" | "configure";

interface DomainPreview {
  hostname: string | null;
  source: "platform" | "server" | "zone" | "none";
  message: string;
  record: { type: string; name: string; value: string | null; proxy: string } | null;
  zoneOption: { zoneId: string; zoneName: string; hostname: string } | null;
}

let domainTimer: number | undefined;
let domainTicket = 0;

/**
 * The Configure step's Domain (spec 6.1): the hostname the first deploy gives the app on the
 * chosen server (GET /environments/:id/hostname-preview), the server's wildcard record when it
 * needs one, and "Also assign a hostname from the workspace's DNS zone" when a zone exists that
 * the automatic hostname doesn't come from. The zone name chosen is kept on the form for create.
 */
export async function refreshDomainPreview(page: HTMLElement): Promise<void> {
  const configure = page.querySelector<HTMLFormElement>("[data-app-configure]");
  const text = configure?.querySelector<HTMLElement>("[data-app-hostname-preview]");
  if (!configure || !text) return;
  const server = configure.querySelector<HTMLSelectElement>('select[name="serverId"]')?.value ?? "";
  const name = configure.querySelector<HTMLInputElement>('input[name="name"]')?.value.trim() ?? "";
  const ticket = ++domainTicket;
  const record = configure.querySelector<HTMLElement>("[data-app-hostname-record]");
  const option = configure.querySelector<HTMLElement>("[data-app-zone-option]");
  const zoneName = configure.querySelector<HTMLElement>("[data-app-zone-hostname]");
  try {
    const answer = await callApi<DomainPreview>(
      "GET",
      `/environments/${encodeURIComponent(page.dataset.environmentId ?? "")}/hostname-preview?serverId=${encodeURIComponent(server)}&name=${encodeURIComponent(name)}`,
    );
    if (ticket !== domainTicket) return;
    text.textContent = answer.message;
    if (record) {
      record.hidden = !answer.record;
      record.textContent = answer.record
        ? `Hostnames like it need this DNS record once, at your DNS provider: ${answer.record.name} ${answer.record.type} ${answer.record.value ?? "the server's public IPv4"} (${answer.record.proxy}).`
        : "";
    }
    if (option) option.hidden = !answer.zoneOption;
    if (zoneName) zoneName.textContent = answer.zoneOption?.hostname ?? "";
    if (answer.zoneOption) configure.dataset.zoneHostname = answer.zoneOption.hostname;
    else delete configure.dataset.zoneHostname;
  } catch (error) {
    if (ticket !== domainTicket) return;
    text.textContent = asApiError(error).message;
    if (option) option.hidden = true;
    delete configure.dataset.zoneHostname;
  }
}

function refreshDomainSoon(page: HTMLElement): void {
  window.clearTimeout(domainTimer);
  domainTimer = window.setTimeout(() => void refreshDomainPreview(page), 400);
}

/** The answer when the host can't say which branch is the default (spec 6.1: then "main"). */
const BRANCH_UNRESOLVED = "Could not resolve repository branch.";
export const BRANCH_FALLBACK_NOTE =
  "The default branch couldn't be looked up, so the branch is main. Change it if the repository uses another.";

/**
 * Continue on "Public repository URL": the host is asked for the repository's default branch
 * (POST /git/default-branch; SSH addresses start at main), which fills the Branch field. When it
 * can't be looked up (a missing repository, a host without smart HTTP, a timeout) the branch is
 * "main", stays editable, and a note says so (spec 6.1; B3-29). Only an address that isn't a
 * repository URL at all keeps the person on this step.
 */
async function continuePublic(page: HTMLElement, form: HTMLFormElement): Promise<void> {
  const input = form.querySelector<HTMLInputElement>('input[name="repositoryUrl"]');
  if (!input) return;
  if (!isPublicGitUrl(input.value)) {
    fieldError(input, input.dataset.message ?? "");
    input.focus();
    return;
  }
  fieldError(input, null);
  const configure = page.querySelector<HTMLFormElement>("[data-app-configure]");
  if (!configure) return;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  form.setAttribute("data-busy", "");
  submit?.setAttribute("aria-disabled", "true");
  let branch: string;
  let fellBack = false;
  try {
    branch = (
      await callApi<{ branch: string; lookedUp: boolean }>("POST", "/git/default-branch", {
        url: input.value.trim(),
      })
    ).branch;
  } catch (error) {
    const problem = asApiError(error);
    // The address itself is wrong: say so here. Anything else: carry on with "main".
    if (problem.code === "invalid_request" && problem.message !== BRANCH_UNRESOLVED) {
      fieldError(input, problem.message);
      input.focus();
      return;
    }
    branch = "main";
    fellBack = true;
  } finally {
    form.removeAttribute("data-busy");
    submit?.removeAttribute("aria-disabled");
  }
  const note = configure.querySelector<HTMLElement>("[data-branch-note]");
  if (note) {
    note.textContent = fellBack ? BRANCH_FALLBACK_NOTE : "";
    note.hidden = !fellBack;
  }
  const repository = configure.querySelector<HTMLInputElement>('input[name="repository"]');
  if (repository) repository.value = input.value.trim();
  const branchInput = configure.querySelector<HTMLInputElement>('input[name="branch"]');
  if (branchInput) branchInput.value = branch;
  const display = configure.querySelector<HTMLInputElement>('input[name="name"]');
  if (display && !display.value) display.value = repositoryName(input.value);
  syncAppName(configure, page.dataset.projectName ?? "");
  showStep(page, "configure");
  void refreshDomainPreview(page);
  display?.focus();
}

function root(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-new-app]") ?? null;
}

function showStep(page: HTMLElement, step: Step): void {
  for (const panel of page.querySelectorAll<HTMLElement>("[data-step]")) {
    panel.hidden = panel.dataset.step !== step;
  }
  for (const mark of page.querySelectorAll<HTMLElement>("[data-step-mark]")) {
    if (mark.dataset.stepMark === step) mark.setAttribute("aria-current", "step");
    else mark.removeAttribute("aria-current");
  }
}

function fieldError(input: HTMLInputElement, message: string | null): void {
  const slot = input.closest("[data-field]")?.querySelector<HTMLElement>("[data-field-error]");
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  if (slot) {
    slot.textContent = message ?? "";
    slot.hidden = !message;
  }
}

function envRow(name = "", value = ""): HTMLElement {
  const row = document.createElement("div");
  row.className = "nz-var-edit-row";
  row.dataset.envRow = "";
  const nameInput = document.createElement("input");
  nameInput.className = "nz-input";
  nameInput.placeholder = "NAME";
  nameInput.value = name;
  nameInput.setAttribute("aria-label", "Variable name");
  nameInput.dataset.envName = "";
  const valueInput = document.createElement("input");
  valueInput.className = "nz-input nz-masked";
  valueInput.placeholder = "value";
  valueInput.value = value;
  valueInput.setAttribute("aria-label", "Variable value");
  valueInput.dataset.envValue = "";
  for (const input of [nameInput, valueInput]) {
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("data-1p-ignore", "");
    input.setAttribute("data-lpignore", "true");
  }
  const tools = document.createElement("span");
  tools.className = "flex gap-1";
  const show = document.createElement("button");
  show.type = "button";
  show.className = "nz-btn nz-btn--icon";
  show.innerHTML = iconSvg("eye");
  show.setAttribute("aria-label", "Show value");
  show.dataset.envShow = "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "nz-btn nz-btn--icon";
  remove.innerHTML = iconSvg("trash");
  remove.setAttribute("aria-label", "Remove variable");
  remove.dataset.envRemove = "";
  tools.append(show, remove);
  row.append(nameInput, valueInput, tools);
  return row;
}

function rows(page: HTMLElement): { name: string; value: string }[] {
  return Array.from(page.querySelectorAll<HTMLElement>("[data-env-row]")).map((row) => ({
    name: row.querySelector<HTMLInputElement>("[data-env-name]")?.value.trim() ?? "",
    value: row.querySelector<HTMLInputElement>("[data-env-value]")?.value ?? "",
  }));
}

function notes(page: HTMLElement, messages: string[], tone: "info" | "warn" = "info"): void {
  const slot = page.querySelector<HTMLElement>("[data-app-env-notes]");
  if (!slot) return;
  const warnings = publicSecretWarnings(rows(page).map((row) => row.name)).map(
    (warning) => `${warning.message} It must be renamed before the app is created.`,
  );
  slot.replaceChildren(
    ...[
      ...messages.map((text) => ({ text, tone })),
      ...warnings.map((text) => ({ text, tone: "warn" as const })),
    ].map((item) => {
      const element = document.createElement("p");
      element.className = item.tone === "warn" ? "nz-inline-note nz-warn-note" : "nz-inline-note";
      element.textContent = item.text;
      return element;
    }),
  );
}

function setRows(page: HTMLElement, list: { name: string; value: string }[]): void {
  page
    .querySelector<HTMLElement>("[data-app-env-rows]")
    ?.replaceChildren(...list.map((row) => envRow(row.name, row.value)));
}

function syncAppName(form: HTMLElement, projectName: string): void {
  const appName = form.querySelector<HTMLInputElement>("[data-app-name]");
  if (!appName || appName.dataset.edited === "true") return;
  const name = form.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "";
  appName.value = name.trim() ? suggestAppNameBase(projectName, name) : "";
}

export function initNewApplication(): void {
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    const page = root(target);
    if (page && target?.matches('[data-app-configure] select[name="serverId"]')) {
      void refreshDomainPreview(page);
      return;
    }
    if (!page || !target?.matches("[data-app-without-git]")) return;
    const git = page.querySelector<HTMLElement>("[data-app-git]");
    const image = page.querySelector<HTMLElement>("[data-app-image]");
    if (git) git.hidden = target.checked;
    if (image) image.hidden = !target.checked;
    if (target.checked) image?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const page = root(form);
    if (!page) return;
    if (form.matches("[data-app-public-url]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void continuePublic(page, form);
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;
    const page = root(target);
    if (!page || !target) return;
    const configure = target.closest<HTMLFormElement>("[data-app-configure]");
    if (!configure) return;
    if (target.matches("[data-app-name]")) target.dataset.edited = "true";
    if (target.name === "name") {
      syncAppName(configure, page.dataset.projectName ?? "");
      refreshDomainSoon(page);
    }
    if (target.matches("[data-port]"))
      fieldError(target, target.value ? portProblem(target.value) : null);
    if (target.matches("[data-env-name]")) notes(page, []);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const page = root(target);
    if (!page) return;
    const go = target?.closest<HTMLElement>("[data-step-go]");
    if (go) {
      showStep(page, go.dataset.stepGo as Step);
      return;
    }
    if (target?.closest("[data-app-env-add]")) {
      const row = envRow();
      page.querySelector("[data-app-env-rows]")?.append(row);
      row.querySelector<HTMLInputElement>("[data-env-name]")?.focus();
      return;
    }
    const show = target?.closest<HTMLElement>("[data-env-show]");
    if (show) {
      const value = show
        .closest("[data-env-row]")
        ?.querySelector<HTMLInputElement>("[data-env-value]");
      const masked = value?.classList.toggle("nz-masked") ?? true;
      show.setAttribute("aria-label", masked ? "Show value" : "Hide value");
      return;
    }
    const remove = target?.closest<HTMLElement>("[data-env-remove]");
    if (remove) {
      remove.closest("[data-env-row]")?.remove();
      notes(page, []);
      return;
    }
    if (target?.closest("[data-app-env-paste-toggle]")) {
      const box = page.querySelector<HTMLElement>("[data-app-env-paste]");
      if (box) box.hidden = !box.hidden;
      box?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      return;
    }
    if (target?.closest("[data-app-env-paste-apply]")) {
      const area = page.querySelector<HTMLTextAreaElement>("[data-app-env-paste-text]");
      if (!area?.value.trim()) return;
      const current = rows(page).filter((row) => row.name || row.value);
      const merged = mergePaste(current, area.value);
      setRows(page, merged.rows);
      area.value = "";
      const box = page.querySelector<HTMLElement>("[data-app-env-paste]");
      if (box) box.hidden = true;
      notes(page, merged.messages);
    }
  });
}
