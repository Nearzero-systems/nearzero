import { db } from "@nearzero/server/db";
import { server, type AuditResourceType } from "@nearzero/server/db/schema";
import { createAuditLog } from "@nearzero/server/services/audit-log";
import { and, eq } from "drizzle-orm";
import {
	isCommunityMode,
	requiresRemoteRuntimeServer,
} from "./runtime-mode";

export {
	isCloudMode,
	isCommunityMode,
	requiresRemoteRuntimeServer,
} from "./runtime-mode";

export type RuntimePlacementAction =
	| "service.create"
	| "service.importGit"
	| "domain.assign"
	| "task.create"
	| "deploy.run"
	| "service.start"
	| "service.stop";

export type RuntimePlacementCode =
	| "ok"
	| "server_required"
	| "server_missing"
	| "server_inactive"
	| "server_not_ready";

export interface RuntimePolicyActor {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	actorType?: "user" | "agent";
}

export interface RuntimePlacementContext {
	serverId?: string | null;
	allowAnyReadyServer?: boolean;
	resourceType?: string;
	resourceId?: string;
	resourceName?: string;
	serviceType?: string;
	environmentId?: string;
	projectId?: string;
	auditMetadata?: Record<string, unknown>;
}

export interface RuntimePlacementResult {
	allowed: boolean;
	action: RuntimePlacementAction;
	code: RuntimePlacementCode;
	message: string;
	guidance: string;
	auditMetadata: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN =
	/(secret|token|password|passwd|private.*key|api.*key|credential|authorization|env)/i;

export class RuntimePlacementPolicyError extends Error {
	public readonly code: RuntimePlacementCode;
	public readonly guidance: string;
	public readonly auditMetadata: Record<string, unknown>;

	constructor(result: RuntimePlacementResult) {
		super(result.message);
		this.name = "RuntimePlacementPolicyError";
		this.code = result.code;
		this.guidance = result.guidance;
		this.auditMetadata = result.auditMetadata;
	}

	toUserMessage(): string {
		return [this.message, this.guidance ? `Next step: ${this.guidance}` : null]
			.filter(Boolean)
			.join("\n");
	}
}

function sanitizeRuntimeAuditMetadata(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeRuntimeAuditMetadata);
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		output[key] = SENSITIVE_KEY_PATTERN.test(key)
			? "[redacted]"
			: sanitizeRuntimeAuditMetadata(entry);
	}
	return output;
}

function result(
	action: RuntimePlacementAction,
	context: RuntimePlacementContext,
	allowed: boolean,
	code: RuntimePlacementCode,
	message: string,
	guidance: string,
): RuntimePlacementResult {
	return {
		allowed,
		action,
		code,
		message,
		guidance,
		auditMetadata: sanitizeRuntimeAuditMetadata({
			mode: isCommunityMode() ? "community" : "cloud",
			action,
			serverId: context.serverId ?? null,
			allowAnyReadyServer: context.allowAnyReadyServer ?? false,
			resourceType: context.resourceType,
			resourceId: context.resourceId,
			resourceName: context.resourceName,
			serviceType: context.serviceType,
			environmentId: context.environmentId,
			projectId: context.projectId,
			...(context.auditMetadata ?? {}),
		}) as Record<string, unknown>,
	};
}

export async function getReadyRuntimeServers(organizationId: string) {
	return db.query.server.findMany({
		where: and(
			eq(server.organizationId, organizationId),
			eq(server.serverStatus, "active"),
			eq(server.setupStatus, "ready"),
		),
		columns: {
			serverId: true,
			name: true,
			ipAddress: true,
			port: true,
			setupStatus: true,
		},
	});
}

export async function evaluateRuntimePlacementPolicy(
	actor: RuntimePolicyActor,
	action: RuntimePlacementAction,
	context: RuntimePlacementContext = {},
): Promise<RuntimePlacementResult> {
	if (context.serverId) {
		const row = await db.query.server.findFirst({
			where: eq(server.serverId, context.serverId),
			columns: {
				serverId: true,
				organizationId: true,
				name: true,
				serverStatus: true,
				setupStatus: true,
			},
		});

		if (!row || row.organizationId !== actor.organizationId) {
			return result(
				action,
				context,
				false,
				"server_missing",
				"The selected server could not be found for this organization.",
				"Choose a server from this organization and try again.",
			);
		}

		if (row.serverStatus !== "active") {
			return result(
				action,
				context,
				false,
				"server_inactive",
				`Server "${row.name}" is inactive.`,
				"Reactivate the server or choose another ready server.",
			);
		}

		if (row.setupStatus !== "ready") {
			return result(
				action,
				{ ...context, auditMetadata: { setupStatus: row.setupStatus } },
				false,
				"server_not_ready",
				`Server "${row.name}" is not ready yet.`,
				"Open the server setup logs and wait for setup to finish successfully.",
			);
		}

		return result(
			action,
			{ ...context, auditMetadata: { serverName: row.name } },
			true,
			"ok",
			requiresRemoteRuntimeServer()
				? "Allowed by runtime placement policy."
				: "Allowed on this organization's ready remote server.",
			"",
		);
	}

	if (!requiresRemoteRuntimeServer()) {
		return result(
			action,
			context,
			true,
			"ok",
			"Allowed on the local Community runtime.",
			"",
		);
	}

	if (context.allowAnyReadyServer) {
		const readyServers = await getReadyRuntimeServers(actor.organizationId);
		if (readyServers.length > 0) {
			return result(
				action,
				{
					...context,
					auditMetadata: {
						...(context.auditMetadata ?? {}),
						readyRuntimeServerCount: readyServers.length,
					},
				},
				true,
				"ok",
				"Allowed by runtime placement policy.",
				"",
			);
		}
	}

	return result(
		action,
		context,
		false,
		"server_required",
		"Nearzero Cloud requires a ready server before this action can run.",
		"Add a server, let setup finish, then try again.",
	);
}

export async function auditRuntimePolicy(
	actor: RuntimePolicyActor,
	result: RuntimePlacementResult,
	context: RuntimePlacementContext = {},
) {
	await createAuditLog({
		organizationId: actor.organizationId,
		userId: actor.userId,
		userEmail: actor.actorType === "agent" ? "Agent" : actor.userEmail,
		userRole: actor.actorType === "agent" ? "agent" : actor.userRole,
		action: result.allowed ? "run" : "stop",
		resourceType: (context.resourceType ?? "settings") as AuditResourceType,
		resourceId: context.resourceId,
		resourceName: context.resourceName ?? result.action,
		metadata: {
			actorType: actor.actorType ?? "user",
			policyKind: "runtime-placement",
			policyAction: result.action,
			policyCode: result.code,
			allowed: result.allowed,
			...result.auditMetadata,
		},
	});
}

export async function assertRuntimePlacementPolicy(
	actor: RuntimePolicyActor,
	action: RuntimePlacementAction,
	context: RuntimePlacementContext = {},
): Promise<RuntimePlacementResult> {
	const policyResult = await evaluateRuntimePlacementPolicy(actor, action, context);
	await auditRuntimePolicy(actor, policyResult, context);
	if (!policyResult.allowed) {
		throw new RuntimePlacementPolicyError(policyResult);
	}
	return policyResult;
}
