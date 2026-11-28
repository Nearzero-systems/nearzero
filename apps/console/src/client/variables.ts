import type { EnvProblem } from "@nearzero/shared/browser";
import type { RevealedVariables } from "../lib/data/types.ts";
import { iconSvg } from "../lib/icons.ts";
import {
  apiProblems,
  type EditorRow,
  FORM_COMMENTS_NOTE,
  formProblems,
  pasteRows,
  problemLabel,
  SAVED_DETAIL,
  SAVED_MESSAGE,
  shouldMergePaste,
  sizeLabel,
  startEditing,
  TEXT_MODE_HINT,
  textOfRows,
  textProblems,
  warningsFor,
} from "../lib/variables-editor.ts";
import { asApiError, callApi, refreshPage } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * The variables editor (spec 05 5.5), in place inside a [data-vars] panel. Edit loads the values
 * (the reveal endpoint) and opens the form, or the .env text when the form can't hold the text
 * exactly. Saving always sends the whole text: the form's rows are written into the text the
 * form was opened from with the shared rules (textFromRows), so comments and every unchanged
 * line are kept byte for byte, and the API checks the same rules again.
 */

interface Editor {
  root: HTMLElement;
  host: HTMLElement;
  mode: "form" | "text";
  /** The text the form's rows are written into: the saved text, or the last text-mode text. */
  base: string;
  rows: EditorRow[];
  text: string;
  version: number;
  showValues: boolean;
  notes: string[];
  problems: { line: number; message: string }[];
  /** Why the form can't hold the text, while it is open as text. */
  reason: string | null;
}

const editors = new WeakMap<HTMLElement, Editor>();

function button(
  label: string,
  attrs: Record<string, string>,
  variant = "outline",
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `nz-btn nz-btn--${variant}`;
  element.textContent = label;
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  return element;
}

function noAutofill(input: HTMLInputElement | HTMLTextAreaElement): void {
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("data-1p-ignore", "");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-form-type", "other");
}

function currentText(editor: Editor): string {
  return editor.mode === "text" ? editor.text : textOfRows(editor.base, editor.rows);
}

function blocking(editor: Editor): EnvProblem[] {
  return editor.mode === "text"
    ? textProblems(editor.text)
    : formProblems(editor.base, editor.rows);
}

function render(editor: Editor): void {
  const { host } = editor;
  const parts: HTMLElement[] = [];

  if (editor.reason) {
    const reason = document.createElement("p");
    reason.className = "nz-inline-note";
    reason.textContent = editor.reason;
    parts.push(reason);
  }

  if (editor.mode === "form") {
    if (editor.rows.some((row) => row.above.some((line) => line.trim() !== ""))) {
      const note = document.createElement("p");
      note.className = "nz-hint";
      note.textContent = FORM_COMMENTS_NOTE;
      parts.push(note);
    }
    const list = document.createElement("div");
    list.className = "nz-var-rows";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Variables");
    editor.rows.forEach((row, index) => {
      const comments = row.above.filter((line) => line.trim() !== "");
      if (comments.length > 0) {
        const block = document.createElement("pre");
        block.className = "nz-var-comment";
        block.textContent = comments.join("\n");
        list.append(block);
      }
      const line = document.createElement("div");
      line.className = "nz-var-edit-row";
      line.dataset.row = String(index);
      const name = document.createElement("input");
      name.className = "nz-input nz-var-name-input";
      name.value = row.name;
      name.placeholder = "NAME";
      name.dataset.rowName = String(index);
      name.setAttribute("aria-label", `Name of variable ${index + 1}`);
      noAutofill(name);
      const value = document.createElement("input");
      value.className = "nz-input nz-var-value-input";
      value.classList.toggle("nz-masked", !editor.showValues);
      value.value = row.value;
      value.placeholder = "value";
      value.dataset.rowValue = String(index);
      value.setAttribute("aria-label", `Value of ${row.name || `variable ${index + 1}`}`);
      noAutofill(value);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "nz-btn nz-btn--icon";
      remove.innerHTML = iconSvg("trash");
      remove.setAttribute("aria-label", `Remove ${row.name || `variable ${index + 1}`}`);
      remove.title = "Remove";
      remove.dataset.rowRemove = String(index);
      const problem = editor.problems.find((item) => item.line === index + 1);
      if (problem) {
        name.setAttribute("aria-invalid", "true");
        line.dataset.invalid = "true";
      }
      line.append(name, value, remove);
      list.append(line);
    });
    if (editor.rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "nz-dim";
      empty.textContent = "No variables. Add one, or paste an env file into a box.";
      list.append(empty);
    }
    parts.push(list);
  } else {
    const area = document.createElement("textarea");
    area.className = "nz-textarea nz-code-input";
    area.rows = Math.min(24, Math.max(6, editor.text.split("\n").length + 1));
    area.value = editor.text;
    area.dataset.varsText = "";
    area.setAttribute("aria-label", ".env text");
    area.classList.toggle("nz-masked", !editor.showValues);
    noAutofill(area);
    parts.push(area);
    const hint = document.createElement("p");
    hint.className = "nz-hint";
    hint.textContent = TEXT_MODE_HINT;
    parts.push(hint);
  }

  const status = document.createElement("div");
  status.className = "nz-var-status";
  status.dataset.varsStatus = "";
  parts.push(status);

  const tools = document.createElement("div");
  tools.className = "nz-var-tools";
  if (editor.mode === "form") tools.append(button("Add variable", { "data-vars-add-row": "" }));
  tools.append(
    button(editor.showValues ? "Hide values" : "Show values", { "data-vars-toggle-values": "" }),
    button(editor.mode === "form" ? "Edit as .env" : "Use the form", { "data-vars-mode": "" }),
  );
  const end = document.createElement("span");
  end.className = "nz-var-tools-end";
  end.append(
    button("Cancel", { "data-vars-cancel": "" }),
    button("Save variables", { "data-vars-save": "" }, "primary"),
  );
  tools.append(end);
  parts.push(tools);

  host.replaceChildren(...parts);
  renderStatus(editor);
}

/** The problems, notes, warnings and size under the editor; redrawn as people type. */
function renderStatus(editor: Editor): void {
  const slot = editor.host.querySelector<HTMLElement>("[data-vars-status]");
  if (!slot) return;
  const items: HTMLElement[] = [];
  for (const problem of editor.problems) {
    const item = document.createElement("p");
    item.className = "nz-inline-error";
    item.setAttribute("role", "alert");
    item.innerHTML = iconSvg("alert");
    const text = document.createElement("span");
    text.textContent = problemLabel({ line: problem.line, message: problem.message }, editor.mode);
    item.append(text);
    items.push(item);
  }
  for (const message of editor.notes) {
    const item = document.createElement("p");
    item.className = "nz-inline-note";
    item.textContent = message;
    items.push(item);
  }
  const names =
    editor.mode === "form"
      ? editor.rows.map((row) => row.name)
      : editor.text.split(/\r?\n/).map((line) => line.split("=")[0] ?? "");
  for (const message of warningsFor(names)) {
    const item = document.createElement("p");
    item.className = "nz-inline-note nz-warn-note";
    item.textContent = message;
    items.push(item);
  }
  const size = document.createElement("p");
  size.className = "nz-hint";
  size.textContent = sizeLabel(new TextEncoder().encode(currentText(editor)).length);
  items.push(size);
  slot.replaceChildren(...items);
}

async function reveal(root: HTMLElement): Promise<RevealedVariables> {
  return callApi<RevealedVariables>("POST", `${root.dataset.apiPath ?? ""}/reveal`);
}

async function openEditor(root: HTMLElement, addRow: boolean): Promise<void> {
  const host = root.querySelector<HTMLElement>("[data-vars-editor]");
  const view = root.querySelector<HTMLElement>("[data-vars-view]");
  const actions = root.querySelector<HTMLElement>("[data-vars-actions]");
  if (!host || !view) return;
  let revealed: RevealedVariables;
  try {
    revealed = await reveal(root);
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
    return;
  }
  const start = startEditing(revealed.text);
  const editor: Editor = {
    root,
    host,
    mode: start.mode,
    base: revealed.text,
    rows: start.rows,
    text: revealed.text,
    version: revealed.version,
    showValues: false,
    notes: [],
    problems: [],
    reason: start.reason,
  };
  if (addRow && editor.mode === "form") editor.rows.push({ name: "", value: "", above: [] });
  editors.set(root, editor);
  view.hidden = true;
  if (actions) actions.hidden = true;
  host.hidden = false;
  render(editor);
  const focus =
    editor.mode === "form"
      ? host.querySelector<HTMLInputElement>(`[data-row-name="${editor.rows.length - 1}"]`)
      : host.querySelector<HTMLTextAreaElement>("[data-vars-text]");
  focus?.focus();
}

function closeEditor(editor: Editor): void {
  editors.delete(editor.root);
  editor.host.hidden = true;
  editor.host.replaceChildren();
  const view = editor.root.querySelector<HTMLElement>("[data-vars-view]");
  const actions = editor.root.querySelector<HTMLElement>("[data-vars-actions]");
  if (view) view.hidden = false;
  if (actions) actions.hidden = false;
}

/** Rows left completely empty are dropped rather than refused. */
function dropBlankRows(editor: Editor): void {
  editor.rows = editor.rows.filter((row) => row.name.trim() !== "" || row.value !== "");
}

function switchMode(editor: Editor): void {
  editor.notes = [];
  if (editor.mode === "form") {
    dropBlankRows(editor);
    const problems = formProblems(editor.base, editor.rows);
    if (problems.length > 0) {
      editor.problems = problems;
      renderStatus(editor);
      render(editor);
      return;
    }
    editor.text = textOfRows(editor.base, editor.rows);
    editor.mode = "text";
    editor.reason = null;
    editor.problems = [];
  } else {
    const start = startEditing(editor.text);
    if (start.reason) {
      // The form can't hold this text exactly; stay in text mode and say why.
      editor.reason = start.reason;
      editor.problems = textProblems(editor.text);
      render(editor);
      return;
    }
    editor.base = editor.text;
    editor.rows = start.rows;
    editor.mode = "form";
    editor.reason = null;
    editor.problems = [];
  }
  render(editor);
}

async function save(editor: Editor): Promise<void> {
  if (editor.mode === "form") dropBlankRows(editor);
  const problems = blocking(editor);
  editor.notes = [];
  if (problems.length > 0) {
    editor.problems = problems;
    render(editor);
    editor.host.querySelector<HTMLElement>('[aria-invalid="true"], [data-vars-text]')?.focus();
    return;
  }
  const saveButton = editor.host.querySelector<HTMLButtonElement>("[data-vars-save]");
  saveButton?.setAttribute("aria-disabled", "true");
  try {
    await callApi("PUT", editor.root.dataset.apiPath ?? "", {
      text: currentText(editor),
      baseVersion: editor.version,
    });
    showToast(`${SAVED_MESSAGE}. ${SAVED_DETAIL}`, { tone: "success" });
    closeEditor(editor);
    await refreshPage();
  } catch (error) {
    const problem = asApiError(error);
    editor.problems = apiProblems(problem.fields, problem.message);
    renderStatus(editor);
  } finally {
    saveButton?.removeAttribute("aria-disabled");
  }
}

function editorOf(element: Element | null): Editor | null {
  const root = element?.closest<HTMLElement>("[data-vars]");
  return root ? (editors.get(root) ?? null) : null;
}

function setRevealLabel(control: HTMLElement, showing: boolean): void {
  control.setAttribute("aria-pressed", showing ? "true" : "false");
  const label = control.querySelector<HTMLElement>("[data-vars-reveal-label]");
  if (label) label.textContent = showing ? "Hide values" : "Show values";
}

/** Shows or hides the values of one or more panels; `control` is their Show values button. */
async function toggleViewValues(roots: HTMLElement[], control: HTMLElement): Promise<void> {
  const showing = control.getAttribute("aria-pressed") === "true";
  if (showing) {
    for (const root of roots) {
      for (const cell of root.querySelectorAll<HTMLElement>("[data-var-value]"))
        cell.textContent = cell.dataset.empty === "true" ? "empty" : "••••••••";
    }
    setRevealLabel(control, false);
    return;
  }
  try {
    const revealed = await Promise.all(roots.map((root) => reveal(root)));
    roots.forEach((root, index) => {
      const values = new Map(revealed[index]?.rows.map((row) => [row.name, row.value]) ?? []);
      for (const cell of root.querySelectorAll<HTMLElement>("[data-var-value]")) {
        const name = cell.closest<HTMLElement>("[data-var-name]")?.dataset.varName ?? "";
        const value = values.get(name);
        cell.textContent = value === undefined || value === "" ? "empty" : value;
      }
    });
    setRevealLabel(control, true);
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  }
}

/** The panels a Show values button works on: its own, or the ids in data-vars-for (a card's). */
function revealRoots(control: HTMLElement): HTMLElement[] {
  const own = control.closest<HTMLElement>("[data-vars]");
  if (own) return [own];
  return (control.dataset.varsFor ?? "")
    .split(" ")
    .map((id) => (id ? document.getElementById(id) : null))
    .filter((root): root is HTMLElement => root?.hasAttribute("data-vars") === true);
}

export function initVariables(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const editButton = target?.closest<HTMLElement>("[data-vars-edit]");
    if (editButton) {
      const root = editButton.closest<HTMLElement>("[data-vars]");
      if (root) void openEditor(root, editButton.hasAttribute("data-vars-add"));
      return;
    }
    const revealButton = target?.closest<HTMLElement>("[data-vars-reveal]");
    if (revealButton) {
      const roots = revealRoots(revealButton);
      if (roots.length > 0) void toggleViewValues(roots, revealButton);
      return;
    }
    const editor = editorOf(target);
    if (!editor) return;
    if (target?.closest("[data-vars-add-row]")) {
      editor.rows.push({ name: "", value: "", above: [] });
      render(editor);
      editor.host
        .querySelector<HTMLInputElement>(`[data-row-name="${editor.rows.length - 1}"]`)
        ?.focus();
    } else if (target?.closest("[data-vars-toggle-values]")) {
      editor.showValues = !editor.showValues;
      render(editor);
    } else if (target?.closest("[data-vars-mode]")) {
      switchMode(editor);
    } else if (target?.closest("[data-vars-cancel]")) {
      closeEditor(editor);
    } else if (target?.closest("[data-vars-save]")) {
      void save(editor);
    } else {
      const remove = target?.closest<HTMLElement>("[data-row-remove]");
      if (remove) {
        editor.rows.splice(Number(remove.dataset.rowRemove), 1);
        editor.problems = [];
        render(editor);
      }
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
    const editor = editorOf(target);
    if (!editor || !target) return;
    if (target.dataset.rowName !== undefined) {
      const row = editor.rows[Number(target.dataset.rowName)];
      if (row) row.name = target.value;
    } else if (target.dataset.rowValue !== undefined) {
      const row = editor.rows[Number(target.dataset.rowValue)];
      if (row) row.value = target.value;
    } else if (target.dataset.varsText !== undefined) {
      editor.text = target.value;
    } else {
      return;
    }
    if (editor.problems.length > 0) editor.problems = [];
    renderStatus(editor);
  });

  // Pasting a whole env file into any box of the form fills the rows (spec 05 5.5).
  document.addEventListener("paste", (event) => {
    const target = event.target as HTMLInputElement | null;
    const editor = editorOf(target);
    if (editor?.mode !== "form" || !target?.matches("[data-row-name], [data-row-value]")) {
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!shouldMergePaste(text)) return;
    event.preventDefault();
    const kept = editor.rows.filter((row) => row.name.trim() !== "" || row.value !== "");
    const merged = pasteRows(kept, text);
    editor.rows = merged.rows;
    editor.notes = merged.messages;
    editor.problems = [];
    render(editor);
  });
}
