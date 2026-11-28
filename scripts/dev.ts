import { resolve } from "node:path";
import { SQL, type Subprocess } from "bun";

/**
 * `bun run dev`: starts the control plane on 4100 and the console on 4400 against the
 * development PostgreSQL from docker-compose.dev.yml. Settings already in the environment win.
 */

const ROOT = resolve(import.meta.dir, "..");
const CONTROL_PORT = process.env.NEARZERO_CONTROL_PORT ?? "4100";
const CONSOLE_PORT = process.env.NEARZERO_CONSOLE_PORT ?? "4400";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";

async function checkDatabase(): Promise<void> {
  const db = new SQL(DATABASE_URL, { connectionTimeout: 3 });
  try {
    await db`select 1`;
  } catch {
    console.error(
      "The development database isn't reachable. Start it with:\n  docker compose -f docker-compose.dev.yml up -d",
    );
    process.exit(1);
  } finally {
    await db.close();
  }
}

async function prefixLines(
  stream: ReadableStream<Uint8Array>,
  label: string,
  out: NodeJS.WriteStream,
) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) out.write(`${label} ${line}\n`);
  }
  if (buffered) out.write(`${label} ${buffered}\n`);
}

function launch(name: string, command: string[], env: Record<string, string>): Subprocess {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const label = `[${name}]`.padEnd(10);
  void prefixLines(child.stdout, label, process.stdout);
  void prefixLines(child.stderr, label, process.stderr);
  return child;
}

await checkDatabase();

const children = [
  launch("control", ["bun", "run", "--cwd", "apps/control", "dev"], {
    NEARZERO_ENV: process.env.NEARZERO_ENV ?? "development",
    DATABASE_URL,
    NEARZERO_CONTROL_PORT: CONTROL_PORT,
    NEARZERO_MANAGEMENT_BIND_ADDRESS: process.env.NEARZERO_MANAGEMENT_BIND_ADDRESS ?? "127.0.0.1",
  }),
  // --ignore-lock keeps Astro in the foreground even when it detects a coding agent, so this
  // script always supervises it.
  launch(
    "console",
    [
      "bun",
      "run",
      "--cwd",
      "apps/console",
      "dev",
      "--port",
      CONSOLE_PORT,
      "--host",
      "127.0.0.1",
      "--ignore-lock",
    ],
    {
      NEARZERO_CONTROL_URL: process.env.NEARZERO_CONTROL_URL ?? `http://127.0.0.1:${CONTROL_PORT}`,
    },
  ),
];

console.log(
  `Control plane: http://127.0.0.1:${CONTROL_PORT}/api/v1/health\nConsole:       http://127.0.0.1:${CONSOLE_PORT}/`,
);

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  void Promise.all(children.map((child) => child.exited)).then(() => process.exit(code));
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
for (const child of children) {
  void child.exited.then((code) => stopAll(code ?? 1));
}
