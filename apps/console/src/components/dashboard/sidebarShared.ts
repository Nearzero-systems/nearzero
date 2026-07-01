import { findActiveNavKey } from "./navMenu";

export type { NavItem } from "./navMenu";
export {
	allNavLeaves,
	createDashboardNavMenu,
	findActiveNavKey,
	helpNavItems,
	mainNavItems,
	settingsNavItems,
} from "./navMenu";

export function getActiveDashboardSection(pathname: string, section: string) {
	return findActiveNavKey(pathname, section);
}

export const navItemClass = (isActive: boolean) =>
	`nz-nav-item ${isActive ? "nz-nav-item--active" : ""} group flex items-center gap-3 rounded-md px-2 py-1 text-xs transition-colors ${
		isActive
			? "bg-[var(--nz-bg-hover)] text-[var(--nz-text)]"
			: "bg-transparent text-[var(--nz-text-muted)] hover:bg-[var(--nz-bg-hover)] hover:text-[var(--nz-text)]"
	}`;

export const navSectionLabelClass =
	"px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--nz-text-subtle)]";
