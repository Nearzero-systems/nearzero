import { capSlug, slugify } from "./slugs.ts";

/**
 * Projects, environments and services without the request schemas: names, kinds, defaults and
 * the rules forms check as people type (spec 02, spec 05, spec 06 6.1, spec 08 8.1). This file
 * imports nothing heavy, so browser code can use it through "@nearzero/shared/browser";
 * projects.ts re-exports it next to the zod schemas built on it.
 */

export const PROJECT_NAME_MAX = 100;
export const SERVICE_NAME_MAX = 100;
export const DESCRIPTION_MAX = 1000;
export const ENVIRONMENT_NAME_MAX = 32;
export const DEFAULT_ENVIRONMENT_NAME = "development";
export const PRODUCTION_ENVIRONMENT_NAME = "production";

/** The Nearzero host as a server target: always there, never a row in the servers list. */
export const HOST_SERVER_ID = "host";

export const SERVICE_KINDS = [
  "application",
  "compose",
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
  "redis",
  "libsql",
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const DATABASE_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
  "redis",
  "libsql",
] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

export function isDatabaseKind(kind: string): kind is DatabaseKind {
  return (DATABASE_KINDS as readonly string[]).includes(kind);
}

/** The original's type names, the same on every page (spec 21.10 Wording; B3-21). */
export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  application: "Application",
  compose: "Compose",
  postgres: "Postgres",
  mysql: "Mysql",
  mariadb: "Mariadb",
  mongodb: "Mongo",
  redis: "Redis",
  libsql: "LibSQL",
};

/**
 * Where a service is in its life. "idle" is a service that was never deployed (every new copy
 * starts there); deploys move it between the others.
 */
export const SERVICE_STATUSES = ["idle", "deploying", "running", "stopped", "failed"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const PROJECT_SORTS = [
  "name-asc",
  "name-desc",
  "newest",
  "oldest",
  "most-services",
  "least-services",
] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];
export const DEFAULT_PROJECT_SORT: ProjectSort = "newest";

export const PROJECT_SORT_LABELS: Record<ProjectSort, string> = {
  "name-asc": "Name (A-Z)",
  "name-desc": "Name (Z-A)",
  newest: "Newest first",
  oldest: "Oldest first",
  "most-services": "Most services",
  "least-services": "Least services",
};

// ---- Environment names (spec 05 5.3)

/** Trimmed and lowercased; spaces and underscores become dashes; repeated dashes collapse. */
export function normalizeEnvironmentName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isProductionEnvironment(name: string): boolean {
  return name === PRODUCTION_ENVIRONMENT_NAME;
}

export const ENVIRONMENT_NAME_RULE = "Use letters, numbers and dashes, like staging or qa-2.";
export const ENVIRONMENT_NAME_PROD =
  'Name it "production" instead, so Nearzero treats it as production (the badge and the Agent\'s production gate).';

/** The problem with a name after {@link normalizeEnvironmentName}, or null when it is fine. */
export function environmentNameProblem(name: string): string | null {
  if (name === "") return "Enter a name for the environment.";
  if (name.length > ENVIRONMENT_NAME_MAX) {
    return `Use at most ${ENVIRONMENT_NAME_MAX} characters.`;
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return ENVIRONMENT_NAME_RULE;
  if (name === "prod" || name === "prd") return ENVIRONMENT_NAME_PROD;
  return null;
}

export function duplicateEnvironmentMessage(name: string): string {
  return `This project already has an environment called "${name}".`;
}

/** The live hint under the name field: what it will be called, or what's wrong. */
export function environmentNameHint(input: string): { name: string; ok: boolean; message: string } {
  const name = normalizeEnvironmentName(input);
  const problem = environmentNameProblem(name);
  if (problem) return { name, ok: false, message: problem };
  if (isProductionEnvironment(name)) {
    return { name, ok: true, message: "This is your production environment." };
  }
  if (name !== input) return { name, ok: true, message: `It will be called ${name}.` };
  return { name, ok: true, message: "Looks good." };
}

// ---- App names (spec 06 6.1)

/** The part a person chooses; a dash and 6 random characters are added to make it unique. */
export const APP_NAME_BASE_MAX = 50;
export const APP_NAME_SUFFIX_LENGTH = 6;
export const APP_NAME_RULE =
  "Use lowercase letters, numbers and single dashes, starting with a letter and ending with a letter or number.";

const APP_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function appNameProblem(base: string): string | null {
  if (base === "") return "Enter an app name.";
  if (base.length > APP_NAME_BASE_MAX) return `Use at most ${APP_NAME_BASE_MAX} characters.`;
  if (!APP_NAME_PATTERN.test(base)) return APP_NAME_RULE;
  return null;
}

/** The app name the form starts with: from the project's name and the service's. */
export function suggestAppNameBase(projectName: string, serviceName: string): string {
  const project = slugify(projectName);
  const service = slugify(serviceName);
  let base =
    project && service && project !== service ? `${project}-${service}` : project || service;
  if (!/^[a-z]/.test(base)) base = base ? `app-${base}` : "app";
  return capSlug(base, APP_NAME_BASE_MAX);
}

// ---- Databases (spec 08 8.1)

export interface DatabaseDefaults {
  image: string;
  /** null where the type has no database name or no user. */
  databaseName: string | null;
  user: string | null;
  /** The type's standard port inside its container. */
  port: number;
  hasRootPassword: boolean;
}

/**
 * The newest stable major of each at release time, the same for the console and the Agent.
 * libSQL is pinned to one server release.
 */
export const DATABASE_DEFAULTS: Record<DatabaseKind, DatabaseDefaults> = {
  postgres: {
    image: "postgres:18",
    databaseName: "postgres",
    user: "postgres",
    port: 5432,
    hasRootPassword: false,
  },
  mysql: {
    image: "mysql:8",
    // MySQL's own "mysql" schema is a system schema, so apps get their own (spec 08 8.1).
    databaseName: "app",
    user: "mysql",
    port: 3306,
    hasRootPassword: true,
  },
  mariadb: {
    image: "mariadb:11",
    databaseName: "mariadb",
    user: "mariadb",
    port: 3306,
    hasRootPassword: true,
  },
  mongodb: {
    image: "mongo:8",
    databaseName: null,
    user: "mongo",
    port: 27017,
    hasRootPassword: false,
  },
  redis: { image: "redis:8", databaseName: null, user: null, port: 6379, hasRootPassword: false },
  libsql: {
    image: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
    databaseName: null,
    user: "libsql",
    port: 8080,
    hasRootPassword: false,
  },
};

/** Public ports are chosen from this range, unique per server (spec 08 8.1). */
export const PUBLIC_PORT_RANGE = { first: 20000, last: 29999 } as const;

export const GENERATED_PASSWORD_LENGTH = 24;
export const DATABASE_PASSWORD_MIN = 8;
export const DATABASE_PASSWORD_MAX = 128;
const PASSWORD_FORBIDDEN = /[$!'"\\/\s]/;

/** A typed password may not contain `$ ! ' " \ /` or spaces. */
export function databasePasswordProblem(password: string): string | null {
  if (PASSWORD_FORBIDDEN.test(password)) {
    return "Leave out $ ! ' \" \\ / and spaces: they break connection strings.";
  }
  if (password.length < DATABASE_PASSWORD_MIN || password.length > DATABASE_PASSWORD_MAX) {
    return `Use ${DATABASE_PASSWORD_MIN} to ${DATABASE_PASSWORD_MAX} characters, or leave it empty to generate one.`;
  }
  return null;
}
