export type ActivationSourceMode = "git" | "image" | "direct_git";
export type ActivationServiceKind = "application" | "compose";
export type ActivationDeploymentStatus =
	| "not_started"
	| "running"
	| "done"
	| "error"
	| "cancelled";

export type ActivationHttpsVerification = {
	configured: boolean;
	verified: boolean;
	host: string | null;
	status: "not_configured" | "verified" | "failed";
	code:
		| "HTTPS_NOT_CONFIGURED"
		| "HTTPS_VERIFIED"
		| "DNS_UNRESOLVED"
		| "DNS_UNSAFE"
		| "TLS_OR_ROUTE_UNREACHABLE"
		| "VERIFICATION_TIMEOUT";
};

export type ActivationStatus = {
	complete: boolean;
	canManage: boolean;
	completed: number;
	total: number;
	steps: {
		runtime: {
			complete: boolean;
			local: { ready: boolean };
			readyRemoteCount: number;
		};
		source: {
			complete: boolean;
			gitProviderCount: number;
			mode: ActivationSourceMode | null;
		};
		project: {
			complete: boolean;
			projectCount: number;
			environmentCount: number;
			first: {
				projectId: string;
				environmentId: string;
				name: string;
			} | null;
		};
		service: {
			complete: boolean;
			count: number;
			first: {
				kind: ActivationServiceKind;
				id: string;
				name: string;
				status: string | null;
			} | null;
		};
		deployment: {
			complete: boolean;
			status: ActivationDeploymentStatus;
			deploymentId: string | null;
			serviceId: string | null;
			serviceKind: ActivationServiceKind | null;
		};
		domain: {
			complete: boolean;
			configured: boolean;
			count: number;
			httpsCount: number;
			host: string | null;
		};
	};
};

export type ActivationJourneyStep =
	| "runtime"
	| "project"
	| "source"
	| "deployment"
	| "https";

export const EMPTY_ACTIVATION_STATUS: ActivationStatus = {
	complete: false,
	canManage: false,
	completed: 0,
	total: 0,
	steps: {
		runtime: {
			complete: false,
			local: { ready: false },
			readyRemoteCount: 0,
		},
		source: {
			complete: false,
			gitProviderCount: 0,
			mode: null,
		},
		project: {
			complete: false,
			projectCount: 0,
			environmentCount: 0,
			first: null,
		},
		service: {
			complete: false,
			count: 0,
			first: null,
		},
		deployment: {
			complete: false,
			status: "not_started",
			deploymentId: null,
			serviceId: null,
			serviceKind: null,
		},
		domain: {
			complete: false,
			configured: false,
			count: 0,
			httpsCount: 0,
			host: null,
		},
	},
};

type UnknownRecord = Record<string, unknown>;

type ActivationApiClient = {
	organization?: {
		activationStatus?: {
			query?: () => Promise<unknown>;
		};
		verifyActivationHttps?: {
			query?: () => Promise<unknown>;
		};
	};
};

function record(value: unknown): UnknownRecord {
	return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function boolean(value: unknown): boolean {
	return value === true;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 0;
}

function text(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized || null;
}

function sourceMode(value: unknown): ActivationSourceMode | null {
	return value === "git" || value === "image" || value === "direct_git"
		? value
		: null;
}

function serviceKind(value: unknown): ActivationServiceKind | null {
	return value === "application" || value === "compose" ? value : null;
}

function deploymentStatus(value: unknown): ActivationDeploymentStatus {
	return value === "running" ||
		value === "done" ||
		value === "error" ||
		value === "cancelled"
		? value
		: "not_started";
}

function verificationStatus(
	value: unknown,
): ActivationHttpsVerification["status"] {
	return value === "verified" || value === "failed" ? value : "not_configured";
}

function verificationCode(value: unknown): ActivationHttpsVerification["code"] {
	switch (value) {
		case "HTTPS_VERIFIED":
		case "DNS_UNRESOLVED":
		case "DNS_UNSAFE":
		case "TLS_OR_ROUTE_UNREACHABLE":
		case "VERIFICATION_TIMEOUT":
			return value;
		default:
			return "HTTPS_NOT_CONFIGURED";
	}
}

/**
 * Keep the backend contract mapping in one place. This intentionally copies only
 * the redacted activation fields the UI needs and treats malformed data as
 * incomplete instead of guessing that setup succeeded.
 */
export function normalizeActivationStatus(value: unknown): ActivationStatus {
	const root = record(value);
	const steps = record(root.steps);
	const runtime = record(steps.runtime);
	const local = record(runtime.local);
	const source = record(steps.source);
	const project = record(steps.project);
	const projectFirst = record(project.first);
	const service = record(steps.service);
	const serviceFirst = record(service.first);
	const deployment = record(steps.deployment);
	const domain = record(steps.domain);

	const projectId = text(projectFirst.projectId);
	const environmentId = text(projectFirst.environmentId);
	const projectName = text(projectFirst.name);
	const firstProject =
		projectId && environmentId && projectName
			? { projectId, environmentId, name: projectName }
			: null;

	const firstServiceKind = serviceKind(serviceFirst.kind);
	const firstServiceId = text(serviceFirst.id);
	const firstServiceName = text(serviceFirst.name);
	const firstService =
		firstServiceKind && firstServiceId && firstServiceName
			? {
					kind: firstServiceKind,
					id: firstServiceId,
					name: firstServiceName,
					status: text(serviceFirst.status),
				}
			: null;

	return {
		complete: boolean(root.complete),
		canManage: boolean(root.canManage),
		completed: count(root.completed),
		total: count(root.total),
		steps: {
			runtime: {
				complete: boolean(runtime.complete),
				local: { ready: boolean(local.ready) },
				readyRemoteCount: count(runtime.readyRemoteCount),
			},
			source: {
				complete: boolean(source.complete),
				gitProviderCount: count(source.gitProviderCount),
				mode: sourceMode(source.mode),
			},
			project: {
				complete: boolean(project.complete),
				projectCount: count(project.projectCount),
				environmentCount: count(project.environmentCount),
				first: firstProject,
			},
			service: {
				complete: boolean(service.complete),
				count: count(service.count),
				first: firstService,
			},
			deployment: {
				complete: boolean(deployment.complete),
				status: deploymentStatus(deployment.status),
				deploymentId: text(deployment.deploymentId),
				serviceId: text(deployment.serviceId),
				serviceKind: serviceKind(deployment.serviceKind),
			},
			domain: {
				complete: boolean(domain.complete),
				configured: boolean(domain.configured),
				count: count(domain.count),
				httpsCount: count(domain.httpsCount),
				host: text(domain.host),
			},
		},
	};
}

/** Load the server-derived, resumable activation state. No browser progress is persisted. */
export async function loadActivationStatus(
	api: unknown,
): Promise<ActivationStatus> {
	const client = api as ActivationApiClient;
	const procedure = client.organization?.activationStatus;
	if (!procedure || typeof procedure.query !== "function") {
		throw new Error("Activation status is unavailable");
	}
	return normalizeActivationStatus(await procedure.query());
}

/** Normalize the separate, live DNS/TLS/route probe. Configured is not verified. */
export function normalizeActivationHttpsVerification(
	value: unknown,
): ActivationHttpsVerification {
	const raw = record(value);
	const configured = boolean(raw.configured);
	const status = verificationStatus(raw.status);
	const code = verificationCode(raw.code);
	const host = text(raw.host);
	return {
		configured,
		verified: Boolean(
			configured &&
				boolean(raw.verified) &&
				status === "verified" &&
				code === "HTTPS_VERIFIED" &&
				host,
		),
		host,
		status,
		code,
	};
}

export async function loadActivationHttpsVerification(
	api: unknown,
): Promise<ActivationHttpsVerification> {
	const client = api as ActivationApiClient;
	const procedure = client.organization?.verifyActivationHttps;
	if (!procedure || typeof procedure.query !== "function") {
		throw new Error("HTTPS verification is unavailable");
	}
	return normalizeActivationHttpsVerification(await procedure.query());
}

export function activationHttpsVerificationMessage(
	result: ActivationHttpsVerification | null,
): string {
	if (!result) return "A live public HTTPS check has not completed.";
	switch (result.code) {
		case "HTTPS_VERIFIED":
			return `${result.host ?? "The configured host"} answered through public DNS, TLS, and the Nearzero route.`;
		case "HTTPS_NOT_CONFIGURED":
			return "Attach an HTTPS domain to a successful deployment before rechecking.";
		case "DNS_UNRESOLVED":
			return "Public DNS does not resolve yet. Check the record and retry after propagation.";
		case "DNS_UNSAFE":
			return "The hostname does not resolve to a safely probeable public address. Review its DNS records.";
		case "VERIFICATION_TIMEOUT":
			return "The HTTPS check timed out. Confirm ports 80 and 443 are open, then retry.";
		case "TLS_OR_ROUTE_UNREACHABLE":
			return "The public TLS and route check failed. Review Traefik, the certificate, and the service port.";
	}
}

type ActivationStepOptions = {
	httpsVerified?: boolean;
};

export function activationStepComplete(
	status: ActivationStatus,
	step: ActivationJourneyStep,
	options: ActivationStepOptions = {},
): boolean {
	switch (step) {
		case "runtime":
			return status.steps.runtime.complete;
		case "project":
			return status.steps.project.complete;
		case "source":
			return status.steps.source.complete && status.steps.service.complete;
		case "deployment":
			return status.steps.deployment.complete;
		case "https":
			return status.steps.domain.configured && options.httpsVerified === true;
	}
}

export function currentActivationStep(
	status: ActivationStatus,
	options: ActivationStepOptions = {},
): ActivationJourneyStep | "complete" {
	const order: ActivationJourneyStep[] = [
		"runtime",
		"project",
		"source",
		"deployment",
		"https",
	];
	return (
		order.find((step) => !activationStepComplete(status, step, options)) ??
		"complete"
	);
}

export function firstProjectWorkspacePath(
	status: ActivationStatus,
): string | null {
	const project = status.steps.project.first;
	if (!project) return null;
	return `/dashboard/project/${encodeURIComponent(project.projectId)}/environment/${encodeURIComponent(project.environmentId)}/overview`;
}

export function firstApplicationSetupPath(
	status: ActivationStatus,
	mode: "git" | "image",
): string | null {
	const project = status.steps.project.first;
	if (!project) return null;
	const base = `/dashboard/project/${encodeURIComponent(project.projectId)}/environment/${encodeURIComponent(project.environmentId)}/services/application/new`;
	return mode === "image" ? `${base}?mode=empty&source=docker` : base;
}

export function sourceModeLabel(mode: ActivationSourceMode | null): string {
	if (mode === "image") return "Container image";
	if (mode === "direct_git") return "Public Git URL";
	if (mode === "git") return "Connected Git provider";
	return "Not selected";
}

/** Build a safe, canonical HTTPS origin for the live-app link. */
export function httpsUrlForHost(host: string | null): string | null {
	const candidate = host?.trim().replace(/\.$/, "") ?? "";
	if (!candidate || /[\s/@?#]/.test(candidate)) return null;
	try {
		const url = new URL(`https://${candidate}`);
		if (!url.hostname || url.username || url.password) return null;
		return url.origin;
	} catch {
		return null;
	}
}
