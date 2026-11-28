import { createHash } from "node:crypto";
import {
  type CommandParams,
  DATABASE_DEFAULTS,
  type DatabaseKind,
  MONGO_REPLICA_SET,
} from "@nearzero/shared";

/**
 * How each of the six databases runs (spec 08 8.1, 8.2): its image's environment, command, data
 * folder, readiness check and port. Pure, so the rules are tested without a server.
 */

export interface DatabaseSettings {
  image: string;
  port: number;
  dataVolume: string;
  databaseName: string | null;
  user: string | null;
  replicaSet: boolean;
  nodeRole: "primary" | "replica";
  primaryUrl: string | null;
  namespaces: boolean;
}

export interface DatabaseSecrets {
  password: string;
  rootPassword?: string;
}

export function readDatabaseSettings(
  kind: DatabaseKind,
  settings: Record<string, unknown> | null,
  appName: string,
): DatabaseSettings {
  const raw = settings ?? {};
  const defaults = DATABASE_DEFAULTS[kind];
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return {
    image: text(raw.image) ?? defaults.image,
    port: typeof raw.port === "number" ? raw.port : defaults.port,
    dataVolume: text(raw.dataVolume) ?? `${appName}-data`,
    databaseName: text(raw.databaseName) ?? defaults.databaseName,
    user: text(raw.user) ?? defaults.user,
    replicaSet: raw.replicaSet === true,
    nodeRole: raw.nodeRole === "replica" ? "replica" : "primary",
    primaryUrl: text(raw.primaryUrl),
    namespaces: raw.namespaces === true,
  };
}

/** The major version in an image tag, like 18 in postgres:18 or 17 in pgvector/pgvector:pg17. */
export function imageMajor(image: string): number | null {
  const withoutDigest = image.split("@")[0] ?? image;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  if (colon <= slash) return null;
  const tag = withoutDigest.slice(colon + 1);
  const match = /^(?:pg)?(\d+)/.exec(tag);
  return match ? Number(match[1]) : null;
}

/** Where a database keeps its data inside its container. */
export function dataPath(kind: DatabaseKind, image: string): string {
  switch (kind) {
    case "postgres": {
      // Postgres 18 images keep a folder per major version under /var/lib/postgresql.
      const major = imageMajor(image);
      return major !== null && major < 18 ? "/var/lib/postgresql/data" : "/var/lib/postgresql";
    }
    case "mysql":
    case "mariadb":
      return "/var/lib/mysql";
    case "mongodb":
      return "/data/db";
    case "redis":
      return "/data";
    case "libsql":
      return "/var/lib/sqld";
  }
}

/** The key file a MongoDB replica set authenticates its members with, derived from the password. */
export function mongoKeyFile(password: string): string {
  return createHash("sha256").update(`nearzero mongo key file\n${password}`).digest("base64");
}

export const MONGO_KEY_FILE_PATH = "/etc/nearzero/mongo-keyfile";

export interface DatabaseContainer {
  env: Record<string, string>;
  command?: string[];
  files: NonNullable<CommandParams<"container.create">["files"]>;
  mountPath: string;
  /** Values to hide wherever they might be printed. */
  secrets: string[];
}

/**
 * How Redis starts (spec 29.5 "Data already in a database's volume is loaded"): with its own
 * append-only persistence, except when its volume holds a snapshot (dump.rdb) and no append-only
 * files, as a moved 0.1.x Redis's does (29a.9 `persistence`, Snapshot when missing). Then it
 * loads the snapshot first and turns append-only on from the loaded data, which writes the
 * append-only files; from the next start on it starts with them. The image's own entrypoint
 * still starts the server, so it runs as the image's user.
 */
export function redisStartScript(dataPath: string): string {
  const dir = `'${dataPath.replaceAll("'", "")}'`;
  return [
    `dir=${dir}`,
    'start() { if command -v docker-entrypoint.sh >/dev/null 2>&1; then exec docker-entrypoint.sh redis-server "$@"; fi; exec redis-server "$@"; }',
    'ask() { redis-cli -a "$NEARZERO_REDIS_PASSWORD" --no-auth-warning "$@"; }',
    'if [ -f "$dir/dump.rdb" ] && [ ! -e "$dir/appendonlydir" ] && [ ! -e "$dir/appendonly.aof" ]; then',
    "  ( until ask ping 2>/dev/null | grep -q PONG; do sleep 1; done; ask config set appendonly yes >/dev/null ) &",
    '  start --requirepass "$NEARZERO_REDIS_PASSWORD" --appendonly no',
    "fi",
    'start --requirepass "$NEARZERO_REDIS_PASSWORD" --appendonly yes',
  ].join("\n");
}

export function databaseContainer(
  kind: DatabaseKind,
  settings: DatabaseSettings,
  secrets: DatabaseSecrets,
): DatabaseContainer {
  const mountPath = dataPath(kind, settings.image);
  const hidden = [secrets.password, ...(secrets.rootPassword ? [secrets.rootPassword] : [])];
  switch (kind) {
    case "postgres":
      return {
        env: {
          POSTGRES_USER: settings.user ?? "postgres",
          POSTGRES_PASSWORD: secrets.password,
          POSTGRES_DB: settings.databaseName ?? "postgres",
        },
        files: [],
        mountPath,
        secrets: hidden,
      };
    case "mysql":
      return {
        env: {
          MYSQL_ROOT_PASSWORD: secrets.rootPassword ?? secrets.password,
          MYSQL_DATABASE: settings.databaseName ?? "app",
          MYSQL_USER: settings.user ?? "mysql",
          MYSQL_PASSWORD: secrets.password,
        },
        files: [],
        mountPath,
        secrets: hidden,
      };
    case "mariadb":
      return {
        env: {
          MARIADB_ROOT_PASSWORD: secrets.rootPassword ?? secrets.password,
          MARIADB_DATABASE: settings.databaseName ?? "mariadb",
          MARIADB_USER: settings.user ?? "mariadb",
          MARIADB_PASSWORD: secrets.password,
        },
        files: [],
        mountPath,
        secrets: hidden,
      };
    case "mongodb": {
      const env = {
        MONGO_INITDB_ROOT_USERNAME: settings.user ?? "mongo",
        MONGO_INITDB_ROOT_PASSWORD: secrets.password,
      };
      if (!settings.replicaSet) return { env, files: [], mountPath, secrets: hidden };
      const key = mongoKeyFile(secrets.password);
      return {
        env,
        command: [
          "mongod",
          "--replSet",
          MONGO_REPLICA_SET,
          "--keyFile",
          MONGO_KEY_FILE_PATH,
          "--bind_ip_all",
        ],
        // Owned by the image's mongodb user (999), readable only by it, as mongod requires.
        files: [
          {
            path: MONGO_KEY_FILE_PATH,
            content: Buffer.from(key).toString("base64"),
            mode: 0o400,
            uid: 999,
            gid: 999,
          },
        ],
        mountPath,
        secrets: [...hidden, key],
      };
    }
    case "redis":
      return {
        // The password reaches the script through the environment, never its text.
        env: { NEARZERO_REDIS_PASSWORD: secrets.password },
        command: ["sh", "-c", redisStartScript(mountPath)],
        files: [],
        mountPath,
        secrets: hidden,
      };
    case "libsql": {
      const env: Record<string, string> = {
        SQLD_NODE: settings.nodeRole,
        SQLD_HTTP_LISTEN_ADDR: `0.0.0.0:${settings.port}`,
        SQLD_HTTP_AUTH: `basic:${Buffer.from(`${settings.user ?? "libsql"}:${secrets.password}`).toString("base64")}`,
      };
      if (settings.nodeRole === "primary") env.SQLD_GRPC_LISTEN_ADDR = "0.0.0.0:5001";
      if (settings.nodeRole === "replica" && settings.primaryUrl) {
        env.SQLD_PRIMARY_URL = settings.primaryUrl;
      }
      if (settings.namespaces) env.SQLD_ENABLE_NAMESPACES = "true";
      return { env, files: [], mountPath, secrets: hidden };
    }
  }
}

/**
 * The command that says the database answers on its real server (not the temporary one image
 * entrypoints run while initializing, which listen only locally or not on TCP at all), or null
 * when running is enough.
 */
export function readinessCheck(
  kind: DatabaseKind,
  settings: DatabaseSettings,
  secrets: DatabaseSecrets,
): { command: string[]; env: Record<string, string> } | null {
  switch (kind) {
    case "postgres":
      return {
        command: [
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-p",
          String(settings.port),
          "-U",
          settings.user ?? "postgres",
          "-d",
          settings.databaseName ?? "postgres",
        ],
        env: {},
      };
    case "mysql":
      return {
        command: ["mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "--silent"],
        env: { MYSQL_PWD: secrets.rootPassword ?? secrets.password },
      };
    case "mariadb":
      return {
        command: ["mariadb-admin", "ping", "-h", "127.0.0.1", "-uroot", "--silent"],
        env: { MYSQL_PWD: secrets.rootPassword ?? secrets.password },
      };
    case "mongodb":
      // The initializing server listens on 127.0.0.1 only; the real one on the container's address.
      return {
        command: [
          "sh",
          "-c",
          'mongosh --quiet --host "$(hostname -i | cut -d" " -f1)" --eval "db.adminCommand({ ping: 1 }).ok"',
        ],
        env: {},
      };
    case "redis":
      return { command: ["redis-cli", "ping"], env: { REDISCLI_AUTH: secrets.password } };
    case "libsql":
      return null;
  }
}

/** Initializes a MongoDB replica set on its first start; does nothing once it is initialized. */
export function mongoReplicaSetInit(
  settings: DatabaseSettings,
  secrets: DatabaseSecrets,
  appName: string,
): { command: string[]; env: Record<string, string> } {
  const config = JSON.stringify({
    _id: MONGO_REPLICA_SET,
    members: [{ _id: 0, host: `${appName}:${settings.port}` }],
  });
  return {
    command: [
      "sh",
      "-c",
      `mongosh --quiet --host "$(hostname -i | cut -d" " -f1)" -u "$NZ_USER" -p "$NZ_PASSWORD" --authenticationDatabase admin --eval 'try { rs.status().ok } catch (e) { rs.initiate(${config}).ok }'`,
    ],
    env: { NZ_USER: settings.user ?? "mongo", NZ_PASSWORD: secrets.password },
  };
}
