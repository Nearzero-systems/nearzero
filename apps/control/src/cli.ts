import { resolve } from "node:path";
import { type CliIo, runCommand, USAGE } from "./cli/commands.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { MigrationError, migrate } from "./db/migrate.ts";
import { silentLogger } from "./log.ts";
import { configureServerSetup } from "./server-setup/settings.ts";
import { createServices } from "./services.ts";

/**
 * Entry point for the account commands that `sudo nearzero <command>` runs inside the
 * control-plane container: create-owner, reset-password, reset-2fa (spec 03 3.4), and
 * owner-status, which the installer asks with --json; and import and migrate, which move a 0.1.x
 * install to 1.0 (spec 29).
 *
 *   bun dist/cli.js create-owner
 *   printf '%s\n%s\n' "$EMAIL" "$PASSWORD" | bun dist/cli.js create-owner
 */

const MIGRATIONS_DIR = resolve(import.meta.dir, "..", "migrations");

/** Reads one line from a terminal in raw mode, echoing typed characters or not. */
function readFromTerminal(prompt: string, echo: boolean): Promise<string | null> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((done) => {
    let value = "";
    const finish = (result: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      done(result);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003") return finish(null);
        if (char === "\u0004") return finish(value === "" ? null : value);
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (echo) process.stdout.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        value += char;
        if (echo) process.stdout.write(char);
      }
    };
    stdin.on("data", onData);
  });
}

function terminalIo(): CliIo {
  const interactive = process.stdin.isTTY === true;
  let piped: string[] | null = null;
  const nextPipedLine = async (): Promise<string | null> => {
    piped ??= (await Bun.stdin.text()).split(/\r?\n/);
    const line = piped.shift();
    return line === undefined ? null : line;
  };
  return {
    interactive,
    readLine: (prompt) => (interactive ? readFromTerminal(prompt, true) : nextPipedLine()),
    readSecret: (prompt) => (interactive ? readFromTerminal(prompt, false) : nextPipedLine()),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

async function main(): Promise<number> {
  const io = terminalIo();
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    for (const line of USAGE) io.out(line);
    return args.length === 0 ? 1 : 0;
  }
  // With --json, scripts get one JSON line even when the command can't run at all.
  const answer = (result: string) => {
    if (args.includes("--json")) io.out(JSON.stringify({ result }));
  };
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    io.err("Nearzero's settings have problems:");
    for (const problem of loaded.problems) io.err(`  - ${problem}`);
    answer("settings_invalid");
    return 1;
  }
  const config = loaded.config;
  const db = createDatabase(config.databaseUrl, {
    maxConnections: 2,
    applicationName: "nearzero-command",
  });
  try {
    try {
      await migrate(db, { directory: MIGRATIONS_DIR });
    } catch (error) {
      if (error instanceof MigrationError) {
        io.err(error.message);
        answer("database_unavailable");
      } else {
        io.err("Nearzero is not running. Start it with: sudo nearzero restart");
        answer("database_unavailable");
      }
      return 1;
    }
    const services = createServices({
      db,
      log: silentLogger,
      authSecret: config.authSecret,
      consoleUrl: config.consoleUrl,
      instanceEmail: config.instanceEmail,
      // The import compares the bundle's install settings with these (spec 29.5).
      hostPublicIPv4: config.publicIp && !config.publicIp.includes(":") ? config.publicIp : null,
      domains: config.domains,
    });
    // `migrate rollback-servers` signs in to servers the way setup does (spec 9.3).
    configureServerSetup(services, {
      strictHostKeyChecking: config.ssh.strictHostKeyChecking,
      ...(config.ssh.runnerBinariesDirectory
        ? { runnerBinariesDirectory: config.ssh.runnerBinariesDirectory }
        : {}),
    });
    return await runCommand(
      args,
      services,
      io,
      undefined,
      config.runner.link?.tlsDirectory ?? null,
    );
  } finally {
    await db.destroy().catch(() => {});
  }
}

process.exit(await main());
