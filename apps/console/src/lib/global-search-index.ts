import {
	createDashboardNavMenu,
	type NavContext,
	type NavLeaf,
	WORKSPACE_ITEMS,
	SETTINGS_ITEMS,
} from "@/components/dashboard/navMenu";
import { buildSettingsSections } from "@/lib/settings-nav";
import { pickAccessibleEnvironment } from "@/lib/pick-accessible-environment";
import { scopeDashboardHref } from "@/lib/org-routes";

export type GlobalSearchItem = {
	id: string;
	label: string;
	hint?: string;
	href: string;
	keywords?: string[];
	external?: boolean;
};

export type GlobalSearchProject = {
	projectId: string;
	name: string;
	description?: string | null;
	environments: Array<{
		environmentId: string;
		name?: string | null;
		isDefault?: boolean | null;
	}>;
};

function leafToItem(
	leaf: NavLeaf,
	ctx: NavContext,
	hint: string,
): GlobalSearchItem | null {
	if (leaf.isEnabled && !leaf.isEnabled(ctx)) return null;
	const href = leaf.external
		? leaf.href
		: scopeDashboardHref(leaf.href, ctx.orgSlug);
	return {
		id: `nav-${leaf.key}`,
		label: leaf.label,
		hint,
		href,
		keywords: [leaf.key, hint.toLowerCase()],
		external: leaf.external,
	};
}

function dedupeItems(items: GlobalSearchItem[]): GlobalSearchItem[] {
	const seen = new Set<string>();
	const output: GlobalSearchItem[] = [];
	for (const item of items) {
		const key = `${item.external ? "ext:" : ""}${item.href}`;
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(item);
	}
	return output;
}

export function buildGlobalSearchIndex(
	ctx: NavContext,
	extras?: { projects?: GlobalSearchProject[] },
): GlobalSearchItem[] {
	const menu = createDashboardNavMenu(ctx);
	const items: GlobalSearchItem[] = [];

	for (const leaf of WORKSPACE_ITEMS) {
		const item = leafToItem(leaf, ctx, "Workspace");
		if (item) items.push(item);
	}

	for (const leaf of menu.infrastructure) {
		const item = leafToItem(
			leaf,
			ctx,
			menu.infrastructureLabel ?? "Infrastructure",
		);
		if (item) items.push(item);
	}

	for (const section of buildSettingsSections(ctx)) {
		for (const leaf of section.items) {
			const item = leafToItem(leaf, ctx, section.label);
			if (item) items.push(item);
		}
	}

	for (const leaf of SETTINGS_ITEMS) {
		const item = leafToItem(leaf, ctx, "Settings");
		if (item) items.push(item);
	}

	for (const leaf of menu.help) {
		const item = leafToItem(leaf, ctx, "Help");
		if (item) items.push(item);
	}

	for (const project of extras?.projects ?? []) {
		const env = pickAccessibleEnvironment(
			project.environments.map((row) => ({
				environmentId: row.environmentId,
				name: row.name ?? "",
				isDefault: row.isDefault,
			})),
		);
		if (!env) continue;
		const href = scopeDashboardHref(
			`/dashboard/project/${project.projectId}/environment/${env.environmentId}/overview`,
			ctx.orgSlug,
		);
		items.push({
			id: `project-${project.projectId}`,
			label: project.name,
			hint: "Project",
			href,
			keywords: [
				project.projectId,
				project.description ?? "",
				env.name ?? "",
				"project",
			].filter(Boolean),
		});
	}

	items.push({
		id: "search-deployments",
		label: "Deployments",
		hint: "Search",
		href: scopeDashboardHref("/dashboard/deployments", ctx.orgSlug),
		keywords: ["deploy", "deployment", "history", "logs"],
	});

	return dedupeItems(items).sort((a, b) => a.label.localeCompare(b.label));
}

export function filterGlobalSearchItems(
	items: GlobalSearchItem[],
	query: string,
	limit = 12,
): GlobalSearchItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return items.slice(0, limit);

	const scored = items
		.map((item) => {
			const label = item.label.toLowerCase();
			const hint = (item.hint ?? "").toLowerCase();
			const keywords = (item.keywords ?? []).join(" ").toLowerCase();
			let score = 0;
			if (label === q) score = 100;
			else if (label.startsWith(q)) score = 80;
			else if (label.includes(q)) score = 65;
			else if (hint.includes(q)) score = 45;
			else if (keywords.includes(q)) score = 35;
			return { item, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));

	return scored.slice(0, limit).map((entry) => entry.item);
}
