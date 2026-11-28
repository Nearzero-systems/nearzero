import { navigate } from "astro:transitions/client";
import {
  appNameProblem,
  branchProblem,
  composePathProblem,
  type GitProviderKind,
  normalizeBuildPath,
  publicSecretWarnings,
  repositoryNameProblem,
  suggestAppNameBase,
} from "@nearzero/shared/browser";
import type { CreatedService } from "../lib/data/types.ts";
import { portProblem } from "../lib/new-application.ts";
import { asApiError, callApi, clearErrors, showErrors, showFormError } from "./api.ts";
import { followCreatedDeploy } from "./build-panel.ts";
import { tellCreated } from "./create-service.ts";
import { refreshDomainPreview } from "./new-application.ts";
import { showToast } from "./toasts.ts";

/**
 * The new-application page's Git side (spec 06 6.1): the Provider step's "Choose repository",
 * the Repository step's account picker and "Filter repositories…" (searched on the provider,
 * at most 200), and the Configure step's branch list, detected app folders and create: the
 * service first, then its Git source (a connected provider, or the public URL), its build
 * commands, and the first deploy when asked. A failure after the app exists says so and links
 * to it.
 */

interface Account {
  id: string;
  kind: GitProviderKind;
  name: string;
  account: string | null;
}

interface Repository {
  id: string;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string | null;
}

type Step = "provider" | "repository" | "configure";

const SETUP_FAILED =
  "The application was created, but setup did not finish. Open the service to repair it.";

function pageOf(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-new-app]") ?? null;
}

function accountsOf(page: HTMLElement): Account[] {
  try {
    return JSON.parse(page.dataset.gitAccounts ?? "[]") as Account[];
  } catch {
    return [];
  }
}

function showStep(page: HTMLElement, step: Step): void {
  for (const panel of page.querySelectorAll<HTMLElement>("[data-step]")) {
    panel.hidden = panel.dataset.step !== step;
  }
  if (step === "configure") void refreshDomainPreview(page);
  for (const mark of page.querySelectorAll<HTMLElement>("[data-step-mark]")) {
    if (mark.dataset.stepMark === step) mark.setAttribute("aria-current", "step");
    else mark.removeAttribute("aria-current");
  }
}

function configureForm(page: HTMLElement): HTMLFormElement | null {
  return page.querySelector<HTMLFormElement>("[data-app-configure]");
}

let latest = 0;
let filterTimer: number | undefined;

function setNote(page: HTMLElement, text: string, error = false): void {
  const note = page.querySelector<HTMLElement>("[data-git-repo-note]");
  if (!note) return;
  note.textContent = text;
  note.classList.toggle("nz-inline-error", error);
}

function repositoryButton(repository: Repository): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nz-git-repo";
  button.dataset.gitRepo = JSON.stringify(repository);
  const name = document.createElement("span");
  name.className = "nz-git-repo-name";
  name.textContent = repository.fullName;
  const meta = document.createElement("span");
  meta.className = "nz-git-repo-meta";
  if (repository.private) {
    const badge = document.createElement("span");
    badge.className = "nz-badge";
    badge.textContent = "Private";
    meta.append(badge);
  }
  if (repository.defaultBranch) {
    const branch = document.createElement("span");
    branch.textContent = repository.defaultBranch;
    meta.append(branch);
  }
  button.append(name, meta);
  return button;
}

async function loadRepositories(page: HTMLElement): Promise<void> {
  const select = page.querySelector<HTMLSelectElement>("[data-git-account]");
  const list = page.querySelector<HTMLElement>("[data-git-repo-list]");
  const search = page.querySelector<HTMLInputElement>("[data-git-filter]")?.value.trim() ?? "";
  const account = accountsOf(page).find((item) => item.id === select?.value);
  if (!select || !list || !account) return;
  const ticket = ++latest;
  setNote(page, "Loading repositories…");
  list.setAttribute("aria-busy", "true");
  try {
    const answer = await callApi<{ repositories: Repository[]; truncated: boolean; cap: number }>(
      "GET",
      `/git-providers/${encodeURIComponent(account.id)}/repositories?search=${encodeURIComponent(search)}`,
    );
    if (ticket !== latest) return;
    list.replaceChildren(...answer.repositories.map(repositoryButton));
    if (answer.repositories.length === 0) {
      setNote(
        page,
        search
          ? `No repository matches "${search}".`
          : account.kind === "github"
            ? "No repositories yet. Grant the GitHub App access to repositories on GitHub, then come back."
            : "This account has no repositories Nearzero can see.",
      );
    } else if (answer.truncated) {
      setNote(page, `Showing the first ${answer.cap}. Type to search the rest.`);
    } else {
      setNote(
        page,
        `${answer.repositories.length} ${answer.repositories.length === 1 ? "repository" : "repositories"}.`,
      );
    }
  } catch (error) {
    if (ticket !== latest) return;
    list.replaceChildren();
    setNote(page, asApiError(error).message, true);
  } finally {
    if (ticket === latest) list.removeAttribute("aria-busy");
  }
}

function chooseKind(page: HTMLElement, kind: GitProviderKind): void {
  const select = page.querySelector<HTMLSelectElement>("[data-git-account]");
  if (!select) return;
  const accounts = accountsOf(page).filter((account) => account.kind === kind);
  select.replaceChildren(
    ...accounts.map((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = account.account ? `${account.name} (${account.account})` : account.name;
      return option;
    }),
  );
  select.disabled = accounts.length < 2;
  const filter = page.querySelector<HTMLInputElement>("[data-git-filter]");
  if (filter) filter.value = "";
  showStep(page, "repository");
  void loadRepositories(page);
  filter?.focus();
}

function setBuildPaths(
  form: HTMLFormElement,
  folders: { path: string; dockerfile: boolean }[],
): void {
  const select = form.querySelector<HTMLSelectElement>("[data-git-build-path]");
  if (!select) return;
  const options = [{ value: "/", label: "/ (repository root)" }];
  for (const folder of folders) {
    if (folder.path === "") continue;
    options.push({
      value: folder.path,
      label: folder.dockerfile ? `${folder.path} (Dockerfile)` : folder.path,
    });
  }
  options.push({ value: "custom", label: "Custom build path" });
  select.replaceChildren(
    ...options.map((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      return option;
    }),
  );
  select.value = "/";
  syncCustomPath(form);
}

function syncCustomPath(form: HTMLFormElement): void {
  const select = form.querySelector<HTMLSelectElement>("[data-git-build-path]");
  const custom = form.querySelector<HTMLElement>("[data-git-custom-path]");
  if (custom) custom.hidden = select?.value !== "custom";
}

function syncAppName(form: HTMLFormElement, projectName: string): void {
  const appName = form.querySelector<HTMLInputElement>("[data-app-name]");
  if (!appName || appName.dataset.edited === "true") return;
  const name = form.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "";
  appName.value = name.trim() ? suggestAppNameBase(projectName, name) : "";
}

async function pickRepository(page: HTMLElement, repository: Repository): Promise<void> {
  const form = configureForm(page);
  const account = page.querySelector<HTMLSelectElement>("[data-git-account]")?.value ?? "";
  if (!form) return;
  form.dataset.gitSource = "provider";
  form.dataset.providerId = account;
  form.dataset.repository = repository.fullName;
  const repoField = form.querySelector<HTMLInputElement>('input[name="repository"]');
  if (repoField) repoField.value = repository.fullName;
  const branch = form.querySelector<HTMLInputElement>("[data-git-branch]");
  if (branch) branch.value = repository.defaultBranch ?? "main";
  const display = form.querySelector<HTMLInputElement>('input[name="name"]');
  if (display && !display.value) display.value = repository.name;
  syncAppName(form, page.dataset.projectName ?? "");
  for (const back of form.querySelectorAll<HTMLElement>("[data-step-go]")) {
    back.dataset.stepGo = "repository";
  }
  setBuildPaths(form, []);
  showStep(page, "configure");
  display?.focus();
  const base = `/git-providers/${encodeURIComponent(account)}`;
  const name = encodeURIComponent(repository.fullName);
  const [branches, inspected] = await Promise.allSettled([
    callApi<{ branches: { name: string }[] }>("GET", `${base}/branches?repository=${name}`),
    callApi<{ appFolders: { path: string; dockerfile: boolean }[] }>(
      "GET",
      `${base}/inspect?repository=${name}`,
    ),
  ]);
  if (form.dataset.repository !== repository.fullName) return;
  const list = page.querySelector<HTMLDataListElement>("[data-git-branches]");
  if (branches.status === "fulfilled" && list) {
    list.replaceChildren(
      ...branches.value.branches.map((item) => {
        const option = document.createElement("option");
        option.value = item.name;
        return option;
      }),
    );
  }
  if (inspected.status === "fulfilled") setBuildPaths(form, inspected.value.appFolders);
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

function value(form: HTMLFormElement, name: string): string {
  return (
    form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `[name="${CSS.escape(name)}"]`,
    )?.value ?? ""
  ).trim();
}

function envRows(page: HTMLElement): { name: string; value: string }[] {
  return Array.from(page.querySelectorAll<HTMLElement>("[data-env-row]"))
    .map((row) => ({
      name: row.querySelector<HTMLInputElement>("[data-env-name]")?.value.trim() ?? "",
      value: row.querySelector<HTMLInputElement>("[data-env-value]")?.value ?? "",
    }))
    .filter((row) => row.name !== "");
}

function buildPathOf(form: HTMLFormElement): string | { problem: string } {
  const chosen = value(form, "buildPath");
  if (chosen === "custom") return normalizeBuildPath(value(form, "customBuildPath"));
  return normalizeBuildPath(chosen === "/" ? "" : chosen);
}

/** The checks the API makes too, so most mistakes show before anything is created. */
function problems(page: HTMLElement, form: HTMLFormElement): boolean {
  clearErrors(form);
  let found = false;
  if (!value(form, "name"))
    found = fieldProblem(form, "name", "Enter a name for the service.") || found;
  const appName = value(form, "appName");
  if (appName) {
    const problem = appNameProblem(appName);
    if (problem) found = fieldProblem(form, "appName", problem) || found;
  }
  const branch = value(form, "branch") || "main";
  const branchIssue = branchProblem(branch);
  if (branchIssue) found = fieldProblem(form, "branch", branchIssue) || found;
  // Empty: each deploy uses the port the image declares (30b R2-01).
  const port = value(form, "servicePort");
  const portIssue = port ? portProblem(port) : null;
  if (portIssue) found = fieldProblem(form, "servicePort", portIssue) || found;
  const path = buildPathOf(form);
  if (typeof path !== "string") {
    found =
      fieldProblem(
        form,
        value(form, "buildPath") === "custom" ? "customBuildPath" : "buildPath",
        path.problem,
      ) || found;
  }
  const warnings = publicSecretWarnings(envRows(page).map((row) => row.name));
  if (warnings.length > 0) {
    showFormError(
      form,
      `${warnings.map((item) => item.message).join(" ")} Rename them before creating the app.`,
    );
    found = true;
  }
  if (!value(form, "serverId")) {
    showFormError(form, "Add a server first: there is nowhere to run this app yet.");
    found = true;
  }
  if (found) form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  return found;
}

async function createFromGit(
  page: HTMLElement,
  form: HTMLFormElement,
  deploy: boolean,
): Promise<void> {
  if (problems(page, form)) return;
  const mode = form.dataset.gitSource === "provider" ? "provider" : "url";
  const branch = value(form, "branch") || "main";
  const buildPath = buildPathOf(form) as string;
  const commands = {
    install: value(form, "installCommand"),
    build: value(form, "buildCommand"),
    start: value(form, "startCommand"),
  };
  const failed = form.querySelector<HTMLElement>("[data-app-setup-failed]");
  if (failed) failed.hidden = true;
  const buttons = form.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
  for (const button of buttons) button.setAttribute("aria-disabled", "true");
  form.setAttribute("data-busy", "");
  let created: CreatedService;
  try {
    created = await callApi<CreatedService>(
      "POST",
      `/environments/${encodeURIComponent(page.dataset.environmentId ?? "")}/services`,
      {
        kind: "application",
        name: value(form, "name"),
        ...(value(form, "appName") ? { appName: value(form, "appName") } : {}),
        serverId: value(form, "serverId"),
        description: value(form, "description"),
        settings: value(form, "servicePort")
          ? { servicePort: Number(value(form, "servicePort")) }
          : {},
        variables: envRows(page),
      },
    );
  } catch (error) {
    const problem = asApiError(error);
    showErrors(form, problem);
    if (Object.keys(problem.fields).length > 0 && !form.querySelector('[aria-invalid="true"]')) {
      showFormError(form, problem.message);
    }
    for (const button of buttons) button.removeAttribute("aria-disabled");
    form.removeAttribute("data-busy");
    return;
  }
  const serviceId = created.service.id;
  const servicePage = `${page.dataset.serviceBase ?? ""}${encodeURIComponent(serviceId)}`;
  tellCreated(created);
  try {
    if (mode === "provider") {
      await callApi("PUT", `/services/${encodeURIComponent(serviceId)}/git-source`, {
        providerId: form.dataset.providerId,
        repository: form.dataset.repository,
        branch,
        buildPath,
      });
    } else {
      await callApi("PUT", `/services/${encodeURIComponent(serviceId)}/source`, {
        type: "git",
        url: value(form, "repository"),
        branch,
        buildPath,
      });
    }
    if (commands.install || commands.build || commands.start) {
      await callApi("PUT", `/services/${encodeURIComponent(serviceId)}/build`, {
        builder: { type: "automatic" },
        commands,
      });
    }
  } catch (error) {
    if (failed) {
      failed.replaceChildren(`${asApiError(error).message} ${SETUP_FAILED} `);
      const link = document.createElement("a");
      link.className = "nz-text-link";
      link.href = servicePage;
      link.textContent = "Open the service";
      failed.append(link);
      failed.hidden = false;
    }
    form.removeAttribute("data-busy");
    return;
  }
  await assignZoneHostname(form, serviceId);
  if (deploy && (await followCreatedDeploy(serviceId, servicePage))) return;
  await navigate(servicePage);
}

/**
 * "Also assign a hostname from the workspace's DNS zone" (spec 6.1): the name the Domain preview
 * offered, added in the zone (Nearzero creates its record). A refusal doesn't undo the app; it
 * is said in a toast, and the hostname can be added from the service's Domains.
 */
async function assignZoneHostname(form: HTMLFormElement, serviceId: string): Promise<void> {
  const hostname = form.dataset.zoneHostname;
  if (!hostname || !form.querySelector<HTMLInputElement>("[data-app-zone-check]")?.checked) return;
  try {
    await callApi("POST", "/domains/hostnames", {
      hostname,
      // Without a typed port the hostname follows the service port the deploy finds.
      connect: {
        serviceId,
        ...(value(form, "servicePort") ? { port: Number(value(form, "servicePort")) } : {}),
      },
      dns: "managed",
    });
  } catch (error) {
    showToast(`${hostname} wasn't added: ${asApiError(error).message}`, { tone: "error" });
  }
}

/** Add New → Compose "From a repository" (spec 7.1): the service, then its repository source. */
async function createComposeFromRepository(form: HTMLFormElement): Promise<void> {
  clearErrors(form);
  let found = false;
  if (!value(form, "name"))
    found = fieldProblem(form, "name", "Enter a name for the service.") || found;
  const providerId = value(form, "repository.account");
  const repository = value(form, "repository.name");
  const branch = value(form, "repository.branch");
  const composePath = value(form, "repository.path");
  if (!providerId) found = fieldProblem(form, "repository.account", "Choose an account.") || found;
  const repoIssue = repositoryNameProblem(repository);
  if (repoIssue) found = fieldProblem(form, "repository.name", repoIssue) || found;
  const branchIssue = branch ? branchProblem(branch) : null;
  if (branchIssue) found = fieldProblem(form, "repository.branch", branchIssue) || found;
  const pathIssue = composePathProblem(composePath);
  if (pathIssue) found = fieldProblem(form, "repository.path", pathIssue) || found;
  if (found) {
    form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    return;
  }
  const format =
    form.querySelector<HTMLInputElement>('input[name="settings.format"]:checked')?.value ??
    "compose";
  form.setAttribute("data-busy", "");
  let created: CreatedService;
  try {
    created = await callApi<CreatedService>(
      "POST",
      `/environments/${encodeURIComponent(form.dataset.environmentId ?? "")}/services`,
      {
        kind: "compose",
        name: value(form, "name"),
        serverId: value(form, "serverId"),
        description: value(form, "description"),
        settings: { format },
      },
    );
  } catch (error) {
    showErrors(form, asApiError(error));
    form.removeAttribute("data-busy");
    return;
  }
  const servicePage = `${form.dataset.serviceBase ?? ""}${encodeURIComponent(created.service.id)}`;
  tellCreated(created);
  try {
    await callApi("PUT", `/services/${encodeURIComponent(created.service.id)}/git-source`, {
      providerId,
      repository,
      branch,
      composePath,
    });
  } catch (error) {
    showFormError(
      form,
      `${asApiError(error).message} The Compose service was created, but setup did not finish. Open the service to repair it.`,
    );
    form.removeAttribute("data-busy");
    return;
  }
  form.closest("dialog")?.close();
  form.removeAttribute("data-busy");
  await navigate(servicePage);
}

function composeSource(form: HTMLFormElement): string | undefined {
  return form.querySelector<HTMLInputElement>('input[name="source"]:checked')?.value;
}

export function initGitImport(): void {
  // Compose "From a repository" is sent here, before client/create-service.ts sees the form.
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (form.dataset.createService !== "compose" || composeSource(form) !== "repository") return;
      event.preventDefault();
      event.stopPropagation();
      if (!form.hasAttribute("data-busy")) void createComposeFromRepository(form);
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const page = pageOf(target);
    if (!page) return;
    const pick = target?.closest<HTMLElement>("[data-git-pick-kind]");
    if (pick) {
      chooseKind(page, pick.dataset.gitPickKind as GitProviderKind);
      return;
    }
    const repo = target?.closest<HTMLElement>("[data-git-repo]");
    if (repo) {
      try {
        void pickRepository(page, JSON.parse(repo.dataset.gitRepo ?? "{}") as Repository);
      } catch {
        // A row without its data can't be picked.
      }
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    const compose = target?.closest<HTMLFormElement>('[data-create-service="compose"]');
    if (compose && target?.matches('input[name="source"]')) {
      // A repository source works once an account is connected (and a server exists).
      const accounts = Number(
        compose.querySelector<HTMLElement>("[data-git-accounts-count]")?.dataset.gitAccountsCount ??
          "0",
      );
      const submit = compose.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit && composeSource(compose) === "repository") {
        submit.disabled = accounts === 0 || compose.dataset.hasServers === "false";
      }
      return;
    }
    const page = pageOf(target);
    if (!page || !target) return;
    if (target.matches("[data-git-account]")) void loadRepositories(page);
    if (target.matches("[data-git-build-path]")) {
      const form = target.closest<HTMLFormElement>("form");
      if (form) syncCustomPath(form);
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    const page = pageOf(target);
    if (!page || !target?.matches("[data-git-filter]")) return;
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void loadRepositories(page), 250);
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const page = pageOf(form);
    if (!page) return;
    if (form.matches("[data-app-public-url]")) {
      // client/new-application.ts checks the address and opens Configure; this remembers it.
      const configure = configureForm(page);
      if (configure && !form.querySelector('[aria-invalid="true"]')) {
        configure.dataset.gitSource = "url";
        delete configure.dataset.providerId;
        delete configure.dataset.repository;
        for (const back of configure.querySelectorAll<HTMLElement>("[data-step-go]")) {
          back.dataset.stepGo = "provider";
        }
        setBuildPaths(configure, []);
      }
      return;
    }
    if (!form.matches("[data-app-configure]")) return;
    event.preventDefault();
    if (form.hasAttribute("data-busy")) return;
    const deploy = (event as SubmitEvent).submitter?.hasAttribute("data-and-deploy") ?? false;
    void createFromGit(page, form, deploy);
  });

  document.addEventListener("astro:page-load", () => {
    const page = document.querySelector<HTMLElement>("[data-new-app]");
    const chosen = page?.dataset.gitChosen as GitProviderKind | undefined;
    if (!page || !chosen) return;
    if (accountsOf(page).some((account) => account.kind === chosen)) chooseKind(page, chosen);
  });
}
