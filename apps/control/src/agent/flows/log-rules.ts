/**
 * Reading a failed deployment's log for the "keep going" loop (spec 19.7): a tool missing on
 * the build machine, variables the app says it needs, and the end of the log. Pure functions.
 */

/** The last `count` lines (a trailing newline doesn't count as a line). */
export function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count).join("\n");
}

const BUILD_TOOLS = "docker|buildx|buildctl|buildkitd|railpack|nixpacks|pack|git|tar";

/** The tool a build couldn't find, when the log says so. */
export function missingTool(log: string): string | null {
  const ours = /([\w.+-]+) is not installed on the build machine/.exec(log);
  if (ours) return ours[1] ?? null;
  const shell = new RegExp(
    `(?:^|[\\s:])(${BUILD_TOOLS})(?:\\.\\w+)?:\\s*(?:command )?not found`,
    "m",
  ).exec(log);
  if (shell) return shell[1] ?? null;
  const exec = new RegExp(`exec: "(${BUILD_TOOLS})": executable file not found`).exec(log);
  return exec ? (exec[1] ?? null) : null;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
/** Never asked for: Nearzero or the system sets them. */
const NOT_ASKED = new Set(["PORT", "NODE_ENV", "PATH", "HOME", "HOSTNAME", "PWD", "SHELL", "USER"]);

/** Patterns whose first group names a variable the app says is missing. */
const NAMED_MISSING: RegExp[] = [
  /\b([A-Z][A-Z0-9_]{2,})\b["'`]?\s+(?:is|was)\s+(?:not\s+set|not\s+defined|undefined|missing|required|empty|not\s+provided)/g,
  /(?:missing|required|undefined|unset)\s+(?:required\s+)?(?:environment\s+|env\s+)?variables?\s*[:=]?\s*["'`]?([A-Z][A-Z0-9_]{2,})/gi,
  /environment\s+variable\s+(?:not\s+found|is\s+missing|missing|not\s+set)\s*[:=]?\s*["'`]?([A-Z][A-Z0-9_]{2,})/gi,
  /(?:set|define|provide|add)\s+(?:the\s+)?["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:environment\s+|env\s+)?variable/gi,
  /KeyError:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /required\s+key\s+([A-Z][A-Z0-9_]{2,})\s+missing\s+value/g,
  /process\.env\.([A-Z][A-Z0-9_]{2,})\s+is\s+(?:undefined|not\s+set|missing)/g,
  /"path":\s*\[\s*"([A-Z][A-Z0-9_]{2,})"\s*\][^\n]{0,80}"message":\s*"Required"/g,
];

/** Framework errors that name no variable but mean one. */
const KNOWN_MISSING: [RegExp, string][] = [
  [/Missing `secret_key_base`/i, "SECRET_KEY_BASE"],
  [/No application encryption key has been specified/i, "APP_KEY"],
  [/\[next-auth\]\[error\]\[NO_SECRET\]|MissingSecret/i, "NEXTAUTH_SECRET"],
  [/The SECRET_KEY setting must not be empty/i, "SECRET_KEY"],
];

/** Databases by their usual local port, with the words their variables usually contain. */
const DATABASE_PORTS: Record<string, { words: string[]; fallback: string }> = {
  "5432": { words: ["DATABASE", "POSTGRES", "PG", "DB_"], fallback: "DATABASE_URL" },
  "3306": { words: ["DATABASE", "MYSQL", "MARIADB", "DB_"], fallback: "DATABASE_URL" },
  "27017": { words: ["MONGO"], fallback: "MONGODB_URI" },
  "6379": { words: ["REDIS", "CACHE"], fallback: "REDIS_URL" },
};

const REFUSED_LINE =
  /ECONNREFUSED|connection refused|can't reach database server|could not connect/i;
const LOCAL_PORT = /(?:localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)\D{0,4}(\d{2,5})/i;

/**
 * Variable names the log says are missing (spec 19.7): named by common framework errors, or a
 * connection refused to a database's usual port on localhost, matched against the names the
 * repository's example files list (else the usual name for that database).
 */
export function missingVariables(log: string, exampleNames: readonly string[]): string[] {
  const found: string[] = [];
  const add = (name: string | undefined) => {
    if (!name || !ENV_NAME.test(name) || NOT_ASKED.has(name)) return;
    if (/^E[A-Z]+$/.test(name) || name.startsWith("ERR_")) return;
    if (!found.includes(name)) found.push(name);
  };
  for (const pattern of NAMED_MISSING) {
    for (const match of log.matchAll(pattern)) add(match[1]);
  }
  const zod = /Invalid environment variables:?([\s\S]{0,600})/.exec(log);
  if (zod?.[1]) {
    for (const match of zod[1].matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*:\s*\[/g)) add(match[1]);
  }
  for (const [pattern, name] of KNOWN_MISSING) if (pattern.test(log)) add(name);
  for (const line of log.split("\n")) {
    if (!REFUSED_LINE.test(line)) continue;
    const port = LOCAL_PORT.exec(line)?.[1];
    const database = port ? DATABASE_PORTS[port] : undefined;
    if (!database) continue;
    const matching = exampleNames.filter((name) =>
      database.words.some((word) => name.toUpperCase().includes(word)),
    );
    if (matching.length > 0) for (const name of matching) add(name);
    else add(database.fallback);
  }
  return found.slice(0, 20);
}

/** A build that never produced an image, by its log ("Building with …" and no "Built …"). */
export function failedWhileBuilding(log: string, image: string | null): boolean {
  return image === null && /^Building with /m.test(log) && !/^Built \S+/m.test(log);
}
