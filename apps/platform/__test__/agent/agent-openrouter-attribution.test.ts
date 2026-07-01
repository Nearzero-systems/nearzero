import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getAgentConfig,
	openRouterHeaders,
} from "../../../../packages/agent/src/config";

const agentSrcRoot = path.resolve(__dirname, "../../../../packages/agent/src");

function listTypeScriptFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
		return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
	});
}

describe("OpenRouter attribution headers", () => {
	const originalEnv = {
		OPENROUTER_HTTP_REFERER: process.env.OPENROUTER_HTTP_REFERER,
		OPENROUTER_APP_URL: process.env.OPENROUTER_APP_URL,
		OPENROUTER_X_TITLE: process.env.OPENROUTER_X_TITLE,
		CONSOLE_URL: process.env.CONSOLE_URL,
	};

	afterEach(() => {
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("derives OpenRouter attribution from env-backed config", () => {
		process.env.OPENROUTER_HTTP_REFERER = "";
		process.env.OPENROUTER_APP_URL = "https://app.nearzero.test";
		process.env.CONSOLE_URL = "https://console.nearzero.test";
		process.env.OPENROUTER_X_TITLE = "Nearzero Cloud";

		const config = getAgentConfig();
		expect(config.openRouterReferer).toBe("https://app.nearzero.test");
		expect(config.openRouterTitle).toBe("Nearzero Cloud");
		expect(openRouterHeaders("sk-or-test", config)).toMatchObject({
			Authorization: "Bearer sk-or-test",
			"Content-Type": "application/json",
			"HTTP-Referer": "https://app.nearzero.test",
			"X-Title": "Nearzero Cloud",
		});
	});

	it("requires every OpenRouter completion caller to use the shared header helper", () => {
		const files = listTypeScriptFiles(agentSrcRoot);
		const openRouterCallers = files.filter((file) =>
			fs.readFileSync(file, "utf8").includes("/chat/completions"),
		);

		expect(openRouterCallers.map((file) => path.relative(agentSrcRoot, file))).toEqual(
			expect.arrayContaining([
				"engine/loop/openrouter-stream.ts",
				"engine/tools/nearzero/analyzeLogs.ts",
				"engine/tools/nearzero/suggestDeploy.ts",
				"followUps.ts",
			]),
		);

		for (const file of openRouterCallers) {
			const source = fs.readFileSync(file, "utf8");
			expect(source, path.relative(agentSrcRoot, file)).toContain(
				"openRouterHeaders(",
			);
		}
	});

	it("keeps attribution header literals inside config only", () => {
		const files = listTypeScriptFiles(agentSrcRoot).filter(
			(file) => path.relative(agentSrcRoot, file) !== "config.ts",
		);
		for (const file of files) {
			const source = fs.readFileSync(file, "utf8");
			expect(source, path.relative(agentSrcRoot, file)).not.toMatch(
				/HTTP-Referer|X-Title/,
			);
		}
	});
});
