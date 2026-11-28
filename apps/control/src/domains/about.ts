import {
  AppError,
  checkHostnameInput,
  duplicateHostnameMessage,
  isPublicIPv4,
  isWithin,
} from "@nearzero/shared";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { upsertRoute } from "../routing/routes.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { consoleAcmeEmail, consoleHostname, hostAddress } from "./addresses.ts";
import { loadSnapshots, pushCertificateContact } from "./certificates.ts";
import { dnsChecks } from "./hostnames.ts";
import { consoleRecord, publishZones, zoneChecklist } from "./zones.ts";

/**
 * The console's own address under About Nearzero (spec 18.2, 10.9): the public URL, the server
 * IP (instance administrators can correct it when detection was wrong), and Configure public
 * domain with "Save and request HTTPS".
 */

export const PORTS_NOTE = "Ports 80 and 443 must be open on this server for HTTPS.";

/** Route keys of the console's routes on the host, when set from here. */
const CONSOLE_ROUTE = "nearzero-console";
const CONSOLE_RUNNER_ROUTE = "nearzero-console-runner";

export type ConsoleAddressState = "ready" | "dns" | "https_pending" | "needs_setup";
const STATE_LABELS: Record<ConsoleAddressState, string> = {
  ready: "Ready",
  dns: "DNS",
  https_pending: "HTTPS pending",
  needs_setup: "Needs setup",
};

export async function aboutAddress(services: ControlServices, actor: WorkspaceActor) {
  const [hostname, ip, email] = await Promise.all([
    consoleHostname(services),
    hostAddress(services),
    consoleAcmeEmail(services),
  ]);
  const corrected = await services.db
    .selectFrom("address_setting")
    .select("value")
    .where("key", "=", "public_ipv4")
    .executeTakeFirst();
  let state: ConsoleAddressState = "needs_setup";
  let dnsMessage: string | null = null;
  if (hostname) {
    const check = await dnsChecks(services)
      .check(hostname, ip)
      .catch(() => null);
    dnsMessage = check?.message ?? null;
    if (check?.status !== "points_here") state = "dns";
    else {
      const snapshot = (await loadSnapshots(services, [HOST_TARGET])).get(HOST_TARGET);
      const now = Date.now();
      const valid = snapshot?.status?.certificates.some(
        (cert) => cert.names.includes(hostname) && cert.notAfter > now,
      );
      state = valid ? "ready" : "https_pending";
    }
  }
  const managedZone = await zoneChecklist(services, actor.workspace.id);
  const canConfigure = actor.access.can("console-domain.configure");
  return {
    consoleUrl: services.consoleUrl() ?? (hostname ? `https://${hostname}` : null),
    serverIp: {
      address: ip,
      corrected: corrected !== undefined,
      detected: services.runners.hostPublicIPv4,
      canCorrect: canConfigure,
    },
    platformDomain: services.domains.platformDomain,
    checklist: {
      consoleAddress: {
        state,
        label: STATE_LABELS[state],
        message: dnsMessage,
        link: "/dashboard/settings",
      },
      // The shape the console's checklist reads: a ready zone counts as ready (B3-03).
      managedZone,
    },
    publicDomain: {
      hostname,
      email,
      canConfigure,
      record: hostname ? { type: "A", name: hostname, value: ip } : null,
      note: PORTS_NOTE,
      changeNote: hostname
        ? "Changing the console's address needs the migration steps in the install guide."
        : null,
    },
  };
}

export async function correctServerIp(
  services: ControlServices,
  actor: WorkspaceActor,
  raw: string,
) {
  await actor.access.require("console-domain.configure");
  const ip = raw.trim();
  if (!isPublicIPv4(ip)) {
    const message =
      "Use this server's public IPv4 address, like 203.0.113.10. Private, shared, loopback and reserved addresses can't be reached from the internet.";
    throw new AppError("invalid_request", message, { fields: { ip: message } });
  }
  const previous = await hostAddress(services);
  await services.db
    .insertInto("address_setting")
    .values({ key: "public_ipv4", value: ip, updated_by: actor.personId })
    .onConflict((c) =>
      c
        .column("key")
        .doUpdateSet({ value: ip, updated_by: actor.personId, updated_at: new Date() }),
    )
    .execute();
  services.runners.hostPublicIPv4 = ip;
  // Records Nearzero manages that pointed at the old address follow it.
  if (previous && previous !== ip) {
    const changed = await services.db
      .updateTable("dns_record")
      .set({ value: ip, updated_at: new Date() })
      .where("managed", "=", true)
      .where("type", "=", "A")
      .where("value", "=", previous)
      .returning("zone_id")
      .execute();
    const zones = [...new Set(changed.map((row) => row.zone_id))];
    if (zones.length > 0) await publishZones(services, zones).catch(() => {});
  }
  // The host's runner hears the new address when it reconnects (its DNS checks use it).
  services.runners.disconnect(HOST_TARGET);
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "console.server-ip-corrected",
    workspaceId: actor.workspace.id,
    details: { ip, previous },
  });
  return {
    ...(await aboutAddress(services, actor)),
    message: `Saved. Nearzero now uses ${ip} for this server.`,
  };
}

export async function configurePublicDomain(
  services: ControlServices,
  actor: WorkspaceActor,
  input: { hostname: string; email: string },
) {
  await actor.access.require("console-domain.configure");
  const checked = checkHostnameInput(input.hostname);
  if (!checked.ok)
    throw new AppError("invalid_request", checked.message, {
      fields: { hostname: checked.message },
    });
  const host = checked.hostname;
  const current = await consoleHostname(services);
  if (current && current !== host) {
    const message = `The console already has the address ${current}. Changing it needs the migration steps in the install guide: run the install command again with NEARZERO_MANAGEMENT_HOSTNAME=${host} and NEARZERO_CONFIRM_ADDRESS_CHANGE=true once you've followed them.`;
    throw new AppError("conflict", message, { fields: { hostname: message } });
  }
  const used = await services.db
    .selectFrom("hostname")
    .select("id")
    .where("host", "=", host)
    .executeTakeFirst();
  if (used) {
    const message = duplicateHostnameMessage(host);
    throw new AppError("conflict", message, { fields: { hostname: message } });
  }
  // The installer's own console route serves a hostname chosen at install.
  if (host !== services.domains.managementHostname) {
    // The console's own requests stay out of Analytics (spec 13.1, R3-26).
    await upsertRoute(services, HOST_TARGET, {
      key: CONSOLE_ROUTE,
      hostnames: [host],
      upstream: { host: "nearzero-control", port: 4321 },
      certificate: "letsencrypt",
      accessLog: false,
    });
    await upsertRoute(services, HOST_TARGET, {
      key: CONSOLE_RUNNER_ROUTE,
      hostnames: [host],
      path: "/api/v1/runner/",
      upstream: { host: "nearzero-control", port: 3000 },
      certificate: "letsencrypt",
      accessLog: false,
    });
  }
  for (const [key, value] of [
    ["console_hostname", host],
    ["console_acme_email", input.email],
  ] as const) {
    await services.db
      .insertInto("address_setting")
      .values({ key, value, updated_by: actor.personId })
      .onConflict((c) =>
        c.column("key").doUpdateSet({ value, updated_by: actor.personId, updated_at: new Date() }),
      )
      .execute();
  }
  // A zone of the instance administrators that covers the new address gets its record (R3-12).
  const covering = await services.db
    .selectFrom("dns_zone")
    .select(["id", "name", "workspace_id"])
    .execute();
  for (const zone of covering.filter((item) => isWithin(host, item.name))) {
    const added = await consoleRecord(services, services.db, {
      id: zone.id,
      name: zone.name,
      workspaceId: zone.workspace_id,
    });
    if (added) await publishZones(services, [zone.id]).catch(() => {});
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "console.public-domain-configured",
    workspaceId: actor.workspace.id,
    details: { hostname: host },
  });
  // The certificate email is the one every router uses for new certificates (spec 10.1); routers
  // connecting later get it when they connect.
  void pushCertificateContact(services).catch(() => {});
  const ip = await hostAddress(services);
  return {
    ...(await aboutAddress(services, actor)),
    message: `Saved. Add the record ${host} A ${ip ?? "<this server's public IPv4>"}; HTTPS starts once it points here. ${PORTS_NOTE}`,
  };
}
