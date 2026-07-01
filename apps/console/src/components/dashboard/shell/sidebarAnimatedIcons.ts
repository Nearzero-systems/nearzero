export const SIDEBAR_ANIMATED_ICON_NAMES = [
	"projects",
	"deployments",
	"schedules",
	"tasks",
	"requests",
	"analytics",
	"server",
	"domains",
	"cluster",
] as const;

export type SidebarAnimatedIconName =
	(typeof SIDEBAR_ANIMATED_ICON_NAMES)[number];

export function isSidebarAnimatedIcon(
	name: string,
): name is SidebarAnimatedIconName {
	return (SIDEBAR_ANIMATED_ICON_NAMES as readonly string[]).includes(name);
}
