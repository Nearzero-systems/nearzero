#!/usr/bin/env bun
/**
 * Generates Astro dashboard route shells matching Dashboard URL paths.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../src/pages");

type RouteDef = {
	path: string;
	title: string;
	/** Astro dashboard component path under components/dashboard/ */
	serverDashboard: string;
	/** Props for the dashboard component (alongside `request={Astro.request}` when needed). */
	dashboardProps?: DashboardPropBinding[];
};

type DashboardPropBinding =
	| { kind: "param"; name: string; param: string }
	| { kind: "literal"; name: string; value: string };

const staticRoutes: RouteDef[] = [
	{ path: "invitation", title: "Invitation", serverDashboard: "__public__" },
	{ path: "swagger", title: "API docs", serverDashboard: "__public__" },
	{ path: "dashboard/home", title: "Home", serverDashboard: "home/HomeDashboard" },
	{ path: "dashboard/agent", title: "Agent", serverDashboard: "agent/AgentDashboard" },
	{ path: "dashboard/projects", title: "Projects", serverDashboard: "projects/ProjectsDashboard" },
	{
		path: "dashboard/about-nearzero",
		title: "About Nearzero",
		serverDashboard: "about-nearzero/AboutNearzeroDashboard",
	},
	{
		path: "dashboard/traefik",
		title: "Traefik",
		serverDashboard: "traefik/TraefikDashboard",
	},
	{ path: "dashboard/deployments", title: "Deployments", serverDashboard: "deployments/DeploymentsDashboard" },
	{
		path: "dashboard/servers",
		title: "Servers",
		serverDashboard: "settings/servers/ServersSettingsDashboard",
	},
	{
		path: "dashboard/tasks",
		title: "Tasks",
		serverDashboard: "schedules/SchedulesDashboard",
	},
	{ path: "dashboard/analytics", title: "Analytics", serverDashboard: "analytics/AnalyticsDashboard" },
	{ path: "dashboard/settings/certificates", title: "Certificates", serverDashboard: "settings/CertificatesDashboard" },
	{ path: "dashboard/settings/git-providers", title: "Git providers", serverDashboard: "settings/GitProvidersDashboard" },
	{
		path: "dashboard/settings/notifications",
		title: "Notifications",
		serverDashboard: "settings/notifications/NotificationsSettingsDashboard",
	},
	{ path: "dashboard/settings/profile", title: "Profile", serverDashboard: "settings/ProfileDashboard" },
	{ path: "dashboard/settings/tags", title: "Tags", serverDashboard: "settings/TagsDashboard" },
	{ path: "dashboard/settings/users", title: "Users", serverDashboard: "settings/UsersDashboard" },
];

const dynamicRoutes: RouteDef[] = [
	{ path: "accept-invitation/[acceptInvitation]", title: "Accept invitation", serverDashboard: "__public__" },
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/[section]",
		title: "Project",
		serverDashboard: "project/ProjectWorkspaceDashboard",
		dashboardProps: [
			{ kind: "param", name: "projectId", param: "projectId" },
			{ kind: "param", name: "environmentId", param: "environmentId" },
			{ kind: "param", name: "section", param: "section" },
		],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/application/[applicationId]",
		title: "Application",
		serverDashboard: "application/ApplicationDashboard",
		dashboardProps: [{ kind: "param", name: "applicationId", param: "applicationId" }],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/compose/[composeId]",
		title: "Compose",
		serverDashboard: "compose/ComposeDashboard",
		dashboardProps: [{ kind: "param", name: "composeId", param: "composeId" }],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/postgres/[postgresId]",
		title: "PostgreSQL",
		serverDashboard: "services/DatabaseServiceDashboard",
		dashboardProps: [
			{ kind: "literal", name: "variant", value: "postgres" },
			{ kind: "param", name: "dbId", param: "postgresId" },
		],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/mysql/[mysqlId]",
		title: "MySQL",
		serverDashboard: "services/DatabaseServiceDashboard",
		dashboardProps: [
			{ kind: "literal", name: "variant", value: "mysql" },
			{ kind: "param", name: "dbId", param: "mysqlId" },
		],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/mongo/[mongoId]",
		title: "MongoDB",
		serverDashboard: "services/DatabaseServiceDashboard",
		dashboardProps: [
			{ kind: "literal", name: "variant", value: "mongo" },
			{ kind: "param", name: "dbId", param: "mongoId" },
		],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/redis/[redisId]",
		title: "Redis",
		serverDashboard: "services/DatabaseServiceDashboard",
		dashboardProps: [
			{ kind: "literal", name: "variant", value: "redis" },
			{ kind: "param", name: "dbId", param: "redisId" },
		],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/mariadb/[mariadbId]",
		title: "MariaDB",
		serverDashboard: "services/DatabaseServiceDashboard",
		dashboardProps: [
			{ kind: "literal", name: "variant", value: "mariadb" },
			{ kind: "param", name: "dbId", param: "mariadbId" },
		],
	},
	{
		path: "dashboard/project/[projectId]/environment/[environmentId]/services/libsql/[libsqlId]",
		title: "LibSQL",
		serverDashboard: "services/DatabaseServiceDashboard",
		dashboardProps: [
			{ kind: "literal", name: "variant", value: "libsql" },
			{ kind: "param", name: "dbId", param: "libsqlId" },
		],
	},
];

function renderServerDashboardPage(
	route: RouteDef & { serverDashboard: string },
) {
	const componentName =
		route.serverDashboard.split("/").pop()?.replace(/\.astro$/u, "") ?? "";
	const dashboardsWithoutRequest = new Set([
		"about-nearzero/AboutNearzeroDashboard",
		"settings/notifications/NotificationsSettingsDashboard",
		"settings/web-server/WebServerSettingsDashboard",
		"settings/servers/ServersSettingsDashboard",
	]);
	const needsRequest = !dashboardsWithoutRequest.has(route.serverDashboard);
	const body = needsRequest
		? `\n  <${componentName} request={Astro.request} />\n`
		: `\n  <${componentName} />\n`;
	const isAboutNearzeroRoute = route.path === "dashboard/about-nearzero";
	const brandingImport = `import { pageTitle } from "@/lib/branding";`;
	const orgRouteImport = "";
	const hostedRedirect = "";

	return `---
import Dashboard from "@/layouts/Dashboard.astro";
import ${componentName} from "@/components/dashboard/${route.serverDashboard}.astro";
${brandingImport}
import { getSession } from "@/lib/backendProxy";
${orgRouteImport}

const session = await getSession(Astro.request);
if (!session?.user) {
  const dest = Astro.url.pathname + Astro.url.search;
  return Astro.redirect(\`/?callbackUrl=\${encodeURIComponent(dest)}\`);
}
${hostedRedirect}
---
<Dashboard title={pageTitle("${route.title}")} user={session.user}>${body}</Dashboard>
`;
}

function renderParameterizedServerDashboardPage(
	route: RouteDef & {
		serverDashboard: string;
		dashboardProps?: DashboardPropBinding[];
	},
) {
	const componentName =
		route.serverDashboard.split("/").pop()?.replace(/\.astro$/u, "") ?? "";

	const bindings = route.dashboardProps ?? [];

	const mapped = bindings.map((b) => {
		if (b.kind === "literal") {
			return `    ${b.name}={${JSON.stringify(b.value)}}`;
		}
		return `    ${b.name}={routeParams.${b.param} ?? ""}`;
	});
	const attrs = [`    request={Astro.request}`, ...mapped];
	const inner = `\n  <${componentName}\n${attrs.join("\n")}\n  />\n`;

	return `---
import Dashboard from "@/layouts/Dashboard.astro";
import ${componentName} from "@/components/dashboard/${route.serverDashboard}.astro";
import { pageTitle } from "@/lib/branding";
import { getSession } from "@/lib/backendProxy";

const session = await getSession(Astro.request);
if (!session?.user) {
  const dest = Astro.url.pathname + Astro.url.search;
  return Astro.redirect(\`/?callbackUrl=\${encodeURIComponent(dest)}\`);
}
const routeParams = Object.fromEntries(
  Object.entries(Astro.params).filter(([, v]) => typeof v === "string"),
) as Record<string, string>;
---
<Dashboard title={pageTitle("${route.title}")} user={session.user}>${inner}</Dashboard>
`;
}

const AUTH_PUBLIC: Record<string, { component: string; frontmatter: string; render: string }> = {
	"invitation": {
		component: "InvitationGrid",
		frontmatter: `import type { InvitationPreview } from "@/lib/invitation-types";
import { createServerTrpcClient } from "@/lib/server-api";
import { getSession } from "@/lib/backendProxy";

const token = Astro.url.searchParams.get("token") ?? "";
let invitation: InvitationPreview | null = null;
let loadError: string | null = null;

if (token) {
\ttry {
\t\tconst api = createServerTrpcClient(Astro.request);
\t\tinvitation = await api.user.getUserByToken.query({ token });
\t} catch (err) {
\t\tloadError =
\t\t\terr instanceof Error && err.message ? err.message : "Invitation not found";
\t}
}

const session = await getSession(Astro.request);
const sessionEmail = session?.user?.email ?? null;`,
		render: `<InvitationGrid token={token} invitation={invitation} loadError={loadError} sessionEmail={sessionEmail} />`,
	},
};

function renderPublicPage(route: RouteDef) {
	const auth = AUTH_PUBLIC[route.path];
	if (auth) {
		return `---
import Base from "@/layouts/Base.astro";
import ${auth.component} from "@/components/auth/${auth.component}.astro";
import { pageTitle } from "@/lib/branding";
${auth.frontmatter}
---
<Base title={pageTitle("${route.title}")}>
  ${auth.render}
</Base>
`;
	}
	return `---
import Base from "@/layouts/Base.astro";
import { pageTitle } from "@/lib/branding";

---
<Base title={pageTitle("${route.title}")}>
  <div class="flex min-h-screen items-center justify-center bg-[#f3f4f6] p-6">
    <div class="w-full max-w-md rounded-xl border border-[#e5e7eb] bg-white p-6">
      <h1 class="font-display text-xl font-semibold text-[#111827]">${route.title}</h1>
      <p class="mt-2 text-xs text-[#6b7280]">Use the platform API for this flow.</p>
      <a href="/" class="mt-6 inline-block text-xs text-[#6d28d9] hover:underline">Back to sign in</a>
    </div>
  </div>
</Base>
`;
}

function renderDashboardPage(route: RouteDef) {
	if (route.path === "accept-invitation/[acceptInvitation]") {
		return `---
const token = Astro.params.acceptInvitation;
if (typeof token === "string" && token.length > 0) {
\treturn Astro.redirect(\`/invitation?token=\${encodeURIComponent(token)}\`);
}
return Astro.redirect("/invitation");
---
`;
	}
	if (route.serverDashboard === "__public__") {
		return renderPublicPage(route);
	}
	if (route.dashboardProps?.length) {
		return renderParameterizedServerDashboardPage(route);
	}
	return renderServerDashboardPage(route);
}

for (const route of staticRoutes) {
	const filePath = join(root, `${route.path}.astro`);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, renderDashboardPage(route));
	console.log("wrote", filePath);
}

for (const route of dynamicRoutes) {
	const filePath = join(root, `${route.path}.astro`);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, renderDashboardPage(route));
	console.log("wrote", filePath);
}

console.log("Done generating", staticRoutes.length + dynamicRoutes.length, "pages");
