import { stripInternalIds } from "@nearzero/shared/browser";
import { Lexer, type Token } from "marked";

/**
 * The Agent's answers as Markdown (spec 19.4): headings, lists, quotes, inline code, tables and
 * code blocks. Text is split into tokens here and drawn by the chat's own components, so raw
 * HTML in an answer is shown as text and never becomes markup. Ids are removed first with the
 * shared stripping function, and a table written on one line is turned into a real table.
 */

export type { Token };

function splitCells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|");
}

/**
 * "| A | B | |---|---| | 1 | 2 |" written on one line becomes the three-line table it means.
 * The separator decides the column count; the header is the row just before it; the rest is cut
 * into rows of that many cells (the empty cell between "| |" is the line break that went
 * missing). Lines that don't fit that shape are left alone.
 */
export function expandInlineTable(line: string): string | null {
  if (!line.includes("|") || !/\|\s*:?-{3,}:?\s*\|/.test(line)) return null;
  const sepMatch = /\|(?:\s*:?-{3,}:?\s*\|)+/.exec(line);
  if (!sepMatch) return null;
  const separator = sepMatch[0];
  const columns = separator.split("|").length - 2;
  if (columns < 1) return null;
  const before = line.slice(0, sepMatch.index).trimEnd();
  const after = line.slice(sepMatch.index + separator.length).trim();
  // The header: the last `columns` cells before the separator, with their pipes.
  if (!before.endsWith("|")) return null;
  const pipes: number[] = [];
  for (let index = before.length - 1; index >= 0 && pipes.length <= columns; index--) {
    if (before[index] === "|") pipes.push(index);
  }
  if (pipes.length < columns + 1) return null;
  const headerStart = pipes[columns] as number;
  const prefix = before.slice(0, headerStart).trim();
  const header = before.slice(headerStart);
  if (splitCells(header).length !== columns) return null;
  if (after === "") {
    return [prefix, header, separator].filter(Boolean).join("\n");
  }
  if (!after.startsWith("|")) return null;
  const cells = splitCells(after);
  const rows: string[] = [];
  let index = 0;
  let trailing = "";
  while (index < cells.length) {
    const row = cells.slice(index, index + columns);
    if (row.length < columns) {
      trailing = row.join("|").trim();
      break;
    }
    rows.push(`| ${row.map((cell) => cell.trim()).join(" | ")} |`);
    index += columns;
    // The boundary between two rows: "| |" leaves one empty cell.
    if (index < cells.length && (cells[index] ?? "").trim() === "") index += 1;
  }
  if (rows.length === 0) return null;
  const lines = [prefix, header, separator, ...rows];
  if (trailing) lines.push("", trailing);
  return lines.filter((part, position) => part !== "" || position > 3).join("\n");
}

/** Expands one-line tables outside code fences. */
export function expandInlineTables(text: string): string {
  if (!text.includes("|")) return text;
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1] as string;
      if (fence === null) fence = mark;
      else if (mark.startsWith(fence[0] as string) && mark.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (fence === null) {
      const expanded = expandInlineTable(line);
      if (expanded !== null) {
        if (out.length > 0 && (out[out.length - 1] ?? "").trim() !== "") out.push("");
        out.push(expanded);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Answer text to tokens: ids out, one-line tables expanded, GitHub-flavored Markdown. */
export function lexAnswer(text: string): Token[] {
  const source = expandInlineTables(stripInternalIds(text));
  try {
    return new Lexer({ gfm: true, breaks: false }).lex(source);
  } catch {
    return [
      {
        type: "paragraph",
        raw: source,
        text: source,
        tokens: [{ type: "text", raw: source, text: source }],
      },
    ];
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Text tokens keep character references as written; show the characters they stand for. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : match;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Links open in a new tab; only web, mail and console addresses become links. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return null;
}

/** A code block's language label: "bash", "yaml"…, or "text" when unknown. */
export function languageLabel(lang: string | undefined): string {
  const word = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (word === "") return "text";
  const names: Record<string, string> = {
    sh: "shell",
    zsh: "shell",
    console: "shell",
    shell: "shell",
    yml: "yaml",
    js: "javascript",
    ts: "typescript",
    py: "python",
    dockerfile: "dockerfile",
    env: "env",
  };
  return names[word] ?? word.slice(0, 24);
}
