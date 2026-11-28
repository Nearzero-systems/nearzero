/**
 * Whether a push deploys an app (spec 6.6), as one function the Git provider milestone reuses:
 * "On push" deploys pushes to the app's branch, "On tag" deploys new tags, and with watch paths
 * a push deploys only when an added, modified or removed file matches one of them.
 *
 * Watch paths are globs: `*` matches within one folder, `**` across folders, `?` one character,
 * `[…]` one of a class, `{a,b}` either alternative; a path starting with `!` excludes what it
 * matches (G2-03); a path without glob characters matches itself and everything under it
 * (`docs` and `docs/`).
 *
 * A push to the branch whose head commit message carries a skip keyword ([skip ci], [ci skip],
 * [no ci], [skip actions] or [actions skip]) doesn't deploy, whichever host sent it. New tags
 * always deploy with the On tag trigger: a tag is a release someone made on purpose.
 */

export interface PushRules {
  trigger: "push" | "tag";
  branch: string;
  watchPaths: readonly string[];
}

export interface PushEvent {
  /** refs/heads/<branch> or refs/tags/<tag>. */
  ref: string;
  /** The commit the push ends at, when the provider says. */
  commit?: string | null;
  /** Files the push touched; null when the provider didn't list them. */
  files?: {
    added: readonly string[];
    modified: readonly string[];
    removed: readonly string[];
  } | null;
  /** A tag or branch being deleted never deploys. */
  deleted?: boolean;
  /** The head commit's whole message, when the provider says. */
  message?: string | null;
}

const SKIP_KEYWORD = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i;

/** The skip keyword in a commit message, as written, or null. */
export function skipKeyword(message: string | null | undefined): string | null {
  return message ? (SKIP_KEYWORD.exec(message)?.[0] ?? null) : null;
}

export type PushDecision =
  | { deploy: true; branch: string | null; tag: string | null; commit: string | null }
  | { deploy: false; reason: string };

const REGEX_SPECIAL = /[.*?+^${}()|[\]\\/]/g;

/** The index of the `]` closing a class that opens at `start`, or -1. */
function classEnd(glob: string, start: number): number {
  let index = start + 1;
  if (glob[index] === "!" || glob[index] === "^") index++;
  if (glob[index] === "]") index++;
  for (; index < glob.length; index++) {
    if (glob[index] === "\\") index++;
    else if (glob[index] === "]") return index;
  }
  return -1;
}

/** The index of the `}` closing a brace that opens at `start`, or -1. */
function braceEnd(glob: string, start: number): number {
  let depth = 0;
  for (let index = start; index < glob.length; index++) {
    const char = glob[index];
    if (char === "\\") index++;
    else if (char === "[") {
      const end = classEnd(glob, index);
      if (end !== -1) index = end;
    } else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

/** A brace's alternatives, split at its own commas (not those of nested braces or classes). */
function alternatives(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (char === "\\") index++;
    else if (char === "[") {
      const end = classEnd(inner, index);
      if (end !== -1) index = end;
    } else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "," && depth === 0) {
      out.push(inner.slice(from, index));
      from = index + 1;
    }
  }
  out.push(inner.slice(from));
  return out;
}

/**
 * A glob as a regular expression's source (31b G2-03), as 0.1.x read watch paths: `*` within one
 * folder, `**` across folders, `?` one character, `[abc]`, `[a-z]` and `[!a]` (or `[^a]`) one
 * character of a class, `{a,b}` either alternative (nested too), and `\` taking the next
 * character as it is. No wildcard or class matches a `/`.
 */
function globSource(glob: string): string {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string;
    if (char === "\\" && index + 1 < glob.length) {
      index++;
      pattern += (glob[index] as string).replace(REGEX_SPECIAL, "\\$&");
    } else if (char === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          pattern += "(?:.*/)?";
        } else pattern += ".*";
      } else pattern += "[^/]*";
    } else if (char === "?") pattern += "[^/]";
    else if (char === "[" && classEnd(glob, index) !== -1) {
      const end = classEnd(glob, index);
      let body = glob.slice(index + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      const members = body.replace(/\\(.)/g, "$1").replace(/[\\\]^[]/g, "\\$&");
      pattern += negated ? `[^/${members}]` : `(?!/)[${members}]`;
      index = end;
    } else if (char === "{" && braceEnd(glob, index) !== -1) {
      const end = braceEnd(glob, index);
      const parts = alternatives(glob.slice(index + 1, end));
      pattern +=
        parts.length > 1
          ? `(?:${parts.map(globSource).join("|")})`
          : `\\{${globSource(parts[0] ?? "")}\\}`;
      index = end;
    } else pattern += char.replace(REGEX_SPECIAL, "\\$&");
  }
  return pattern;
}

const compiled = new Map<string, RegExp | null>();

/** A watch path's matcher; null for a plain path, which matches itself and what is under it. */
function matcherOf(pattern: string): RegExp | null {
  const known = compiled.get(pattern);
  if (known !== undefined) return known;
  const made = /[*?[{\\]/.test(pattern) ? new RegExp(`^${globSource(pattern)}$`) : null;
  if (compiled.size > 1000) compiled.clear();
  compiled.set(pattern, made);
  return made;
}

/** Whether a file path matches one watch path, read without its `!` (see watchPathsMatch). */
export function matchesWatchPath(file: string, watchPath: string): boolean {
  const path = file.replace(/^\/+/, "");
  const pattern = watchPath.trim().replace(/^\/+/, "");
  if (pattern === "") return false;
  const matcher = matcherOf(pattern);
  if (!matcher) {
    const folder = pattern.replace(/\/+$/, "");
    return path === folder || path.startsWith(`${folder}/`);
  }
  return matcher.test(path);
}

/**
 * Whether a file counts for these watch paths (31b G2-03): it matches one of the paths without
 * `!` (or there are none, so `!docs/**` alone means anything outside docs) and none of the
 * paths with `!`.
 */
export function watchPathsMatch(file: string, watchPaths: readonly string[]): boolean {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const raw of watchPaths) {
    const path = raw.trim();
    if (path.startsWith("!")) excluded.push(path.slice(1));
    else if (path !== "") included.push(path);
  }
  if (included.length > 0 && !included.some((path) => matchesWatchPath(file, path))) return false;
  return !excluded.some((path) => matchesWatchPath(file, path));
}

export function shouldDeployPush(rules: PushRules, event: PushEvent): PushDecision {
  if (event.deleted) return { deploy: false, reason: "The branch or tag was deleted." };
  const commit = event.commit && /^[0-9a-f]{7,64}$/.test(event.commit) ? event.commit : null;
  if (event.ref.startsWith("refs/tags/")) {
    if (rules.trigger !== "tag") {
      return {
        deploy: false,
        reason: "This app deploys pushes, not tags (its trigger is On push).",
      };
    }
    return { deploy: true, branch: null, tag: event.ref.slice("refs/tags/".length), commit };
  }
  if (rules.trigger === "tag") {
    return { deploy: false, reason: "This app deploys new tags (its trigger is On tag)." };
  }
  const branch = event.ref.startsWith("refs/heads/")
    ? event.ref.slice("refs/heads/".length)
    : event.ref;
  if (branch !== rules.branch) {
    return {
      deploy: false,
      reason: `The push was to ${branch}; this app deploys ${rules.branch}.`,
    };
  }
  const skip = skipKeyword(event.message);
  if (skip) {
    return {
      deploy: false,
      reason: `The head commit's message contains ${skip}, so this push doesn't deploy.`,
    };
  }
  if (rules.watchPaths.length > 0 && event.files) {
    const touched = [...event.files.added, ...event.files.modified, ...event.files.removed];
    const hit = touched.some((file) => watchPathsMatch(file, rules.watchPaths));
    if (!hit) {
      return { deploy: false, reason: "No file the push changed matches the app's watch paths." };
    }
  }
  return { deploy: true, branch, tag: null, commit };
}

/**
 * Reads a push from a webhook body shaped like the common Git hosts' push events (ref, after or
 * checkout_sha, commits with added/modified/removed, head_commit.message). Null when the body
 * isn't one: the generic webhook then deploys the branch's newest commit.
 */
export function readPushBody(body: unknown): (PushEvent & { subject: string | null }) | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  if (typeof value.ref !== "string") return null;
  const lists = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  let listed = false;
  if (Array.isArray(value.commits)) {
    for (const commit of value.commits) {
      if (typeof commit !== "object" || commit === null) continue;
      for (const key of ["added", "modified", "removed"] as const) {
        const files = (commit as Record<string, unknown>)[key];
        if (Array.isArray(files)) {
          listed = true;
          for (const file of files) if (typeof file === "string") lists[key].push(file);
        }
      }
    }
  }
  const after =
    typeof value.after === "string"
      ? value.after
      : typeof value.checkout_sha === "string"
        ? value.checkout_sha
        : null;
  const head = value.head_commit as Record<string, unknown> | undefined;
  const message = typeof head?.message === "string" ? head.message : null;
  const subject = message !== null ? (message.split("\n")[0] ?? null) : null;
  return {
    ref: value.ref,
    commit: after && !/^0+$/.test(after) ? after : null,
    files: listed ? lists : null,
    deleted: value.deleted === true || (after !== null && /^0+$/.test(after)),
    subject,
    message,
  };
}
