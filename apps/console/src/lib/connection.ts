import { DATABASE_DEFAULTS, type DatabaseKind } from "@nearzero/shared/browser";
import type { ServiceKind } from "./data/types.ts";

/**
 * A database's connection URLs (spec 08 8.2): the internal URL for apps on the same server (the
 * container's internal name and the type's standard port) and the public URL from anywhere (the
 * server's address and the database's public port). Credentials are percent-encoded. MongoDB
 * authenticates against "admin"; a replica set names "rs0" from inside and connects directly from
 * outside. Every URL can be drawn with the password masked.
 */

export const MASK = "••••••••";

export interface ConnectionParts {
  kind: ServiceKind;
  user: string | null;
  password: string;
  databaseName: string | null;
  host: string;
  port: number;
  replicaSet?: boolean;
}

export type ConnectionScope = "internal" | "public";

/** Percent-encodes a user name or password for the authority part of a URL. */
export function encodeCredential(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function credentials(user: string, password: string, mask: boolean): string {
  return `${encodeCredential(user)}:${mask ? MASK : encodeCredential(password)}`;
}

export function connectionUrl(
  parts: ConnectionParts,
  scope: ConnectionScope,
  options: { mask?: boolean } = {},
): string {
  const mask = options.mask ?? false;
  const where = `${parts.host}:${parts.port}`;
  const user = parts.user ?? "";
  // A database name the answer leaves out is the type's own default (MySQL's is "app": its
  // "mysql" schema belongs to the server, spec 08 8.1).
  const database = () =>
    encodeURIComponent(
      parts.databaseName ?? DATABASE_DEFAULTS[parts.kind as DatabaseKind]?.databaseName ?? "",
    );
  switch (parts.kind) {
    case "postgres":
      return `postgresql://${credentials(user, parts.password, mask)}@${where}/${database()}`;
    case "mysql":
    case "mariadb":
      return `mysql://${credentials(user, parts.password, mask)}@${where}/${database()}`;
    case "mongodb": {
      const extra = parts.replicaSet
        ? scope === "internal"
          ? "&replicaSet=rs0"
          : "&directConnection=true"
        : "";
      return `mongodb://${credentials(user, parts.password, mask)}@${where}/?authSource=admin${extra}`;
    }
    case "redis":
      return `redis://${credentials("default", parts.password, mask)}@${where}`;
    case "libsql":
      return `http://${credentials(user, parts.password, mask)}@${where}`;
    default:
      return "";
  }
}

/** The firewall and address hints under the public URL (spec 08 8.2). */
export function publicHint(input: {
  publicPort: number | null;
  publicPortNote: string | null;
  addressKnown: boolean;
}): string {
  if (input.publicPort === null) {
    return input.publicPortNote ?? "Not reachable from outside this server.";
  }
  if (!input.addressKnown) {
    return `Port ${input.publicPort} on this database's server. Nearzero doesn't know that server's public address, so use its IP with port ${input.publicPort}.`;
  }
  return `If it doesn't connect, allow inbound TCP ${input.publicPort} in the server's firewall or cloud security group.`;
}

/** Stands in for a server address the console doesn't know. */
export const UNKNOWN_ADDRESS = "SERVER_IP";
