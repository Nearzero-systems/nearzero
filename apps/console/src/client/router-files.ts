import { sendForm } from "./api.ts";

/**
 * Settings → Router files (spec 18.3): a file opens read-only; Edit mode makes it editable and
 * enables Save, which sends the text exactly as typed (no trimming: whitespace is YAML's
 * structure). The control plane refuses invalid YAML or configuration with the line and reason,
 * shown under the editor; a saved file shows "Router config updated" and the page reloads.
 */

function partsOf(form: HTMLFormElement) {
  return {
    text: form.querySelector<HTMLTextAreaElement>("[data-router-file-text]"),
    save: form.querySelector<HTMLButtonElement>("[data-router-save]"),
  };
}

export function initRouterFiles(): void {
  document.addEventListener("change", (event) => {
    const toggle = event.target;
    if (!(toggle instanceof HTMLInputElement) || toggle.dataset.routerEditMode === undefined)
      return;
    const form = toggle.closest<HTMLFormElement>("[data-router-file-form]");
    if (!form) return;
    const { text, save } = partsOf(form);
    if (text) {
      text.readOnly = !toggle.checked;
      if (toggle.checked) text.focus();
    }
    if (save) save.disabled = !toggle.checked;
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.routerFileForm === undefined) return;
    event.preventDefault();
    const { text } = partsOf(form);
    if (!text || text.readOnly || form.hasAttribute("data-busy")) return;
    void sendForm(form, { contents: text.value });
  });
}
