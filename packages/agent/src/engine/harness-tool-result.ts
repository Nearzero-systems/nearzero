import { isAgentHarnessError } from "@nearzero/server/services/agent-harness-errors";

export type HarnessToolFailure = {
	ok: false;
	harnessCode?: string;
	message: string;
	guidance?: string;
};

export function formatHarnessToolFailure(error: unknown): HarnessToolFailure {
	if (isAgentHarnessError(error)) {
		return {
			ok: false,
			harnessCode: error.harnessCode,
			message: error.message,
			guidance: error.guidance,
		};
	}
	return {
		ok: false,
		message: error instanceof Error ? error.message : "Tool execution failed.",
	};
}
