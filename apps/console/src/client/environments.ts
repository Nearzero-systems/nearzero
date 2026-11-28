import { navigate } from "astro:transitions/client";
import { type NameHint, nameHint, variablesHint } from "../lib/environments.ts";
import { asApiError, callApi, refreshPage, showErrors } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * Add, rename and delete an environment (spec 05 5.3): the live name hint ("It will be called
 * x.", "This is your production environment.", "Looks good." or what's wrong), the variables
 * choice and its hints, and the typed confirmation for delete.
 */

function taken(form: HTMLFormElement): string[] {
  try {
    return JSON.parse(form.dataset.taken ?? "[]") as string[];
  } catch {
    return [];
  }
}

function syncName(form: HTMLFormElement): NameHint | null {
  const input = form.querySelector<HTMLInputElement>("[data-env-name]");
  const slot = form.querySelector<HTMLElement>("[data-env-hint]");
  if (!input || !slot) return null;
  const hint = nameHint(input.value, taken(form));
  slot.textContent = hint.message;
  slot.dataset.tone = input.value.trim() === "" ? "" : hint.ok ? "ok" : "error";
  return hint;
}

function syncVariables(form: HTMLFormElement): void {
  const copy = form.querySelector<HTMLInputElement>('input[name="variablesFrom"][value="copy"]');
  const values = form.querySelector<HTMLElement>("[data-env-values]");
  const valuesBox = values?.querySelector<HTMLInputElement>("input");
  const source = form.querySelector<HTMLSelectElement>("[data-env-source]");
  const slot = form.querySelector<HTMLElement>("[data-env-variables-hint]");
  if (!copy || !values || !valuesBox || !source || !slot) return;
  values.hidden = !copy.checked;
  if (!copy.checked) valuesBox.checked = false;
  const text = variablesHint({
    copy: copy.checked,
    values: valuesBox.checked,
    sourceName: source.selectedOptions[0]?.textContent?.trim() ?? "",
    newName: form.querySelector<HTMLInputElement>("[data-env-name]")?.value ?? "",
  });
  slot.hidden = text === null;
  slot.textContent = text ?? "";
}

function syncDelete(form: HTMLFormElement): void {
  const confirm = form.querySelector<HTMLInputElement>("[data-env-confirm]");
  const submit = form.querySelector<HTMLButtonElement>("[data-env-delete-submit]");
  if (confirm && submit) submit.disabled = confirm.value.trim() !== (form.dataset.confirm ?? "");
}

function fieldError(form: HTMLFormElement, message: string): void {
  const slot = form.querySelector<HTMLElement>("[data-field-error]");
  const input = form.querySelector<HTMLInputElement>("[data-env-name]");
  if (slot) {
    slot.textContent = message;
    slot.hidden = false;
  }
  input?.setAttribute("aria-invalid", "true");
  input?.focus();
}

function busy(form: HTMLFormElement, on: boolean): void {
  form.toggleAttribute("data-busy", on);
  for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) {
    if (on) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  }
}

async function submitAdd(form: HTMLFormElement): Promise<void> {
  const hint = syncName(form);
  if (!hint?.ok) {
    fieldError(form, hint?.message ?? "Enter a name for the environment.");
    return;
  }
  const copy = form.querySelector<HTMLInputElement>('input[name="variablesFrom"][value="copy"]');
  const source = form.querySelector<HTMLSelectElement>("[data-env-source]");
  const values = form.querySelector<HTMLInputElement>('input[name="variablesValues"]');
  const description =
    form.querySelector<HTMLTextAreaElement>('textarea[name="description"]')?.value.trim() ?? "";
  busy(form, true);
  try {
    const answer = await callApi<{
      environment: { id: string; name: string };
      message: string;
      notCopied: { name: string; reason: string }[];
    }>("POST", `/projects/${encodeURIComponent(form.dataset.projectId ?? "")}/environments`, {
      name: hint.name,
      description,
      variables: {
        from: copy?.checked ? (source?.value ?? null) : null,
        values: Boolean(copy?.checked && values?.checked),
      },
    });
    form.closest("dialog")?.close();
    showToast(answer.message, { tone: "success" });
    for (const skipped of answer.notCopied) {
      showToast(`${skipped.name} wasn't copied: ${skipped.reason}`, {
        tone: "info",
        persist: true,
      });
    }
    // /<ws>/dashboard/projects/<project>/…: the new environment opens on its Overview.
    const project = location.pathname.split("/").slice(0, 5).join("/");
    await navigate(`${project}/${encodeURIComponent(answer.environment.id)}/overview`);
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    busy(form, false);
  }
}

async function submitRename(form: HTMLFormElement): Promise<void> {
  const hint = syncName(form);
  if (!hint?.ok) {
    fieldError(form, hint?.message ?? "Enter a name for the environment.");
    return;
  }
  busy(form, true);
  try {
    const answer = await callApi<{ environment: { name: string } }>(
      "PATCH",
      `/environments/${encodeURIComponent(form.dataset.environmentId ?? "")}`,
      { name: hint.name },
    );
    form.closest("dialog")?.close();
    showToast(`Renamed to ${answer.environment.name}`, { tone: "success" });
    await refreshPage();
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    busy(form, false);
  }
}

async function submitDelete(form: HTMLFormElement): Promise<void> {
  const confirm = form.querySelector<HTMLInputElement>("[data-env-confirm]");
  if (!confirm || confirm.value.trim() !== form.dataset.confirm) return;
  busy(form, true);
  try {
    await callApi(
      "DELETE",
      `/environments/${encodeURIComponent(form.dataset.environmentId ?? "")}`,
    );
    form.closest("dialog")?.close();
    showToast(`Deleted ${form.dataset.confirm}`, { tone: "success" });
    const parts = location.pathname.split("/");
    await navigate(parts.slice(0, 5).join("/"));
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    busy(form, false);
  }
}

export function initEnvironmentDialogs(): void {
  document.addEventListener("input", (event) => {
    const form = (event.target as Element | null)?.closest<HTMLFormElement>("[data-env-form]");
    if (!form) return;
    if (form.dataset.envForm === "delete") syncDelete(form);
    else {
      syncName(form);
      if (form.dataset.envForm === "add") syncVariables(form);
    }
  });
  document.addEventListener("change", (event) => {
    const form = (event.target as Element | null)?.closest<HTMLFormElement>(
      '[data-env-form="add"]',
    );
    if (form) syncVariables(form);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.envForm) return;
    event.preventDefault();
    if (form.hasAttribute("data-busy")) return;
    const kind = form.dataset.envForm;
    if (kind === "add") void submitAdd(form);
    else if (kind === "rename") void submitRename(form);
    else if (kind === "delete") void submitDelete(form);
  });
}
