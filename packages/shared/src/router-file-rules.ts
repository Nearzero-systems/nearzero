/**
 * Settings → Router files (spec 18.3): which files in a router's folder people may edit, and the
 * words the editor uses. Shared by the control plane, the runner (which writes the files) and the
 * console. Browser-safe: no imports.
 */

/** The largest router file the editor reads or saves. */
export const ROUTER_FILE_MAX_BYTES = 256 * 1024;

/**
 * A router file's name: directly in the router's folder (no folders, nothing hidden), YAML.
 * Traefik's file provider reads every .yml/.yaml/.toml file in the folder; the editor writes YAML.
 */
export const ROUTER_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;

/** Files the runner writes and rewrites: routes, the shared middlewares, uploaded certificates. */
export function isManagedRouterFile(name: string): boolean {
  return name.startsWith("route-") || name.startsWith("nearzero-");
}

/**
 * The router's main settings (R3-23): entry points, certificate resolvers and global options, as
 * Nearzero passes them when it starts the router. Shown read-only beside the folder's files under
 * this name, which is never a file in the folder, and refused when saved.
 */
export const ROUTER_MAIN_SETTINGS = {
  name: "main-settings",
  title: "Main settings",
  note: "Nearzero sets these when it starts the router, so they can't be edited here.",
} as const;

/** Why `name` can't be saved, or null when it can. */
export function routerFileNameProblem(name: string): string | null {
  if (name === ROUTER_MAIN_SETTINGS.name) return ROUTER_MAIN_SETTINGS.note;
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) {
    return "Router files live directly in the router's folder. Paths outside it are refused.";
  }
  if (!ROUTER_FILE_NAME.test(name)) {
    return "Use a file name of letters, digits, dots, dashes or underscores ending in .yml or .yaml.";
  }
  if (isManagedRouterFile(name)) return ROUTER_FILE_MESSAGES.managed;
  return null;
}

export const ROUTER_FILE_MESSAGES = {
  warning:
    "Adding invalid configuration to existing files can break your router, and every app and hostname behind it with it. Nearzero checks each file before saving it.",
  managed: "Managed by Nearzero; changes are overwritten on the next deploy.",
  saved: "Router config updated",
  toml: "TOML files are shown read-only. Edit router configuration in YAML files.",
  empty: "The router's folder has no configuration files yet.",
} as const;
