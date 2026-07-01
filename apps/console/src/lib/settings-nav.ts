import type { NavContext, NavLeaf } from "@/components/dashboard/navMenu";
import { settingsDashboardGates } from "@/components/dashboard/settings/settingsDashboardGates";
import { scopeDashboardHref } from "@/lib/org-routes";

export function getDefaultSettingsPath(): string {
	return "/dashboard/about-nearzero";
}

export function getDefaultSettingsHref(orgSlug?: string | null): string {
	return scopeDashboardHref(getDefaultSettingsPath(), orgSlug);
}

export type SettingsSection = {
	key: string;
	label: string;
	items: NavLeaf[];
};

/** All settings & operations pages — none removed from the old sidebar. */
export function buildSettingsSections(ctx: NavContext): SettingsSection[] {
	const dash = (path: string) => scopeDashboardHref(path, ctx.orgSlug);

	const sections: SettingsSection[] = [
		{
			key: "about-nearzero",
			label: "About Nearzero",
			items: [
				{
					key: "settings-about-nearzero",
					label: "About Nearzero",
					href: dash("/dashboard/about-nearzero"),
					icon: "story",
					isEnabled: settingsDashboardGates.always,
				},
			],
		},
		{
			key: "teams",
			label: "Teams",
			items: [
				{
					key: "settings-teams",
					label: "Teams",
					href: dash("/dashboard/settings/users"),
					icon: "users",
					isEnabled: settingsDashboardGates.users,
				},
				{
					key: "settings-audit-logs",
					label: "Audit log",
					href: dash("/dashboard/settings/audit-logs"),
					icon: "audit",
					isEnabled: settingsDashboardGates.auditLogs,
				},
			],
		},
		{
			key: "agent",
			label: "Agent policies",
			items: [
				{
					key: "settings-agent",
					label: "Agent",
					href: dash("/dashboard/settings/agent"),
					icon: "agent",
					isEnabled: settingsDashboardGates.agent,
				},
			],
		},
		{
			key: "deploy",
			label: "Deploy pipeline",
			items: [
				{
					key: "settings-git-providers",
					label: "Git providers",
					href: dash("/dashboard/settings/git-providers"),
					icon: "git",
					isEnabled: settingsDashboardGates.gitProviders,
				},
			],
		},
		{
			key: "operations",
			label: "Operations",
			items: [
				{
					key: "settings-traefik",
					label: "Traefik",
					href: dash("/dashboard/traefik"),
					icon: "traefik",
					isEnabled: settingsDashboardGates.traefik,
				},
			],
		},
		{
			key: "notifications",
			label: "Notifications",
			items: [
				{
					key: "settings-notifications",
					label: "Channels",
					href: dash("/dashboard/settings/notifications"),
					icon: "bell",
					isEnabled: settingsDashboardGates.notifications,
				},
			],
		},
	];

	return sections
		.map((section) => ({
			...section,
			items: section.items.filter((item) =>
				item.isEnabled ? item.isEnabled(ctx) : true,
			),
		}))
		.filter((section) => section.items.length > 0);
}

const SETTINGS_PATH_PREFIX = "/dashboard/settings";
const OPERATIONS_PATHS = [
	"/dashboard/about-nearzero",
	"/dashboard/monitoring",
	"/dashboard/traefik",
] as const;

const PATH_TO_SETTINGS_KEY: Array<{ prefix: string; key: string }> = [
	{ prefix: "/dashboard/settings/profile", key: "settings-profile" },
	{ prefix: "/dashboard/settings/users", key: "settings-teams" },
	{ prefix: "/dashboard/settings/git-providers", key: "settings-git-providers" },
	{ prefix: "/dashboard/settings/server", key: "settings-about-nearzero" },
	{ prefix: "/dashboard/settings/certificates", key: "settings-certificates" },
	{ prefix: "/dashboard/settings/dns", key: "settings-dns" },
	{ prefix: "/dashboard/about-nearzero", key: "settings-about-nearzero" },
	{ prefix: "/dashboard/monitoring", key: "settings-about-nearzero" },
	{ prefix: "/dashboard/traefik", key: "settings-traefik" },
	{ prefix: "/dashboard/settings/notifications", key: "settings-notifications" },
	{ prefix: "/dashboard/settings/audit-logs", key: "settings-audit-logs" },
	{ prefix: "/dashboard/settings/agent", key: "settings-agent" },
];

export function normalizeSettingsPathname(pathname: string) {
	return pathname.replace(/^\/[^/]+\/dashboard/, "/dashboard");
}

export function isSettingsAreaPath(pathname: string) {
	const path = normalizeSettingsPathname(pathname);
	if (path === SETTINGS_PATH_PREFIX || path.startsWith(`${SETTINGS_PATH_PREFIX}/`)) {
		return true;
	}
	return OPERATIONS_PATHS.some(
		(p) => path === p || path.startsWith(`${p}/`),
	);
}

export function findActiveSettingsKey(pathname: string): string {
	const path = normalizeSettingsPathname(pathname);
	if (path === SETTINGS_PATH_PREFIX || path === `${SETTINGS_PATH_PREFIX}/`) {
		return "settings-about-nearzero";
	}

	const sorted = [...PATH_TO_SETTINGS_KEY].sort(
		(a, b) => b.prefix.length - a.prefix.length,
	);
	for (const { prefix, key } of sorted) {
		if (path === prefix || path.startsWith(`${prefix}/`)) {
			return key;
		}
	}
	return "settings-home";
}

export function getSettingsPageTitle(key: string): string {
	const titles: Record<string, string> = {
		"settings-home": "Settings",
		"settings-profile": "Profile",
		"settings-git-providers": "Git providers",
		"settings-certificates": "Certificates",
		"settings-dns": "DNS",
		"settings-about-nearzero": "About Nearzero",
		"settings-traefik": "Traefik",
		"settings-notifications": "Notifications",
		"settings-teams": "Teams",
		"settings-users": "Teams",
		"settings-audit-logs": "Audit log",
		"settings-agent": "Agent policies",
	};
	return titles[key] ?? "Settings";
}
