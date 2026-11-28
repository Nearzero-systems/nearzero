import { initAbout } from "./about.ts";
import { initDeployLogs } from "./deploy-log.ts";
import { initDeploymentsPage } from "./deployments.ts";
import { initDomainsPage } from "./domains-page.ts";
import { initFilterForms } from "./filter-forms.ts";
import { initRuntimeLogs } from "./runtime-logs.ts";
import { initServers } from "./servers.ts";
import { initServicePage } from "./service-page.ts";
import { initTerminal } from "./terminal.ts";

/**
 * The operations area's browser code in one place (deploys, runtime, domains, servers,
 * deployments, About Nearzero), so the console's boot script starts it with one call.
 */
export function initOperations(): void {
  initDeployLogs();
  initRuntimeLogs();
  initTerminal();
  initServicePage();
  initDeploymentsPage();
  initFilterForms();
  initServers();
  initDomainsPage();
  initAbout();
}
