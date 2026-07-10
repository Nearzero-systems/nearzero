#!/usr/bin/env bun
/**
 * Verify and publish the Community edition to the public Nearzero repository.
 */
import { $ } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

async function main() {
	console.log("nearzero: verifying Community edition boundaries...");
	await $`bun run verify:edition-split`.cwd(root);

	console.log("nearzero: typecheck...");
	await $`bun run typecheck`.cwd(root);

	console.log("nearzero: building platform + console...");
	await $`bun run platform:build`.cwd(root);
	await $`bun run console:build`.cwd(root);

	console.log("nearzero: running unit tests (excluding deploy integration)...");
	await $`bun run --filter @nearzero/platform test -- --exclude **/deploy/application.real.test.ts`.cwd(
		root,
	);

	console.log("nearzero: committing Community edition changes...");
	await $`git add -A`.cwd(root);
	const commit = await $`git commit -m ${"feat: open-core Community edition split"}`.cwd(root).nothrow();
	if (commit.exitCode !== 0) {
		console.log("nearzero: nothing new to commit");
	}

	console.log("nearzero: pushing to https://github.com/Nearzero-systems/nearzero.git");
	const push = await $`git push origin main`.cwd(root).nothrow();
	if (push.exitCode !== 0) {
		console.error("nearzero: git push failed");
		process.exit(push.exitCode ?? 1);
	}

	console.log("nearzero: Community publish complete.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
