import {
	createDevProjectForAgent,
	toAgentActorContext,
} from "@nearzero/server/services/agent-workspace";
import type { AgentWireEnvelope } from "../../wire";
import {
	AgentUserInputRequiredError,
	projectNameInputRequest,
	type AgentUserInputResponse,
} from "../agent-user-input";
import { formatHarnessToolFailure } from "../harness-tool-result";
import { needsProjectNameFromUser } from "../project-name-guard";
import type { ToolContext } from "../tools/registry";

type Emit = (event: AgentWireEnvelope["event"]) => Promise<void>;

const CREATE_PROJECT =
	/\b(create|make|add|start|set up|setup)\b[\s\S]*\bproject\b/i;

const CREATE_PROJECT_PREFIX =
	/^(?:now\s+)?(?:can you|could you|please|would you|can u|could u)?\s*(?:create|make|add|start|set up|setup)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?project\b/i;

const BARE_CREATE_PREFIX =
	/^(?:now\s+)?(?:can you|could you|please|would you|can u|could u)?\s*(?:create|make|add|start|set up|setup)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:project\s+)?/i;

function cleanProjectName(value: string | undefined) {
	const name = String(value ?? "")
		.trim()
		.replace(/\s*[.?!]+\s*$/g, "")
		.replace(/^(?:called|named|with\s+name|as)\s+/i, "")
		.replace(/\s+(?:for me|in nearzero|on nearzero)\s*$/i, "")
		.trim();
	return name || null;
}

export function detectProjectCreateName(
	text: string,
	options: { allowBareName?: boolean } = {},
):
	| { kind: "none" }
	| { kind: "missing" }
	| { kind: "named"; name: string } {
	const trimmed = text.trim();
	if (!trimmed) return { kind: "none" };
	if (!CREATE_PROJECT.test(trimmed) && !options.allowBareName) {
		return { kind: "none" };
	}
	if (options.allowBareName && !BARE_CREATE_PREFIX.test(trimmed)) {
		return { kind: "none" };
	}

	const explicit = trimmed.match(
		/\bproject\s+(?:called|named|with\s+name|as)\s+(.+?)\s*[.?!]*$/i,
	);
	const residual = cleanProjectName(
		explicit?.[1] ??
			trimmed.replace(
				options.allowBareName ? BARE_CREATE_PREFIX : CREATE_PROJECT_PREFIX,
				"",
			),
	);
	if (!residual || needsProjectNameFromUser(residual)) return { kind: "missing" };

	return { kind: "named", name: residual };
}

export async function runProjectCreateByNameHarness(input: {
	name: string;
	toolContext: ToolContext;
	emit: Emit;
}): Promise<string> {
	const projectName = input.name.trim();
	if (needsProjectNameFromUser(projectName)) {
		throw new AgentUserInputRequiredError(projectNameInputRequest());
	}

	const actor = toAgentActorContext(input.toolContext);
	const toolCallId = `harness-create-${Date.now()}`;

	await input.emit({
		kind: "tool_start",
		toolCallId,
		toolName: "createProject",
		detail: "Creating project",
	});

	let response: string;
	try {
		const result = await createDevProjectForAgent(actor, { name: projectName });
		response = `Created **${result.projectName}** with a **${result.environmentName}** environment.`;
		await input.emit({
			kind: "tool_result",
			toolCallId,
			toolName: "createProject",
			resultPreview: JSON.stringify(result),
			isError: false,
		});
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		response = `Could not create **${projectName}**: ${failure.message}`;
		if (failure.guidance) response += `\n\n${failure.guidance}`;
		await input.emit({
			kind: "tool_result",
			toolCallId,
			toolName: "createProject",
			resultPreview: JSON.stringify(failure),
			isError: true,
		});
	}

	await input.emit({
		kind: "tool_end",
		toolCallId,
		toolName: "createProject",
	});

	return response;
}

export async function runProjectCreateHarness(input: {
	userText: string;
	toolContext: ToolContext;
	emit: Emit;
	allowBareName?: boolean;
}): Promise<string | null> {
	const detected = detectProjectCreateName(input.userText, {
		allowBareName: input.allowBareName,
	});
	if (detected.kind === "none") return null;
	if (detected.kind === "missing") {
		throw new AgentUserInputRequiredError(projectNameInputRequest());
	}
	return runProjectCreateByNameHarness({
		name: detected.name,
		toolContext: input.toolContext,
		emit: input.emit,
	});
}

export async function runProjectCreateUserInputHarness(input: {
	response: AgentUserInputResponse;
	toolContext: ToolContext;
	emit: Emit;
}): Promise<string | null> {
	if (input.response.field !== "projectName") return null;
	return runProjectCreateByNameHarness({
		name: input.response.value,
		toolContext: input.toolContext,
		emit: input.emit,
	});
}
