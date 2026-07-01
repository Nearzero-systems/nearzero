export type DeploymentServiceKind =
	| "application"
	| "compose"
	| "database"
	| "queue";

export type DeploymentSourceSummary = {
	provider: string;
	repository: string;
	branch: string;
	buildPath: string;
	trigger: string;
};

export type DeploymentViewRow = {
	id: string;
	detailId: string;
	sourceKind: "deployment" | "queue";
	serviceKind: DeploymentServiceKind;
	service: string;
	serviceType: string;
	project: string;
	environment: string;
	server: string;
	title: string;
	description: string;
	status: string;
	createdAt: string | Date | number | null;
	createdLabel: string;
	startedAt: string | Date | number | null;
	finishedAt: string | Date | number | null;
	durationLabel: string;
	href?: string;
	deploymentId?: string;
	applicationId?: string;
	composeId?: string;
	rollbackId?: string;
	rollbackLabel?: string;
	errorMessage?: string;
	source: DeploymentSourceSummary;
	queueRow?: any;
};

export const deploymentStatusBadgeClass: Record<string, string> = {
	running:
		"bg-yellow-600/15 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400",
	active:
		"bg-yellow-600/15 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400",
	done: "bg-emerald-600/15 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
	completed:
		"bg-emerald-600/15 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
	idle: "bg-secondary text-secondary-foreground",
	stopped: "bg-secondary text-secondary-foreground",
	not_running: "bg-secondary text-secondary-foreground",
	error: "bg-red-600/15 text-red-700 dark:bg-red-500/15 dark:text-red-400",
	failed: "bg-red-600/15 text-red-700 dark:bg-red-500/15 dark:text-red-400",
	cancelled: "bg-secondary text-secondary-foreground",
	pending: "bg-secondary text-secondary-foreground",
	waiting: "bg-secondary text-secondary-foreground",
	delayed: "bg-secondary text-secondary-foreground",
	paused: "bg-secondary text-secondary-foreground",
	removed: "bg-red-600/15 text-red-700 dark:bg-red-500/15 dark:text-red-400",
};

export const deploymentStatusDotClass: Record<string, string> = {
	running: "bg-yellow-500",
	active: "bg-yellow-500",
	done: "bg-emerald-500",
	completed: "bg-emerald-500",
	idle: "bg-[var(--nz-text-subtle)]",
	stopped: "bg-[var(--nz-text-subtle)]",
	not_running: "bg-[var(--nz-text-subtle)]",
	error: "bg-red-500",
	failed: "bg-red-500",
	cancelled: "bg-[var(--nz-text-subtle)]",
	pending: "bg-[var(--nz-text-subtle)]",
	waiting: "bg-[var(--nz-text-subtle)]",
	delayed: "bg-[var(--nz-text-subtle)]",
	paused: "bg-[var(--nz-text-subtle)]",
	removed: "bg-red-500",
};

export function formatDeploymentStatusLabel(
	status: string | null | undefined,
): string {
	const normalized = (status ?? "").trim().toLowerCase();
	switch (normalized) {
		case "running":
			return "Building";
		case "active":
			return "Active";
		case "done":
		case "completed":
			return "Running";
		case "idle":
		case "stopped":
		case "not_running":
			return "Not running";
		case "error":
		case "failed":
			return "Error";
		case "waiting":
		case "pending":
			return "Queued";
		case "delayed":
			return "Delayed";
		case "cancelled":
			return "Cancelled";
		case "paused":
			return "Paused";
		case "removed":
			return "Removed";
		default:
			return normalized ? normalized.replace(/_/g, " ") : "Unknown";
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeDeploymentStatus(status: string | null | undefined) {
	return (status ?? "").trim().toLowerCase();
}

function runtimeStatusForDeployment(row: any, kind: DeploymentServiceKind) {
	switch (kind) {
		case "application":
			return normalizeDeploymentStatus(row.application?.applicationStatus);
		case "compose":
			return normalizeDeploymentStatus(row.compose?.composeStatus);
		case "database":
			return normalizeDeploymentStatus(row.meta?.serviceStatus);
		default:
			return "";
	}
}

function resolveDeploymentDisplayStatus(
	deploymentStatus: string,
	runtimeStatus: string,
) {
	const normalized = normalizeDeploymentStatus(deploymentStatus) || "running";
	if (normalized !== "done" && normalized !== "completed") return normalized;
	switch (runtimeStatus) {
		case "idle":
		case "stopped":
		case "not_running":
			return "idle";
		case "error":
		case "failed":
			return "error";
		case "done":
			return "done";
		default:
			return normalized;
	}
}

function label(value: unknown, fallback = "-"): string {
	const next = text(value);
	return next || fallback;
}

function sourceLabel(sourceType: string): string {
	switch (sourceType) {
		case "github":
			return "GitHub";
		case "gitlab":
			return "GitLab";
		case "bitbucket":
			return "Bitbucket";
		case "gitea":
			return "Gitea";
		case "git":
			return "Git URL";
		case "docker":
			return "Docker image";
		case "drop":
			return "Uploaded source";
		case "raw":
			return "Inline compose";
		case "database":
			return "Database";
		case "queue":
			return "Deployment queue";
		default:
			return "Source";
	}
}

function joinRepo(owner: unknown, repo: unknown): string {
	const ownerText = text(owner);
	const repoText = text(repo);
	if (ownerText && repoText) return `${ownerText}/${repoText}`;
	return ownerText || repoText || "-";
}

function sourceSummary(
	service: any,
	kind: DeploymentServiceKind,
): DeploymentSourceSummary {
	if (kind === "database") {
		return {
			provider: "Database",
			repository: "Managed service",
			branch: "-",
			buildPath: "-",
			trigger: "-",
		};
	}
	if (kind === "queue") {
		return {
			provider: "Deployment queue",
			repository: "Waiting for worker",
			branch: "-",
			buildPath: "-",
			trigger: "-",
		};
	}

	const sourceType = text(service?.sourceType) || "unknown";
	const defaultBuildPath =
		kind === "compose" ? label(service?.composePath) : label(service?.buildPath);

	switch (sourceType) {
		case "github":
			return {
				provider: sourceLabel(sourceType),
				repository: joinRepo(service?.owner, service?.repository),
				branch: label(service?.branch),
				buildPath: defaultBuildPath,
				trigger: label(service?.triggerType),
			};
		case "gitlab":
			return {
				provider: sourceLabel(sourceType),
				repository: joinRepo(service?.gitlabOwner, service?.gitlabRepository),
				branch: label(service?.gitlabBranch),
				buildPath:
					kind === "compose" ? defaultBuildPath : label(service?.gitlabBuildPath),
				trigger: label(service?.triggerType),
			};
		case "bitbucket":
			return {
				provider: sourceLabel(sourceType),
				repository: joinRepo(
					service?.bitbucketOwner,
					text(service?.bitbucketRepositorySlug) || service?.bitbucketRepository,
				),
				branch: label(service?.bitbucketBranch),
				buildPath:
					kind === "compose" ?
						defaultBuildPath
					:	label(service?.bitbucketBuildPath),
				trigger: label(service?.triggerType),
			};
		case "gitea":
			return {
				provider: sourceLabel(sourceType),
				repository: joinRepo(service?.giteaOwner, service?.giteaRepository),
				branch: label(service?.giteaBranch),
				buildPath:
					kind === "compose" ? defaultBuildPath : label(service?.giteaBuildPath),
				trigger: label(service?.triggerType),
			};
		case "git":
			return {
				provider: sourceLabel(sourceType),
				repository: label(service?.customGitUrl),
				branch: label(service?.customGitBranch),
				buildPath:
					kind === "compose" ?
						defaultBuildPath
					:	label(service?.customGitBuildPath),
				trigger: label(service?.triggerType),
			};
		case "docker":
			return {
				provider: sourceLabel(sourceType),
				repository: label(service?.dockerImage),
				branch: "-",
				buildPath: "-",
				trigger: "-",
			};
		case "drop":
			return {
				provider: sourceLabel(sourceType),
				repository: "Uploaded archive",
				branch: "-",
				buildPath: label(service?.dropBuildPath),
				trigger: "-",
			};
		case "raw":
			return {
				provider: sourceLabel(sourceType),
				repository: "Compose file",
				branch: "-",
				buildPath: defaultBuildPath,
				trigger: label(service?.triggerType),
			};
		default:
			return {
				provider: sourceLabel(sourceType),
				repository: "-",
				branch: "-",
				buildPath: defaultBuildPath,
				trigger: label(service?.triggerType),
			};
	}
}

function getServiceInfo(row: any) {
	const app = row.application;
	const comp = row.compose;
	if (app?.environment?.project && app.environment) {
		return {
			kind: "application" as const,
			type: "Application",
			name: app.name,
			id: app.applicationId,
			href: `/dashboard/project/${app.environment.project.projectId}/environment/${app.environment.environmentId}/services/application/${app.applicationId}`,
			projectName: app.environment.project.name,
			environmentName: app.environment.name,
			source: sourceSummary(app, "application"),
		};
	}
	if (comp?.environment?.project && comp.environment) {
		return {
			kind: "compose" as const,
			type: "Compose",
			name: comp.name,
			id: comp.composeId,
			href: `/dashboard/project/${comp.environment.project.projectId}/environment/${comp.environment.environmentId}/services/compose/${comp.composeId}`,
			projectName: comp.environment.project.name,
			environmentName: comp.environment.name,
			source: sourceSummary(comp, "compose"),
		};
	}

	const meta = row.meta;
	if (meta?.variant && meta.serviceId && meta.projectId && meta.environmentId) {
		const variantLabels: Record<string, string> = {
			mongo: "MongoDB",
			postgres: "PostgreSQL",
			mysql: "MySQL",
			redis: "Redis",
			mariadb: "MariaDB",
			libsql: "LibSQL",
		};
		return {
			kind: "database" as const,
			type: variantLabels[meta.variant] ?? meta.variant,
			name: meta.name ?? meta.variant,
			id: meta.serviceId,
			href: `/dashboard/project/${meta.projectId}/environment/${meta.environmentId}/services/${meta.variant}/${meta.serviceId}`,
			projectName: meta.projectName ?? "-",
			environmentName: meta.environmentName ?? "-",
			source: sourceSummary(null, "database"),
		};
	}
	return null;
}

function queueJobPayload(row: any): Record<string, unknown> {
	const raw = row?.data as unknown;
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	return {};
}

function deploymentTargetKey(row: DeploymentViewRow): string | null {
	if (row.applicationId) return `application:${row.applicationId}`;
	if (row.composeId) return `compose:${row.composeId}`;
	return null;
}

function queueTargetKey(row: any): string | null {
	const payload = queueJobPayload(row);
	const applicationId = text(payload.applicationId);
	if (applicationId) return `application:${applicationId}`;
	const composeId = text(payload.composeId);
	if (composeId) return `compose:${composeId}`;
	return null;
}

export function formatDeploymentDate(
	value: string | Date | number | null | undefined,
): string {
	if (value == null) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleString();
}

export function formatDeploymentDuration(
	startedAt: string | Date | number | null | undefined,
	finishedAt: string | Date | number | null | undefined,
): string {
	if (startedAt == null) return "-";
	const start = new Date(startedAt).getTime();
	const end = finishedAt == null ? Date.now() : new Date(finishedAt).getTime();
	if (Number.isNaN(start) || Number.isNaN(end)) return "-";
	const seconds = Math.max(0, Math.round((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const restSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${restSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return `${hours}h ${restMinutes}m`;
}

function getJobLabel(row: any): string {
	const d = row.data as {
		applicationType?: string;
		applicationId?: string;
		composeId?: string;
		previewDeploymentId?: string;
		titleLog?: string;
		type?: string;
	};
	if (!d) return String(row.id);
	if (d.titleLog) return d.titleLog;
	if (d.applicationId) return `Application ${d.applicationId.slice(0, 8)}`;
	if (d.composeId) return `Compose ${d.composeId.slice(0, 8)}`;
	if (d.previewDeploymentId) return `Preview ${d.previewDeploymentId.slice(0, 8)}`;
	return `${d.applicationType ?? d.type ?? "Job"} ${String(row.id)}`;
}

export function deploymentToViewRow(row: any): DeploymentViewRow | null {
	const info = getServiceInfo(row);
	if (!info) return null;
	const serverName =
		row.server?.name ??
		row.meta?.serviceServerName ??
		row.application?.server?.name ??
		row.compose?.server?.name ??
		"-";
	const rawDescription = text(row.description);
	const description = rawDescription.startsWith("NZ_DB:") ? "" : rawDescription;
	// A database deployment whose underlying service was deleted is "removed".
	// These rows aren't tied to the service by a foreign key, so they remain in
	// the deployments table; instead of showing a misleading "Running" tag we
	// surface a "Removed" tag so the history stays visible but clearly marked.
	const isRemoved = info.kind === "database" && row.meta?.serviceExists === false;
	const status = isRemoved
		? "removed"
		: resolveDeploymentDisplayStatus(
				text(row.status) || "running",
				runtimeStatusForDeployment(row, info.kind),
			);
	const errorMessage = text(row.errorMessage);
	const rollback = row.rollback;
	const rollbackVersion =
		rollback?.version != null ? `Rollback v${rollback.version}` : "Rollback";
	const deploymentId = text(row.deploymentId);
	const id = deploymentId || text(row.id) || `${info.type}-${row.createdAt}`;
	return {
		id,
		detailId: deploymentId || id,
		sourceKind: "deployment",
		serviceKind: info.kind,
		service: label(info.name, "Deployment"),
		serviceType: info.type,
		project: label(info.projectName),
		environment: label(info.environmentName),
		server: serverName,
		title: label(row.title, "Deployment"),
		description,
		status,
		createdAt: row.createdAt ?? null,
		createdLabel: formatDeploymentDate(row.createdAt),
		startedAt: row.startedAt ?? null,
		finishedAt: row.finishedAt ?? null,
		durationLabel: formatDeploymentDuration(row.startedAt, row.finishedAt),
		href: info.href,
		deploymentId: deploymentId || undefined,
		applicationId: info.kind === "application" ? info.id : undefined,
		composeId: info.kind === "compose" ? info.id : undefined,
		rollbackId: text(rollback?.rollbackId) || undefined,
		rollbackLabel: text(rollback?.image) || rollbackVersion,
		errorMessage,
		source: info.source,
	};
}

export function queueToViewRow(row: any): DeploymentViewRow {
	const payload = queueJobPayload(row);
	const pathInfo = row.servicePath;
	const appType =
		typeof payload.applicationType === "string" ? payload.applicationType : "Queue";
	const applicationId = text(payload.applicationId);
	const composeId = text(payload.composeId);
	return {
		id: String(row.id),
		detailId: String(row.id),
		sourceKind: "queue",
		serviceKind: "queue",
		service: getJobLabel(row),
		serviceType: "Queued job",
		project: "-",
		environment: "-",
		server: "-",
		title: appType,
		description: "Waiting for the deployment worker",
		status: row.state ?? "pending",
		createdAt: row.timestamp ?? null,
		createdLabel: formatDeploymentDate(row.timestamp),
		startedAt: row.processedOn ?? null,
		finishedAt: row.finishedOn ?? null,
		durationLabel: formatDeploymentDuration(row.processedOn, row.finishedOn),
		href: pathInfo?.href,
		applicationId: applicationId || undefined,
		composeId: composeId || undefined,
		source: sourceSummary(null, "queue"),
		queueRow: row,
	};
}

export function mapDeploymentsToViewRows(
	deployments: any[] | null | undefined,
	queueRows: any[] | null | undefined = [],
): DeploymentViewRow[] {
	const deploymentRows = (deployments ?? [])
		.map(deploymentToViewRow)
		.filter((row): row is DeploymentViewRow => row != null);
	const runningTargets = new Set(
		deploymentRows
			.filter((row) => row.status === "running")
			.map(deploymentTargetKey)
			.filter((key): key is string => key != null),
	);
	const visibleQueueRows = (queueRows ?? []).filter((row) => {
		const state = text(row.state).toLowerCase();
		const target = queueTargetKey(row);
		// Terminal-state queue jobs are redundant: the deployment records are the
		// source of truth for completed/failed runs. Hiding them avoids stale
		// "Manual deployment" rows lingering with no service context.
		if (state === "completed" || state === "failed") return false;
		if (state !== "active") return true;
		return !target || !runningTargets.has(target);
	});
	return [
		...visibleQueueRows.map(queueToViewRow),
		...deploymentRows,
	];
}

export function deploymentRowMatchesFilters(
	row: DeploymentViewRow,
	filters: {
		status?: string;
		type?: string;
		query?: string;
	},
) {
	const statusFilter = filters.status ?? "all";
	const typeFilter = filters.type ?? "all";
	if (statusFilter !== "all" && row.status !== statusFilter) return false;
	if (typeFilter !== "all" && row.serviceKind !== typeFilter) return false;
	const q = (filters.query ?? "").trim().toLowerCase();
	if (!q) return true;
	return [
		row.service,
		row.serviceType,
		row.project,
		row.environment,
		row.server,
		row.title,
		row.description,
		row.status,
		row.createdLabel,
		row.source.provider,
		row.source.repository,
		row.source.branch,
		row.source.buildPath,
		row.source.trigger,
	]
		.join(" ")
		.toLowerCase()
		.includes(q);
}

export function compareDeploymentRows(
	a: DeploymentViewRow,
	b: DeploymentViewRow,
	sortId: string,
	sortDesc: boolean,
): number {
	const mul = sortDesc ? -1 : 1;
	if (sortId === "createdAt") {
		const ta = a.createdAt == null ? 0 : new Date(a.createdAt).getTime();
		const tb = b.createdAt == null ? 0 : new Date(b.createdAt).getTime();
		return mul * (ta - tb);
	}
	const valueFor = (row: DeploymentViewRow) => {
		switch (sortId) {
			case "service":
				return row.service;
			case "project":
				return row.project;
			case "environment":
				return row.environment;
			case "server":
				return row.server;
			case "title":
				return row.title;
			case "status":
				return row.status;
			default:
				return row.service;
		}
	};
	return mul * valueFor(a).localeCompare(valueFor(b));
}
