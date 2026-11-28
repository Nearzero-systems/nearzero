import { navigate } from "astro:transitions/client";
import { ApiError, apiErrorFrom, unreachableError } from "../lib/api-error.ts";
import { showToast } from "./toasts.ts";

/**
 * Browser calls to the Nearzero API through the console's /api/v1 proxy, and forms that send
 * themselves there (spec 04 4.6 to 4.8, 19.9). A form opts in with
 *   data-api="PATCH /me"
 * and its named fields become the JSON body: text as strings, `data-json="bool"` checkboxes as
 * true/false, `data-json="list"` checkboxes as arrays of their ticked values, `data-json="number"`
 * as numbers, and `data-omit-empty` leaves an empty field out. A refusal puts each field's
 * message under that field (dotted paths match `name`) and anything else in the form's
 * [data-form-error]. On success the form fires `nz:api-success` with the answer; by default
 * (`data-api-then="reload"`) it shows the answer's message as a toast and reloads the page's
 * data in place.
 */

export async function callApi<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  init: { raw?: Blob; contentType?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  let payload: BodyInit | undefined;
  if (init.raw) {
    payload = init.raw;
    headers["content-type"] = init.contentType ?? init.raw.type;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
    });
  } catch {
    throw unreachableError();
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) throw apiErrorFrom(response.status, parsed);
  document.dispatchEvent(new CustomEvent("nz:changed"));
  return parsed as T;
}

let keptScroll: number | null = null;
/** Which folds (details with an id) were open, so a refresh keeps them as the person left them. */
let keptFolds: Map<string, boolean> | null = null;

/**
 * Loads this page's data again in place (in-app navigation), keeping the scroll position and
 * which folds are open (C3-04: Create URL kept Deployment settings open on the new URL).
 */
export async function refreshPage(): Promise<void> {
  const routed = document.querySelector('meta[name="astro-view-transitions-enabled"]') !== null;
  if (!routed) {
    location.reload();
    return;
  }
  keptScroll = window.scrollY;
  keptFolds = new Map(
    Array.from(document.querySelectorAll<HTMLDetailsElement>("details[id]")).map((fold) => [
      fold.id,
      fold.open,
    ]),
  );
  await navigate(location.pathname + location.search, { history: "replace" });
}

/** Opens and closes the folds as they were before the refresh. */
export function restoreFolds(root: ParentNode, kept: ReadonlyMap<string, boolean>): void {
  for (const fold of Array.from(root.querySelectorAll<HTMLDetailsElement>("details[id]"))) {
    const open = kept.get(fold.id);
    if (open !== undefined) fold.open = open;
  }
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function fieldsOf(form: HTMLFormElement): Field[] {
  return Array.from(form.elements).filter(
    (element): element is Field =>
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement) &&
      Boolean(element.name) &&
      !element.disabled &&
      !element.closest("[hidden], [inert]"),
  );
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

/** The form's fields as a JSON body (see the module comment for the rules). */
export function formBody(form: HTMLFormElement): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const lists = new Map<string, string[]>();
  for (const field of fieldsOf(form)) {
    const kind = field.dataset.json;
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      if (kind === "list") {
        const list = lists.get(field.name) ?? [];
        if (field.checked) list.push(field.value);
        lists.set(field.name, list);
      } else {
        setPath(body, field.name, field.checked);
      }
      continue;
    }
    if (field instanceof HTMLInputElement && field.type === "radio") {
      if (field.checked) setPath(body, field.name, field.value);
      continue;
    }
    if (field instanceof HTMLInputElement && field.type === "file") continue;
    const value =
      field instanceof HTMLInputElement && field.type === "password"
        ? field.value
        : field.value.trim();
    if (value === "" && field.dataset.omitEmpty !== undefined) continue;
    if (kind === "number") setPath(body, field.name, value === "" ? null : Number(value));
    else setPath(body, field.name, value);
  }
  for (const [name, list] of lists) setPath(body, name, list);
  return body;
}

export function clearErrors(form: HTMLFormElement): void {
  for (const slot of form.querySelectorAll<HTMLElement>("[data-field-error]")) {
    slot.hidden = true;
    slot.textContent = "";
  }
  for (const field of form.querySelectorAll("[aria-invalid]"))
    field.removeAttribute("aria-invalid");
  const general = form.querySelector<HTMLElement>("[data-form-error]");
  if (general) general.hidden = true;
}

export function showFormError(form: HTMLFormElement, message: string): void {
  const general = form.querySelector<HTMLElement>("[data-form-error]");
  const text = general?.querySelector<HTMLElement>("[data-form-error-text]") ?? general;
  if (general && text) {
    text.textContent = message;
    general.hidden = false;
    general.scrollIntoView?.({ block: "nearest" });
  } else {
    showToast(message, { tone: "error" });
  }
}

/** Shows an API refusal on a form: per field where it names one, else at the top. */
export function showErrors(form: HTMLFormElement, error: ApiError): void {
  clearErrors(form);
  let shown = false;
  let first: Field | null = null;
  for (const [path, message] of Object.entries(error.fields)) {
    const field = form.querySelector<Field>(`[name="${CSS.escape(path)}"]`);
    const slot = field?.closest("[data-field]")?.querySelector<HTMLElement>("[data-field-error]");
    if (!field || !slot || field.closest("[hidden]")) continue;
    field.setAttribute("aria-invalid", "true");
    slot.textContent = message;
    slot.hidden = false;
    shown = true;
    first ??= field;
  }
  if (!shown) showFormError(form, error.message);
  first?.focus();
}

function setBusy(form: HTMLFormElement, busy: boolean): void {
  for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) {
    if (busy) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  }
  form.toggleAttribute("data-busy", busy);
}

export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError({ status: 0, code: "internal", message: "Something went wrong. Try again." });
}

/**
 * Fills "{name}" in a form's API path from its field of that name, which then stays out of the
 * body: `data-api="PATCH /workspace/members/{personId}"`.
 */
function fillPath(template: string, form: HTMLFormElement, body: unknown): string {
  return template.replace(/\{([\w.-]+)\}/g, (_match, name: string) => {
    const field = form.querySelector<HTMLInputElement>(`[name="${CSS.escape(name)}"]`);
    if (body && typeof body === "object") delete (body as Record<string, unknown>)[name];
    return encodeURIComponent(field?.value ?? "");
  });
}

/** Sends a [data-api] form now (also used by code that builds its own body). */
export async function sendForm(
  form: HTMLFormElement,
  body: unknown = formBody(form),
): Promise<unknown> {
  const [method = "POST", template = "/"] = (form.dataset.api ?? "").split(/\s+/);
  const path = fillPath(template, form, body);
  setBusy(form, true);
  clearErrors(form);
  try {
    const answer = await callApi(method, path, method === "DELETE" ? undefined : body);
    form.dispatchEvent(new CustomEvent("nz:api-success", { detail: answer, bubbles: true }));
    const then = form.dataset.apiThen ?? "reload";
    if (then === "reload") {
      const message =
        form.dataset.apiToast ??
        (typeof (answer as { message?: unknown })?.message === "string"
          ? (answer as { message: string }).message
          : null);
      if (message) showToast(message, { tone: "success" });
      form.closest("dialog")?.close();
      await refreshPage();
    }
    return answer;
  } catch (error) {
    const problem = asApiError(error);
    showErrors(form, problem);
    form.dispatchEvent(new CustomEvent("nz:api-error", { detail: problem, bubbles: true }));
    return undefined;
  } finally {
    setBusy(form, false);
  }
}

export function initApiForms(): void {
  // Runs after forms.ts, which stops invalid forms in the capture phase.
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.api === undefined) return;
    event.preventDefault();
    if (form.hasAttribute("data-busy") || form.dataset.apiManual !== undefined) return;
    void sendForm(form);
  });

  document.addEventListener("astro:page-load", () => {
    if (keptFolds) {
      restoreFolds(document, keptFolds);
      keptFolds = null;
    }
    if (keptScroll === null) return;
    const y = keptScroll;
    keptScroll = null;
    window.scrollTo(0, y);
  });
}
