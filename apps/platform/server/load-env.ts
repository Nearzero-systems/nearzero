import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const platformRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const envPath = path.join(platformRoot, ".env");

if (fs.existsSync(envPath)) {
	config({ path: envPath, override: false });
}
