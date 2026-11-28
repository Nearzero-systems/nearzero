import { type DatabaseKind, isDatabaseKind, type ServiceKind } from "@nearzero/shared";
import { applicationKind } from "./application.ts";
import type { KindModule } from "./common.ts";
import { composeKind } from "./compose.ts";
import { databaseKind } from "./database.ts";

export * from "./common.ts";

/** The module for each of the eight kinds; see common.ts for what a module does. */
const MODULES: Record<ServiceKind, KindModule> = {
  application: applicationKind,
  compose: composeKind,
  postgres: databaseKind("postgres"),
  mysql: databaseKind("mysql"),
  mariadb: databaseKind("mariadb"),
  mongodb: databaseKind("mongodb"),
  redis: databaseKind("redis"),
  libsql: databaseKind("libsql"),
};

export function kindModule(kind: ServiceKind): KindModule {
  return MODULES[kind];
}

export function isDatabase(kind: ServiceKind): kind is DatabaseKind {
  return isDatabaseKind(kind);
}
