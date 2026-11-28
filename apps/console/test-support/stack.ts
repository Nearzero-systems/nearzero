import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SQL, type Subprocess } from "bun";

/**
 * A throwaway Nearzero for the console's browser checks (the sweep and the end-to-end flow): its
 * own database on the development PostgreSQL, a control plane and a console on fixed test ports,
 * and helpers that seed people through the API. Nothing here touches other databases,
 * containers or ports. Logs go to apps/console/test-artifacts/stack/.
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(CONSOLE_ROOT, "..", "..");
const LOGS = resolve(CONSOLE_ROOT, "test-artifacts", "stack");
/**
 * Where the control plane runs from: this repository, or (NEARZERO_TEST_CONTROL_ROOT) another
 * checkout of it, for testing the console while the control plane in this tree is mid-change.
 */
const CONTROL_ROOT = process.env.NEARZERO_TEST_CONTROL_ROOT
  ? resolve(process.env.NEARZERO_TEST_CONTROL_ROOT)
  : REPO_ROOT;
const ADMIN_URL =
  process.env.NEARZERO_TEST_DATABASE_URL ??
  "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";

export interface StackOptions {
  /** "dev" runs `astro dev` (the sweep); "built" runs the production build (the e2e flow). */
  console: "dev" | "built";
  controlPort?: number;
  consolePort?: number;
  /** A label for the database name: nz_m2c_<label>_<random>. */
  label: string;
  /** The database name's prefix instead of nz_m2c (each builder keeps its own). */
  databasePrefix?: string;
  /** The built console's server entry, relative to apps/console (default ./dist/server/entry.mjs). */
  consoleEntry?: string;
  /** More settings for the control plane and the console (a platform domain, a handoff folder…). */
  env?: Record<string, string>;
}

export interface Stack {
  controlUrl: string;
  consoleUrl: string;
  databaseName: string;
  env: Record<string, string>;
  createOwner(email: string, password: string): Promise<string>;
  stop(): Promise<void>;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function waitFor(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(300);
  }
  throw new Error(`${label} did not answer at ${url} within ${timeoutMs / 1000}s (${last}).`);
}

async function portIsFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return false;
  } catch {
    return true;
  }
}

/**
 * Several people can run the browser checks at once on one machine: NEARZERO_TEST_CONTROL_PORT,
 * NEARZERO_TEST_CONSOLE_PORT and NEARZERO_TEST_DATABASE_PREFIX, when set, take the place of the
 * ports and database prefix a check asks for, and NEARZERO_TEST_CONSOLE_ENTRY runs a built
 * console copied elsewhere (relative to apps/console), so another build of dist/ mid-run can't
 * swap its scripts.
 */
function envNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function startStack(options: StackOptions): Promise<Stack> {
  const controlPort = envNumber("NEARZERO_TEST_CONTROL_PORT") ?? options.controlPort ?? 4150;
  const consolePort = envNumber("NEARZERO_TEST_CONSOLE_PORT") ?? options.consolePort ?? 4450;
  for (const port of [controlPort, consolePort]) {
    if (!(await portIsFree(port))) {
      throw new Error(`Port ${port} is already in use. Stop whatever runs there and try again.`);
    }
  }
  await mkdir(LOGS, { recursive: true });
  const prefix =
    process.env.NEARZERO_TEST_DATABASE_PREFIX?.match(/^[a-z][a-z0-9_]{0,30}$/)?.[0] ??
    options.databasePrefix ??
    "nz_m2c";
  const databaseName = `${prefix}_${options.label}_${randomHex(4)}`;
  const admin = new SQL(ADMIN_URL);
  await admin.unsafe(`create database "${databaseName}"`);
  const databaseUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${databaseName}`;
    return url.toString();
  })();
  const consoleUrl = `http://127.0.0.1:${consolePort}`;
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NEARZERO_ENV: "development",
    DATABASE_URL: databaseUrl,
    NEARZERO_AUTH_SECRET: randomHex(32),
    NEARZERO_CONTROL_PORT: String(controlPort),
    NEARZERO_MANAGEMENT_BIND_ADDRESS: "127.0.0.1",
    NEARZERO_CONSOLE_URL: consoleUrl,
    NEARZERO_LOG_LEVEL: "warn",
    ...options.env,
  };
  const children: Subprocess[] = [];
  // With a prefix of one's own, the logs get their own names too.
  const logLabel =
    prefix === options.databasePrefix || !process.env.NEARZERO_TEST_DATABASE_PREFIX
      ? options.label
      : `${prefix}-${options.label}`;
  const log = (name: string) => Bun.file(join(LOGS, `${logLabel}-${name}.log`));
  for (const name of ["control", "control-err", "console", "console-err"]) {
    await Bun.write(log(name), "");
  }

  const stop = async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(8000)]);
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => {});
    await admin.close();
  };

  try {
    children.push(
      Bun.spawn(["bun", "apps/control/src/main.ts"], {
        cwd: CONTROL_ROOT,
        env,
        stdout: log("control"),
        stderr: log("control-err"),
      }),
    );
    await waitFor(`${controlUrl}/api/v1/health`, 120_000, "The control plane");
    const consoleCommand =
      options.console === "dev"
        ? [
            "bun",
            "--bun",
            "astro",
            "dev",
            "--port",
            String(consolePort),
            "--host",
            "127.0.0.1",
            "--ignore-lock",
          ]
        : [
            "bun",
            process.env.NEARZERO_TEST_CONSOLE_ENTRY ??
              options.consoleEntry ??
              "./dist/server/entry.mjs",
          ];
    children.push(
      Bun.spawn(consoleCommand, {
        cwd: CONSOLE_ROOT,
        env: {
          ...env,
          ASTRO_TELEMETRY_DISABLED: "1",
          NEARZERO_CONTROL_URL: controlUrl,
          HOST: "127.0.0.1",
          PORT: String(consolePort),
        },
        stdout: log("console"),
        stderr: log("console-err"),
      }),
    );
    await waitFor(`${consoleUrl}/sign-in`, 90_000, "The console");
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    controlUrl,
    consoleUrl,
    databaseName,
    env,
    async createOwner(email, password) {
      const child = Bun.spawn(["bun", "apps/control/src/cli.ts", "create-owner"], {
        cwd: CONTROL_ROOT,
        env,
        stdin: new Blob([`${email}\n${password}\n`]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`create-owner failed: ${err || out}`);
      return out.trim();
    },
    stop,
  };
}

// ---------- Seeding through the API, as a browser would through the console's proxy

export class ApiSession {
  cookie = "";

  constructor(private readonly base: string) {}

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const [name = "", value = ""] = pair.split("=");
      const jar = new Map(
        this.cookie
          .split("; ")
          .filter(Boolean)
          .map((part) => part.split("=") as [string, string]),
      );
      if (/max-age=0/i.test(line) || value === "") jar.delete(name);
      else jar.set(name, value);
      this.cookie = Array.from(jar, ([key, item]) => `${key}=${item}`).join("; ");
    }
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T) : ({} as T);
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
    }
    return parsed;
  }

  /** The session cookie's value, for a browser context. */
  sessionToken(): string {
    const match = this.cookie.match(/(?:^|; )nz_session=([^;]+)/);
    if (!match?.[1]) throw new Error("No session cookie was set.");
    return match[1];
  }

  static async signIn(base: string, email: string, password: string): Promise<ApiSession> {
    const session = new ApiSession(base);
    await session.call("POST", "/auth/sign-in", { email, password });
    return session;
  }
}
