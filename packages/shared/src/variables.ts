/**
 * Variables: the env-file text people edit, the form rows built from it, pasting, and how values
 * reach a service at deploy (spec 05 5.5). Shared so the console's editor and the control plane
 * use exactly the same rules and words.
 *
 * The stored form of a set of variables is the text itself. Saving in text mode stores what was
 * typed, byte for byte; the form keeps every line it doesn't change exactly as it was, comments
 * included.
 *
 * Grammar, one line at a time:
 * - an empty line, or a line whose first non-blank character is `#`, is kept as it is;
 * - anything else is `NAME=value`, split at the first `=`. Spaces around the name and the value
 *   are ignored. A value that starts and ends with the same quote character (`"`, `'` or `` ` ``)
 *   is the text between them, taken literally (there are no escapes). Otherwise the value is the
 *   text as written, `#` and inner quotes included: there are no comments after values.
 *
 * Env files written for other tools (an example file in a repository, say) can be read in the
 * tolerant mode of `parseEnv`, which reads what the grammar above would refuse as far as it can.
 * The editor never uses it.
 */

/** Up to 256 KB of text per service, and per environment's shared variables (spec 05 5.5). */
export const VARIABLES_MAX_BYTES = 256 * 1024;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const BUILD_SAFE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUOTES = ['"', "'", "`"] as const;
type Quote = (typeof QUOTES)[number];

/** Names start with a letter or `_`, then letters, digits, `_`, `.` or `-`. */
export function isVariableName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Builds receive only names made of letters, digits and `_`. */
export function isBuildSafeName(name: string): boolean {
  return BUILD_SAFE_PATTERN.test(name);
}

/** Docker and Compose control variables Compose never takes from shared variables. */
export function isComposeControlName(name: string): boolean {
  return (
    name.startsWith("DOCKER_") || name.startsWith("COMPOSE_") || name === "PATH" || name === "HOME"
  );
}

export function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const NAME_RULE = "Names start with a letter or _, then use letters, digits, _, . or -.";
const TOO_LARGE = `Variables can be up to ${VARIABLES_MAX_BYTES / 1024} KB of text. Remove some, or keep large values in files instead.`;

export function variablesTooLargeMessage(): string {
  return TOO_LARGE;
}

// ---- Parsing text

export interface EnvVariableLine {
  kind: "variable";
  /** 1-based line number. */
  line: number;
  /**
   * The last line, set only when a value runs over several lines, which only the tolerant mode
   * reads. `raw` then holds every line of the run.
   */
  endLine?: number;
  raw: string;
  name: string;
  value: string;
}

export interface EnvTextLine {
  kind: "blank" | "comment";
  line: number;
  raw: string;
}

/** A line (or, for an unclosed quote, a run of lines) that blocks saving. */
export interface EnvInvalidLine {
  kind: "invalid";
  line: number;
  /** The last line of the run; the same as `line` for one line. */
  endLine: number;
  raw: string;
}

export type EnvLine = EnvVariableLine | EnvTextLine | EnvInvalidLine;

export interface EnvProblem {
  /** The line (text) or the row (form) the problem is on, 1-based. */
  line: number;
  name?: string;
  message: string;
}

export interface EnvDocument {
  lines: EnvLine[];
  /** The line ending the text uses; new lines written by the form use the same. */
  newline: "\n" | "\r\n";
  finalNewline: boolean;
  variables: EnvVariableLine[];
  /** Everything that blocks saving, each with its line. */
  errors: EnvProblem[];
}

type LineResult =
  | { ok: true; name: string; value: string }
  /**
   * `opensQuote`: the value starts a quote that doesn't close on this line; `name`, `rest` (the
   * text after that quote) and `asWritten` (the value text as it stands) come with it.
   */
  | {
      ok: false;
      message: string;
      opensQuote?: Quote;
      name?: string;
      rest?: string;
      asWritten?: string;
    };

const EXPORT_PREFIX = /^export\s+/;

/**
 * One line, by the grammar above. `tolerant` drops an `export ` before the name, a comment after
 * a closing quote, and the checks on what a value may contain (all three quote characters, a
 * stray carriage return).
 */
function readLine(raw: string, line: number, tolerant = false): LineResult {
  const equals = raw.indexOf("=");
  if (equals < 0) {
    return {
      ok: false,
      message: `Line ${line} isn't NAME=value. Write it as NAME=value, or start it with # to make it a comment.`,
    };
  }
  let name = raw.slice(0, equals).trim();
  if (tolerant) name = name.replace(EXPORT_PREFIX, "");
  if (name === "") {
    return { ok: false, message: `Line ${line} has a value but no name. Write it as NAME=value.` };
  }
  if (/^export\s/.test(name)) {
    return {
      ok: false,
      message: `Line ${line} starts with "export". Write it as NAME=value, without "export".`,
    };
  }
  if (!isVariableName(name)) {
    return { ok: false, message: `Line ${line}: "${name}" isn't a valid name. ${NAME_RULE}` };
  }
  const after = raw.slice(equals + 1);
  const text = after.trim();
  let value = text;
  const first = text[0] as Quote | undefined;
  if (first && (QUOTES as readonly string[]).includes(first)) {
    const closing = text.indexOf(first, 1);
    if (text.length >= 2 && text.endsWith(first)) {
      value = text.slice(1, -1);
    } else if (closing < 0) {
      return {
        ok: false,
        name,
        opensQuote: first,
        rest: after.trimStart().slice(1),
        asWritten: text,
        message: `Line ${line}: the value of ${name} goes over several lines. Values must fit on one line.`,
      };
    } else if (tolerant) {
      value = text.slice(1, closing);
    } else {
      return {
        ok: false,
        name,
        message: `Line ${line}: there is text after the closing quote of ${name}'s value. Values can't have comments after them; put the comment on its own line, starting with #.`,
      };
    }
  }
  if (tolerant) return { ok: true, name, value };
  if (value.includes("\r")) {
    return {
      ok: false,
      name,
      message: `Line ${line}: the value of ${name} goes over several lines. Values must fit on one line.`,
    };
  }
  if (hasAllQuotes(value)) {
    return {
      ok: false,
      name,
      message: `Line ${line}: the value of ${name} contains all three quote characters (" ' \`), so it can't be written safely. Remove one kind of quote.`,
    };
  }
  return { ok: true, name, value };
}

function hasAllQuotes(value: string): boolean {
  return QUOTES.every((quote) => value.includes(quote));
}

function splitLines(text: string): { lines: string[]; newline: "\n" | "\r\n"; final: boolean } {
  if (text === "") return { lines: [], newline: "\n", final: false };
  const newline = /\r\n/.test(text) && text.indexOf("\r\n") <= text.indexOf("\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const final = lines.at(-1) === "";
  if (final) lines.pop();
  return { lines, newline, final };
}

export interface ParseEnvOptions {
  /**
   * Read an env file written for other tools as far as it can be read, instead of refusing what
   * the editor refuses: an `export ` before a name is dropped, a comment after a closing quote is
   * dropped, a quoted value may run over several lines up to its closing quote (one that never
   * closes is read as written, and the lines after it are read on their own), and values may
   * hold all three quote characters. Lines that still aren't `NAME=value` stay invalid, with
   * their errors, and names set twice are still reported.
   */
  tolerant?: boolean;
}

export function parseEnv(text: string, options: ParseEnvOptions = {}): EnvDocument {
  const tolerant = options.tolerant === true;
  const { lines: raws, newline, final } = splitLines(text);
  const lines: EnvLine[] = [];
  const errors: EnvProblem[] = [];
  const variables: EnvVariableLine[] = [];
  const firstLine = new Map<string, number>();

  const addVariable = (entry: EnvVariableLine) => {
    const earlier = firstLine.get(entry.name);
    if (earlier !== undefined) {
      errors.push({
        line: entry.line,
        name: entry.name,
        message: `${entry.name} is set twice, on lines ${earlier} and ${entry.line}. Keep one.`,
      });
    } else {
      firstLine.set(entry.name, entry.line);
    }
    lines.push(entry);
    variables.push(entry);
  };

  for (let index = 0; index < raws.length; index++) {
    const raw = raws[index] ?? "";
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "") {
      lines.push({ kind: "blank", line, raw });
      continue;
    }
    if (trimmed.startsWith("#")) {
      lines.push({ kind: "comment", line, raw });
      continue;
    }
    const result = readLine(raw, line, tolerant);
    if (result.ok) {
      addVariable({ kind: "variable", line, raw, name: result.name, value: result.value });
      continue;
    }
    if (result.opensQuote) {
      // A value over several lines: the run goes up to the line with the closing quote.
      const quote = result.opensQuote;
      let end = index;
      let closed = false;
      for (let next = index + 1; next < raws.length; next++) {
        end = next;
        if ((raws[next] ?? "").includes(quote)) {
          closed = true;
          break;
        }
      }
      if (tolerant && result.name !== undefined) {
        if (!closed) {
          addVariable({
            kind: "variable",
            line,
            raw,
            name: result.name,
            value: result.asWritten ?? "",
          });
          continue;
        }
        const last = raws[end] ?? "";
        const value = [
          result.rest ?? "",
          ...raws.slice(index + 1, end),
          last.slice(0, last.indexOf(quote)),
        ].join("\n");
        addVariable({
          kind: "variable",
          line,
          endLine: end + 1,
          raw: raws.slice(index, end + 1).join(newline),
          name: result.name,
          value,
        });
        index = end;
        continue;
      }
      // The editor refuses it: one error for the whole run.
      const span = end > index ? ` (lines ${line} to ${end + 1})` : "";
      errors.push({
        line,
        ...(result.name ? { name: result.name } : {}),
        message: `Line ${line}: the value of ${result.name} goes over several lines${span}. Values must fit on one line.`,
      });
      lines.push({
        kind: "invalid",
        line,
        endLine: end + 1,
        raw: raws.slice(index, end + 1).join(newline),
      });
      index = end;
      continue;
    }
    errors.push({ line, ...(result.name ? { name: result.name } : {}), message: result.message });
    lines.push({ kind: "invalid", line, endLine: line, raw });
  }
  return { lines, newline, finalNewline: final, variables, errors };
}

/** Problems that block saving this text, including its size. */
export function checkEnvText(text: string): EnvProblem[] {
  const problems = [...parseEnv(text).errors];
  if (textBytes(text) > VARIABLES_MAX_BYTES) problems.unshift({ line: 0, message: TOO_LARGE });
  return problems;
}

// ---- The form

export interface EnvRow {
  name: string;
  value: string;
  /** The line it is on in the text. */
  line: number;
  /** Comment and empty lines right above it, exactly as written. */
  above: string[];
}

export interface EnvForm {
  rows: EnvRow[];
  /** Comment and empty lines after the last variable. */
  trailing: string[];
  /**
   * Set when the form can't hold this text exactly: the editor opens it as text instead, with
   * this reason, so nothing is changed or lost.
   */
  problem: string | null;
}

export const FORM_COMMENTS_NOTE =
  "Comments are kept as they are. To change them, use Edit as .env.";
export const TEXT_MODE_HINT = "One per line, NAME=value. Lines starting with # are comments.";

export function formFromText(text: string): EnvForm {
  const document = parseEnv(text);
  const rows: EnvRow[] = [];
  let pending: string[] = [];
  for (const line of document.lines) {
    if (line.kind === "variable") {
      rows.push({ name: line.name, value: line.value, line: line.line, above: pending });
      pending = [];
    } else {
      pending.push(line.raw);
    }
  }
  const first = document.errors[0];
  return {
    rows,
    trailing: pending,
    problem: first
      ? `This opens as .env text, so nothing is changed or lost. ${first.message}`
      : null,
  };
}

export interface EnvRowInput {
  name: string;
  value: string;
}

/** Problems that block saving the form, each on its 1-based row. */
export function checkRows(rows: readonly EnvRowInput[]): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const seen = new Map<string, number>();
  rows.forEach((row, index) => {
    const line = index + 1;
    const name = row.name.trim();
    if (name === "") {
      if (row.value !== "") {
        problems.push({ line, message: `Row ${line} has a value but no name. Give it a name.` });
      } else {
        problems.push({ line, message: `Row ${line} is empty. Fill it in or remove it.` });
      }
      return;
    }
    if (!isVariableName(name)) {
      problems.push({ line, name, message: `"${name}" isn't a valid name. ${NAME_RULE}` });
      return;
    }
    const earlier = seen.get(name);
    if (earlier !== undefined) {
      problems.push({
        line,
        name,
        message: `${name} is set twice, in rows ${earlier} and ${line}. Keep one.`,
      });
    } else {
      seen.set(name, line);
    }
    if (/[\r\n]/.test(row.value)) {
      problems.push({
        line,
        name,
        message: `The value of ${name} goes over several lines. Values must fit on one line.`,
      });
    } else if (hasAllQuotes(row.value)) {
      problems.push({
        line,
        name,
        message: `The value of ${name} contains all three quote characters (" ' \`), so it can't be written safely. Remove one kind of quote.`,
      });
    }
  });
  return problems;
}

/** One `NAME=value` line that reads back as exactly this value. */
export function writeVariableLine(name: string, value: string): string {
  const plain =
    value === "" ||
    (value === value.trim() && !(QUOTES as readonly string[]).includes(value[0] ?? ""));
  if (plain) return `${name}=${value}`;
  const quote = QUOTES.find((candidate) => !value.includes(candidate));
  if (!quote) throw new Error(`The value of ${name} can't be quoted.`);
  return `${name}=${quote}${value}${quote}`;
}

/**
 * The text after saving the form: rows in their order, each keeping the comments above it, lines
 * of unchanged rows kept exactly, and changed or new rows written fresh. Comments above a row
 * that was removed stay, above the next row that is still there.
 */
export function textFromRows(original: string, rows: readonly EnvRowInput[]): string {
  const document = parseEnv(original);
  interface Entry {
    name: string;
    value: string;
    raw: string;
    above: string[];
    kept: boolean;
  }
  const entries: Entry[] = [];
  let pending: string[] = [];
  for (const line of document.lines) {
    if (line.kind === "variable") {
      entries.push({
        name: line.name,
        value: line.value,
        raw: line.raw,
        above: pending,
        kept: false,
      });
      pending = [];
    } else {
      pending.push(line.raw);
    }
  }
  const trailing = pending;

  const matches = rows.map((row) => {
    const entry = entries.find(
      (candidate) => !candidate.kept && candidate.name === row.name.trim(),
    );
    if (entry) entry.kept = true;
    return entry;
  });
  let carried: string[] = [];
  for (const entry of entries) {
    if (entry.kept) {
      entry.above = [...carried, ...entry.above];
      carried = [];
    } else {
      carried = [...carried, ...entry.above];
    }
  }

  const out: string[] = [];
  rows.forEach((row, index) => {
    const name = row.name.trim();
    const entry = matches[index];
    if (entry) {
      out.push(...entry.above);
      out.push(entry.value === row.value ? entry.raw : writeVariableLine(name, row.value));
    } else {
      out.push(writeVariableLine(name, row.value));
    }
  });
  out.push(...carried, ...trailing);
  if (out.length === 0) return "";
  const final = document.finalNewline || original === "";
  return out.join(document.newline) + (final ? document.newline : "");
}

/** The same text with every value emptied: what a copy in another environment gets. */
export function blankValues(text: string): string {
  const document = parseEnv(text);
  const out = document.lines.map((line) =>
    line.kind === "variable" ? `${line.name}=` : line.kind === "invalid" ? null : line.raw,
  );
  const kept = out.filter((line): line is string => line !== null);
  if (kept.length === 0) return "";
  return kept.join(document.newline) + (document.finalNewline ? document.newline : "");
}

// ---- Pasting an env file into the form

export interface PasteResult {
  rows: EnvRowInput[];
  added: number;
  updated: number;
  /** 1-based lines of the paste that were left out. */
  leftOutLines: number[];
  commentsLeftOut: boolean;
  /** What to tell the person, in order. */
  messages: string[];
}

function listLines(lines: number[]): string {
  if (lines.length === 1) return `line ${lines[0]}`;
  return `lines ${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}`;
}

/**
 * Whether pasted text should fill the form rather than one box: two or more lines with at least
 * one `NAME=value`, or a single `NAME=value` line whose name is written like an environment
 * variable (capitals, digits and `_`). A single line like a base64 value with `=` padding stays a
 * value.
 */
export function looksLikeEnvFile(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const valid = lines.filter((line, index) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("#") && readLine(line, index + 1).ok;
  });
  if (lines.length > 1) return valid.length > 0;
  const only = lines[0];
  if (!only || valid.length !== 1) return false;
  const name = only.slice(0, only.indexOf("=")).trim();
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

/** Merges a pasted env file into the rows: new names are added, existing ones updated. */
export function mergePaste(rows: readonly EnvRowInput[], pasted: string): PasteResult {
  const next = rows.map((row) => ({ ...row }));
  const leftOutLines: number[] = [];
  let commentsLeftOut = false;
  const addedNames = new Set<string>();
  const updatedNames = new Set<string>();
  const existing = new Set(rows.map((row) => row.name.trim()));

  pasted.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    if (trimmed.startsWith("#")) {
      commentsLeftOut = true;
      return;
    }
    const result = readLine(raw, index + 1);
    if (!result.ok) {
      leftOutLines.push(index + 1);
      return;
    }
    const row = next.find((candidate) => candidate.name.trim() === result.name);
    if (row) {
      row.value = result.value;
      if (existing.has(result.name)) updatedNames.add(result.name);
    } else {
      next.push({ name: result.name, value: result.value });
      addedNames.add(result.name);
    }
  });

  const added = addedNames.size;
  const updated = updatedNames.size;
  const messages = [
    `Added ${added} ${added === 1 ? "variable" : "variables"} and updated ${updated} from the paste.`,
  ];
  if (leftOutLines.length > 0) {
    messages.push(`Left out ${listLines(leftOutLines)}: not one-line NAME=value.`);
  }
  if (commentsLeftOut) messages.push("Comments in the paste were left out.");
  return { rows: next, added, updated, leftOutLines, commentsLeftOut, messages };
}

// ---- Warnings

/** Prefixes whose variables are built into code that reaches browsers. */
export const PUBLIC_PREFIXES = [
  "NEXT_PUBLIC_",
  "NUXT_PUBLIC_",
  "REACT_APP_",
  "VITE_",
  "PUBLIC_",
] as const;

const SECRET_WORDS =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|SECRET_?KEY|SERVICE_ROLE)/i;

export interface PublicSecretWarning {
  name: string;
  prefix: string;
  message: string;
}

/**
 * Secret-looking names with a public prefix: those values end up in code sent to browsers. A
 * warning in the variables editor; app creation refuses them.
 */
export function publicSecretWarnings(names: readonly string[]): PublicSecretWarning[] {
  const warnings: PublicSecretWarning[] = [];
  for (const name of names) {
    const prefix = PUBLIC_PREFIXES.find((candidate) => name.toUpperCase().startsWith(candidate));
    if (!prefix) continue;
    if (!SECRET_WORDS.test(name.slice(prefix.length))) continue;
    warnings.push({
      name,
      prefix,
      message: `${name} looks like a secret, but names starting with ${prefix} reach browsers. Rename it if its value must stay private.`,
    });
  }
  return warnings;
}

// ---- Resolution at deploy

export interface VariableValue {
  name: string;
  value: string;
}

export interface ResolveInput {
  /** The environment's shared variables, in their order. */
  shared: readonly VariableValue[];
  /** The service's own variables, in their order. */
  own: readonly VariableValue[];
  /** Runtime gets everything; a build gets only names of letters, digits and `_`. */
  target: "runtime" | "build";
  /** Compose services never inherit Docker and Compose control variables from shared ones. */
  compose?: boolean;
}

export interface ResolveError {
  /** The variable whose value couldn't be worked out. */
  name: string;
  /** The reference that failed, like "environment.MISSING", when one did. */
  reference?: string;
  message: string;
}

export type ResolveResult =
  | { ok: true; variables: VariableValue[] }
  | { ok: false; errors: ResolveError[] };

const REFERENCE = /\$\{\{\s*(environment\.|project\.)?([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

/**
 * The most one value may grow to once its references are filled in, and the most a service's
 * variables may add up to (B1-08): references can repeat each other, so a few hundred bytes of
 * text could otherwise grow without end and run the control plane out of memory. Linux refuses
 * single environment strings over 128 KB and environments over about 2 MB anyway.
 */
export const RESOLVED_VALUE_MAX_BYTES = 256 * 1024;
export const RESOLVED_TOTAL_MAX_BYTES = 1024 * 1024;

/**
 * What a service receives at deploy: the environment's shared variables, then its own (its own
 * win on a clash), with `${{environment.NAME}}` (a shared variable) and `${{NAME}}` (the
 * service's own) replaced by their values. A reference to something that isn't set fails with
 * its name. Pure: it never reads or logs anything.
 *
 * From 0.1.x (30b R2-16): `${{project.NAME}}` means the shared `NAME` (project-level values
 * became each environment's shared variables), unless the service has a variable literally
 * called `project.NAME`; and inside a shared value, a reference that can't be worked out stays
 * exactly as written instead of failing every deploy of the environment, as 0.1.x passed shared
 * values on untouched.
 */
export function resolveVariables(input: ResolveInput): ResolveResult {
  const shared = new Map(input.shared.map((item) => [item.name, item.value]));
  const own = new Map(input.own.map((item) => [item.name, item.value]));

  const delivered: { name: string; scope: "shared" | "own" }[] = [];
  const position = new Map<string, number>();
  for (const { name } of input.shared) {
    if (input.compose && isComposeControlName(name)) continue;
    if (position.has(name)) continue;
    position.set(name, delivered.length);
    delivered.push({ name, scope: "shared" });
  }
  for (const { name } of input.own) {
    const at = position.get(name);
    if (at !== undefined) {
      delivered[at] = { name, scope: "own" };
      continue;
    }
    position.set(name, delivered.length);
    delivered.push({ name, scope: "own" });
  }

  const errors: ResolveError[] = [];
  // scope:name → its value, or null when it can't be worked out (its error is already recorded).
  const done = new Map<string, string | null>();
  let total = 0;
  let totalReported = false;

  const resolve = (
    scope: "shared" | "own",
    name: string,
    chain: readonly string[],
  ): string | null => {
    const key = `${scope}:${name}`;
    const cached = done.get(key);
    if (cached !== undefined) return cached;
    const holder = scope === "shared" ? `The shared variable ${name}` : name;
    if (chain.includes(key)) {
      // A shared value that loops stays as written where it is used (see above).
      if (scope === "own") {
        errors.push({
          name,
          message: `${holder} can't be worked out: its references loop back to it. Remove one of them.`,
        });
      }
      return null;
    }
    const raw = (scope === "shared" ? shared : own).get(name) ?? "";
    let failed = false;
    let tooLarge = false;
    let size = raw.length;
    const value: string = raw.replace(
      REFERENCE,
      (match: string, prefix: string | undefined, target: string): string => {
        if (failed || tooLarge) return "";
        let targetScope: "shared" | "own" = prefix ? "shared" : "own";
        let targetName = target;
        let reference = prefix === "environment." ? `environment.${target}` : target;
        if (prefix === "project.") {
          // A variable literally called project.NAME wins; else the shared NAME.
          if (own.has(`project.${target}`)) {
            targetScope = "own";
            targetName = `project.${target}`;
          }
          reference = `project.${target}`;
        }
        if (!(targetScope === "shared" ? shared : own).has(targetName)) {
          if (scope === "shared") return match;
          failed = true;
          errors.push({
            name,
            reference,
            message:
              targetScope === "shared"
                ? `${holder} uses \${{${reference}}}, but ${targetName} isn't one of this environment's shared variables. Add it, or change the reference.`
                : `${holder} uses \${{${reference}}}, but this service has no variable called ${targetName}. Add it, or change the reference.`,
          });
          return "";
        }
        const resolved: string | null = resolve(targetScope, targetName, [...chain, key]);
        if (resolved === null) {
          if (scope === "shared") return match;
          failed = true;
          return "";
        }
        size += resolved.length;
        if (size > RESOLVED_VALUE_MAX_BYTES) {
          tooLarge = true;
          return "";
        }
        return resolved;
      },
    );
    if (tooLarge) {
      errors.push({
        name,
        message: `${holder} grows past ${RESOLVED_VALUE_MAX_BYTES / 1024} KB once its references are filled in. Use fewer references, or keep large values in files instead.`,
      });
      done.set(key, null);
      return null;
    }
    if (!failed && total + value.length > RESOLVED_TOTAL_MAX_BYTES) {
      if (!totalReported) {
        totalReported = true;
        errors.push({
          name,
          message: `The variables add up to more than ${RESOLVED_TOTAL_MAX_BYTES / 1024 / 1024} MB once their references are filled in, at ${name}. Use fewer references, or keep large values in files instead.`,
        });
      }
      done.set(key, null);
      return null;
    }
    const result: string | null = failed ? null : value;
    if (result !== null) total += result.length;
    done.set(key, result);
    return result;
  };

  const variables: VariableValue[] = [];
  for (const { name, scope } of delivered) {
    if (input.target === "build" && !isBuildSafeName(name)) continue;
    const value = resolve(scope, name, []);
    if (value !== null) variables.push({ name, value });
  }
  if (errors.length > 0) {
    const unique = new Map(
      errors.map((error) => [`${error.name}|${error.reference ?? ""}|${error.message}`, error]),
    );
    return { ok: false, errors: [...unique.values()] };
  }
  return { ok: true, variables };
}
