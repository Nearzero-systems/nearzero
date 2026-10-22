import { AgentHarnessError } from "@nearzero/server/services/agent-harness-errors";
import { describe, expect, it, vi } from "vitest";
import {
	findProjectsMentionedInText,
	hasDeleteVerb,
	resolveProjectForDelete,
} from "../../../../packages/agent/src/engine/harness-intents/project-resolution";
import { checkHarnessPolicy } from "../../../../packages/agent/src/engine/harness-policy";

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

	it("asks to confirm partial names instead of deleting", () => {
		expect(
			resolveProjectForDelete("can you remove torchflow", catalog),
		).toEqual({
			kind: "ambiguous",
			names: ["Torchflow-test-1779915699839"],
		});
		expect(
			resolveProjectForDelete(
				"please remove the project torchflow for me",
				catalog,
			),
		).toEqual({ kind: "ambiguous", names: ["Torchflow-test-1779915699839"] });
	});

	it("matches explicit delete phrasing", () => {
		expect(
			resolveProjectForDelete("delete hypeframe project", catalog),
		).toEqual({
			kind: "match",
			project: { projectId: "p2", name: "Hypeframe" },
		});
		expect(
			resolveProjectForDelete(
				"please remove the project torchflow-test-1779915699839 for me",
				catalog,
			).kind,
		).toBe("match");
	});

	it("does not delete a project when a service inside it is the target", () => {
		expect(
			resolveProjectForDelete("delete the redis service in hypeframe", catalog),
		).toEqual({ kind: "skip" });
		expect(
			resolveProjectForDelete(
				"remove the old deployments from hypeframe",
				catalog,
			),
		).toEqual({ kind: "skip" });
	});

	it("skips negated requests", () => {
		expect(resolveProjectForDelete("don't delete hypeframe", catalog)).toEqual({
			kind: "skip",
		});
		expect(
			resolveProjectForDelete("delete everything but keep hypeframe", catalog),
		).toEqual({ kind: "skip" });
	});

	it("matches whole project names only", () => {
		expect(
			resolveProjectForDelete("delete the rapid project", [
				{ projectId: "a", name: "api" },
				{ projectId: "b", name: "rapid" },
			]),
		).toEqual({ kind: "match", project: { projectId: "b", name: "rapid" } });
		expect(
			findProjectsMentionedInText(
				[{ projectId: "a", name: "api" }],
				"delete the rapid project",
			),
		).toEqual([]);
	});

	it("does not treat clearing logs or caches as a project delete", () => {
		expect(resolveProjectForDelete("clear the logs", catalog)).toEqual({
			kind: "skip",
		});
		expect(resolveProjectForDelete("remove the build cache", catalog)).toEqual({
			kind: "skip",
		});
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
			"delete hype and hypeframe projects",
			[
				{ projectId: "a", name: "Hype" },
				{ projectId: "b", name: "Hypeframe" },
			],
		);
		expect(result.kind).toBe("ambiguous");
	});

	it("prefers the longest full name over a shorter name inside it", () => {
		const projects = [
			{ projectId: "a", name: "Hype" },
			{ projectId: "b", name: "Hypeframe" },
		];
		expect(
			findProjectsMentionedInText(projects, "delete hypeframe project").map(
				(p) => p.name,
			),
		).toEqual(["Hypeframe"]);
		expect(
			findProjectsMentionedInText(projects, "hypeframe and hype").map(
				(p) => p.name,
			),
		).toEqual(["Hypeframe", "Hype"]);
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
