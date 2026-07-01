import { describe, expect, it } from "vitest";
import { detectProjectCreateName } from "../../../../packages/agent/src/engine/harness-intents/project-create";

describe("project create harness intent", () => {
	it("detects create project requests that need a name", () => {
		expect(detectProjectCreateName("now make a new project")).toEqual({
			kind: "missing",
		});
		expect(detectProjectCreateName("please create a project")).toEqual({
			kind: "missing",
		});
	});

	it("detects explicit project names", () => {
		expect(detectProjectCreateName("create a project called Torchflow")).toEqual({
			kind: "named",
			name: "Torchflow",
		});
		expect(detectProjectCreateName("set up a new project named Hypeframe")).toEqual({
			kind: "named",
			name: "Hypeframe",
		});
	});

	it("detects bare create names inside compound harness clauses", () => {
		expect(detectProjectCreateName("make paper", { allowBareName: true })).toEqual({
			kind: "named",
			name: "paper",
		});
		expect(detectProjectCreateName("make paper")).toEqual({ kind: "none" });
	});

	it("ignores non-create project questions", () => {
		expect(detectProjectCreateName("how many projects do we have")).toEqual({
			kind: "none",
		});
	});
});
