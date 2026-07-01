import type { AuditResourceType } from "@nearzero/server/db/schema";
import {
	findEnvironmentById,
	isProductionEnvironment,
} from "@nearzero/server/services/environment";
import { getOrganizationSettings } from "@nearzero/server/services/organization-settings";
import { auditAgentAction } from "./agent-audit";
import {
	type AgentHarnessCode,
	AgentHarnessError,
} from "./agent-harness-errors";

export type AgentPolicyAction =
	| "agent.openrouter.setup"
	| "agent.project.create"
	| "agent.project.update"
	| "agent.project.delete"
	| "agent.service.create"
	| "agent.service.importGit"
	| "agent.service.setupSsh"
	| "agent.domain.assign"
	| "agent.server.create"
	| "agent.deploy.run"
	| "agent.production.mutate";

export type AgentPolicyActor = {
	userId: string;
	organizationId: string;
	userEmail?: string;
	userRole?: string;
	threadId?: string | null;
};

export type AgentPolicyResourceContext = {
	organizationId?: string;
	resourceType?: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	environmentId?: string;
	projectId?: string;
	isProduction?: boolean;
	containsSecretValue?: boolean;
	auditMetadata?: Record<string, unknown>;
};

export type AgentPolicyResult = {
	allowed: boolean;
	action: AgentPolicyAction;
	code: AgentHarnessCode | "ok";
	message: string;
	guidance: string;
	auditMetadata: Record<string, unknown>;
};

type PolicySettingKey =
	| "allowAgentOpenRouterSetup"
	| "allowAgentProjectCreation"
	| "allowAgentProjectUpdates"
	| "allowAgentProductionActions"
	| "allowAgentDevProjectDeletion"
	| "allowAgentServiceCreation"
	| "allowAgentServiceImports"
	| "allowAgentSshServiceSetup"
	| "allowAgentDomainAssignment"
	| "allowAgentServerCreation"
	| "allowAgentDeployments";

const POLICY_SETTINGS: Record<AgentPolicyAction, PolicySettingKey> = {
	"agent.openrouter.setup": "allowAgentOpenRouterSetup",
	"agent.project.create": "allowAgentProjectCreation",
	"agent.project.update": "allowAgentProjectUpdates",
	"agent.project.delete": "allowAgentDevProjectDeletion",
	"agent.service.create": "allowAgentServiceCreation",
	"agent.service.importGit": "allowAgentServiceImports",
	"agent.service.setupSsh": "allowAgentSshServiceSetup",
	"agent.domain.assign": "allowAgentDomainAssignment",
	"agent.server.create": "allowAgentServerCreation",
	"agent.deploy.run": "allowAgentDeployments",
	"agent.production.mutate": "allowAgentProductionActions",
};

const POLICY_DEPENDENCIES: Partial<
	Record<AgentPolicyAction, AgentPolicyAction[]>
> = {
	"agent.service.importGit": ["agent.service.create"],
	"agent.service.setupSsh": ["agent.service.create"],
	"agent.domain.assign": ["agent.service.create"],
};

const POLICY_COPY: Record<
	AgentPolicyAction,
	{ code: AgentHarnessCode; message: string; guidance: string }
> = {
	"agent.openrouter.setup": {
		code: "policy_action_disabled",
		message: "Agent OpenRouter setup is disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent OpenRouter setup.",
	},
	"agent.project.create": {
		code: "policy_project_create_disabled",
		message: "Agent project creation is disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent project creation.",
	},
	"agent.project.update": {
		code: "policy_action_disabled",
		message: "Agent project updates are disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent project updates.",
	},
	"agent.project.delete": {
		code: "policy_dev_delete_disabled",
		message: "Agent project deletion is disabled for this organization.",
		guidance:
			"Enable Settings > Agent > Allow Agent dev project deletion, then ask again.",
	},
	"agent.service.create": {
		code: "policy_service_setup_disabled",
		message: "Agent service creation is disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent service creation.",
	},
	"agent.service.importGit": {
		code: "policy_service_import_disabled",
		message: "Agent service imports are disabled for this organization.",
		guidance:
			"Enable Settings > Agent > Allow Agent service imports, then ask again.",
	},
	"agent.service.setupSsh": {
		code: "policy_service_setup_disabled",
		message: "Agent SSH-based service setup is disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent SSH service setup.",
	},
	"agent.domain.assign": {
		code: "policy_action_disabled",
		message: "Agent domain assignment is disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent domain assignment.",
	},
	"agent.server.create": {
		code: "policy_server_create_disabled",
		message: "Agent server creation is disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent server creation.",
	},
	"agent.deploy.run": {
		code: "policy_action_disabled",
		message: "Agent deployments are disabled for this organization.",
		guidance: "Enable Settings > Agent > Allow Agent deployments.",
	},
	"agent.production.mutate": {
		code: "policy_production_blocked",
		message: "Agent is blocked from changing production environments.",
		guidance: "Enable Settings > Agent > Allow Agent production actions.",
	},
};

const SECRET_KEY_PATTERN =
	/(api[_-]?key|token|secret|password|private[_-]?key|ciphertext|credential|env)$/i;

export function sanitizeAgentPolicyMetadata(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeAgentPolicyMetadata);
	if (!value || typeof value !== "object") return value;
	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		sanitized[key] = SECRET_KEY_PATTERN.test(key)
			? "[redacted]"
			: sanitizeAgentPolicyMetadata(entry);
	}
	return sanitized;
}

async function resolveProductionContext(
	resourceContext: AgentPolicyResourceContext,
) {
	if (resourceContext.isProduction !== undefined) {
		return resourceContext.isProduction;
	}
	if (!resourceContext.environmentId) return false;
	const environment = await findEnvironmentById(resourceContext.environmentId);
	return isProductionEnvironment(environment);
}

function baseMetadata(
	action: AgentPolicyAction,
	resourceContext: AgentPolicyResourceContext,
) {
	return sanitizeAgentPolicyMetadata({
		action,
		...(resourceContext.environmentId
			? { environmentId: resourceContext.environmentId }
			: {}),
		...(resourceContext.projectId
			? { projectId: resourceContext.projectId }
			: {}),
		...(resourceContext.auditMetadata ?? {}),
	}) as Record<string, unknown>;
}

function denied(
	action: AgentPolicyAction,
	copy: { code: AgentHarnessCode; message: string; guidance: string },
	resourceContext: AgentPolicyResourceContext,
): AgentPolicyResult {
	return {
		allowed: false,
		action,
		code: copy.code,
		message: copy.message,
		guidance: copy.guidance,
		auditMetadata: baseMetadata(action, resourceContext),
	};
}

export async function evaluateAgentPolicy(
	actor: AgentPolicyActor,
	action: AgentPolicyAction,
	resourceContext: AgentPolicyResourceContext = {},
): Promise<AgentPolicyResult> {
	if (
		resourceContext.organizationId &&
		resourceContext.organizationId !== actor.organizationId
	) {
		return denied(
			action,
			{
				code: "policy_unauthorized",
				message: "This resource does not belong to the active organization.",
				guidance: "Switch organizations or choose a resource you can access.",
			},
			resourceContext,
		);
	}

	if (resourceContext.containsSecretValue) {
		return denied(
			action,
			{
				code: "policy_secret_exposure_blocked",
				message: "Agent is blocked from handling secret values.",
				guidance:
					"Use a dedicated secret input or settings form so the value bypasses the model, stream, and audit log.",
			},
			resourceContext,
		);
	}

	const settings = await getOrganizationSettings(actor.organizationId);
	for (const dependency of POLICY_DEPENDENCIES[action] ?? []) {
		const dependencySetting = POLICY_SETTINGS[dependency];
		if (!settings[dependencySetting]) {
			return denied(action, POLICY_COPY[dependency], resourceContext);
		}
	}

	const setting = POLICY_SETTINGS[action];
	if (!settings[setting]) {
		return denied(action, POLICY_COPY[action], resourceContext);
	}

	const isProduction = await resolveProductionContext(resourceContext);
	if (isProduction && action !== "agent.production.mutate") {
		const productionSetting = POLICY_SETTINGS["agent.production.mutate"];
		if (!settings[productionSetting]) {
			return denied(
				action,
				POLICY_COPY["agent.production.mutate"],
				resourceContext,
			);
		}
	}

	return {
		allowed: true,
		action,
		code: "ok",
		message: "Allowed by Agent policy.",
		guidance: "",
		auditMetadata: baseMetadata(action, {
			...resourceContext,
			auditMetadata: {
				...(resourceContext.auditMetadata ?? {}),
				isProduction,
			},
		}),
	};
}

export async function auditAgentPolicyDecision(
	actor: AgentPolicyActor,
	result: AgentPolicyResult,
	resourceContext: AgentPolicyResourceContext = {},
) {
	await auditAgentAction({
		organizationId: actor.organizationId,
		userId: actor.userId,
		userEmail: actor.userEmail ?? "agent@nearzero.local",
		userRole: actor.userRole ?? "member",
		threadId: actor.threadId,
		action: result.allowed ? "run" : "stop",
		resourceType: resourceContext.resourceType ?? "settings",
		resourceId: resourceContext.resourceId,
		resourceName: resourceContext.resourceName ?? result.action,
		metadata: {
			policyAction: result.action,
			policyCode: result.code,
			allowed: result.allowed,
			...result.auditMetadata,
		},
	});
}

export async function assertAgentPolicy(
	actor: AgentPolicyActor,
	action: AgentPolicyAction,
	resourceContext: AgentPolicyResourceContext = {},
): Promise<AgentPolicyResult> {
	const result = await evaluateAgentPolicy(actor, action, resourceContext);
	if (!result.allowed) {
		await auditAgentPolicyDecision(actor, result, resourceContext);
		throw new AgentHarnessError(
			result.code as AgentHarnessCode,
			result.message,
			result.guidance,
		);
	}
	return result;
}

export async function assertAgentEnvironmentWritable(
	actor: AgentPolicyActor,
	environmentId: string,
): Promise<{ environmentId: string; projectId: string }> {
	const environment = await findEnvironmentById(environmentId);
	if (isProductionEnvironment(environment)) {
		await assertAgentPolicy(actor, "agent.production.mutate", {
			environmentId,
			projectId: environment.projectId,
			isProduction: true,
			resourceType: "environment",
			resourceId: environmentId,
			resourceName: environment.name,
		});
	}
	return {
		environmentId,
		projectId: environment.projectId,
	};
}
