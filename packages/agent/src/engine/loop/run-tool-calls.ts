import type { AgentServiceType } from "@nearzero/server/services/agent-workspace";
import { AgentUserInputRequiredError } from "../agent-user-input";
import { needsProjectNameFromUser } from "../project-name-guard";
import { deploymentTools, type ToolContext } from "../tools/registry";
import type { OpenAiToolCall } from "./hydrate-messages";
import { exposedToolNames } from "./tool-schemas";

const MAX_TOOL_OUTPUT_CHARS = 12_000;

function trimOutput(value: string) {
	if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value;
	return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[truncated]`;
}

export async function runToolCall(
	ctx: ToolContext,
	toolCall: OpenAiToolCall,
) {
	const name = toolCall.function.name;
	if (!exposedToolNames.has(name)) {
		throw new Error(`Unknown tool: ${name}`);
	}

	const args = JSON.parse(toolCall.function.arguments || "{}") as Record<
		string,
		unknown
	>;

	switch (name) {
		case "listProjects":
			return deploymentTools.listProjects(ctx);
		case "getProject":
			return deploymentTools.getProject(ctx, {
				projectId: String(args.projectId ?? ""),
			});
		case "getEnvironment":
			return deploymentTools.getEnvironment(ctx, {
				environmentId: String(args.environmentId ?? ""),
			});
		case "getService":
			return deploymentTools.getService(ctx, {
				serviceType: String(args.serviceType ?? "application") as AgentServiceType,
				serviceId: String(args.serviceId ?? ""),
			});
		case "listDeployments":
			return deploymentTools.listDeployments(ctx, {
				serviceType: String(args.serviceType ?? "application") as AgentServiceType,
				serviceId: String(args.serviceId ?? ""),
				limit:
					typeof args.limit === "number" ? args.limit : undefined,
			});
		case "createProject": {
			const projectName = String(args.name ?? "").trim();
			if (needsProjectNameFromUser(projectName)) {
				throw new AgentUserInputRequiredError("projectName");
			}
			return deploymentTools.createProject(ctx, {
				name: projectName,
				description: args.description ? String(args.description) : undefined,
			});
		}
		case "updateProject":
			return deploymentTools.updateProject(ctx, {
				projectId: String(args.projectId ?? ""),
				name: args.name ? String(args.name) : undefined,
				description: args.description ? String(args.description) : undefined,
			});
		case "deleteProject":
			return deploymentTools.deleteProject(ctx, {
				projectId: String(args.projectId ?? ""),
			});
		case "getDeploymentLogs":
			return deploymentTools.getDeploymentLogs(ctx, {
				deploymentId: String(args.deploymentId ?? ""),
				tail: typeof args.tail === "number" ? args.tail : undefined,
			});
		case "suggest":
			return deploymentTools.suggest({
				organizationId: ctx.organizationId,
				input: String(args.input ?? ""),
				serverId: args.serverId ? String(args.serverId) : undefined,
			});
		case "deploy":
			return deploymentTools.deploy(ctx, args as never);
		case "runDeployment":
			return deploymentTools.runDeployment(ctx, {
				serviceType: args.serviceType === "compose" ? "compose" : "application",
				serviceId: String(args.serviceId ?? ""),
				title: args.title ? String(args.title) : undefined,
				description: args.description ? String(args.description) : undefined,
			});
		case "webSearch":
			return deploymentTools.webSearch({ query: String(args.query ?? "") });
		case "analyzeLogs":
			return deploymentTools.analyzeLogs({
				organizationId: ctx.organizationId,
				logs: String(args.logs ?? ""),
				context: args.context === "build" ? "build" : "runtime",
			});
		default:
			if (name in deploymentTools) {
				const tool = deploymentTools[name as keyof typeof deploymentTools];
				if (typeof tool === "function") {
					return (tool as (ctx: ToolContext, input: Record<string, unknown>) => unknown)(
						ctx,
						args,
					);
				}
			}
			throw new Error(`Unhandled tool: ${name}`);
	}
}

export function previewToolResult(result: unknown) {
	try {
		return trimOutput(JSON.stringify(result));
	} catch {
		return trimOutput(String(result));
	}
}
