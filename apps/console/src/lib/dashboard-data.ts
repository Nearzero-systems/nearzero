import {
	deploymentStatusBadgeClass,
	mapDeploymentsToViewRows,
} from "@/lib/deployment-view-rows";
import { pickAccessibleEnvironment } from "@/lib/pick-accessible-environment";

type NearzeroProject = {
	projectId: string;
	name: string;
	description?: string | null;
	environments?: {
		environmentId: string;
		name: string;
		isDefault?: boolean | null;
	}[];
};

type NearzeroDeployment = {
	deploymentId: string;
	status: string;
	createdAt: string | Date;
	application?: {
		name: string;
		applicationId: string;
		environment?: {
			name: string;
			environmentId: string;
			project?: { name: string; projectId: string };
		};
	};
	compose?: {
		name: string;
		composeId: string;
		environment?: {
			name: string;
			environmentId: string;
			project?: { name: string; projectId: string };
		};
	};
};

type GitProvider = {
	gitProviderId: string;
	providerType: string;
};

export function mapProjectsToRows(projects: NearzeroProject[] | null | undefined) {
	return (projects ?? []).map((project) => {
		const env = pickAccessibleEnvironment(project.environments ?? []);
		const cardHref = env
			? `/dashboard/project/${project.projectId}/environment/${env.environmentId}/overview`
			: `/dashboard/projects`;
		return {
			id: project.projectId,
			name: project.name,
			description: project.description ?? "",
			cardHref,
			visitHref: null,
			repoProvider: "",
			repoFull: "",
			repoBranch: "",
		};
	});
}

export function mapDeploymentsToRows(
	deployments: NearzeroDeployment[] | null | undefined,
) {
	return mapDeploymentsToViewRows(deployments).map((row) => ({
		projectName: row.project,
		serviceName: row.service,
		environmentName: row.environment,
		status: row.status,
		statusToneClass:
			deploymentStatusBadgeClass[row.status] ??
			"bg-secondary text-secondary-foreground",
		detailsHref: `/dashboard/deployments?deploymentId=${encodeURIComponent(row.detailId)}`,
		visitHref: null,
		createdAtLabel: row.createdLabel,
	}));
}

export function linkedVcsFromProviders(providers: GitProvider[] | null | undefined) {
	const linked = new Set<string>();
	for (const p of providers ?? []) {
		const t = String(p.providerType ?? "").toLowerCase();
		if (t.includes("github")) linked.add("github");
		if (t.includes("gitlab")) linked.add("gitlab");
		if (t.includes("bitbucket")) linked.add("bitbucket");
	}
	return [...linked];
}

export function projectsInitialView(
	projectCount: number,
): "connect" | "import" | "inventory" {
	if (projectCount > 0) return "inventory";
	return "connect";
}
