import { describe, expect, it, vi } from "vitest";
import {
	resolveProjectForDelete,
	findProjectsMentionedInText,
	hasDeleteVerb,
} from "../../../../packages/agent/src/engine/harness-intents/project-resolution";
import { checkHarnessPolicy } from "../../../../packages/agent/src/engine/harness-policy";
import { AgentHarnessError } from "@nearzero/server/services/agent-harness-errors";

const catalog = [
	{ projectId: "p1", name: "Torchflow-test-1779915699839" },
	{ projectId: "p2", name: "Hypeframe" },
];

describe("project delete resolution", () => {
	it("resolves project name mentioned in compound delete requests", () => {
		const result = resolveProjectForDelete(
			"remove all the services of hypeframe and the project as well",
			catalog,
		);
		expect(result.kind).toBe("match");
		if (result.kind === "match") {
			expect(result.project.projectId).toBe("p2");
			expect(result.project.name).toBe("Hypeframe");
		}
	});

	it("skips service-only delete requests for the LLM tool path", () => {
		expect(
			resolveProjectForDelete("delete the postgres service", catalog),
		).toEqual({ kind: "skip" });
	});

	it("skips when no project name appears in text or catalog", () => {
		expect(
			resolveProjectForDelete(
				"remove all the services of hypeframe and the project as well",
				[],
			),
		).toEqual({ kind: "skip" });
	});

	it("matches short hints against catalog partial names", () => {
		const result = resolveProjectForDelete("can you remove torchflow", catalog);
		expect(result.kind).toBe("match");
		if (result.kind === "match") {
			expect(result.project.projectId).toBe("p1");
		}
	});

	it("matches explicit delete phrasing", () => {
		expect(resolveProjectForDelete("delete hypeframe project", catalog)).toEqual({
			kind: "match",
			project: { projectId: "p2", name: "Hypeframe" },
		});
		expect(
			resolveProjectForDelete("please remove the project torchflow for me", catalog).kind,
		).toBe("match");
	});

	it("returns explicitMiss only for short unknown hints", () => {
		const result = resolveProjectForDelete("remove completelymadeup", catalog);
		expect(result.kind).toBe("explicitMiss");
		if (result.kind === "explicitMiss") {
			expect(result.hint).toBe("completelymadeup");
		}
	});

	it("returns ambiguous when multiple catalog names appear in text", () => {
		const result = resolveProjectForDelete(
			"delete hypeframe project",
			[
				{ projectId: "a", name: "Hype" },
				{ projectId: "b", name: "Hypeframe" },
			],
		);
		expect(result.kind).toBe("ambiguous");
	});

	it("orders mentioned projects by longest name first", () => {
		const mentioned = findProjectsMentionedInText(
			[
				{ projectId: "a", name: "Hype" },
				{ projectId: "b", name: "Hypeframe" },
			],
			"delete hypeframe project",
		);
		expect(mentioned.map((p) => p.name)).toEqual(["Hypeframe", "Hype"]);
	});

	it("detects delete verbs", () => {
		expect(hasDeleteVerb("get rid of Torchflow-test")).toBe(true);
		expect(hasDeleteVerb("how many projects do we have")).toBe(false);
	});
});

describe("harness policy gate", () => {
	it("returns policy guidance when agent.project.delete is disabled", async () => {
		const agentPolicy = await import("@nearzero/server/services/agent-policy");
		const spy = vi
			.spyOn(agentPolicy, "assertAgentPolicy")
			.mockRejectedValueOnce(
				new AgentHarnessError(
					"policy_dev_delete_disabled",
					"Agent project deletion is disabled for this organization.",
					"Enable Settings > Agent > Allow Agent dev project deletion, then ask again.",
				),
			);

		const result = await checkHarnessPolicy(
			{ userId: "u1", organizationId: "org1" },
			"agent.project.delete",
			{ resourceType: "project" },
		);

		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reply).toContain("Agent project deletion is disabled");
			expect(result.reply).toContain("Allow Agent dev project deletion");
		}

		spy.mockRestore();
	});
});
