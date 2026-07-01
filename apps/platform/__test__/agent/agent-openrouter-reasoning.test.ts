import { describe, expect, it } from "vitest";
import {
	assistantToolTurnMessage,
	assistantToolTurnPayload,
	buildOpenRouterChatBody,
	openRouterReasoningConfig,
} from "../../../../packages/agent/src/engine/loop/openrouter-stream";

describe("openRouterReasoningConfig", () => {
	it("disables reasoning effort for Kimi tool-calling compatibility", () => {
		expect(openRouterReasoningConfig()).toEqual({ effort: "none" });
	});
});

describe("buildOpenRouterChatBody", () => {
	it("always sends reasoning.exclude for agent chat requests", () => {
		const body = buildOpenRouterChatBody({
			model: "moonshotai/kimi-k2.6",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
		expect(body.reasoning).toEqual({ effort: "none" });
	});

	it("includes tools by default for multi-hop agent turns", () => {
		const body = buildOpenRouterChatBody({
			model: "moonshotai/kimi-k2.6",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			tools: [{ type: "function", function: { name: "listProjects", parameters: {} } }],
			toolChoice: "auto",
		});
		expect(body.tools).toHaveLength(1);
		expect(body.tool_choice).toBe("auto");
	});
});

describe("assistantToolTurnPayload", () => {
	it("preserves reasoning_details required by Kimi tool continuations", () => {
		const payload = assistantToolTurnPayload({
			content: "",
			toolCalls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "listProjects", arguments: "{}" },
				},
			],
			reasoning: "Need project count",
			reasoningDetails: [{ type: "reasoning.text", text: "Need project count" }],
		});
		expect(payload.reasoning_details).toHaveLength(1);
		expect(payload.reasoning).toBe("Need project count");
		expect(assistantToolTurnMessage({
			content: "",
			toolCalls: payload.tool_calls,
			reasoning: payload.reasoning,
			reasoningDetails: payload.reasoning_details as unknown[],
		})).toMatchObject({
			role: "assistant",
			reasoning_details: payload.reasoning_details,
		});
	});
});
