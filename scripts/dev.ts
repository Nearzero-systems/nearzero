#!/usr/bin/env bun
/**
 * Start the local dev app stack.
 * Local Docker infra is explicit: run with --with-infra or use bun run dev:infra.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
	buildServerPackages,
	ensureDevInfra,
	ensureEnvFiles,
	ensureMonitoringImage,
	log,
	printDevUrls,
	root,
	waitForHealth,
} from "./lib/dev-utils";

const withInfra =
	process.argv.includes("--with-infra") || process.argv.includes("--full");
const frontendOnly =
	process.argv.includes("--frontend-only") ||
	process.argv.includes("--frontend");

ensureEnvFiles({ localInfra: withInfra });

if (withInfra) {
	await ensureDevInfra();
	ensureMonitoringImage();
} else if (!frontendOnly) {
	log(
		"Skipping local Docker infra. Run `bun run dev:infra` for Postgres/Redis or `bun run dev:full` for running the entire stack.",
	);
}

if (!frontendOnly) {
	buildServerPackages();
}

let platformProc: ChildProcess | null = null;
let consoleProc: ChildProcess | null = null;
let consoleCheckProc: ChildProcess | null = null;
let shuttingDown = false;
const runConsoleCheckWatch =
	process.env.NEARZERO_DEV_CHECK === "1" || process.argv.includes("--check");
const childProcesses = () =>
	[consoleCheckProc, consoleProc, platformProc].filter(
		(proc): proc is ChildProcess => Boolean(proc),
	);

function pipeOutput(stream: Readable | null, target: NodeJS.WriteStream) {
	if (!stream) return;

	let carry = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		carry += chunk;
		const lines = carry.split(/\r?\n/);
		carry = lines.pop() ?? "";

		for (const line of lines) {
			if (shuttingDown && /^\s*└─ Exited with code (130|143)\s*$/.test(line)) {
				continue;
			}
			target.write(`${line}\n`);
		}
	});
	stream.on("end", () => {
		if (carry) target.write(carry);
	});
}

function run(name: string, args: string[]): ChildProcess {
	const child = spawn("bun", args, {
		cwd: root,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});

	pipeOutput(child.stdout, process.stdout);
	pipeOutput(child.stderr, process.stderr);

	child.on("exit", (code, signal) => {
		if (shuttingDown) return;
		if (signal) {
			console.error(`${name} exited unexpectedly (${signal})`);
			shutdown(1);
		} else if (code === 0) {
			console.error(`${name} exited unexpectedly`);
			shutdown(1);
		} else if (code && code !== 0) {
			console.error(`${name} exited with code ${code}`);
			shutdown(code ?? 1);
		}
	});
	return child;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") {
			child.kill(signal);
			return;
		}
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			console.warn(`Failed to stop child process ${child.pid}`, error);
		}
	}
}

function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	log("");
	log("Stopping Nearzero dev stack…");

	for (const child of childProcesses()) {
		killProcessTree(child, "SIGTERM");
	}

	setTimeout(() => {
		for (const child of childProcesses()) {
			if (child.exitCode === null && child.signalCode === null) {
				killProcessTree(child, "SIGKILL");
			}
		}
		process.exit(code);
	}, 1_500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (!frontendOnly) {
	log("Starting @nearzero/platform on :3000…");
	platformProc = run("platform", [
		"run",
		"--filter",
		"@nearzero/platform",
		"dev",
	]);

	await waitForHealth("http://127.0.0.1:3000/api/health");
}

log("Starting @nearzero/console on :4321…");
consoleProc = run("console", ["run", "--filter", "@nearzero/console", "dev"]);
if (runConsoleCheckWatch) {
	log("Starting @nearzero/console astro check watch…");
	consoleCheckProc = run("console-check", [
		"run",
		"--filter",
		"@nearzero/console",
		"check:watch",
	]);
} else {
	log(
		"Skipping console astro check watch. Set NEARZERO_DEV_CHECK=1 or pass --check to enable it.",
	);
}
printDevUrls({
	console: true,
	platform: !frontendOnly,
	infra: withInfra,
});
