import { navigate } from "astro:transitions/client";
import { DELETE_SHARED_NOTE, SECRET_KEEP_PLACEHOLDER } from "@nearzero/shared/browser";
import { asApiError, callApi, clearErrors, formBody, refreshPage, showFormError } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * Settings → Git providers in the browser (spec 16.1–16.5): Connect GitHub posts the app
 * manifest to GitHub; GitLab and Gitea go to the host's authorization page; Bitbucket and
 * access tokens connect at once and come back to where the person started; Edit with Test
 * connection; Share, Install, Authorize or Reconnect, and Delete with its "I understand" tick.
 */

function pageReturn(): string | null {
  const value = document.querySelector<HTMLElement>("[data-git-providers-page]")?.dataset.return;
  return value ? value : null;
}

/** Back to where the person started, or this page with its new data. */
async function finish(message: string | null): Promise<void> {
  if (message) showToast(message, { tone: "success" });
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) {
    dialog.close();
  }
  const back = pageReturn();
  if (back) await navigate(back);
  else await refreshPage();
}

function syncTokenFields(form: HTMLFormElement): void {
  const toggle = form.querySelector<HTMLInputElement>("[data-git-token-toggle]");
  const useToken = toggle?.checked ?? false;
  for (const block of form.querySelectorAll<HTMLElement>("[data-git-oauth-fields]")) {
    block.hidden = useToken;
  }
  for (const block of form.querySelectorAll<HTMLElement>("[data-git-token-fields]")) {
    block.hidden = !useToken;
  }
}

/** A GitHub App is created by posting its manifest to GitHub from the browser (spec 16.2). */
async function continueOnGithub(form: HTMLFormElement): Promise<void> {
  clearErrors(form);
  const org = form.querySelector<HTMLInputElement>("[data-git-org-toggle]")?.checked
    ? (form.querySelector<HTMLInputElement>('input[name="organization"]')?.value.trim() ?? "")
    : "";
  const returnTo = form.querySelector<HTMLInputElement>('input[name="returnTo"]')?.value ?? "";
  form.setAttribute("data-busy", "");
  try {
    const started = await callApi<{ action: string; manifest: string }>(
      "POST",
      "/git-providers/github/manifest",
      { organization: org, ...(returnTo ? { returnTo } : {}) },
    );
    const post = document.createElement("form");
    post.method = "post";
    post.action = started.action;
    post.hidden = true;
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "manifest";
    field.value = started.manifest;
    post.append(field);
    document.body.append(post);
    post.submit();
  } catch (error) {
    const problem = asApiError(error);
    const slot = form
      .querySelector('input[name="organization"]')
      ?.closest("[data-field]")
      ?.querySelector<HTMLElement>("[data-field-error]");
    if (problem.fields.organization && slot) {
      slot.textContent = problem.fields.organization;
      slot.hidden = false;
    } else {
      showFormError(form, problem.message);
    }
    form.removeAttribute("data-busy");
  }
}

interface EditFill {
  providerId: string;
  name: string;
  kind: string;
  deprecated?: boolean;
  configured?: Record<string, boolean>;
  auth?: string;
  [key: string]: unknown;
}

function fillEdit(dialog: HTMLDialogElement, fill: EditFill): void {
  const form = dialog.querySelector<HTMLFormElement>("form");
  if (!form) return;
  clearErrors(form);
  for (const field of form.querySelectorAll<HTMLInputElement>("input[name]")) {
    if (field.type === "checkbox") continue;
    const value = fill[field.name];
    field.value = field.type === "password" ? "" : typeof value === "string" ? value : "";
    if (field.dataset.secretOf) {
      field.placeholder = fill.configured?.[field.dataset.secretOf] ? SECRET_KEEP_PLACEHOLDER : "";
    }
  }
  const toggle = form.querySelector<HTMLInputElement>("[data-git-token-toggle]");
  if (toggle) toggle.checked = fill.auth === "token";
  syncTokenFields(form);
  const deprecated = form.querySelector<HTMLElement>("[data-git-deprecated]");
  if (deprecated) deprecated.hidden = fill.deprecated !== true;
  const result = form.querySelector<HTMLElement>("[data-git-test-result]");
  if (result) result.hidden = true;
}

async function testConnection(button: HTMLElement): Promise<void> {
  const form = button.closest<HTMLFormElement>("form");
  if (!form) return;
  const result = form.querySelector<HTMLElement>("[data-git-test-result]");
  const body = formBody(form);
  const providerId = String(body.providerId ?? "");
  delete body.providerId;
  clearErrors(form);
  button.setAttribute("aria-disabled", "true");
  if (result) {
    result.hidden = false;
    result.classList.remove("nz-inline-error");
    result.textContent = "Testing the connection…";
  }
  try {
    const answer = await callApi<{ message: string }>(
      "POST",
      `/git-providers/${encodeURIComponent(providerId)}/test`,
      body,
    );
    if (result) result.textContent = answer.message;
  } catch (error) {
    if (result) {
      result.classList.add("nz-inline-error");
      result.textContent = asApiError(error).message;
    }
  } finally {
    button.removeAttribute("aria-disabled");
  }
}

interface DeletePlan {
  shared: boolean;
  needsUnderstood: boolean;
  warning: string | null;
}

async function openDelete(trigger: HTMLElement): Promise<void> {
  const dialog = document.getElementById("nz-git-delete");
  if (!(dialog instanceof HTMLDialogElement)) return;
  const form = dialog.querySelector<HTMLFormElement>("form");
  if (!form) return;
  const providerId = trigger.dataset.gitDelete ?? "";
  trigger.closest<HTMLElement>("[popover]")?.hidePopover();
  clearErrors(form);
  const id = form.querySelector<HTMLInputElement>('input[name="providerId"]');
  if (id) id.value = providerId;
  for (const slot of form.querySelectorAll<HTMLElement>('[data-fill-text="name"]')) {
    slot.textContent = trigger.dataset.gitName ?? "";
  }
  const shared = form.querySelector<HTMLElement>("[data-git-delete-shared]");
  const usage = form.querySelector<HTMLElement>("[data-git-delete-usage]");
  const understood = form.querySelector<HTMLElement>("[data-git-delete-understood]");
  const tick = understood?.querySelector<HTMLInputElement>("input");
  const loading = form.querySelector<HTMLElement>("[data-git-delete-loading]");
  const confirm = form.querySelector<HTMLButtonElement>("[data-git-delete-confirm]");
  for (const element of [shared, usage, understood]) if (element) element.hidden = true;
  if (tick) tick.checked = false;
  if (loading) loading.hidden = false;
  if (confirm) confirm.disabled = true;
  form.dataset.needsUnderstood = "false";
  openDialog(dialog, trigger);
  try {
    const { plan } = await callApi<{ plan: DeletePlan }>(
      "GET",
      `/git-providers/${encodeURIComponent(providerId)}/delete-plan`,
    );
    if (shared) {
      shared.textContent = DELETE_SHARED_NOTE;
      shared.hidden = !plan.shared;
    }
    if (usage && plan.warning) {
      usage.textContent = plan.warning;
      usage.hidden = false;
    }
    if (understood) understood.hidden = !plan.needsUnderstood;
    form.dataset.needsUnderstood = plan.needsUnderstood ? "true" : "false";
    if (confirm) confirm.disabled = plan.needsUnderstood;
  } catch (error) {
    showFormError(form, asApiError(error).message);
  } finally {
    if (loading) loading.hidden = true;
  }
}

async function confirmDelete(form: HTMLFormElement): Promise<void> {
  const providerId = form.querySelector<HTMLInputElement>('input[name="providerId"]')?.value ?? "";
  const understood =
    form.querySelector<HTMLInputElement>('input[name="understood"]')?.checked ?? false;
  if (form.dataset.needsUnderstood === "true" && !understood) return;
  form.setAttribute("data-busy", "");
  try {
    const answer = await callApi<{ message: string }>(
      "DELETE",
      `/git-providers/${encodeURIComponent(providerId)}${understood ? "?understood=true" : ""}`,
    );
    form.closest("dialog")?.close();
    showToast(answer.message, { tone: "success", persist: answer.message.length > 40 });
    await refreshPage();
  } catch (error) {
    showFormError(form, asApiError(error).message);
  } finally {
    form.removeAttribute("data-busy");
  }
}

/**
 * Opened as ?install=<id>&return=<path> (the Agent's "Give access on GitHub", C3-01): the GitHub
 * App's install page opens at once, and GitHub brings the person back to <path> afterwards.
 */
function startRequestedInstall(): void {
  const page = document.querySelector<HTMLElement>("[data-git-providers-page]");
  if (!page) return;
  if (page.dataset.installMissing !== undefined) {
    delete page.dataset.installMissing;
    showToast(
      "That GitHub provider isn't one you can install. Ask the person who connected it, or an owner or admin.",
      { tone: "error", persist: true },
    );
    return;
  }
  const id = page.dataset.installNow;
  if (!id) return;
  delete page.dataset.installNow;
  void rowAction(
    `/git-providers/${encodeURIComponent(id)}/install`,
    { returnTo: pageReturn() ?? location.pathname },
    (answer) => location.assign(String(answer.installUrl)),
  );
}

async function rowAction(
  path: string,
  body: Record<string, unknown>,
  then: (answer: Record<string, unknown>) => Promise<void> | void,
): Promise<void> {
  try {
    await then(await callApi<Record<string, unknown>>("POST", path, body));
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
  }
}

export function initGitProviders(): void {
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.matches("[data-git-org-toggle]")) {
      const field = target.closest("form")?.querySelector<HTMLElement>("[data-git-org-field]");
      if (field) field.hidden = !target.checked;
      if (target.checked) field?.querySelector<HTMLInputElement>("input")?.focus();
    } else if (target?.matches("[data-git-token-toggle]")) {
      const form = target.closest("form");
      if (form) syncTokenFields(form);
    } else if (target?.matches('[data-git-delete-understood] input[name="understood"]')) {
      const form = target.closest("form");
      const confirm = form?.querySelector<HTMLButtonElement>("[data-git-delete-confirm]");
      if (confirm) confirm.disabled = !target.checked;
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-git-github-connect]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void continueOnGithub(form);
    } else if (form.matches("[data-git-delete-form]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void confirmDelete(form);
    }
  });

  document.addEventListener("nz:api-success", (event) => {
    const form = event.target as HTMLFormElement | null;
    const answer = (event as CustomEvent).detail as {
      authorizeUrl?: string | null;
      message?: string;
      provider?: { kindLabel?: string };
    };
    if (!form?.matches?.("[data-git-connect], [data-git-edit-form]")) return;
    if (answer?.authorizeUrl) {
      location.assign(answer.authorizeUrl);
      return;
    }
    const message =
      answer?.message ??
      (form.matches("[data-git-connect]")
        ? `${answer?.provider?.kindLabel ?? "Provider"} connected`
        : "Provider saved");
    if (form.matches("[data-git-edit-form]")) {
      form.closest("dialog")?.close();
      showToast(message, { tone: "success" });
      void refreshPage();
    } else {
      void finish(message);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const edit = target?.closest<HTMLElement>("[data-git-edit]");
    if (edit) {
      const dialog = document.getElementById(`nz-git-edit-${edit.dataset.gitEdit ?? ""}`);
      if (!(dialog instanceof HTMLDialogElement)) return;
      edit.closest<HTMLElement>("[popover]")?.hidePopover();
      try {
        fillEdit(dialog, JSON.parse(edit.dataset.gitFill ?? "{}") as EditFill);
      } catch {
        return;
      }
      openDialog(dialog, edit);
      return;
    }
    const test = target?.closest<HTMLElement>("[data-git-test]");
    if (test) {
      if (test.getAttribute("aria-disabled") !== "true") void testConnection(test);
      return;
    }
    const remove = target?.closest<HTMLElement>("[data-git-delete]");
    if (remove) {
      void openDelete(remove);
      return;
    }
    const share = target?.closest<HTMLElement>("[data-git-share]");
    if (share) {
      share.closest<HTMLElement>("[popover]")?.hidePopover();
      const shared = share.dataset.gitShared === "true";
      void rowAction(
        `/git-providers/${encodeURIComponent(share.dataset.gitShare ?? "")}/share`,
        { shared: !shared },
        async (answer) => {
          showToast(String(answer.message ?? ""), { tone: "success" });
          await refreshPage();
        },
      );
      return;
    }
    const install = target?.closest<HTMLElement>("[data-git-install]");
    if (install) {
      install.closest<HTMLElement>("[popover]")?.hidePopover();
      void rowAction(
        `/git-providers/${encodeURIComponent(install.dataset.gitInstall ?? "")}/install`,
        { returnTo: location.pathname },
        (answer) => location.assign(String(answer.installUrl)),
      );
      return;
    }
    const authorize = target?.closest<HTMLElement>("[data-git-authorize]");
    if (authorize) {
      authorize.closest<HTMLElement>("[popover]")?.hidePopover();
      void rowAction(
        `/git-providers/${encodeURIComponent(authorize.dataset.gitAuthorize ?? "")}/authorize`,
        { returnTo: location.pathname },
        (answer) => location.assign(String(answer.authorizeUrl)),
      );
    }
  });

  document.addEventListener("astro:page-load", () => {
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "[data-git-connect], [data-git-edit-form]",
    )) {
      syncTokenFields(form);
    }
    startRequestedInstall();
  });
}
