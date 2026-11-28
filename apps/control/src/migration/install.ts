import { LEGACY_SETTING_ALIASES } from "@nearzero/shared";
import type { z } from "zod";
import type { Db } from "../db/database.ts";
import type { ControlServices } from "../services.ts";
import { dataModeNamed, registrationModeNamed } from "./labels.ts";
import type { installSchema } from "./records.ts";
import type { ImportReport } from "./report.ts";

/**
 * The install's own settings from the bundle (install.json, spec 29a.5.22), and the 0.1.x setting
 * names 1.0 renamed (spec 29.5, "Old install settings"; spec 03 3.1: every 0.1.x name keeps
 * working). The installer reads the old settings file itself and writes the 1.0 names; the import
 * compares what the bundle says with this install and writes what lives in the database.
 */

type InstallSettings = z.infer<typeof installSchema>;

/**
 * 0.1.x setting names 1.0 reads under a 1.0 name, old name to new (spec 03 3.5). The installer
 * keeps the same table (NZ_SETTING_ALIASES in installer/install.sh).
 */
export const SETTING_RENAMES: Readonly<Record<string, string>> = LEGACY_SETTING_ALIASES;

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Writes the database parts of install.json (29a.5.22) and adds its report lines. */
export async function importInstallSettings(
  db: Db,
  services: ControlServices,
  install: InstallSettings,
  report: ImportReport,
): Promise<void> {
  const say = (message: string) =>
    report.install.push({ kind: "install", name: "install", message });
  const domains = services.domains;

  if (install.platformDomain && !same(install.platformDomain, domains.platformDomain)) {
    say(
      domains.platformDomain
        ? `The 0.1.x install gave apps addresses under ${install.platformDomain}; this one uses ${domains.platformDomain}. Hostnames already under ${install.platformDomain} are kept.`
        : `The 0.1.x install gave apps addresses under ${install.platformDomain}, and this install has no domain yet. Hostnames already under it are kept; to give new apps addresses there, run the install command again with NEARZERO_PLATFORM_DOMAIN=${install.platformDomain}.`,
    );
  }
  if (install.platformDomainSharedEdge) {
    report.dropped.push({
      kind: "install",
      name: "install",
      message:
        "The shared edge for the platform domain isn't in 1.0 (spec 27): each server serves its own apps under its own label.",
    });
  }
  if (install.consoleHostname && !same(install.consoleHostname, domains.managementHostname)) {
    say(
      `The 0.1.x console was at ${install.consoleHostname}; this one is at ${domains.managementHostname ?? "this server's IP address"}. To keep the old address, run the install command again with NEARZERO_MANAGEMENT_HOSTNAME=${install.consoleHostname}.`,
    );
  }
  const zone = install.managedZone?.domain;
  if (zone && !same(zone, domains.managedZone)) {
    say(
      `The 0.1.x install served the DNS zone ${zone} itself. Its records were imported; to serve it from this install, run the install command again with NEARZERO_MANAGED_DNS_ZONE=${zone}.`,
    );
  }
  if (dataModeNamed(install.dataMode) === "external") {
    say(
      "The 0.1.x install kept its data in an external database. 1.0 keeps its own data where its install command chose; the old database is left untouched.",
    );
  }
  if (registrationModeNamed(install.registrationMode) === "open") {
    say(
      "Open sign-up isn't offered for self-hosted installs; people join by invitation (spec 04 4.2).",
    );
  }
  if (install.publicIp) {
    const row = await db
      .selectFrom("address_setting")
      .select("value")
      .where("key", "=", "public_ipv4")
      .executeTakeFirst();
    const current = row?.value ?? services.runners.hostPublicIPv4;
    if (current && !same(current, install.publicIp)) {
      say(
        `The 0.1.x install's public address was ${install.publicIp}; this server's is ${current}. Records Nearzero manages point at ${current}; update records you manage yourself.`,
      );
    }
  }
  if (install.letsEncryptEmail && !domains.acmeEmail) {
    await db
      .insertInto("address_setting")
      .values({ key: "console_acme_email", value: install.letsEncryptEmail })
      .onConflict((conflict) => conflict.column("key").doNothing())
      .execute();
  }
  if (typeof install.analytics?.requestLogging === "boolean") {
    await db
      .updateTable("analytics_setting")
      .set({ enabled: install.analytics.requestLogging })
      .where("id", "=", true)
      .execute();
  }
  const thresholds = install.monitoring?.thresholds;
  const cpu = threshold(thresholds?.cpuPercent);
  const memory = threshold(thresholds?.memoryPercent);
  if (cpu !== null || memory !== null) {
    await db
      .insertInto("server_alert_setting")
      .values({ target: "host", cpu_threshold: cpu, memory_threshold: memory })
      .onConflict((conflict) =>
        conflict.column("target").doUpdateSet({ cpu_threshold: cpu, memory_threshold: memory }),
      )
      .execute();
  }
  if (typeof install.hostDailyCleanup === "boolean") {
    await db
      .insertInto("docker_cleanup")
      .values({ target: "host", enabled: install.hostDailyCleanup })
      .onConflict((conflict) =>
        conflict.column("target").doUpdateSet({ enabled: install.hostDailyCleanup ?? null }),
      )
      .execute();
  }
  if (install.monitoring?.retentionDays) {
    say(
      `The 0.1.x install kept metrics for ${install.monitoring.retentionDays} days. 1.0 reads that from NEARZERO_METRICS_RETENTION_DAYS, which the installer carries over.`,
    );
  }
}

/** An alert threshold in percent; 0 or anything outside 1–100 means off (29a.5.7). */
export function threshold(value: number | null | undefined): number | null {
  return typeof value === "number" && value >= 1 && value <= 100 ? Math.round(value) : null;
}
