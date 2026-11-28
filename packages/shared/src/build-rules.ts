/**
 * How a service's variables reach its build (spec 23.4, 05 5.5, 30b R2-05). A value is a secret
 * unless its name says it is meant to be public: then it may be a build argument and end up in
 * the built image, the way frameworks bake such values into the browser bundle. Every other value
 * reaches a build only as a build secret, never on a command line or in the image.
 */

/** Prefixes frameworks use for values meant for the browser, and builder settings. */
export const PUBLIC_BUILD_PREFIXES = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "REACT_APP_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "GATSBY_",
  "VUE_APP_",
  "STORYBOOK_",
  "NIXPACKS_",
  "RAILPACK_",
  "BP_",
] as const;

/** Names that are settings, not secrets. */
export const PUBLIC_BUILD_NAMES = ["PORT", "NODE_ENV", "CI"] as const;

export function isPublicBuildVariable(name: string): boolean {
  return (
    (PUBLIC_BUILD_NAMES as readonly string[]).includes(name) ||
    PUBLIC_BUILD_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Names a build tool's own process never takes from a service: they steer the tool, the Docker
 * CLI or the system's loader (which runs as root on the server), not the build. Such a variable
 * still reaches Dockerfile and Nixpacks builds as a build secret.
 */
const TOOL_NAMES = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "IFS",
  "TMPDIR",
  "PWD",
  "OLDPWD",
  "USER",
  "LOGNAME",
  "HOSTNAME",
]);
const TOOL_PREFIXES = [
  "LD_",
  "DYLD_",
  "DOCKER_",
  "BUILDKIT_",
  "BUILDX_",
  "COMPOSE_",
  "NEARZERO_",
  "XDG_",
  "GIT_",
  "SSH_",
  "SSL_",
];

export function isBuildToolName(name: string): boolean {
  return TOOL_NAMES.has(name) || TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The component label of a service's build cache volumes (spec 3.3, 23.1; B2-22). */
export const BUILD_CACHE_COMPONENT = "build-cache";
