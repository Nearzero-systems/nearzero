import { afterEach, describe, expect, it, vi } from "vitest";
import {
	OpenRouterRequestError,
	streamOpenRouterCompletion,
} from "../../../../packages/agent/src/engine/loop/openrouter-stream";

const provider = {
	apiKey: "sk-or-v1-test",
	baseUrl: "https://openrouter.invalid/api/v1",
	model: "test/model",
} as never;

async function failWith(status: number, body: string) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status })),
	);
	try {
		await streamOpenRouterCompletion({
			provider,
			messages: [{ role: "user", content: "hi" }],
			onDelta: async () => undefined,
		});
	} catch (error) {
		return error as OpenRouterRequestError;
	}
	throw new Error("expected the request to fail");
}

describe("OpenRouter request errors", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports a rejected key without OpenRouter's raw JSON", async () => {
		const error = await failWith(
			401,
			JSON.stringify({ error: { message: "User not found.", code: 401 } }),
		);
		expect(error).toBeInstanceOf(OpenRouterRequestError);
		expect(error.rejectedKey).toBe(true);
		expect(error.message).toBe("OpenRouter rejected the saved API key.");
	});

	it("explains missing credits and rate limits", async () => {
		const credits = await failWith(402, JSON.stringify({ error: { code: 402 } }));
		expect(credits.rejectedKey).toBe(false);
		expect(credits.message).toContain("out of credits");

		const limited = await failWith(429, "slow down");
		expect(limited.message).toContain("rate limiting");
	});

	it("keeps OpenRouter's own message for other failures", async () => {
		const flagged = await failWith(
			403,
			JSON.stringify({ error: { message: "Input was flagged", code: 403 } }),
		);
		expect(flagged.rejectedKey).toBe(false);
		expect(flagged.message).toBe(
			"OpenRouter could not answer (HTTP 403): Input was flagged",
		);
	});
});
