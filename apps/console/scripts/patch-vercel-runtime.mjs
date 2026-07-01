import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_DIR = new URL("../.vercel/output/functions", import.meta.url).pathname;
const TARGET_RUNTIME = "nodejs22.x";

function patchVcConfig(path) {
	const raw = readFileSync(path, "utf8");
	const config = JSON.parse(raw);
	if (config.runtime === TARGET_RUNTIME) return false;
	config.runtime = TARGET_RUNTIME;
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`);
	return true;
}

let patched = 0;

for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
	if (!entry.isDirectory() || !entry.name.endsWith(".func")) continue;
	const configPath = join(OUTPUT_DIR, entry.name, ".vc-config.json");
	if (patchVcConfig(configPath)) patched += 1;
}

if (patched > 0) {
	console.log(`Patched ${patched} Vercel function(s) to use ${TARGET_RUNTIME}.`);
}
