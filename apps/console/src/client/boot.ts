import { initAccessEditors } from "./access-editor.ts";
import { initAgentHome } from "./agent.ts";
import { initAnalytics } from "./analytics.ts";
import { initApiForms } from "./api.ts";
import { initBackups } from "./backups.ts";
import { initBell } from "./bell.ts";
import { initCanvas } from "./canvas.ts";
import { initChannels } from "./channels.ts";
import { initCharts } from "./charts.ts";
import { initCompose } from "./compose.ts";
import { initConnectionCards } from "./connection.ts";
import { initCopyButtons } from "./copy.ts";
import { initCreateService } from "./create-service.ts";
import { initDeployButtons } from "./deploys.ts";
import { initDialogs, openMarkedDialogs } from "./dialogs.ts";
import { initAddDomain } from "./domains.ts";
import { initEnvironmentDialogs } from "./environments.ts";
import { initForms } from "./forms.ts";
import { initGitImport } from "./git-import.ts";
import { initGitProviders } from "./git-providers.ts";
import { initGitSource } from "./git-source.ts";
import { initPixelGlow } from "./glow.ts";
import { initLocalTimes } from "./local-times.ts";
import { initMembers } from "./members.ts";
import { initMenus } from "./menus.ts";
import { initTabs, scrollCurrentIntoView } from "./misc.ts";
import { initMonitoring } from "./monitoring.ts";
import { initMotion } from "./motion.ts";
import { initNavigation } from "./navigation.ts";
import { initNewApplication } from "./new-application.ts";
import { initOperations } from "./operations.ts";
import { initPrefetch } from "./prefetch.ts";
import { initProfile } from "./profile.ts";
import { initProjectsList } from "./projects.ts";
import { initRouterFiles } from "./router-files.ts";
import { initServerSetup } from "./server-setup.ts";
import { initServiceDelete } from "./service-delete.ts";
import { initServicesList } from "./services-list.ts";
import { initSettingsPages } from "./settings-pages.ts";
import { initSidebarToggle } from "./sidebar.ts";
import { initTabGlider } from "./tab-glider.ts";
import { initTasks } from "./tasks.ts";
import { initTeardown } from "./teardown.ts";
import { initTheme } from "./theme.ts";
import { showPageToasts } from "./toasts.ts";
import { initTwoFactor } from "./two-factor.ts";
import { initUserButton } from "./user-button.ts";
import { initVariables } from "./variables.ts";
import { initWorkspaceDialogs } from "./workspaces.ts";

/**
 * The console's one client script. Modules listen on `document`, so they keep working across
 * in-app navigation; per-page setup runs on `astro:page-load` (or once, on pages without the
 * client router).
 */

initMotion();
initTheme();
initDialogs();
initMenus();
initForms();
initCopyButtons();
initTabs();
initTabGlider();
initSidebarToggle();
initPixelGlow();
initBell();
initLocalTimes();
initProjectsList();
initAgentHome();
initApiForms();
initAccessEditors();
initWorkspaceDialogs();
initProfile();
initTwoFactor();
initUserButton();
initMembers();
initSettingsPages();
initRouterFiles();
initEnvironmentDialogs();
initTeardown();
initServiceDelete();
initServicesList();
initCreateService();
initDeployButtons();
initVariables();
initCanvas();
initAddDomain();
initConnectionCards();
initNewApplication();
initOperations();
initGitProviders();
initGitImport();
initGitSource();
initBackups();
initCompose();
initServerSetup();
// Tasks, Analytics, monitoring and notification channels (spec 12–15).
initCharts();
initTasks();
initAnalytics();
initMonitoring();
initChannels();

const routed = document.querySelector('meta[name="astro-view-transitions-enabled"]') !== null;
if (routed) {
  initNavigation();
  initPrefetch();
}

function onPage(): void {
  showPageToasts();
  openMarkedDialogs();
  scrollCurrentIntoView();
}

if (routed) document.addEventListener("astro:page-load", onPage);
else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onPage);
else onPage();
