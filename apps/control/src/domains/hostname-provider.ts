import type {
  HostnameRequest as HostnameProviderInput,
  HostnameAnswer as HostnameProviderResult,
  HostnameRoute,
} from "../deploys/hostnames.ts";
import type { ControlServices } from "../services.ts";
import { describeTarget, type TargetInfo, wildcardRecord } from "./addresses.ts";
import { checkWildcard } from "./cards.ts";
import {
  assignAutomatic,
  automaticBase,
  composeServicesOf,
  dnsChecks,
  dropRoute,
  HOSTNAME_COLUMNS,
  type HostnameRow,
  loadServices,
  matchesBase,
  removeRow,
  type ServiceInfo,
} from "./hostnames.ts";
import { publishZones } from "./zones.ts";

/**
 * What the domains area tells every deploy (spec 10.2, 06 6.5): the routes of all the service's
 * hostnames, after giving it an automatic hostname when it has none (the platform domain on the
 * host, <random>.<server label>.<platform domain> elsewhere, or a name in the environment's
 * zone), and log lines naming any DNS record that is still missing. Hostnames are assigned and
 * routed before their record exists; certificates wait for DNS.
 */

export function registerDomainHostnames(services: ControlServices): void {
  services.hostnameProviders.register("domains", (input) => hostnamesForDeploy(services, input));
}

async function rowsOf(services: ControlServices, serviceId: string): Promise<HostnameRow[]> {
  return (await services.db
    .selectFrom("hostname")
    .select(HOSTNAME_COLUMNS)
    .where("service_id", "=", serviceId)
    .orderBy("created_at")
    .execute()) as HostnameRow[];
}

/** A service that moved to another server takes its hostnames along. */
async function followService(
  services: ControlServices,
  rows: HostnameRow[],
  target: TargetInfo,
): Promise<void> {
  for (const row of rows) {
    if (row.target === target.id) continue;
    if (row.route_key) await dropRoute(services, row.target, row.route_key).catch(() => {});
    await services.db
      .updateTable("hostname")
      .set({ target: target.id, updated_at: new Date() })
      .where("id", "=", row.id)
      .execute();
    if (row.zone_id && target.ipv4) {
      await services.db
        .updateTable("dns_record")
        .set({ value: target.ipv4, updated_at: new Date() })
        .where("hostname_id", "=", row.id)
        .execute();
      await publishZones(services, [row.zone_id]).catch(() => {});
    }
    row.target = target.id;
  }
}

async function declined(services: ControlServices, serviceId: string): Promise<boolean> {
  const row = await services.db
    .selectFrom("service_hostname_state")
    .select("automatic_declined")
    .where("service_id", "=", serviceId)
    .executeTakeFirst();
  return row?.automatic_declined ?? false;
}

function portOf(row: HostnameRow, service: ServiceInfo, fallback: number): number {
  if (row.port) return row.port;
  if (service.kind === "compose") {
    return (
      composeServicesOf(service.settings).find((item) => item.name === row.compose_service)?.port ??
      fallback
    );
  }
  return fallback;
}

export async function hostnamesForDeploy(
  services: ControlServices,
  input: HostnameProviderInput,
): Promise<HostnameProviderResult> {
  const service = (await loadServices(services.db, null, [input.serviceId])).get(input.serviceId);
  if (!service || (service.kind !== "application" && service.kind !== "compose"))
    return { routes: [], notes: [] };
  const target = await describeTarget(services, input.serverId);
  if (!target) return { routes: [], notes: [] };
  const notes: string[] = [];
  let rows = await rowsOf(services, service.id);
  await followService(services, rows, target);

  // Automatic hostnames whose environment default changed while they couldn't be updated.
  const base = await automaticBase(services, service, target, false);
  for (const row of rows.filter((item) => item.automatic && item.replace_on_deploy)) {
    if (base.kind === "none" || matchesBase(row, base, service)) {
      await services.db
        .updateTable("hostname")
        .set({ replace_on_deploy: false })
        .where("id", "=", row.id)
        .execute();
      continue;
    }
    try {
      const { row: fresh } = await assignAutomatic(services, service, base, {
        writeRoute: false,
        createdBy: null,
        composeService: row.compose_service,
        port: row.port,
        path: row.path,
      });
      await removeRow(services, row);
      await services.db
        .deleteFrom("service_hostname_state")
        .where("service_id", "=", service.id)
        .execute();
      notes.push(
        `${row.host} was replaced by ${fresh.host} (the environment's hostname default changed).`,
      );
    } catch (error) {
      notes.push(`Couldn't replace ${row.host}: ${(error as Error).message}`);
    }
  }
  rows = await rowsOf(services, service.id);

  if (rows.length === 0 && !(await declined(services, service.id))) {
    if (base.kind === "none") {
      const record = wildcardRecord(services, target);
      notes.push(
        record
          ? "This service has no domain, so it has no public address. Generate one or add your own under its Domains section."
          : `This service has no domain, so it has no public address. Add a DNS zone under Domains, or add your own domain with an A record pointing at ${target.ipv4 ?? "this server's public IPv4 address"}.`,
      );
    } else {
      try {
        await assignAutomatic(services, service, base, { writeRoute: false, createdBy: null });
      } catch (error) {
        notes.push(`Couldn't give this service a hostname: ${(error as Error).message}`);
      }
      rows = await rowsOf(services, service.id);
    }
  } else if (rows.length === 0) {
    notes.push(
      "This service has no domain, so it has no public address. Add one under its Domains section.",
    );
  }

  const routes: HostnameRoute[] = [];
  for (const row of rows) {
    routes.push({
      host: row.host,
      path: row.path,
      port: portOf(row, service, input.port),
      ...(row.compose_service ? { composeService: row.compose_service } : {}),
      https: true,
    });
  }
  // DNS lookups can take seconds when resolvers are slow or unreachable: the deploy goes on, and
  // their notes reach the log when they arrive (punch list 18).
  const later = Promise.all(rows.map((row) => dnsNotes(services, row, target))).then((lists) =>
    lists.flat(),
  );
  return { routes, notes, later };
}

/** Log lines for a hostname whose DNS isn't ready (spec 10.2: the exact record to add). */
async function dnsNotes(
  services: ControlServices,
  row: HostnameRow,
  target: TargetInfo,
): Promise<string[]> {
  if (row.source === "zone") return [`${row.host} is served by Nearzero DNS.`];
  if (row.source === "platform" || row.source === "server") {
    const record = wildcardRecord(services, target);
    const check = await checkWildcard(services, target).catch(() => null);
    if (record && check && check.status !== "points_here") {
      return [
        `${row.host} is assigned, but it won't load until this DNS record exists: ${record.name} A ${record.value ?? "<this server's public IPv4>"} (DNS only, not proxied). HTTPS starts on its own once it does.`,
      ];
    }
    return [`${row.host} is assigned.`];
  }
  const check = await dnsChecks(services)
    .check(row.host, target.ipv4, false, target.unknownAddress)
    .catch(() => null);
  if (check && check.status !== "points_here") return [`${row.host}: ${check.message}`];
  return [];
}
