export type AgentUserInputField =
	| "projectName"
	| "gitProviderId"
	| "gitRepository"
	| "gitBranch"
	| "serverId";

export type AgentUserInputOption = {
	label: string;
	value: string;
	description?: string;
	action?: "submit" | "connectGitProvider";
	providerType?: "github" | "gitlab" | "bitbucket" | "gitea";
	href?: string;
};

export type AgentUserInputRequest = {
	field: AgentUserInputField;
	prompt: string;
	waitingLabel: string;
	placeholder?: string;
	submitLabel?: string;
	inputType?: "text" | "password";
	secret?: boolean;
	options?: AgentUserInputOption[];
	context?: Record<string, string>;
};

export type AgentUserInputResponse = {
	field: AgentUserInputField;
	value: string;
	secret?: boolean;
	context?: Record<string, string>;
};

export function projectNameInputRequest(
	overrides: Partial<AgentUserInputRequest> = {},
): AgentUserInputRequest {
	return {
		field: "projectName",
		prompt: "Name the new project",
		waitingLabel: "Waiting for project name",
		placeholder: "Project name",
		submitLabel: "Create",
		inputType: "text",
		secret: false,
		...overrides,
	};
}

export class AgentUserInputRequiredError extends Error {
	field: AgentUserInputField;
	request: AgentUserInputRequest;

	constructor(fieldOrRequest: AgentUserInputField | AgentUserInputRequest) {
		const request =
			typeof fieldOrRequest === "string"
				? fieldOrRequest === "projectName"
					? projectNameInputRequest()
					: {
							field: fieldOrRequest,
							prompt: "Provide a value",
							waitingLabel: "Waiting for input",
						}
				: fieldOrRequest;
		super(`Agent user input required: ${request.field}`);
		this.name = "AgentUserInputRequiredError";
		this.field = request.field;
		this.request = request;
	}
}
