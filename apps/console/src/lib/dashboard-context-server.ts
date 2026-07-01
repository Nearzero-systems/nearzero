import { createServerTrpcClient } from "@/lib/server-api";
import { parseDashboardPath } from "@/lib/dashboard-context";

export type DashboardContextLabels = {
	projectName?: string;
	environmentName?: string;
	isProductionEnvironment?: boolean;
	serviceName?: string;
};

export async function resolveDashboardContext(
	request: Request,
	pathname: string,
): Promise<DashboardContextLabels> {
	const route = parseDashboardPath(pathname);
	if (!route.projectId && !route.environmentId) return {};

	const api = createServerTrpcClient(request) as {
		project: { one: { query: (input: { projectId: string }) => Promise<{ name: string }> } };
		environment: {
			one: {
				query: (input: { environmentId: string }) => Promise<{
					name: string;
					isDefault: boolean;
					project?: { name?: string };
				}>;
			};
		};
	};

	const labels: DashboardContextLabels = {};

	if (route.environmentId) {
		try {
			const environment = await api.environment.one.query({
				environmentId: route.environmentId,
			});
			labels.environmentName = environment.name;
			labels.isProductionEnvironment =
				environment.name.trim().toLowerCase() === "production";
			if (environment.project?.name) {
				labels.projectName = environment.project.name;
			}
		} catch {
			labels.environmentName = "Environment";
		}
	}

	if (route.projectId && !labels.projectName) {
		try {
			const project = await api.project.one.query({ projectId: route.projectId });
			labels.projectName = project.name;
		} catch {
			labels.projectName = "Project";
		}
	}

	return labels;
}
