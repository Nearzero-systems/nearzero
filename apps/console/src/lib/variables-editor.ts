import {
  checkEnvText,
  checkRows,
  type EnvProblem,
  type EnvRowInput,
  FORM_COMMENTS_NOTE,
  formFromText,
  looksLikeEnvFile,
  mergePaste,
  publicSecretWarnings,
  TEXT_MODE_HINT,
  textBytes,
  textFromRows,
  VARIABLES_MAX_BYTES,
  variablesTooLargeMessage,
} from "@nearzero/shared/browser";

/**
 * The variables editor's rules (spec 05 5.5), shared by the shared-variables page and every
 * service's Variables tab. The parsing, the form/text round trip and the paste merge are the
 * shared package's own (packages/shared/src/variables.ts), so the console and the control plane
 * agree on every line; this module adds what the editor shows.
 */

export { FORM_COMMENTS_NOTE, TEXT_MODE_HINT };

export const SAVED_MESSAGE = "Variables saved";
export const SAVED_DETAIL = "They reach the service on its next deploy.";

export interface EditorRow extends EnvRowInput {
  /** Comment and empty lines right above it, exactly as saved. Shown, never edited, in the form. */
  above: string[];
}

export interface EditorStart {
  mode: "form" | "text";
  rows: EditorRow[];
  trailing: string[];
  text: string;
  /** Why the form can't hold this text exactly (it opens as text instead), or null. */
  reason: string | null;
}

/** Where the editor opens: the form, unless the saved text can't be held by it exactly. */
export function startEditing(text: string): EditorStart {
  const form = formFromText(text);
  return {
    mode: form.problem ? "text" : "form",
    rows: form.rows.map((row) => ({ name: row.name, value: row.value, above: row.above })),
    trailing: form.trailing,
    text,
    reason: form.problem,
  };
}

/** The text the form's rows become, keeping comments and unchanged lines exactly. */
export function textOfRows(original: string, rows: readonly EnvRowInput[]): string {
  return textFromRows(original, rows);
}

/** Everything that blocks saving the form, each on its row, plus the size limit. */
export function formProblems(original: string, rows: readonly EnvRowInput[]): EnvProblem[] {
  const problems = checkRows(rows);
  if (problems.length === 0 && textBytes(textFromRows(original, rows)) > VARIABLES_MAX_BYTES) {
    problems.unshift({ line: 0, message: variablesTooLargeMessage() });
  }
  return problems;
}

/** Everything that blocks saving the text, each with its line (line 0: the whole text). */
export function textProblems(text: string): EnvProblem[] {
  return checkEnvText(text);
}

/** How a problem is introduced in the list under the editor. */
export function problemLabel(problem: EnvProblem, mode: "form" | "text"): string {
  if (problem.line === 0) return problem.message;
  if (mode === "text" && problem.message.startsWith(`Line ${problem.line}`)) return problem.message;
  if (mode === "form" && problem.message.startsWith(`Row ${problem.line}`)) return problem.message;
  return `${mode === "text" ? "Line" : "Row"} ${problem.line}: ${problem.message}`;
}

/**
 * The API names the line (`lines.N`, text) or row (`rows.N`, form) of each refusal; anything
 * else is a message for the whole editor.
 */
export function apiProblems(
  fields: Record<string, string>,
  fallback: string,
): { line: number; message: string }[] {
  const problems: { line: number; message: string }[] = [];
  for (const [key, message] of Object.entries(fields)) {
    const match = key.match(/^(?:lines|rows)\.(\d+)$/);
    problems.push({ line: match ? Number(match[1]) : 0, message });
  }
  if (problems.length === 0) problems.push({ line: 0, message: fallback });
  return problems.sort((a, b) => a.line - b.line);
}

/** Pasting a whole env file fills the rows instead of one box. */
export function shouldMergePaste(text: string): boolean {
  return looksLikeEnvFile(text);
}

export function pasteRows(
  rows: readonly EditorRow[],
  pasted: string,
): { rows: EditorRow[]; messages: string[] } {
  const merged = mergePaste(
    rows.map((row) => ({ name: row.name, value: row.value })),
    pasted,
  );
  const byName = new Map(rows.map((row) => [row.name.trim(), row.above]));
  return {
    rows: merged.rows.map((row) => ({ ...row, above: byName.get(row.name.trim()) ?? [] })),
    messages: merged.messages,
  };
}

/** Secret-looking names with a public prefix: a warning, never a block, in the editor. */
export function warningsFor(names: readonly string[]): string[] {
  return publicSecretWarnings(names.map((name) => name.trim()).filter(Boolean)).map(
    (warning) => warning.message,
  );
}

/** "12.3 KB of 256 KB". */
export function sizeLabel(bytes: number): string {
  const kb = bytes / 1024;
  const shown = kb < 10 ? kb.toFixed(1) : String(Math.round(kb));
  return `${shown} KB of ${VARIABLES_MAX_BYTES / 1024} KB`;
}

export function variableCount(count: number): string {
  return `${count} ${count === 1 ? "variable" : "variables"}`;
}
