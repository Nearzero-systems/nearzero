import { describe, expect, it } from "vitest";
import { AgentHarnessError } from "@nearzero/server/services/agent-harness-errors";
import { formatHarnessToolFailure } from "../../../../packages/agent/src/engine/harness-tool-result";

describe("harness tool results", () => {
	it("formats policy failures for the model", () => {
		const result = formatHarnessToolFailure(
			new AgentHarnessError(
				"policy_dev_delete_disabled",
				"Agent project deletion is disabled.",
				"Enable Settings > Agent > Allow Agent dev project deletion.",
			),
		);
		expect(result).toEqual({
			ok: false,
			harnessCode: "policy_dev_delete_disabled",
			message: "Agent project deletion is disabled.",
			guidance: "Enable Settings > Agent > Allow Agent dev project deletion.",
		});
	});
});
