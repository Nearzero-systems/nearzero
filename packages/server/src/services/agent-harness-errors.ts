export type AgentHarnessCode =
	| "policy_action_disabled"
	| "policy_dev_delete_disabled"
	| "policy_deploy_server_required"
	| "policy_invalid_context"
	| "policy_project_create_disabled"
	| "policy_project_has_production"
	| "policy_production_blocked"
	| "policy_secret_exposure_blocked"
	| "policy_server_create_disabled"
	| "policy_service_import_disabled"
	| "policy_service_setup_disabled"
	| "policy_unauthorized";

export class AgentHarnessError extends Error {
	readonly harnessCode: AgentHarnessCode;
	readonly guidance: string;

	constructor(
		harnessCode: AgentHarnessCode,
		message: string,
		guidance: string,
	) {
		super(message);
		this.name = "AgentHarnessError";
		this.harnessCode = harnessCode;
		this.guidance = guidance;
	}
}

export function isAgentHarnessError(error: unknown): error is AgentHarnessError {
	return error instanceof AgentHarnessError;
}
