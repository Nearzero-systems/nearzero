import { checkRows, type EnvProblem, looksLikeEnvFile, mergePaste } from "@nearzero/shared/browser";

/**
 * The Agent's variables form (spec 19.8): one fixed row per name the Agent asked for, more rows
 * the person adds, pasting a whole env file into any box, a counter, and the one-line rule. The
 * values go from the browser to the service's variables API; the chat only learns the names.
 */

export interface VariableRow {
  /** Stable key for the page. */
  key: string;
  name: string;
  value: string;
  /** Asked for by the Agent: the name can't be changed or removed. */
  fixed: boolean;
}

export const ONE_LINE_RULE = "Values must fit on one line. Put it on one line with \\n.";

export function initialRows(names: readonly string[]): VariableRow[] {
  const seen = new Set<string>();
  const rows: VariableRow[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ key: `fixed-${name}`, name, value: "", fixed: true });
  }
  return rows;
}

let added = 0;
export function newRow(): VariableRow {
  added += 1;
  return { key: `added-${added}`, name: "", value: "", fixed: false };
}

/** "N of M set": rows with a value, of all rows with a name. */
export function counterText(rows: readonly VariableRow[]): string {
  const named = rows.filter((row) => row.name.trim() !== "" || row.fixed);
  const set = named.filter((row) => row.value !== "").length;
  return `${set} of ${named.length} set`;
}

/** Rows with a name (the Agent's and the person's). */
export function namedCount(rows: readonly VariableRow[]): number {
  return rows.filter((row) => row.fixed || row.name.trim() !== "").length;
}

/** The rows that will be saved: a name and a value. */
export function rowsToSave(rows: readonly VariableRow[]): { name: string; value: string }[] {
  return rows
    .filter((row) => row.name.trim() !== "" && row.value !== "")
    .map((row) => ({ name: row.name.trim(), value: row.value }));
}

/** "Save 2 variables and deploy" (or without "and deploy" when the form doesn't deploy). */
export function saveLabel(deployLabel: string, count: number): string {
  const deploys = /and deploy\s*$/i.test(deployLabel);
  const noun = count === 1 ? "variable" : "variables";
  return `Save ${count} ${noun}${deploys ? " and deploy" : ""}`;
}

export interface RowProblem {
  key: string;
  message: string;
}

/**
 * What blocks saving: invalid or duplicate names, values over several lines. Empty added rows
 * are ignored (they are simply not saved); fixed rows may stay empty.
 */
export function rowProblems(rows: readonly VariableRow[]): RowProblem[] {
  const considered = rows.filter((row) => row.fixed || row.name.trim() !== "" || row.value !== "");
  const input = considered.map((row) => ({ name: row.name, value: row.value }));
  const problems: EnvProblem[] = checkRows(input).filter((problem) => {
    const row = considered[problem.line - 1];
    // A fixed row with no value yet is fine: it is just not saved.
    return !(row?.fixed && row.value === "" && /is empty/.test(problem.message));
  });
  return problems.map((problem) => {
    const row = considered[problem.line - 1];
    const message = /several lines/.test(problem.message)
      ? `${row?.name.trim() || "This value"}: ${ONE_LINE_RULE}`
      : problem.message;
    return { key: row?.key ?? "", message };
  });
}

export interface PasteOutcome {
  rows: VariableRow[];
  /** Fixed or existing rows whose value came from the paste. */
  filled: number;
  added: number;
  /** 1-based lines of the paste that were skipped (only their numbers are shown). */
  skippedLines: number[];
  report: string;
}

function listLines(lines: readonly number[]): string {
  if (lines.length === 1) return `line ${lines[0]}`;
  return `lines ${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}`;
}

/**
 * A paste into any box of the form: when it looks like an env file, it fills the rows (values
 * of names already there, new rows for new names) and reports what happened, by line number
 * only. Otherwise null, and the paste goes into the box as usual.
 */
export function pasteEnv(rows: readonly VariableRow[], text: string): PasteOutcome | null {
  if (!looksLikeEnvFile(text)) return null;
  const merged = mergePaste(
    rows.map((row) => ({ name: row.name, value: row.value })),
    text,
  );
  const next: VariableRow[] = merged.rows.map((row, index) => {
    const existing = rows[index];
    if (existing) return { ...existing, value: row.value };
    return { ...newRow(), name: row.name, value: row.value };
  });
  const filled = merged.updated;
  const parts: string[] = [];
  parts.push(
    `Filled ${filled} ${filled === 1 ? "value" : "values"} and added ${merged.added} ${
      merged.added === 1 ? "variable" : "variables"
    } from the paste.`,
  );
  const skipped = [...merged.leftOutLines];
  if (skipped.length > 0) parts.push(`Skipped ${listLines(skipped)}: not one-line NAME=value.`);
  if (merged.commentsLeftOut) parts.push("Comments were skipped.");
  return {
    rows: next,
    filled,
    added: merged.added,
    skippedLines: skipped,
    report: parts.join(" "),
  };
}

/** A paste of several lines into one value box that isn't an env file: refused. */
export function multiLineValue(text: string): boolean {
  return /[\r\n]/.test(text.replace(/[\r\n]+$/, ""));
}

/**
 * The body for PUT /services/:id/variables in form mode: every name already saved is kept as it
 * is (its value is never read), and the form's rows are written over or added.
 */
export function mergeBody(
  savedNames: readonly string[],
  rows: readonly { name: string; value: string }[],
  baseVersion: number | undefined,
): { rows: { name: string; value?: string; keep?: boolean }[]; baseVersion?: number } {
  const fromForm = new Map(rows.map((row) => [row.name, row.value]));
  const out: { name: string; value?: string; keep?: boolean }[] = [];
  for (const name of savedNames) {
    const value = fromForm.get(name);
    if (value !== undefined) {
      out.push({ name, value });
      fromForm.delete(name);
    } else {
      out.push({ name, keep: true });
    }
  }
  for (const [name, value] of fromForm) out.push({ name, value });
  return baseVersion === undefined ? { rows: out } : { rows: out, baseVersion };
}
