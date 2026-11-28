import { DATABASE_DEFAULTS, type DatabaseKind } from "@nearzero/shared";
import { type KindModule, parseCreateInput, pick, type Secrets, type Settings } from "./common.ts";

/**
 * The six databases (spec 08 8.1). Settings: image, database name and user (where the type has
 * them), the data volume, and the creation-only choices (MongoDB replica set; libSQL node role,
 * primary URL and namespaces). Secrets: the password and, for MySQL and MariaDB, the root
 * password; generated (24 letters and digits) when left empty. A copy keeps the settings and gets
 * its own volume and its own passwords.
 *
 * The public port is not a setting: it is a column of the service, unique per server.
 */

const PUBLIC_KEYS = [
  "image",
  "databaseName",
  "user",
  "port",
  "dataVolume",
  "replicaSet",
  "nodeRole",
  "primaryUrl",
  "namespaces",
] as const;

interface DatabaseInput {
  image: string;
  databaseName?: string;
  user?: string;
  password: string;
  rootPassword?: string;
  replicaSet?: boolean;
  nodeRole?: "primary" | "replica";
  primaryUrl?: string;
  namespaces?: boolean;
}

export function dataVolumeName(appName: string): string {
  return `${appName}-data`;
}

export function databaseKind(kind: DatabaseKind): KindModule {
  const defaults = DATABASE_DEFAULTS[kind];

  const secretsFor = (
    given: { password?: string; rootPassword?: string },
    generate: () => string,
  ): Secrets => {
    const secrets: Secrets = { password: given.password || generate() };
    if (defaults.hasRootPassword) secrets.rootPassword = given.rootPassword || generate();
    return secrets;
  };

  return {
    kind,
    database: true,
    create(raw, context) {
      const input = parseCreateInput(kind, raw) as unknown as DatabaseInput;
      const settings: Settings = {
        image: input.image || defaults.image,
        port: defaults.port,
        dataVolume: dataVolumeName(context.appName),
      };
      if (defaults.databaseName !== null) {
        settings.databaseName = input.databaseName || defaults.databaseName;
      }
      if (defaults.user !== null) settings.user = input.user || defaults.user;
      if (kind === "mongodb") settings.replicaSet = input.replicaSet ?? false;
      if (kind === "libsql") {
        settings.nodeRole = input.nodeRole ?? "primary";
        settings.primaryUrl = settings.nodeRole === "replica" ? (input.primaryUrl ?? "") : null;
        settings.namespaces = input.namespaces ?? false;
      }
      return { settings, secrets: secretsFor(input, context.generatePassword) };
    },
    copy(settings, context) {
      return {
        settings: { ...pick(settings, PUBLIC_KEYS), dataVolume: dataVolumeName(context.appName) },
        secrets: secretsFor({}, context.generatePassword),
      };
    },
    update(settings, raw) {
      const input = raw as { image?: string };
      if (input.image === undefined || input.image === settings.image) {
        return { settings, notes: [] };
      }
      return {
        settings: { ...settings, image: input.image || defaults.image },
        notes: [
          "Saved. The new image is used on the next deploy. A major version change may need a manual upgrade of the data first.",
        ],
      };
    },
    publicSettings(settings) {
      return pick(settings, PUBLIC_KEYS);
    },
  };
}
