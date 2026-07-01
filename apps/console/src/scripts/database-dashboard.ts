import {
	bindDatabaseActions,
	bindDatabaseDeploymentHistory,
	bindDatabaseStatusPolling,
} from "@/components/dashboard/services/databaseActions";
import {
	bindCollapsibles,
	bindSettingPanelHints,
	bindServiceTabs,
} from "@/scripts/application-dashboard";

export function bootDatabaseDashboard() {
	const run = () => {
		bindDatabaseActions();
		bindDatabaseStatusPolling();
		for (const root of document.querySelectorAll<HTMLElement>(
			"[data-db-service-root='1']",
		)) {
			bindServiceTabs(root);
			bindSettingPanelHints(root);
			const deployRoot = root.querySelector<HTMLElement>("#nz-app-deploy-root");
			if (deployRoot) bindCollapsibles(deployRoot);
		}
		bindDatabaseDeploymentHistory();
	};

	requestAnimationFrame(() => {
		requestAnimationFrame(run);
	});
}
