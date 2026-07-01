import { describe, expect, it } from "vitest";
import { detectServiceImportIntent } from "../../../../packages/agent/src/engine/harness-intents/service-import";

describe("service import harness intent", () => {
	it("detects Git service import requests", () => {
		expect(detectServiceImportIntent("add a service from GitHub")).toBe(true);
		expect(detectServiceImportIntent("import a repository into torchflow")).toBe(true);
		expect(detectServiceImportIntent("set up an app from gitlab")).toBe(true);
		expect(detectServiceImportIntent("run a service inside torchflow project")).toBe(true);
		expect(detectServiceImportIntent("deploy an application in torchflow")).toBe(true);
	});

	it("ignores project creation and unrelated chat", () => {
		expect(detectServiceImportIntent("make a new project named paper")).toBe(false);
		expect(detectServiceImportIntent("which model are you")).toBe(false);
	});
});
