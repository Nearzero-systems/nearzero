/**
 * Modal dialogs (spec 21.5, 23.7). Built on <dialog> with showModal(), which makes the rest of
 * the page inert. On top of that:
 * - Escape closes (the browser's cancel event).
 * - A click on the backdrop closes, but only when the press and the release both landed outside
 *   the dialog's box. Content that re-renders under the pointer can't close it, because the
 *   check uses coordinates, not the element that received the click.
 * - Tab and Shift+Tab cycle inside the dialog.
 * - Focus returns to whatever opened it.
 * - Opened by pointer, its first field takes focus quietly: no ring until a key is pressed, the
 *   page is pointed at, or focus moves on (spec 21.10). Opened from the keyboard, the ring shows.
 */

const openers = new WeakMap<HTMLDialogElement, Element>();
const pressedOutside = new WeakMap<HTMLDialogElement, boolean>();

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function outside(dialog: HTMLDialogElement, x: number, y: number): boolean {
  const box = dialog.getBoundingClientRect();
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

function tabbables(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) =>
      !element.closest("[hidden]") &&
      !element.closest("[inert]") &&
      element.getClientRects().length > 0 &&
      !element.matches("[popover]:not(:popover-open) *"),
  );
}

/**
 * Sets named fields from a JSON object, for one dialog serving many rows: inputs by `name`,
 * text by `data-fill-text`, and `data-fill-shown` parts shown only when their value isn't empty.
 */
function fill(dialog: HTMLDialogElement, json: string | undefined): void {
  if (!json) return;
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(json);
  } catch {
    return;
  }
  for (const [name, value] of Object.entries(values)) {
    for (const field of dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      `[name="${CSS.escape(name)}"]`,
    )) {
      // Radios and checkboxes keep their own values; the fill picks which are on.
      if (
        field instanceof HTMLInputElement &&
        (field.type === "radio" || field.type === "checkbox")
      ) {
        field.checked = Array.isArray(value)
          ? value.map(String).includes(field.value)
          : field.value === String(value ?? "");
      } else {
        field.value = String(value ?? "");
      }
    }
    for (const slot of dialog.querySelectorAll<HTMLElement>(
      `[data-fill-text="${CSS.escape(name)}"]`,
    )) {
      slot.textContent = String(value ?? "");
    }
    // Parts shown only when the value has something to say (an empty list or text hides them).
    for (const part of dialog.querySelectorAll<HTMLElement>(
      `[data-fill-shown="${CSS.escape(name)}"]`,
    )) {
      part.hidden = value === null || value === undefined || value === "" || value === false;
    }
  }
}

function resetErrors(dialog: HTMLDialogElement): void {
  for (const error of dialog.querySelectorAll<HTMLElement>("[data-field-error]")) {
    error.hidden = true;
    error.textContent = "";
  }
  for (const field of dialog.querySelectorAll("[aria-invalid]"))
    field.removeAttribute("aria-invalid");
}

const QUIET = "data-quiet-focus";
let keyboardLast = false;

/**
 * Focuses what a page or dialog opens on. After a pointer interaction (or none) it carries
 * `data-quiet-focus`, which hides its focus ring until the person uses the keyboard, points at
 * the page or moves focus; after a key press the ring shows as usual.
 */
export function focusOnOpen(element: HTMLElement | null | undefined): void {
  if (!element) return;
  if (!keyboardLast) element.setAttribute(QUIET, "");
  element.focus();
}

function initQuietFocus(): void {
  const wake = () => {
    for (const element of document.querySelectorAll(`[${QUIET}]`)) element.removeAttribute(QUIET);
  };
  document.addEventListener(
    "keydown",
    () => {
      keyboardLast = true;
      wake();
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      keyboardLast = false;
      wake();
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (event) => {
      if (event.target instanceof Element) event.target.removeAttribute(QUIET);
    },
    true,
  );
}

export function openDialog(dialog: HTMLDialogElement, opener?: Element | null): void {
  if (dialog.open) return;
  if (opener) openers.set(dialog, opener);
  resetErrors(dialog);
  if (dialog.hasAttribute("data-sheet")) {
    // The sheet slides in under the pointer that opened it: no hover fill until it moves.
    dialog.setAttribute("data-pointer-rest", "");
    dialog.addEventListener("pointermove", () => dialog.removeAttribute("data-pointer-rest"), {
      once: true,
    });
  }
  dialog.showModal();
  const first =
    dialog.querySelector<HTMLElement>("[autofocus]") ??
    tabbables(dialog).find((element) => !element.matches("[data-dialog-close]")) ??
    tabbables(dialog)[0];
  focusOnOpen(first);
}

export function closeOpenSheets(): void {
  for (const sheet of document.querySelectorAll<HTMLDialogElement>("dialog[data-sheet][open]")) {
    sheet.close();
  }
}

/**
 * Opens dialogs the server marked, keeping the errors it rendered. They are part of the page, so
 * they are there at once instead of scaling in (a first paint never animates, spec 21.7).
 */
export function openMarkedDialogs(): void {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[data-open-on-load]")) {
    dialog.removeAttribute("data-open-on-load");
    if (!dialog.open) {
      dialog.setAttribute("data-motion-pause", "");
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => dialog.removeAttribute("data-motion-pause")),
      );
    }
  }
}

export function initDialogs(): void {
  initQuietFocus();
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const trigger = target?.closest<HTMLElement>("[data-dialog-open]");
    if (trigger) {
      const dialog = document.getElementById(trigger.dataset.dialogOpen ?? "");
      if (dialog instanceof HTMLDialogElement) {
        event.preventDefault();
        // A menu item that opens a dialog closes its menu first.
        trigger.closest<HTMLElement>("[popover]")?.hidePopover();
        fill(dialog, trigger.dataset.dialogFill);
        openDialog(dialog, trigger);
      }
      return;
    }
    const closer = target?.closest<HTMLElement>("[data-dialog-close]");
    if (closer) {
      closer.closest("dialog")?.close();
      return;
    }
    // Backdrop clicks arrive on the dialog element itself.
    if (target instanceof HTMLDialogElement && target.open) {
      const startedOutside = pressedOutside.get(target) ?? false;
      pressedOutside.delete(target);
      if (startedOutside && outside(target, event.clientX, event.clientY)) target.close();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof HTMLDialogElement && target.open) {
      pressedOutside.set(target, outside(target, event.clientX, event.clientY));
    } else {
      const dialog = (target as Element | null)?.closest?.("dialog");
      if (dialog) pressedOutside.set(dialog, false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const dialog = (document.activeElement as Element | null)?.closest("dialog[open]");
    if (!(dialog instanceof HTMLDialogElement) || !dialog.matches(":modal")) return;
    const items = tabbables(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // `close` doesn't bubble; listening in the capture phase catches it for every dialog.
  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement)) return;
      const opener = openers.get(dialog);
      openers.delete(dialog);
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    },
    true,
  );
}
