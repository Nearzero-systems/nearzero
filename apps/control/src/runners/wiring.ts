import type { RunnerChecks } from "@nearzero/shared";
import { onHostRunnerReady } from "../analytics/area.ts";
import type { Db } from "../db/database.ts";
import { describeTarget } from "../domains/addresses.ts";
import { onRunnerReady } from "../domains/background.ts";
import type { Logger } from "../log.ts";
import { alertsOnMetrics } from "../monitoring/routes.ts";
import { syncRoutes } from "../routing/routes.ts";
import { markReadyFromRunner } from "../servers/servers.ts";
import type { ControlServices } from "../services.ts";
import { HOST_TARGET, RunnerHub } from "./hub.ts";
import { pinnedRunnerLink } from "./link.ts";

/**
 * What happens when a runner connects: its server is marked ready once every mandatory check
 * passes (spec 9.4: Docker, the private network, the router), and it gets every route it should
 * have. Offline errors name the server.
 */

export function mandatoryChecksPass(checks: RunnerChecks): boolean {
  return checks.docker && checks.network && checks.router && checks.routerDirectory;
}

export function createRunnerHub(db: Db, log: Logger, services: () => ControlServices): RunnerHub {
  return new RunnerHub(db, log.child({ component: "runners" }), {
    async onReady(target, hello) {
      if (target !== HOST_TARGET && mandatoryChecksPass(hello.checks)) {
        await markReadyFromRunner(db, target);
      }
      await syncRoutes(services(), target).catch((error: unknown) =>
        log.warn("couldn't give a runner its routes", { target, error }),
      );
      // Its uploaded certificates and, on the host, the managed DNS zones (spec 10.7, 10.8).
      await onRunnerReady(services(), target).catch((error: unknown) =>
        log.warn("couldn't give a runner its certificates and zones", { target, error }),
      );
      // The host's router logs requests unless an administrator turned it off (spec 13.1).
      if (target === HOST_TARGET) {
        await onHostRunnerReady(services()).catch((error: unknown) =>
          log.warn("couldn't give the host's runner its request log setting", { error }),
        );
      }
    },
    // Where remote runners should connect: they are moved there (spec 31, G3-01).
    preferredLink: () => services().runnerLink(),
    // Every remote runner's fallback, and the next pin while the pair is replaced (C4-06, C4-10).
    fallbackLink: () => pinnedRunnerLink(services(), services().runnerLinkSettings),
    nextFingerprint: () => services().runnerLinkSettings.next ?? null,
    // The address its router's certificate hold compares DNS with (spec 10.7).
    publicIPv4: async (target) => (await describeTarget(services(), target))?.ipv4 ?? null,
    // Server alerts follow every sample (spec 14.3).
    onMetrics: (target, samples) => alertsOnMetrics({ db }, log)(target, samples),
    async onChecks(target, checks) {
      if (target !== HOST_TARGET && mandatoryChecksPass(checks)) {
        await markReadyFromRunner(db, target);
      }
    },
    async offlineMessage(target) {
      if (target === HOST_TARGET) {
        return "The Nearzero host's runner isn't connected, so Nearzero can't work on the host right now. On the host, check it with: sudo nearzero status";
      }
      const row = await db
        .selectFrom("server")
        .select("name")
        .where("id", "=", target)
        .executeTakeFirst();
      return `The runner on "${row?.name ?? "this server"}" isn't connected, so Nearzero can't reach that server right now. Check that the server is on and can reach Nearzero; the runner reconnects by itself.`;
    },
  });
}
