/**
 * Copying text (spec 21.9). The asynchronous clipboard API is missing on plain HTTP, so after
 * trying it we select a hidden read-only field and run the copy command. When a modal dialog is
 * open the rest of the page is inert, so the field goes inside the topmost open dialog.
 */

export const COPY_REFUSED_MESSAGE = "The browser refused to copy.";
export const COPIED_MESSAGE = "Copied to clipboard";

interface FieldLike {
  value: string;
  readOnly: boolean;
  setAttribute(name: string, value: string): void;
  style: { cssText: string };
  focus(options?: { preventScroll?: boolean }): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
}

interface HostLike {
  append(node: never): void;
}

interface FocusableLike {
  focus(options?: { preventScroll?: boolean }): void;
}

export interface CopyEnvironment {
  clipboard: { writeText(text: string): Promise<void> } | null | undefined;
  createField(): FieldLike;
  /** The open modal dialogs, in document order. */
  openDialogs(): HostLike[];
  body: HostLike;
  activeElement(): FocusableLike | null;
  execCopy(): boolean;
}

/** Where the fallback field goes: the last open dialog (the topmost), else the body. */
export function fallbackHost(env: Pick<CopyEnvironment, "openDialogs" | "body">): HostLike {
  const dialogs = env.openDialogs();
  return dialogs[dialogs.length - 1] ?? env.body;
}

function copyWithField(text: string, env: CopyEnvironment): boolean {
  const previous = env.activeElement();
  const field = env.createField();
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.setAttribute("tabindex", "-1");
  // Visible to the selection machinery, invisible to people.
  field.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;";
  (fallbackHost(env).append as (node: FieldLike) => void)(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    return env.execCopy();
  } catch {
    return false;
  } finally {
    field.remove();
    try {
      previous?.focus({ preventScroll: true });
    } catch {
      // The element that had focus may be gone; nothing to restore.
    }
  }
}

/** Copies `text`; true when the browser accepted it. Call it from a real click. */
export async function copyText(text: string, env: CopyEnvironment): Promise<boolean> {
  const writeText = env.clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(env.clipboard, text);
      return true;
    } catch {
      // Refused or unavailable here; try the selection fallback.
    }
  }
  return copyWithField(text, env);
}

/** The real browser environment. Reads `navigator.clipboard` without assuming it exists. */
export function browserCopyEnvironment(): CopyEnvironment {
  const nav = globalThis.navigator as (Navigator & { clipboard?: Clipboard }) | undefined;
  return {
    clipboard: nav && "clipboard" in nav ? nav.clipboard : undefined,
    createField: () => document.createElement("textarea"),
    openDialogs: () => Array.from(document.querySelectorAll("dialog[open]")),
    body: document.body,
    activeElement: () => document.activeElement as HTMLElement | null,
    execCopy: () => document.execCommand("copy"),
  };
}
