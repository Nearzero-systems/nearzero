import {
	NEARZERO_DOCS_URL,
	NEARZERO_SUPPORT_URL,
	normalizeExternalUrl,
} from "../../lib/branding";
import { scopeDashboardHref } from "../../lib/org-routes";

export type NavAuth = {
	role?: string | null;
} | null;

export type NavPermissions = {
	deployment?: { read?: boolean };
	monitoring?: { read?: boolean };
	domain?: { read?: boolean };
	organization?: { update?: boolean };
	traefikFiles?: { read?: boolean };
	docker?: { read?: boolean };
	server?: { read?: boolean };
	member?: { read?: boolean };
	auditLog?: { read?: boolean };
	sshKeys?: { read?: boolean };
	tag?: { read?: boolean };
	gitProviders?: { read?: boolean };
	registry?: { read?: boolean };
	destination?: { read?: boolean };
	certificate?: { read?: boolean };
	notification?: { read?: boolean };
} | null;

export type NavContext = {
	auth?: NavAuth;
	permissions?: NavPermissions;
	orgSlug?: string | null;
	whitelabeling?: {
		appName?: string | null;
		docsUrl?: string | null;
		supportUrl?: string | null;
	} | null;
};

export type NavLeaf = {
	key: string;
	label: string;
	href: string;
	icon: string;
	asyncRouteId?: string;
	loadingLabel?: string;
	shellMode?: "normal" | "workspace";
	external?: boolean;
	isEnabled?: (ctx: NavContext) => boolean;
};

export type NavGroup = {
	key: string;
	label: string;
	icon: string;
	items: NavLeaf[];
};

export type NavItem = NavLeaf;

const always = () => true;
const admin = (ctx: NavContext) => !!ctx.permissions?.organization?.update;

/** Main workspace navigation — Agent, Projects, Deployments, Tasks. */
export const WORKSPACE_ITEMS: NavLeaf[] = [
	{
		key: "agent",
		label: "Agent",
		href: "/dashboard/agent",
		icon: "agent",
		asyncRouteId: "dashboard:agent",
		loadingLabel: "Loading agent...",
		shellMode: "workspace",
		isEnabled: always,
	},
	{
		key: "projects",
		label: "Projects",
		href: "/dashboard/projects",
		icon: "projects",
		asyncRouteId: "dashboard:projects",
		loadingLabel: "Loading projects...",
		shellMode: "normal",
		isEnabled: always,
	},
	{
		key: "deployments",
		label: "Deployments",
		href: "/dashboard/deployments",
		icon: "deployments",
		asyncRouteId: "dashboard:deployments",
		loadingLabel: "Loading deployments...",
		shellMode: "normal",
		isEnabled: (ctx) => !!ctx.permissions?.deployment?.read,
	},
	{
		key: "tasks",
		label: "Tasks",
		href: "/dashboard/tasks",
		icon: "schedules",
		asyncRouteId: "dashboard:tasks",
		loadingLabel: "Loading tasks...",
		shellMode: "normal",
		isEnabled: admin,
	},
	{
		key: "analytics",
		label: "Analytics",
		href: "/dashboard/analytics",
		icon: "requests",
		asyncRouteId: "dashboard:analytics",
		loadingLabel: "Loading analytics...",
		shellMode: "normal",
		isEnabled: (ctx) => !!ctx.permissions?.docker?.read,
	},
];

/** Infrastructure section — promoted from Settings. */
export const INFRASTRUCTURE_ITEMS: NavLeaf[] = [
	{
		key: "servers",
		label: "Servers",
		href: "/dashboard/servers",
		icon: "server",
		asyncRouteId: "dashboard:servers",
		loadingLabel: "Loading servers...",
		shellMode: "normal",
		isEnabled: (ctx) => !!ctx.permissions?.server?.read,
	},
	{
		key: "domains",
		label: "Domains",
		href: "/dashboard/domains",
		icon: "domains",
		asyncRouteId: "dashboard:domains",
		loadingLabel: "Loading domains...",
		shellMode: "normal",
		isEnabled: (ctx) =>
			!!ctx.permissions?.domain?.read || !!ctx.permissions?.certificate?.read,
	},
];

const MAIN_SIDEBAR_GROUPS: NavGroup[] = [];

/** @deprecated Sidebar groups moved into Settings hub — kept for search/compat exports. */
export const NAV_GROUPS: NavGroup[] = [
	{
		key: "infrastructure",
		label: "Infrastructure",
		icon: "cluster",
		items: [
			{
				key: "settings-about-nearzero",
				label: "About Nearzero",
				href: "/dashboard/about-nearzero",
				icon: "monitoring",
				isEnabled: always,
			},
			{
				key: "tasks",
				label: "Tasks",
				href: "/dashboard/tasks",
				icon: "schedules",
				isEnabled: admin,
			},
			{
				key: "traefik",
				label: "Traefik File System",
				href: "/dashboard/traefik",
				icon: "traefik",
				isEnabled: (ctx) => !!ctx.permissions?.traefikFiles?.read,
			},
			{
				key: "analytics",
				label: "Analytics",
				href: "/dashboard/analytics",
				icon: "requests",
				isEnabled: (ctx) => !!ctx.permissions?.docker?.read,
			},
		],
	},
	{
		key: "account",
		label: "Account",
		icon: "user",
		items: [
			{
				key: "settings-profile",
				label: "Profile",
				href: "/dashboard/settings/profile",
				icon: "user",
				isEnabled: always,
			},
		],
	},
	{
		key: "team",
		label: "Team & Access",
		icon: "users",
		items: [
			{
				key: "settings-users",
				label: "Users",
				href: "/dashboard/settings/users",
				icon: "users",
				isEnabled: (ctx) => !!ctx.permissions?.member?.read,
			},
		],
	},
	{
		key: "servers",
		label: "Servers",
		icon: "server",
		items: [
			{
				key: "settings-about-nearzero",
				label: "About Nearzero",
				href: "/dashboard/about-nearzero",
				icon: "story",
				isEnabled: always,
			},
			{
				key: "servers",
				label: "Servers",
				href: "/dashboard/servers",
				icon: "server",
				isEnabled: (ctx) => !!ctx.permissions?.server?.read,
			},
		],
	},
	{
		key: "security",
		label: "Security",
		icon: "certificates",
		items: [
			{
				key: "servers-ssh-keys",
				label: "SSH Keys",
				href: "/dashboard/servers?tab=ssh-keys",
				icon: "key",
				isEnabled: (ctx) => !!ctx.permissions?.sshKeys?.read,
			},
			{
				key: "settings-certificates",
				label: "Certificates",
				href: "/dashboard/domains?tab=certificates",
				icon: "certificates",
				isEnabled: (ctx) => !!ctx.permissions?.certificate?.read,
			},
		],
	},
	{
		key: "integrations",
		label: "Integrations",
		icon: "git",
		items: [
			{
				key: "settings-git-providers",
				label: "Git",
				href: "/dashboard/settings/git-providers",
				icon: "git",
				isEnabled: (ctx) => !!ctx.permissions?.gitProviders?.read,
			},
			{
				key: "settings-notifications",
				label: "Notifications",
				href: "/dashboard/settings/notifications",
				icon: "bell",
				isEnabled: (ctx) => !!ctx.permissions?.notification?.read,
			},
			{
				key: "settings-agent",
				label: "Agent policies",
				href: "/dashboard/settings/agent",
				icon: "agent",
				isEnabled: admin,
			},
		],
	},
];

/** Flat settings list — mirrors Nearzero `MENU.settings` order for search/compat. */
export const SETTINGS_ITEMS: NavLeaf[] = NAV_GROUPS.flatMap((group) => group.items);

const HELP_ITEMS: NavLeaf[] = [
	{
		key: "docs",
		label: "Documentation",
		href: NEARZERO_DOCS_URL,
		icon: "docs",
		external: true,
	},
	{
		key: "support",
		label: "Support",
		href: NEARZERO_SUPPORT_URL,
		icon: "help",
		external: true,
	},
];

function scopeNavLeaf(item: NavLeaf, ctx: NavContext): NavLeaf {
	if (item.external) return item;
	return {
		...item,
		href: scopeDashboardHref(item.href, ctx.orgSlug),
	};
}

function filterLeaves(items: NavLeaf[], ctx: NavContext): NavLeaf[] {
	return items
		.filter((item) => (item.isEnabled ? item.isEnabled(ctx) : true))
		.map((item) => scopeNavLeaf(item, ctx));
}

function filterGroups(groups: NavGroup[], ctx: NavContext): NavGroup[] {
	return groups
		.map((group) => ({
			...group,
			items: filterLeaves(group.items, ctx),
		}))
		.filter((group) => group.items.length > 0);
}

export function createDashboardNavMenu(ctx: NavContext) {
	const docsUrl = normalizeExternalUrl(
		ctx.whitelabeling?.docsUrl,
		NEARZERO_DOCS_URL,
	);
	const supportUrl = normalizeExternalUrl(
		ctx.whitelabeling?.supportUrl,
		NEARZERO_SUPPORT_URL,
	);

	const help = HELP_ITEMS.map((item) => {
		if (item.key === "docs") return { ...item, href: docsUrl };
		if (item.key === "support") return { ...item, href: supportUrl };
		return item;
	});

	const groups = filterGroups(MAIN_SIDEBAR_GROUPS, ctx);
	const infrastructure = filterLeaves(INFRASTRUCTURE_ITEMS, ctx);

	return {
		workspace: filterLeaves(WORKSPACE_ITEMS, ctx),
		groups,
		infrastructure,
		infrastructureLabel:
			infrastructure.length > 0 ? ("Infrastructure" as const) : null,
		help,
	};
}

export function allNavLeaves(): NavLeaf[] {
	return [
		...WORKSPACE_ITEMS,
		...INFRASTRUCTURE_ITEMS,
		...SETTINGS_ITEMS,
		...HELP_ITEMS,
	];
}

function isActiveRoute(itemUrl: string, pathname: string): boolean {
	const normalizedItemUrl = itemUrl.replace("/projects", "/project");
	const normalizedPathname = pathname.replace("/projects", "/project");

	if (normalizedPathname === normalizedItemUrl) return true;

	if (normalizedPathname.startsWith(normalizedItemUrl)) {
		const nextChar = normalizedPathname.charAt(normalizedItemUrl.length);
		return nextChar === "/";
	}

	return false;
}

export function findActiveNavKey(pathname: string, section = ""): string {
	const dashboardPath = pathname.replace(/^\/[^/]+\/dashboard/, "/dashboard");

	for (const item of WORKSPACE_ITEMS) {
		if (isActiveRoute(item.href, dashboardPath)) return item.key;
	}

	for (const group of MAIN_SIDEBAR_GROUPS) {
		for (const item of group.items) {
			if (isActiveRoute(item.href, dashboardPath)) return item.key;
		}
	}

	for (const item of INFRASTRUCTURE_ITEMS) {
		if (isActiveRoute(item.href, dashboardPath)) return item.key;
	}

	if (dashboardPath === "/dashboard/agent") return "agent";
	if (dashboardPath.startsWith("/dashboard/project")) return "projects";
	if (dashboardPath === "/dashboard/projects") return "projects";
	if (dashboardPath === "/dashboard/deployments") return "deployments";
	if (dashboardPath === "/dashboard/tasks") return "tasks";
	if (dashboardPath === "/dashboard/analytics") return "analytics";
	if (dashboardPath === "/dashboard/about-nearzero") return "settings-about-nearzero";
	if (dashboardPath === "/dashboard/monitoring") return "settings-about-nearzero";
	if (dashboardPath === "/dashboard/settings/server") return "settings-about-nearzero";
	if (dashboardPath === "/dashboard/servers") return "servers";
	if (
		dashboardPath === "/dashboard/domains" ||
		dashboardPath === "/dashboard/settings/dns" ||
		dashboardPath === "/dashboard/settings/certificates"
	) {
		return "domains";
	}
	if (dashboardPath === "/dashboard/home" || dashboardPath === "/dashboard") {
		return section === "projects" ? "projects" : "agent";
	}

	return section || "agent";
}

/** @deprecated use createDashboardNavMenu().workspace */
export const mainNavItems: NavItem[] = WORKSPACE_ITEMS;

/** @deprecated use createDashboardNavMenu().groups */
export const settingsNavItems: NavItem[] = SETTINGS_ITEMS;

/** @deprecated use createDashboardNavMenu().help */
export const helpNavItems: NavItem[] = HELP_ITEMS;
