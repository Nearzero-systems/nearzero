import {
  AppError,
  connectServiceSchema,
  createHostnameSchema,
  environmentDefaultSchema,
  generateHostnameSchema,
  previewHostnameSchema,
  publicDomainSchema,
  recordSchema,
  serverIpSchema,
  updateCertificateSchema,
  uploadCertificateSchema,
  zoneSchema,
  zoneUpdateSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import { serviceTarget } from "../projects/objects.ts";
import type { ControlServices } from "../services.ts";
import { aboutAddress, configurePublicDomain, correctServerIp } from "./about.ts";
import { automaticCard, checkTargetRecord, reachableTarget, serverDnsCard } from "./cards.ts";
import { listDefaults, updateDefault, workspaceZones } from "./defaults.ts";
import {
  checkHostnameDns,
  connectHostname,
  createHostname,
  disconnectHostname,
  generateForService,
  generateSuggestion,
  getHostname,
  giveHostnames,
  listHostnames,
  newAppHostnamePreview,
  previewHostname,
  removeHostname,
  retryCertificate,
  SHOW_FILTERS,
  type ShowFilter,
  serviceHostnames,
  servicesWithoutDomain,
} from "./hostnames.ts";
import { deleteUpload, listUploads, updateUpload, uploadCertificate } from "./uploads.ts";
import {
  addRecord,
  applyZone,
  connectZone,
  deleteRecord,
  getZone,
  listZones,
  removeZone,
  updateRecord,
  updateZone,
} from "./zones.ts";

/**
 * The Domains page, the service Add domain dialog, the server DNS card and About Nearzero's
 * address (spec 10, 9.5, 18.2). docs/api/domains.md documents every endpoint.
 */

const PAGE_REFUSAL =
  'You can\'t see Domains: it needs rights on a service, or the "Manage certificates" or "Manage DNS" permission. Ask an owner or admin of this workspace.';

/** People with domain or certificate rights (spec 10.10). */
async function requireDomainsPage(services: ControlServices, actor: WorkspaceActor): Promise<void> {
  if (actor.role === "owner" || actor.role === "admin") return;
  if (actor.access.can("certificates.manage") || actor.access.can("dns.manage")) return;
  const rows = await services.db
    .selectFrom("service")
    .select(["id", "project_id", "environment_id"])
    .where("workspace_id", "=", actor.workspace.id)
    .execute();
  if (rows.some((row) => actor.access.can("service.hostnames", serviceTarget(row)))) return;
  throw new AppError("forbidden", PAGE_REFUSAL);
}

function showFilter(value: string | undefined): ShowFilter {
  if (value === undefined || value === "") return "all";
  if ((SHOW_FILTERS as readonly string[]).includes(value)) return value as ShowFilter;
  throw new AppError("invalid_request", `Show one of: ${SHOW_FILTERS.join(", ")}.`);
}

export function domainRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- The page (spec 10.3)

  app.get("/domains", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await requireDomainsPage(services, actor);
    const [hostnames, zones, uploads] = await Promise.all([
      listHostnames(services, actor),
      workspaceZones(services.db, actor.workspace.id),
      services.db
        .selectFrom("uploaded_certificate")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("workspace_id", "=", actor.workspace.id)
        .executeTakeFirstOrThrow(),
    ]);
    const uploadCount = Number(uploads.count);
    const platformDomain = services.domains.platformDomain;
    const parents = new Set<string>();
    for (const zone of zones) parents.add(zone.name);
    if (platformDomain) parents.add(platformDomain);
    for (const view of hostnames.hostnames) {
      const dot = view.hostname.indexOf(".");
      if (dot > 0 && view.hostname.slice(dot + 1).includes("."))
        parents.add(view.hostname.slice(dot + 1));
    }
    const noDomain = !platformDomain && zones.length === 0 && hostnames.hostnames.length === 0;
    return c.json({
      title: "Domains",
      description:
        "Where your apps can be reached, and whether DNS and HTTPS are ready. Certificates are free and renew on their own.",
      platformDomain,
      noDomain,
      noDomainCard: noDomain
        ? {
            title: "No domain yet",
            text: "Apps run without a public address until there is a domain. Add your own domain, or point a domain's nameservers to Nearzero.",
            actions: ["Add domain", "Connect a DNS zone"],
          }
        : null,
      startFrom: [...parents].slice(0, 6),
      tabs: [
        { id: "hostnames", label: "Hostnames", count: hostnames.hostnames.length, shown: true },
        { id: "dns-zones", label: "DNS zones", count: zones.length, shown: zones.length > 0 },
        {
          id: "environment-defaults",
          label: "Environment defaults",
          count: null,
          shown: zones.length > 0,
        },
        {
          id: "uploaded-certificates",
          label: "Uploaded certificates",
          count: uploadCount,
          shown: uploadCount > 0,
        },
      ],
      more: [
        {
          id: "connect-zone",
          label: "Connect a DNS zone",
          hint: "Point a domain's nameservers to Nearzero",
        },
        {
          id: "upload-certificate",
          label: "Upload certificate",
          hint: "Only for wildcards or your own CA",
        },
      ],
      can: {
        connectZone: actor.access.can("dns.manage"),
        uploadCertificate: actor.access.can("certificates.manage"),
      },
    });
  });

  // ---- Hostnames (spec 10.4, 10.5)

  app.get("/domains/hostnames", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await requireDomainsPage(services, actor);
    const search = c.req.query("q");
    const list = await listHostnames(services, actor, {
      ...(search === undefined ? {} : { search }),
      show: showFilter(c.req.query("show")),
      refresh: c.req.query("refresh") === "1",
    });
    return c.json({ ...list, withoutDomain: await servicesWithoutDomain(services, actor) });
  });

  app.post("/domains/hostnames/preview", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, previewHostnameSchema);
    return c.json(await previewHostname(services, actor, input));
  });

  app.post("/domains/hostnames", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createHostnameSchema);
    return c.json(await createHostname(services, actor, input), 201);
  });

  app.get("/domains/hostnames/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ hostname: await getHostname(services, actor, c.req.param("id")) });
  });

  app.post("/domains/hostnames/:id/connect", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, connectServiceSchema);
    return c.json(await connectHostname(services, actor, c.req.param("id"), input));
  });

  app.post("/domains/hostnames/:id/disconnect", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await disconnectHostname(services, actor, c.req.param("id")));
  });

  app.delete("/domains/hostnames/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await removeHostname(services, actor, c.req.param("id")));
  });

  app.post("/domains/hostnames/:id/check-dns", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await checkHostnameDns(services, actor, c.req.param("id")));
  });

  app.post("/domains/hostnames/:id/retry", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await retryCertificate(services, actor, c.req.param("id")));
  });

  // ---- Automatic hostnames card and the server DNS card (spec 10.3, 9.5)

  app.get("/domains/automatic", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await requireDomainsPage(services, actor);
    return c.json({ card: await automaticCard(services, actor, c.req.query("fresh") === "1") });
  });

  app.post("/domains/targets/:id/check", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await checkTargetRecord(services, actor, c.req.param("id")));
  });

  app.post("/domains/targets/:id/give-hostnames", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await reachableTarget(services, actor, c.req.param("id"));
    return c.json(await giveHostnames(services, actor, c.req.param("id")));
  });

  app.get("/servers/:id/dns-card", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      card: await serverDnsCard(services, actor, c.req.param("id"), c.req.query("fresh") === "1"),
    });
  });

  // ---- A service's hostnames (spec 10.6, 06 6.7, 07 7.2)

  app.get("/services/:id/hostnames", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await serviceHostnames(services, actor, c.req.param("id")));
  });

  // The new-application page's Domain preview (spec 6.1), before the app exists.
  app.get("/environments/:id/hostname-preview", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(
      await newAppHostnamePreview(services, actor, {
        environmentId: c.req.param("id"),
        serverId: (c.req.query("serverId") ?? "").slice(0, 64),
        name: (c.req.query("name") ?? "").slice(0, 200),
      }),
    );
  });

  app.get("/services/:id/hostnames/suggestion", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await generateSuggestion(services, actor, c.req.param("id")));
  });

  app.post("/services/:id/hostnames/generate", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, generateHostnameSchema);
    return c.json(await generateForService(services, actor, c.req.param("id"), input), 201);
  });

  // ---- DNS zones (spec 10.8)

  app.get("/domains/zones", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const zones = await listZones(services, actor);
    const failing = zones.filter((zone) => zone.status === "needs_attention");
    return c.json({
      zones,
      banner:
        failing.length > 0
          ? `${failing.map((zone) => zone.name).join(", ")} ${failing.length === 1 ? "needs" : "need"} attention.`
          : null,
      canApplyAll: zones.length >= 2,
    });
  });

  app.post("/domains/zones", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, zoneSchema);
    return c.json(await connectZone(services, actor, input), 201);
  });

  app.post("/domains/zones/apply-all", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      zones: await applyZone(services, actor, "all"),
      message: "Applied all zones.",
    });
  });

  app.get("/domains/zones/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await getZone(services, actor, c.req.param("id")));
  });

  app.patch("/domains/zones/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, zoneUpdateSchema);
    return c.json({ zone: await updateZone(services, actor, c.req.param("id"), input) });
  });

  app.delete("/domains/zones/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await removeZone(services, actor, c.req.param("id")));
  });

  app.post("/domains/zones/:id/apply", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      zones: await applyZone(services, actor, c.req.param("id")),
      message: "Applied.",
    });
  });

  app.post("/domains/zones/:id/records", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, recordSchema);
    return c.json({ record: await addRecord(services, actor, c.req.param("id"), input) }, 201);
  });

  app.patch("/domains/zones/:id/records/:recordId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, recordSchema);
    return c.json({
      record: await updateRecord(
        services,
        actor,
        c.req.param("id"),
        c.req.param("recordId"),
        input,
      ),
    });
  });

  app.delete("/domains/zones/:id/records/:recordId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await deleteRecord(services, actor, c.req.param("id"), c.req.param("recordId")));
  });

  // ---- Environment defaults (spec 10.8)

  app.get("/domains/defaults", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await listDefaults(services, actor));
  });

  app.put("/domains/defaults/:environmentId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, environmentDefaultSchema);
    return c.json(await updateDefault(services, actor, c.req.param("environmentId"), input));
  });

  // ---- Uploaded certificates (spec 10.7)

  app.get("/domains/certificates", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ certificates: await listUploads(services, actor) });
  });

  app.post("/domains/certificates", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, uploadCertificateSchema);
    return c.json({ certificate: await uploadCertificate(services, actor, input) }, 201);
  });

  app.patch("/domains/certificates/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateCertificateSchema);
    return c.json({ certificate: await updateUpload(services, actor, c.req.param("id"), input) });
  });

  app.delete("/domains/certificates/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await deleteUpload(services, actor, c.req.param("id")));
  });

  // ---- About Nearzero: the console's address (spec 18.2, 10.9)

  app.get("/about/address", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await aboutAddress(services, actor));
  });

  app.put("/about/server-ip", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, serverIpSchema);
    return c.json(await correctServerIp(services, actor, input.ip));
  });

  app.put("/about/public-domain", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, publicDomainSchema);
    return c.json(await configurePublicDomain(services, actor, input));
  });

  return app;
}
