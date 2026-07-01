#!/usr/bin/env bun
/**
 * One-time (or idempotent) local dev setup:
 * env files → Docker infra → migrations → monitoring image → server build
 */
import {
	buildServerPackages,
	ensureEnvFiles,
	ensureMonitoringImage,
	log,
	root,
	runPlatformSetup,
	runSync,
	waitForDocker,
	waitForPostgres,
} from "./lib/dev-utils";

const skipInstall = process.argv.includes("--no-install");

log("Nearzero setup");
log("==============");

if (!skipInstall) {
	runSync("Install dependencies", "bun", ["install"], root);
} else {
	log("Skipping bun install (--no-install)");
}

ensureEnvFiles({ localInfra: true });

await waitForDocker();
ensureMonitoringImage();
runPlatformSetup();
await waitForPostgres();
buildServerPackages();

log("");
log("Setup complete.");
log("  App stack:      bun run dev");
log("  Frontend only:  bun run dev:frontend");
log("  Local infra:    bun run dev:infra");
log("  Full local dev: bun run dev:full");
log("  Console:  http://localhost:4321");
log("  Platform: http://localhost:3000");
log("");
