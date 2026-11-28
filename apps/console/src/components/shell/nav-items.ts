import type { IconName } from "../../lib/icons.ts";
import { agentPath, dashboardPath, projectsPath } from "../../lib/routes.ts";

export type NavKey =
  | "agent"
  | "projects"
  | "deployments"
  | "tasks"
  | "analytics"
  | "servers"
  | "domains"
  | "settings"
  | "profile";

export interface NavLink {
  key: NavKey;
  label: string;
  icon: IconName;
  href: string;
}

/**
 * The sidebar's order (spec 21.6, 21.10): no Documentation or Support links here; they are in
 * the user menu. Items the person can't use are left out.
 */
export function navGroups(workspace: string, options: { analytics: boolean; tasks?: boolean }) {
  const main: NavLink[] = [
    { key: "agent", label: "Agent", icon: "agent", href: agentPath(workspace) },
    { key: "projects", label: "Projects", icon: "projects", href: projectsPath(workspace) },
    {
      key: "deployments",
      label: "Deployments",
      icon: "deployments",
      href: dashboardPath(workspace, "deployments"),
    },
  ];
  // Only for people with somewhere to run a task (spec 12.1, 24 G8, R3-31).
  if (options.tasks !== false) {
    main.push({
      key: "tasks",
      label: "Tasks",
      icon: "tasks",
      href: dashboardPath(workspace, "tasks"),
    });
  }
  if (options.analytics) {
    main.push({
      key: "analytics",
      label: "Analytics",
      icon: "analytics",
      href: dashboardPath(workspace, "analytics"),
    });
  }
  const infrastructure: NavLink[] = [
    {
      key: "servers",
      label: "Servers",
      icon: "servers",
      href: dashboardPath(workspace, "servers"),
    },
    {
      key: "domains",
      label: "Domains",
      icon: "domains",
      href: dashboardPath(workspace, "domains"),
    },
  ];
  return { main, infrastructure };
}
