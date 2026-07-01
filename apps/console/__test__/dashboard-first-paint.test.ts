import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dashboardPagesDir = join(root, "src/pages/dashboard");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			out.push(...walk(path));
			continue;
		}
		if (path.endsWith(".astro")) out.push(path);
	}
	return out;
}

const blockedPatterns = [
	/createServerTrpcClient/,
	/bootstrapSettingsDashboardPage/,
	/resolveDashboardContext/,
	/await\s+Promise\.all/,
	/await\s+[^;\n]+\.query\s*\(/,
];

describe("dashboard first-paint route boundary", () => {
	test("dashboard routes do not block first paint on page-specific backend data", () => {
		const files = walk(dashboardPagesDir);
		const violations = files.flatMap((file) => {
			const source = readFileSync(file, "utf8");
			return blockedPatterns
				.filter((pattern) => pattern.test(source))
				.map((pattern) => `${file.replace(`${root}/`, "")}: ${pattern}`);
		});

		expect(violations).toEqual([]);
	});
});
