/**
 * Folding rules of the chat (spec 19.4): code blocks fold after 24 lines, a step's raw result
 * after 14 lines or 1,600 characters (it is capped at 6,000 by the platform), a failed step's
 * reason shows up to 280 characters, and long questions fold until clicked.
 */

export const CODE_FOLD_LINES = 24;
export const RESULT_FOLD_LINES = 14;
export const RESULT_FOLD_CHARS = 1_600;
export const RESULT_CAP_CHARS = 6_000;
export const REASON_MAX_CHARS = 280;
export const QUESTION_FOLD_LINES = 10;
export const QUESTION_FOLD_CHARS = 700;

export interface Folded {
  shown: string;
  /** Lines left out ("Show more (N more lines)"); 0 when nothing is folded. */
  hiddenLines: number;
  folded: boolean;
}

/** A code block: the first 24 lines, and how many more there are. */
export function foldCode(code: string, open: boolean, limit = CODE_FOLD_LINES): Folded {
  const text = code.replace(/\n$/, "");
  const lines = text.split("\n");
  if (open || lines.length <= limit) return { shown: text, hiddenLines: 0, folded: false };
  return {
    shown: lines.slice(0, limit).join("\n"),
    hiddenLines: lines.length - limit,
    folded: true,
  };
}

export function showMoreLabel(hiddenLines: number): string {
  return `Show more (${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"})`;
}

/** A step's raw result: folded after 14 lines or 1,600 characters, never over 6,000. */
export function foldResult(result: string, open: boolean): Folded & { capped: boolean } {
  const capped = result.length > RESULT_CAP_CHARS;
  const text = capped ? result.slice(0, RESULT_CAP_CHARS) : result;
  const lines = text.split("\n");
  const tooLong = lines.length > RESULT_FOLD_LINES || text.length > RESULT_FOLD_CHARS;
  if (open || !tooLong) return { shown: text, hiddenLines: 0, folded: false, capped };
  let shown = lines.slice(0, RESULT_FOLD_LINES).join("\n");
  if (shown.length > RESULT_FOLD_CHARS) shown = shown.slice(0, RESULT_FOLD_CHARS);
  const shownLines = shown.split("\n").length;
  return { shown, hiddenLines: Math.max(1, lines.length - shownLines), folded: true, capped };
}

/** A failed step's reason under its row: at most 280 characters. */
export function shortReason(reason: string | null): string | null {
  if (!reason) return null;
  const clean = reason.trim();
  if (clean.length <= REASON_MAX_CHARS) return clean;
  return `${clean.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…`;
}

/** Whether a question is long enough to fold. */
export function questionFolds(text: string): boolean {
  return text.length > QUESTION_FOLD_CHARS || text.split("\n").length > QUESTION_FOLD_LINES;
}

/** Quotes: up to 1,200 characters of the selection, on one chip. */
export function clipQuote(selection: string, max = 1_200): string {
  const text = selection
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length <= max ? text : text.slice(0, max);
}

/** File sizes on chips: "820 B", "14 KB", "3.2 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / 1024 / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
