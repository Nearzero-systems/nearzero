import { BUILD_CACHE_COMPONENT, NEARZERO_LABELS } from "@nearzero/shared";
import { sql } from "kysely";
import type { ServiceTeardown, TeardownResult, TeardownTarget } from "../deletion/teardown.ts";
import { routePrefix } from "../deploys/pipeline.ts";
import { cancelDeployment } from "../deploys/queue.ts";
import { removeServiceWebhook } from "../git-providers/sources.ts";
import { movedNotFinalized } from "../migration/moves.ts";
import { removeRoute } from "../routing/routes.ts";
import { HOST_TARGET, RunnerCommandError } from "../runners/hub.ts";
import { syncPublishedPorts } from "../servers/firewall.ts";
import type { ControlServices } from "../services.ts";
import { mountVolume, readAppSettings } from "./app-settings.ts";
import { reasonOf, ServerOps } from "./server-ops.ts";

/**
 * Removing a service from the server it ran on, through that server's runner (spec 5.1, 5.2,
 * 23.1 "Teardown is complete"): its containers (stopped first), its images, its folders in the
 * runner's work folder, its volumes when asked (always for Compose) and its routes. A server
 * that can't be reached is "not removed" with the reason, so the delete fails visibly and can be
 * retried; nothing is reported removed while anything of it is left running or routed.
 *
 * Safe to repeat: whatever is already gone counts as removed. Deployment rows stay, marked
 * "removed", for 30 days.
 */

function volumeNamesOf(target: Pick<TeardownTarget, "kind" | "appName" | "settings">): string[] {
  const names: string[] = [];
  if (typeof target.settings.dataVolume === "string") names.push(target.settings.dataVolume);
  if (target.kind === "application") {
    for (const mount of readAppSettings(target.settings).mounts) {
      if (mount.type === "volume") names.push(mountVolume(target.appName, mount));
    }
  }
  return names;
}

/**
 * Volumes another service on the same server mounts too, by name: a copy made before copies got
 * volumes of their own (B1-05), or two moved services that kept one 0.1.x volume. Deleting one
 * service never wipes data the other still uses.
 */
export async function volumesUsedElsewhere(
  services: ControlServices,
  target: Pick<TeardownTarget, "serviceId" | "serverId">,
): Promise<Map<string, string>> {
  let query = services.db
    .selectFrom("service")
    .select(["id", "name", "kind", "app_name", "settings"])
    .where("id", "!=", target.serviceId);
  query =
    target.serverId === null
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", target.serverId);
  const used = new Map<string, string>();
  for (const row of await query.execute()) {
    for (const name of volumeNamesOf({
      kind: row.kind,
      appName: row.app_name,
      settings: row.settings ?? {},
    })) {
      if (!used.has(name)) used.set(name, row.name);
    }
  }
  return used;
}

export function runnerTeardown(services: ControlServices): ServiceTeardown {
  return {
    async remove(target, options): Promise<TeardownResult> {
      const { db } = services;
      const server = target.serverId ?? HOST_TARGET;
      // Waiting deploys of a service being deleted never run.
      const open = await db
        .selectFrom("deployment")
        .select(["id", "status"])
        .where("service_id", "=", target.serviceId)
        .where("status", "in", ["queued", "building"])
        .execute();
      for (const row of open) await cancelDeployment(db, row.id).catch(() => {});
      if (open.some((row) => row.status === "building")) {
        return {
          removed: false,
          reason: "A deployment of this service was still running. It was cancelled; delete again.",
        };
      }
      const deployed = await db
        .selectFrom("deployment")
        .select("id")
        .where("service_id", "=", target.serviceId)
        .where("status", "not in", ["queued", "cancelled"])
        .executeTakeFirst();
      const routes = await db
        .selectFrom("router_route")
        .select(["target", "key"])
        .where("key", "like", `${routePrefix(target.serviceId)}%`)
        .execute();
      if (target.status === "idle" && !deployed && routes.length === 0) {
        // Never deployed: nothing of it is on any server.
        await markRemoved(services, target.serviceId);
        return { removed: true, ...(await webhookNotes(services, target.serviceId)) };
      }
      const ops = new ServerOps(services, server, options.signal);
      const keptNotes: string[] = [];
      try {
        if (target.kind === "compose") {
          await ops.stream(
            "compose.down",
            {
              project: target.appName,
              volumes: true,
              // A moved stack shares its project name with 0.1.x's copy until finalize.
              removeOrphans: !(await movedNotFinalized(services.db, target.serviceId)),
            },
            () => {},
            10 * 60_000,
          );
        }
        const containers = await ops.serviceContainers(target.serviceId);
        for (const container of containers) {
          if (container.state === "running" && !options.stopFirst) {
            return {
              removed: false,
              reason: "The service is running and wasn't stopped first. Delete it again.",
            };
          }
          await ops.stopAndRemove(container.id, 10);
        }
        const images = (await ops.command("image.list", {
          labels: [`${NEARZERO_LABELS.service}=${target.serviceId}`],
          reference: [],
        })) as { id: string; tags: string[] }[];
        const named = (await ops.command("image.list", {
          labels: [],
          reference: [`nearzero/${target.appName}`],
        })) as { id: string; tags: string[] }[];
        for (const image of [...images, ...named]) {
          await ops.command("image.remove", { image: image.id, force: true }).catch((error) => {
            if (error instanceof RunnerCommandError && error.runnerCode === "not_found") return;
            throw error;
          });
        }
        // Its build caches are never data: they go whether or not its volumes do (B2-22).
        const caches = (await ops.command("volume.list", {
          labels: [
            `${NEARZERO_LABELS.service}=${target.serviceId}`,
            `${NEARZERO_LABELS.component}=${BUILD_CACHE_COMPONENT}`,
          ],
        })) as { Name: string }[];
        for (const cache of caches) {
          await ops.command("volume.remove", { name: cache.Name, force: true }).catch((error) => {
            if (error instanceof RunnerCommandError && error.runnerCode === "not_found") return;
            throw error;
          });
        }
        if (options.removeVolumes || target.kind === "compose") {
          const labelled = (await ops.command("volume.list", {
            labels: [`${NEARZERO_LABELS.service}=${target.serviceId}`],
          })) as { Name: string }[];
          const names = new Set([
            ...labelled.map((volume) => volume.Name),
            ...volumeNamesOf(target),
          ]);
          const elsewhere = await volumesUsedElsewhere(services, target);
          for (const name of names) {
            const user = elsewhere.get(name);
            if (user) {
              keptNotes.push(`The volume ${name} is also used by ${user}, so its data was kept.`);
              continue;
            }
            await ops.command("volume.remove", { name, force: true }).catch((error) => {
              if (error instanceof RunnerCommandError && error.runnerCode === "not_found") return;
              throw error;
            });
          }
        }
        await ops.command("workdir.remove", { appKey: target.appName });
        for (const route of routes) await removeRoute(services, route.target, route.key);
        const left = await ops.serviceContainers(target.serviceId);
        if (left.length > 0) {
          return {
            removed: false,
            reason: `${left.length} of its containers are still on the server. Delete it again.`,
          };
        }
      } catch (error) {
        if (options.signal.aborted) throw error;
        return {
          removed: false,
          reason: `Couldn't remove it from its server: ${reasonOf(error)} Nothing was reported removed; delete it again once the server is reachable.`,
        };
      }
      // The firewall rules Nearzero added for its published ports go too (30b R2-13).
      const firewall = await syncPublishedPorts(ops, null);
      await markRemoved(services, target.serviceId);
      const notes = [
        ...keptNotes,
        ...firewall,
        ...((await webhookNotes(services, target.serviceId)).notes ?? []),
      ];
      return { removed: true, ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}

/**
 * Once the service is off its server, the push webhook Nearzero registered at GitLab, Gitea or
 * Bitbucket goes too (spec 16.6), best effort: a host that can't be reached doesn't keep the
 * service, and what is left over is noted in the result for the person.
 */
async function webhookNotes(
  services: ControlServices,
  serviceId: string,
): Promise<{ notes?: string[] }> {
  const removal = await removeServiceWebhook(services, serviceId);
  if (removal.state === "failed") {
    services.log.warn("a deleted service's Git webhook couldn't be removed", {
      serviceId,
      reason: removal.message,
    });
    return { notes: [removal.message] };
  }
  return {};
}

/** Deployment rows outlive their service, marked "removed" for 30 days (spec 11.3). */
async function markRemoved(services: ControlServices, serviceId: string): Promise<void> {
  await services.db
    .updateTable("deployment")
    .set({ status: "removed", removed_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("service_id", "=", serviceId)
    .execute();
}
