import { AppError, relativeRecordName } from "@nearzero/shared";
import type { WorkspaceActor } from "../http/actor.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { listServers } from "../servers/servers.ts";
import type { ControlServices } from "../services.ts";
import {
  automaticParent,
  describeTarget,
  describeTargets,
  type TargetInfo,
  wildcardRecord,
} from "./addresses.ts";
import { type DnsCheck, wildcardProbe } from "./dns-check.ts";
import { dnsChecks, withoutHostnameOn } from "./hostnames.ts";
import { detectProvider, providerSteps, recordTitle } from "./providers.ts";

/**
 * The cards that name the one DNS record each server needs (spec 10.2, 10.3, 9.5): the
 * "Automatic hostnames" card on the Domains page and the DNS card in a server's dialogs. The
 * record's status comes from looking up a random name under the server's wildcard.
 */

export type RecordBadge = "points_here" | "points_elsewhere" | "not_set_up" | "couldnt_check";

const BADGES: Record<RecordBadge, string> = {
  points_here: "Points here",
  points_elsewhere: "Points elsewhere",
  not_set_up: "Not set up",
  couldnt_check: "Couldn't check",
};

export function badgeOf(check: DnsCheck): RecordBadge {
  switch (check.status) {
    case "points_here":
      return "points_here";
    case "points_elsewhere":
    case "proxied":
    case "ipv6_only":
      return "points_elsewhere";
    case "no_record":
      return "not_set_up";
    default:
      return "couldnt_check";
  }
}

const wildcardCache = new WeakMap<ControlServices, Map<string, DnsCheck>>();

/** Looks up a random name under a target's wildcard (answers are kept for 20 seconds). */
export async function checkWildcard(services: ControlServices, target: TargetInfo, fresh = false) {
  const parent = automaticParent(services, target);
  if (!parent) return null;
  let cache = wildcardCache.get(services);
  if (!cache) {
    cache = new Map();
    wildcardCache.set(services, cache);
  }
  const key = `${parent}|${target.ipv4 ?? ""}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.checkedAt < dnsChecks(services).ttlMs) return hit;
  const probe = wildcardProbe(parent, services.domains.random);
  const check = await dnsChecks(services).check(probe, target.ipv4, true, target.unknownAddress);
  const named = {
    ...check,
    name: `*.${parent}`,
    message: check.message.replaceAll(probe, `*.${parent}`),
  };
  cache.set(key, named);
  return named;
}

export const ABOUT_HTTPS =
  "Each hostname gets its own Let's Encrypt certificate, checked over HTTP on port 80, so port 80 must be open. There are no wildcard certificates, and Let's Encrypt issues at most 50 new certificates per week for one registered domain.";

/** The Automatic hostnames card (spec 10.3), when there is a platform domain. */
export async function automaticCard(
  services: ControlServices,
  actor: WorkspaceActor,
  fresh = false,
) {
  const domain = services.domains.platformDomain;
  if (!domain) return null;
  // Every target is described and checked at once: N servers cost one lookup's time, not N
  // (spec 23.5, B1-49).
  const ids = [
    ...(actor.access.can("host.use") ? [HOST_TARGET] : []),
    ...(await listServers(services, actor)).map((server) => server.id),
  ];
  const described = await describeTargets(services, ids);
  const targets = ids
    .map((id) => described.get(id))
    .filter((info): info is TargetInfo => info !== undefined);
  const rows = await Promise.all(
    targets.map((target) => recordRow(services, actor, target, fresh)),
  );
  return {
    domain,
    description: `Every app gets its own hostname with HTTPS, like a3f9c2b1.${domain}. One DNS record per server covers all of its apps.`,
    rows,
    aboutHttps: ABOUT_HTTPS,
  };
}

async function recordRow(
  services: ControlServices,
  actor: WorkspaceActor,
  target: TargetInfo,
  fresh: boolean,
) {
  const record = wildcardRecord(services, target);
  const check = await checkWildcard(services, target, fresh);
  const badge = check ? badgeOf(check) : "couldnt_check";
  const without = (await withoutHostnameOn(services, actor, target.id)).length;
  const ready = badge === "points_here";
  // Services without a hostname can get one before the record exists: hostnames are assigned
  // and routed first, and load once DNS points here (spec 10.2, R3-21).
  const action = without === 0 ? "check_again" : without === 1 ? "give_one" : "give_n";
  return {
    target: { id: target.id, name: target.name, host: target.host, address: target.ipv4 },
    record: record ? { type: record.type, name: record.name, value: record.value } : null,
    badge,
    badgeLabel: BADGES[badge],
    without,
    subtitle:
      without > 0
        ? `${without} ${without === 1 ? "service" : "services"} without a hostname`
        : `Apps get a hostname under ${record?.parent ?? services.domains.platformDomain}`,
    action,
    actionLabel:
      action === "check_again"
        ? "Check again"
        : action === "give_one"
          ? "Give it a hostname"
          : `Give ${without} a hostname`,
    help: ready
      ? null
      : "Add this record once at your DNS provider, as DNS only (not proxied). Every app on this server then gets its own hostname.",
    message: check?.message ?? null,
    checkedAt: check ? new Date(check.checkedAt).toISOString() : null,
  };
}

/** "Check again" on one row: a fresh lookup and the result line (spec 10.3). */
export async function checkTargetRecord(
  services: ControlServices,
  actor: WorkspaceActor,
  targetId: string,
) {
  const target = await reachableTarget(services, actor, targetId);
  const row = await recordRow(services, actor, target, true);
  return {
    row,
    message:
      row.badge === "points_here"
        ? `${row.record?.name} points at this server.`
        : `${row.record?.name ?? "The record"} doesn't point at this server yet. DNS changes can take a few minutes.`,
  };
}

export async function reachableTarget(
  services: ControlServices,
  actor: WorkspaceActor,
  targetId: string,
): Promise<TargetInfo> {
  if (targetId === HOST_TARGET) {
    if (!actor.access.can("host.use"))
      throw new AppError("not_found", "The Nearzero host isn't available to this workspace.");
  } else {
    await actor.access.require("server.see", { kind: "server", id: targetId });
  }
  const target = await describeTarget(services, targetId);
  if (!target)
    throw new AppError(
      "not_found",
      "This server doesn't exist in this workspace, or you don't have access to it.",
    );
  return target;
}

/** The server's DNS card (spec 9.5): the record to add, at which provider, and whether it's there. */
export async function serverDnsCard(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
  fresh = false,
) {
  const target = await reachableTarget(services, actor, serverId);
  const record = wildcardRecord(services, target);
  if (target.host || !record) return { shown: false };
  const found = await dnsChecks(services).zone(record.name);
  const provider = detectProvider(found.nameservers);
  const relative = relativeRecordName(record.name, found.zone);
  const check = await checkWildcard(services, target, fresh);
  const badge = check ? badgeOf(check) : "couldnt_check";
  const recordToAdd = {
    name: relative,
    fullName: record.name,
    zone: found.zone,
    type: "A" as const,
    value: target.ipv4 ?? "<server IPv4>",
  };
  const ready = badge === "points_here";
  // The names apps on this server get: everything under its wildcard (G3-07).
  const under = record.name.replace(/^\*\./, "");
  return {
    shown: true,
    // Ready: only "App addresses are ready" and its sentence. Otherwise the record to add, with
    // "Add it now, while setup runs." for the setup dialog alone (G3-07, spec 9.5).
    title: ready ? SERVER_DNS_TEXT.readyTitle : recordTitle(provider),
    subtitle: ready
      ? SERVER_DNS_TEXT.readySubtitle(target.name, under)
      : SERVER_DNS_TEXT.missingSubtitle(target.name, under),
    whileSetup: SERVER_DNS_TEXT.whileSetup,
    record: { type: "A", name: relative, value: target.ipv4, proxy: "DNS only" },
    zoneLine: `In the domain ${found.zone}. The full name is ${record.name}.`,
    provider: provider ? { id: provider.id, name: provider.name } : null,
    steps: providerSteps(provider, recordToAdd),
    badge: badge === "not_set_up" ? "not_added" : badge,
    badgeLabel: badge === "not_set_up" ? "Not added yet" : BADGES[badge],
    ready,
    readyText: ready ? SERVER_DNS_TEXT.readyTitle : null,
    checkHint: "DNS changes usually show up within a few minutes.",
    message: check?.message ?? null,
    // What "Check again" says when it ends (G3-07).
    checkToast: ready ? SERVER_DNS_TEXT.checkPointsHere : SERVER_DNS_TEXT.checkNotYet,
  };
}

/** The server DNS card's words (spec 9.5, G3-07). */
export const SERVER_DNS_TEXT = {
  readyTitle: "App addresses are ready",
  readySubtitle: (server: string, under: string) =>
    `Apps on ${server} get their own address under ${under}, with HTTPS set up automatically.`,
  missingSubtitle: (server: string, under: string) =>
    `It gives every app on ${server} its own address under ${under}, with HTTPS set up automatically.`,
  whileSetup: "Add it now, while setup runs.",
  checkPointsHere: "The record points here. Apps on this server get their own address.",
  checkNotYet: "It doesn't point at this server yet. DNS changes can take a few minutes.",
} as const;
