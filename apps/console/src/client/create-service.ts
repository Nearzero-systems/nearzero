import { navigate } from "astro:transitions/client";
import {
  appNameProblem,
  type DatabaseDefaults,
  databasePasswordProblem,
  suggestAppNameBase,
} from "@nearzero/shared/browser";
import type { CreatedService } from "../lib/data/types.ts";
import { imageProblem } from "../lib/new-application.ts";
import { asApiError, callApi, clearErrors, formBody, showErrors, showFormError } from "./api.ts";
import { followCreatedDeploy } from "./build-panel.ts";
import { deployAndTell } from "./deploys.ts";
import { showToast } from "./toasts.ts";

/**
 * The create dialogs and forms that save a service with no deploy engine needed (spec 08 8.1,
 * 07 7.1, 06 6.1 "Create without Git"). Each is a form with `data-create-service`; its named
 * fields become the request (nested names like `settings.image`), fields of other database
 * types are hidden and left out. After saving it says where else the service was added (spec
 * 05 5.4), starts the first deploy where the page asks for one, and opens the service's page.
 */

function defaultsOf(form: HTMLFormElement): Record<string, DatabaseDefaults> {
  try {
    return JSON.parse(form.dataset.defaults ?? "{}") as Record<string, DatabaseDefaults>;
  } catch {
    return {};
  }
}

function selectedKind(form: HTMLFormElement): string {
  return (
    form.querySelector<HTMLInputElement>('input[name="kind"]:checked')?.value ??
    form.querySelector<HTMLInputElement>('input[name="kind"]')?.value ??
    ""
  );
}

/** Shows the fields the chosen type has; keeps defaults in step unless someone typed over them. */
function syncKind(form: HTMLFormElement, kindChanged: boolean): void {
  const kind = selectedKind(form);
  for (const element of form.querySelectorAll<HTMLElement>("[data-kinds]")) {
    const wrapper = element.closest<HTMLElement>("[data-field]") ?? element;
    wrapper.hidden = !(element.dataset.kinds ?? "").split(" ").includes(kind);
  }
  const role = form.querySelector<HTMLSelectElement>("[data-node-role]")?.value;
  for (const element of form.querySelectorAll<HTMLElement>("[data-replica-only]")) {
    const wrapper = element.closest<HTMLElement>("[data-field]") ?? element;
    wrapper.hidden = role !== "replica";
  }
  if (!kindChanged) return;
  const defaults = defaultsOf(form)[kind];
  for (const input of form.querySelectorAll<HTMLInputElement>("[data-default-of]")) {
    const key = input.dataset.defaultOf as keyof DatabaseDefaults;
    const value = defaults?.[key];
    // Fields that leave the default to the API show it as a placeholder ("Default postgres:18").
    if (input.hasAttribute("data-default-placeholder")) {
      const template = input.dataset.defaultPlaceholder ?? "";
      input.placeholder =
        template && typeof value === "string" ? template.replace("{value}", value) : "";
      continue;
    }
    if (input.dataset.edited === "true") continue;
    input.value = typeof value === "string" ? value : "";
  }
}

function syncSource(form: HTMLFormElement): void {
  const source = form.querySelector<HTMLInputElement>('input[name="source"]:checked')?.value;
  if (!source) return;
  for (const panel of form.querySelectorAll<HTMLElement>("[data-source-panel]")) {
    panel.hidden = panel.dataset.sourcePanel !== source;
  }
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit && form.dataset.hasServers !== "false") submit.disabled = source !== "raw";
}

/** The app name follows the project's and the service's names until someone edits it. */
function syncAppName(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>("[data-app-name]");
  if (!input || input.dataset.edited === "true") return;
  const name = form.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "";
  input.value = name.trim() ? suggestAppNameBase(form.dataset.projectName ?? "", name) : "";
}

function fieldProblem(form: HTMLFormElement, name: string, message: string): boolean {
  const field = form.querySelector<HTMLInputElement>(`[name="${CSS.escape(name)}"]`);
  const slot = field?.closest("[data-field]")?.querySelector<HTMLElement>("[data-field-error]");
  if (!field || !slot || field.closest("[hidden]")) return false;
  field.setAttribute("aria-invalid", "true");
  slot.textContent = message;
  slot.hidden = false;
  return true;
}

/** The checks the API makes too, so most mistakes show before anything is sent. */
function problems(form: HTMLFormElement): boolean {
  clearErrors(form);
  let found = false;
  const name = form.querySelector<HTMLInputElement>('input[name="name"]');
  if (name && !name.value.trim()) {
    found =
      fieldProblem(form, "name", name.dataset.required || "Enter a name for the service.") || found;
  }
  const appName = form.querySelector<HTMLInputElement>('input[name="appName"]');
  if (appName?.value.trim()) {
    const problem = appNameProblem(appName.value.trim());
    if (problem) found = fieldProblem(form, "appName", problem) || found;
  }
  for (const input of form.querySelectorAll<HTMLInputElement>("[data-password]")) {
    if (!input.value || input.closest("[hidden]")) continue;
    const problem = databasePasswordProblem(input.value);
    if (problem) found = fieldProblem(form, input.name, problem) || found;
  }
  const image = form.querySelector<HTMLInputElement>("[data-image]");
  if (image?.value.trim()) {
    const problem = imageProblem(image.value);
    if (problem) found = fieldProblem(form, image.name, problem) || found;
  }
  const compose = form.querySelector<HTMLTextAreaElement>('textarea[name="settings.composeFile"]');
  if (compose && !compose.closest("[hidden]") && !compose.value.trim()) {
    found = fieldProblem(form, compose.name, "Paste the Compose file.") || found;
  }
  if (found) form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  return found;
}

function bodyOf(form: HTMLFormElement): Record<string, unknown> {
  const body = formBody(form);
  delete body.source;
  if (body.kind === undefined) body.kind = selectedKind(form);
  // Empty strings mean "use the default" or "generate"; leave them out.
  const settings = (body.settings ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) if (value === "") delete settings[key];
  body.settings = settings;
  if (body.appName === "") delete body.appName;
  return body;
}

/** Says where else it went (spec 05 5.4) and any notes, like a database created private. */
export function tellCreated(created: CreatedService): void {
  if (created.message) showToast(created.message, { tone: "success", persist: true });
  else showToast(`Created ${created.service.name}`, { tone: "success" });
  for (const note of created.notes) showToast(note, { tone: "info", persist: true });
  for (const skipped of created.notAddedTo) {
    showToast(`Not added to ${skipped.environmentName}: ${skipped.reason}`, {
      tone: "info",
      persist: true,
    });
  }
}

export async function createService(
  form: HTMLFormElement,
  body: Record<string, unknown>,
  options: { deploy: boolean },
): Promise<CreatedService | null> {
  const environmentId = form.dataset.environmentId ?? "";
  const buttons = form.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
  for (const button of buttons) button.setAttribute("aria-disabled", "true");
  form.setAttribute("data-busy", "");
  try {
    const created = await callApi<CreatedService>(
      "POST",
      `/environments/${encodeURIComponent(environmentId)}/services`,
      body,
    );
    form.closest("dialog")?.close();
    tellCreated(created);
    const servicePage = `${form.dataset.serviceBase ?? ""}${encodeURIComponent(created.service.id)}`;
    // On the creation page the build panel follows the first deploy (spec 6.1).
    if (options.deploy && (await followCreatedDeploy(created.service.id, servicePage))) {
      return created;
    }
    if (options.deploy) await deployAndTell(created.service.id);
    await navigate(servicePage);
    return created;
  } catch (error) {
    const problem = asApiError(error);
    showErrors(form, problem);
    if (Object.keys(problem.fields).length > 0 && !form.querySelector('[aria-invalid="true"]')) {
      showFormError(form, problem.message);
    }
    return null;
  } finally {
    for (const button of buttons) button.removeAttribute("aria-disabled");
    form.removeAttribute("data-busy");
  }
}

export function initCreateService(): void {
  document.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;
    const form = target?.closest?.<HTMLFormElement>("[data-create-service]");
    if (!form || !target) return;
    if (target.matches("[data-app-name], [data-default-of]")) target.dataset.edited = "true";
    if (target.name === "name") syncAppName(form);
  });
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    const form = target?.closest?.<HTMLFormElement>("[data-create-service]");
    if (!form || !target) return;
    if (target.name === "kind") syncKind(form, true);
    if (target.matches("[data-node-role]")) syncKind(form, false);
    if (target.name === "source") syncSource(form);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.createService === undefined) return;
    event.preventDefault();
    if (form.hasAttribute("data-busy") || form.dataset.createManual !== undefined) return;
    if (problems(form)) return;
    const deploy = (event as SubmitEvent).submitter?.hasAttribute("data-and-deploy") ?? false;
    void createService(form, bodyOf(form), {
      deploy: deploy || form.dataset.deployAfter === "true",
    });
  });
  document.addEventListener("astro:page-load", () => {
    for (const form of document.querySelectorAll<HTMLFormElement>("[data-create-service]")) {
      syncKind(form, false);
      syncSource(form);
    }
  });
}

export { bodyOf as createBody, problems as createProblems };
