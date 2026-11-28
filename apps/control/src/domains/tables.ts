import type { ColumnType, Generated } from "kysely";

/**
 * Types for the domain tables of migration 0250 (spec 10). They are added to the control plane's
 * `Database` type here, beside the area that owns them, so other areas' table lists stay apart.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;
type Id = Generated<string>;
type Json = ColumnType<unknown, string | null | undefined, string | null>;

export type HostnameSourceColumn = "platform" | "server" | "zone" | "own";

export interface DnsZoneTable {
  id: Id;
  workspace_id: string;
  name: string;
  admin_email: string;
  nameservers: string[];
  /** bigint columns come back as strings from node-postgres. */
  serial: ColumnType<string, number | string | undefined, number | string>;
  applied_serial: ColumnType<
    string | null,
    number | string | null | undefined,
    number | string | null
  >;
  applied_content: string | null;
  applied_at: Date | null;
  apply_error: string | null;
  auto_apply: ColumnType<boolean, boolean | undefined, boolean>;
  health: Json;
  health_checked_at: Date | null;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface HostnameTable {
  id: Id;
  workspace_id: string;
  host: string;
  source: HostnameSourceColumn;
  zone_id: string | null;
  automatic: ColumnType<boolean, boolean | undefined, boolean>;
  service_id: string | null;
  compose_service: string | null;
  port: number | null;
  path: ColumnType<string, string | undefined, string>;
  target: string;
  route_key: string | null;
  dns: Json;
  dns_checked_at: Date | null;
  last_attempt_at: Date | null;
  replace_on_deploy: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface DnsRecordTable {
  id: Id;
  zone_id: string;
  name: string;
  type: "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "CAA" | "NS";
  value: string;
  ttl: ColumnType<number, number | undefined, number>;
  priority: number | null;
  managed: ColumnType<boolean, boolean | undefined, boolean>;
  hostname_id: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface EnvironmentHostnameDefaultTable {
  environment_id: string;
  workspace_id: string;
  source: "platform" | "none" | "zone";
  zone_id: string | null;
  prefix: ColumnType<string, string | undefined, string>;
  updated_by: string | null;
  updated_at: DbTime;
}

export interface ServiceHostnameStateTable {
  service_id: string;
  automatic_declined: ColumnType<boolean, boolean | undefined, boolean>;
  updated_at: DbTime;
}

export interface UploadedCertificateTable {
  id: Id;
  workspace_id: string;
  name: string;
  target: string;
  certificate_pem: string;
  key_sealed: string;
  names: string[];
  not_before: Date;
  not_after: Date;
  issuer: string;
  fingerprint: string;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface CertificateSnapshotTable {
  target: string;
  status: Json;
  error: string | null;
  read_at: DbTime;
}

export interface AddressSettingTable {
  key: "public_ipv4" | "console_hostname" | "console_acme_email";
  value: string;
  updated_by: string | null;
  updated_at: DbTime;
}

declare module "../db/schema.ts" {
  interface Database {
    dns_zone: DnsZoneTable;
    hostname: HostnameTable;
    dns_record: DnsRecordTable;
    environment_hostname_default: EnvironmentHostnameDefaultTable;
    service_hostname_state: ServiceHostnameStateTable;
    uploaded_certificate: UploadedCertificateTable;
    certificate_snapshot: CertificateSnapshotTable;
    address_setting: AddressSettingTable;
  }
}
