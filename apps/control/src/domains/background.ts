import { sql } from "kysely";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { consoleHostname, describeTarget } from "./addresses.ts";
import { pushCertificateContact, pushUploads, refreshSnapshot } from "./certificates.ts";
import { checkRowDns, dropRoute, HOSTNAME_COLUMNS, type HostnameRow } from "./hostnames.ts";
import { checkZoneHealth, ensureInstallZone, publishPendingZones, publishZones } from "./zones.ts";

/**
 * The domains area's background work (spec 10.7): a check a minute after start and every 5
 * minutes after that looks every hostname up again, has routers release holds whose DNS is now
 * right, and reads each server's certificates. A quicker sweep publishes managed DNS changes
 * (a hostname's record removed with it, or with its deleted service) and removes routes left
 * behind by services that no longer exist.
 *
 * It runs in the process that holds the runner connections (the install runs one).
 */

export const FIRST_CHECK_AFTER_MS = 60_000;
export const CHECK_EVERY_MS = 5 * 60_000;
export const SWEEP_EVERY_MS = 5_000;

export interface DomainsBackground {
  stop(): void;
  /** Runs one full check now (tests, and anything that wants it sooner). */
  checkNow(): Promise<void>;
  sweepNow(): Promise<void>;
}

/**
 * Routes of services that no longer exist (keys s-<service id>-…, the deploy pipeline's). A
 * deleted service's teardown removes them first; this catches anything left behind.
 */
export async function sweepOrphanRoutes(services: ControlServices): Promise<number> {
  const orphans = await services.db
    .selectFrom("router_route as r")
    .select(["r.target", "r.key"])
    .where("r.key", "~", "^s-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("service as s")
            .select("s.id")
            .where(sql<boolean>`s.id::text = substring(r.key from 3 for 36)`),
        ),
      ),
    )
    .execute();
  let removed = 0;
  for (const orphan of orphans) {
    try {
      await dropRoute(services, orphan.target, orphan.key);
      removed++;
    } catch (error) {
      services.log.warn("couldn't remove a route whose service is gone", {
        target: orphan.target,
        error,
      });
    }
  }
  return removed;
}

/**
 * Gives a server's router its public IPv4 as it is now (R3-10): a server added by hostname
 * follows its name to a new address at the next 5-minute check, without a reconnect, and a
 * lookup of the name that failed just now says so instead of taking the address away. The
 * router also checks its holds again.
 */
export async function pushRouterAddress(services: ControlServices, target: string): Promise<void> {
  if (target === HOST_TARGET || !services.runners.isOnline(target)) return;
  const info = await describeTarget(services, target);
  if (!info) return;
  await services.runners.command(
    target,
    "router.check-holds",
    { publicIPv4: info.ipv4, ...(info.lookupFailed ? { lookupFailed: true } : {}) },
    { timeoutMs: 60_000 },
  );
}

export async function runCheckCycle(services: ControlServices): Promise<void> {
  await ensureInstallZone(services).catch((error: unknown) =>
    services.log.warn("couldn't connect the install's DNS zone", { error }),
  );
  const rows = (await services.db
    .selectFrom("hostname")
    .select(HOSTNAME_COLUMNS)
    .execute()) as HostnameRow[];
  const pointsHere = new Set<string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, rows.length) }, async () => {
      while (next < rows.length) {
        const row = rows[next++] as HostnameRow;
        const check = await checkRowDns(services, row, true).catch(() => null);
        if (check?.status === "points_here" && row.service_id) pointsHere.add(row.target);
      }
    }),
  );
  const targets = [...new Set(rows.filter((row) => row.service_id).map((row) => row.target))];
  // The console's own certificate (About Nearzero) lives on the host's router.
  if (!targets.includes(HOST_TARGET) && (await consoleHostname(services)))
    targets.push(HOST_TARGET);
  // Every connected server's router hears its address as it is now (R3-10); that also checks
  // its holds again.
  const addressed = new Set<string>();
  for (const target of services.runners.onlineTargets()) {
    if (target === HOST_TARGET) continue;
    await pushRouterAddress(services, target)
      .then(() => addressed.add(target))
      .catch(() => {});
  }
  for (const target of targets) {
    if (!services.runners.isOnline(target)) continue;
    // Holds whose DNS is right now are released here rather than at the runner's own next check.
    if (pointsHere.has(target) && !addressed.has(target)) {
      await services.runners
        .command(target, "router.check-holds", {}, { timeoutMs: 60_000 })
        .catch(() => {});
    }
    await refreshSnapshot(services, target).catch(() => {});
  }
  if (services.runners.isOnline(HOST_TARGET)) await checkZoneHealth(services).catch(() => {});
}

/** What a runner gets when it connects: its uploaded certificates, and on the host the DNS zones. */
export async function onRunnerReady(services: ControlServices, target: string): Promise<void> {
  // The certificate contact from About Nearzero (spec 10.1), before anything asks for a certificate.
  await pushCertificateContact(services, target);
  // Always, even with none left: one deleted while its server was offline goes from the router
  // now (R3-20).
  await pushUploads(services, target).catch((error: unknown) =>
    services.log.warn("couldn't give a runner its uploaded certificates", { target, error }),
  );
  if (target === HOST_TARGET) {
    const zone = await services.db.selectFrom("dns_zone").select("id").executeTakeFirst();
    if (zone) {
      await publishZones(services, []).catch((error: unknown) =>
        services.log.warn("couldn't publish DNS zones to the host", { error }),
      );
    }
  }
  // The address its name resolves to now; a lookup that failed at connect holds nothing (R3-10).
  void pushRouterAddress(services, target).catch(() => {});
  // Read in the background: a runner too old to know the command shouldn't hold anything up.
  void refreshSnapshot(services, target).catch(() => {});
}

/**
 * What a workspace's domains put on routers and the DNS server, which a workspace delete leaves
 * behind otherwise (spec 23.1 "Teardown is complete", B1-64): read before the delete, and the
 * returned step republishes the zones and certificate sets without them once it is done. A
 * router that is offline then gets its set when its runner connects again.
 */
export async function workspaceDomainsCleanup(
  services: ControlServices,
  workspaceId: string,
): Promise<() => Promise<void>> {
  const zone = await services.db
    .selectFrom("dns_zone")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  const targets = await services.db
    .selectFrom("uploaded_certificate")
    .select("target")
    .distinct()
    .where("workspace_id", "=", workspaceId)
    .execute();
  return async () => {
    if (zone) {
      await publishZones(services, []).catch((error: unknown) =>
        services.log.warn("couldn't publish DNS zones after a workspace was deleted", { error }),
      );
    }
    for (const { target } of targets) {
      if (!services.runners.isOnline(target)) continue;
      await pushUploads(services, target).catch((error: unknown) =>
        services.log.warn("couldn't update a router's certificates after a workspace was deleted", {
          target,
          error,
        }),
      );
    }
  };
}

export async function startDomainsBackground(
  services: ControlServices,
): Promise<DomainsBackground> {
  // An administrator's corrected address wins over the install's from the first connection on.
  const corrected = await services.db
    .selectFrom("address_setting")
    .select("value")
    .where("key", "=", "public_ipv4")
    .executeTakeFirst()
    .catch(() => undefined);
  if (corrected) services.runners.hostPublicIPv4 = corrected.value;

  let stopped = false;
  let checking: Promise<void> | null = null;
  let sweeping: Promise<void> | null = null;
  const checkNow = () => {
    checking ??= runCheckCycle(services)
      .catch((error: unknown) => services.log.warn("the domains check failed", { error }))
      .finally(() => {
        checking = null;
      });
    return checking;
  };
  const sweepNow = () => {
    sweeping ??= (async () => {
      await sweepOrphanRoutes(services);
      await publishPendingZones(services);
    })()
      .catch((error: unknown) => services.log.warn("the domains sweep failed", { error }))
      .finally(() => {
        sweeping = null;
      });
    return sweeping;
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  timers.push(
    setTimeout(() => {
      if (stopped) return;
      void checkNow();
      const every = setInterval(() => void checkNow(), CHECK_EVERY_MS);
      (every as { unref?: () => void }).unref?.();
      timers.push(every);
    }, FIRST_CHECK_AFTER_MS),
  );
  timers.push(setInterval(() => void sweepNow(), SWEEP_EVERY_MS));
  for (const timer of timers) (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
    checkNow,
    sweepNow,
  };
}
