import {
  browserCopyEnvironment,
  COPIED_MESSAGE,
  COPY_REFUSED_MESSAGE,
  copyText,
} from "../lib/copy-text.ts";
import { showToast } from "./toasts.ts";

/** Copy buttons: any element with `data-copy`. Copying only runs from a real click (spec 21.9). */
export function initCopyButtons(): void {
  document.addEventListener("click", async (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>("[data-copy]");
    if (!button || !event.isTrusted) return;
    event.preventDefault();
    const ok = await copyText(button.dataset.copy ?? "", browserCopyEnvironment());
    // A button may name what it copied ("Backup codes copied to clipboard").
    const done = button.dataset.copyMessage || COPIED_MESSAGE;
    showToast(ok ? done : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" });
  });
}
