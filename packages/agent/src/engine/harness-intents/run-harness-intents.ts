import {
	deleteDevProjectForAgent,
	getAccessibleProject,
	listAccessibleProjects,
	toAgentActorContext,
} from "@nearzero/server/services/agent-workspace";
import { isProductionEnvironment } from "@nearzero/server/services/environment";
import type { AgentWireEnvelope } from "../../wire";
import type { AgentUserInputResponse } from "../agent-user-input";
import { checkHarnessPolicy } from "../harness-policy";
import { formatHarnessToolFailure } from "../harness-tool-result";
import type { ToolContext } from "../tools/registry";
import {
	runProjectCreateHarness,
	runProjectCreateUserInputHarness,
} from "./project-create";
import {
	formatHarnessFailureReply,
	hasDeleteVerb,
	resolveProjectForDelete,
} from "./project-delete";
import {
	runServiceImportHarness,
	runServiceImportUserInputHarness,
} from "./service-import";

type Emit = (event: AgentWireEnvelope["event"]) => Promise<void>;

function splitCompoundIntentClauses(text: string) {
	return text
		.split(
			/\s+(?:and\s+then|then|and)\s+(?=(?:can you|could you|please|would you|can u|could u)?\s*(?:remove|delete|drop|destroy|get rid of|eliminate|clear|create|make|add|start|set up|setup)\b)/i,
		)
		.map((clause) => clause.trim())
		.filter(Boolean);
}

function projectHasProductionEnvironment(project: Record<string, unknown>) {
	const environments = project.environments;
	if (!Array.isArray(environments)) return false;
	return environments.some((env) => {
		if (!env || typeof env !== "object") return false;
		const record = env as { name?: string; isDefault?: boolean };
		return isProductionEnvironment({
			name: String(record.name ?? ""),
			isDefault: Boolean(record.isDefault),
		});
	});
}

export async function runProjectDeleteHarness(input: {
	userText: string;
	toolContext: ToolContext;
	emit: Emit;
}): Promise<string | null> {
	if (!hasDeleteVerb(input.userText)) return null;

	const actor = toAgentActorContext(input.toolContext);

	const orgPolicy = await checkHarnessPolicy(actor, "agent.project.delete", {
		resourceType: "project",
	});
	if (!orgPolicy.allowed) return orgPolicy.reply;

	const projects = (await listAccessibleProjects(actor)).map((project) => ({
		projectId: String(project.projectId ?? ""),
		name: String(project.name ?? ""),
	}));

	const resolved = resolveProjectForDelete(input.userText, projects);

	if (resolved.kind === "skip") return null;
	if (resolved.kind === "ambiguous") {
		return `Multiple projects match: ${resolved.names.join(", ")}. Which one should I delete?`;
	}
	if (resolved.kind === "explicitMiss") {
		return `I couldn't find a project matching "${resolved.hint}".`;
	}

	const { project } = resolved;

	let isProduction = false;
	try {
		const fullProject = await getAccessibleProject(actor, project.projectId);
		isProduction = projectHasProductionEnvironment(
			fullProject as Record<string, unknown>,
		);
	} catch {
		// Permission or not found — let deleteDevProjectForAgent surface the error.
	}

	const resourcePolicy = await checkHarnessPolicy(actor, "agent.project.delete", {
		resourceType: "project",
		resourceId: project.projectId,
		resourceName: project.name,
		projectId: project.projectId,
		isProduction,
	});
	if (!resourcePolicy.allowed) return resourcePolicy.reply;

	const toolCallId = `harness-delete-${project.projectId}`;

	await input.emit({
		kind: "tool_start",
		toolCallId,
		toolName: "deleteProject",
		detail: "Deleting project",
	});

	let response: string;
	try {
		const result = await deleteDevProjectForAgent(actor, {
			projectId: project.projectId,
		});
		response = `Deleted **${result.projectName}**.`;
		await input.emit({
			kind: "tool_result",
			toolCallId,
			toolName: "deleteProject",
			resultPreview: JSON.stringify(result),
			isError: false,
		});
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		response = formatHarnessFailureReply(project.name, failure);
		await input.emit({
			kind: "tool_result",
			toolCallId,
			toolName: "deleteProject",
			resultPreview: JSON.stringify(failure),
			isError: true,
		});
	}

	await input.emit({
		kind: "tool_end",
		toolCallId,
		toolName: "deleteProject",
	});

	return response;
}

export async function runHarnessIntents(input: {
	userText: string;
	toolContext: ToolContext;
	emit: Emit;
}): Promise<string | null> {
	const clauses = splitCompoundIntentClauses(input.userText);
	if (clauses.length > 1) {
		const replies: string[] = [];
		for (const [index, clause] of clauses.entries()) {
			const reply =
				(await runProjectDeleteHarness({
					...input,
					userText: clause,
				})) ??
				(await runProjectCreateHarness({
					...input,
					userText: clause,
					allowBareName: index > 0,
				})) ??
				(await runServiceImportHarness({
					...input,
					userText: clause,
				}));
			if (reply) replies.push(reply);
		}
		if (replies.length > 0) return replies.join("\n\n");
	}

	return (
		(await runProjectCreateHarness(input)) ??
		(await runProjectDeleteHarness(input)) ??
		(await runServiceImportHarness(input))
	);
}

export async function runHarnessUserInputResponse(input: {
	response: AgentUserInputResponse;
	toolContext: ToolContext;
	emit: Emit;
}): Promise<string | null> {
	return (
		(await runProjectCreateUserInputHarness(input)) ??
		(await runServiceImportUserInputHarness(input))
	);
}
