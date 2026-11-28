/**
 * Checks forms in the browser before they are sent (spec 4.1, 4.3, 5.1). A form opts in with
 * `data-validate`; each field states its rules and messages:
 *   data-required="Enter your email address."
 *   data-email="Use a valid email address."
 *   data-minlength="8" data-minlength-message="Password must be at least 8 characters."
 *   data-email-list="10"  (comma, semicolon or newline separated addresses)
 * The server checks everything again.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function splitEmailList(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/** Names every invalid address, as the API does (spec 4.3). */
export function invalidEmailsMessage(invalid: string[]): string {
  const one = invalid.length === 1;
  const quoted = invalid.map((address) => `"${address}"`).join(", ");
  return `${quoted} ${one ? "is not a valid email address" : "are not valid email addresses"}. Fix ${one ? "it" : "them"} or remove ${one ? "it" : "them"}.`;
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function problem(field: Field): string | null {
  const value = field.value.trim();
  const data = field.dataset;
  if (data.required !== undefined && !value) return data.required || "This field is required.";
  if (!value) return null;
  if (data.email !== undefined && !isEmail(value))
    return data.email || "Use a valid email address.";
  if (data.minlength && field.value.length < Number(data.minlength)) {
    return data.minlengthMessage ?? `Use at least ${data.minlength} characters.`;
  }
  if (data.emailList) {
    const addresses = splitEmailList(field.value);
    const invalid = addresses.filter((address) => !isEmail(address));
    if (invalid.length > 0) return invalidEmailsMessage(invalid);
    if (addresses.length > Number(data.emailList)) {
      return `Invite up to ${data.emailList} people here. You can invite more from Settings → Members & access.`;
    }
  }
  return null;
}

function show(field: Field, message: string | null): void {
  const wrapper = field.closest("[data-field]");
  const slot = wrapper?.querySelector<HTMLElement>("[data-field-error]");
  if (message) field.setAttribute("aria-invalid", "true");
  else field.removeAttribute("aria-invalid");
  if (slot) {
    slot.textContent = message ?? "";
    slot.hidden = !message;
  }
}

export function validateForm(form: HTMLFormElement): boolean {
  let firstInvalid: Field | null = null;
  for (const field of form.querySelectorAll<Field>("input, textarea, select")) {
    // Fields in a hidden part of the form (another tab or mode) aren't being sent.
    if (field.disabled || field.closest("[hidden]")) continue;
    const message = problem(field);
    show(field, message);
    if (message && !firstInvalid) firstInvalid = field;
  }
  firstInvalid?.focus();
  return firstInvalid === null;
}

/**
 * A form the browser (or the client router) sends as a page: a POST with no API binding and no
 * script of its own. Its page is replaced by the answer, so it is never sent twice.
 */
export function sendsAsPage(form: HTMLFormElement): boolean {
  return (
    form.dataset.api === undefined &&
    !form.hasAttribute("data-scripted") &&
    (form.getAttribute("method") ?? "get").toLowerCase() === "post"
  );
}

function markBusy(form: HTMLFormElement, busy: boolean): void {
  form.toggleAttribute("data-busy", busy);
  for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) {
    if (busy) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  }
}

export function initForms(): void {
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      // Forms that send themselves to the API (client/api.ts) never submit as a page: stopping
      // it here, first, also keeps the client router from turning them into a GET whose
      // address would carry the fields (a password, a code).
      // Forms run by their own scripts (`data-scripted`) never submit as a page either.
      if (form.dataset.api !== undefined || form.hasAttribute("data-scripted")) {
        event.preventDefault();
      }
      // One submit at a time for a page-sending form: a second Enter (or click) before the
      // answer arrives is dropped, not sent again (aria-disabled alone stops only clicks).
      const asPage = sendsAsPage(form);
      if (asPage && form.hasAttribute("data-busy")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (form.hasAttribute("data-validate") && !validateForm(form)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (asPage) {
        markBusy(form, true);
        return;
      }
      // Scripted and API forms show the same dimmed button while they run; their scripts
      // make it usable again when the answer (or a refusal) is back.
      if (!form.hasAttribute("data-validate")) return;
      for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) {
        button.setAttribute("aria-disabled", "true");
      }
    },
    true,
  );

  // A page restored from the back/forward cache keeps its DOM: its forms work again.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const form of document.querySelectorAll<HTMLFormElement>("form[data-busy]")) {
      if (sendsAsPage(form)) markBusy(form, false);
    }
  });

  // Clear a field's error as soon as it is edited.
  document.addEventListener("input", (event) => {
    const field = event.target as Field;
    if (field?.getAttribute?.("aria-invalid") === "true") show(field, null);
  });
}
