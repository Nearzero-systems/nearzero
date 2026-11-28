import {
  DATABASE_KINDS,
  type DatabaseKind,
  DEPLOYMENT_STATUS_LABELS,
  type DeploymentStatus,
  GIT_PROVIDER_LABELS,
} from "@nearzero/shared";
import { z } from "zod";
import { composeSourceOf, describeComposeSource } from "../../compose-runtime/source.ts";
import { serviceHostnames } from "../../domains/hostnames.ts";
import { type AppSource, readAppSettings } from "../../service-runtime/app-settings.ts";
import { readDatabaseSettings } from "../../service-runtime/databases.ts";
import { serviceForAction } from "../../service-runtime/runtime.ts";
import { defineCapability } from "../capability.ts";
import { describeService, findService, onServer, serviceInput, serviceRefs } from "./common.ts";

/**
 * Reading one service's settings (spec 20.2, 30d R4-04): where it builds from, how it builds, its
 * push deploys, its hostnames and its last 5 deployments, so "which branch does web deploy
 * from?" is answered from a result and the keep-going loop sees the builder before changing it.
 * Nothing secret is in it: no passwords, keys, tokens, file contents or variable values, and Git
 * URLs lose any user name or token.
 */

/** A Git URL without whatever credentials it carries (https://user:token@host/… → https://host/…). */
export function credentialFreeUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

function sourceView(source: AppSource | null) {
  if (!source) return { type: "none" };
  switch (source.type) {
    case "git":
      return {
        type: "git",
        url: credentialFreeUrl(source.url),
        branch: source.branch,
        folder: source.buildPath || "/",
        sshKey: source.sshKeyId ? "a saved SSH key" : null,
        watchPaths: source.watchPaths,
        submodules: source.submodules,
      };
    case "provider":
      return {
        type: "repository",
        provider: GIT_PROVIDER_LABELS[source.provider],
        connected: source.providerId !== null,
        repository: source.repository,
        branch: source.branch,
        folder: source.buildPath || "/",
        watchPaths: source.watchPaths,
        submodules: source.submodules,
      };
    case "image":
      return {
        type: "image",
        image: source.image,
        registry: source.registry ? source.registry.address : null,
      };
    case "upload":
      return {
        type: "upload",
        folder: source.buildPath || "/",
        file: source.upload ? source.upload.fileName : null,
      };
  }
}

function isDatabase(kind: string): kind is DatabaseKind {
  return (DATABASE_KINDS as readonly string[]).includes(kind);
}

export const readServiceCapability = defineCapability({
  name: "read_service",
  area: "finding",
  description:
    "Read one service's settings: where it builds from (repository or Git URL, branch, folder, or image), its builder and install/build/start commands, push deploys (autodeploy and trigger), its hostnames and its last 5 deployments. Read-only; secrets are never included.",
  input: z.object(serviceInput),
  policies: [],
  changes: false,
  label: { running: "Reading service", done: "Read service" },
  startTarget: (input) => input.service,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    const row = await serviceForAction(ctx.services, ctx.actor, service.id, "service.see");
    const settings = (row.settings ?? null) as Record<string, unknown> | null;
    const app = readAppSettings(settings);
    let build: Record<string, unknown>;
    if (service.kind === "application") {
      build = {
        source: sourceView(app.source),
        builder: app.builder,
        commands: app.commands,
        servicePort: app.servicePort,
        autodeploy: app.deploy.autodeploy,
        trigger: app.source && "trigger" in app.source ? app.source.trigger : null,
      };
    } else if (service.kind === "compose") {
      const source = composeSourceOf(settings);
      build = {
        source: source ? describeComposeSource(source) : { type: "none" },
        autodeploy: app.deploy.autodeploy,
        trigger: app.source && "trigger" in app.source ? app.source.trigger : null,
      };
    } else if (isDatabase(service.kind)) {
      const database = readDatabaseSettings(service.kind, settings, row.app_name);
      build = {
        image: database.image,
        databaseName: database.databaseName,
        user: database.user,
        port: database.port,
        password: "Generated and stored by Nearzero; the person sees it on the database's page.",
      };
    } else {
      build = {};
    }
    const hostnames = await serviceHostnames(ctx.services, ctx.actor, service.id)
      .then((found) =>
        found.hostnames.map((view) => ({
          hostname: view.hostname,
          url: view.url,
          path: view.service?.path ?? "/",
          port: view.service?.port ?? null,
          composeService: view.service?.composeService ?? null,
          dns: view.dns.label,
          https: view.https.label,
        })),
      )
      .catch(() => []);
    const canSeeDeployments = ctx.actor.access.can(
      "service.deployments",
      serviceRefs(service)[0] as never,
    );
    const deployments = canSeeDeployments
      ? (
          await ctx.services.db
            .selectFrom("deployment")
            .select(["id", "status", "title", "trigger", "created_at", "finished_at", "error"])
            .where("service_id", "=", service.id)
            .orderBy("created_at", "desc")
            .limit(5)
            .execute()
        ).map((deployment) => ({
          id: deployment.id,
          status:
            DEPLOYMENT_STATUS_LABELS[deployment.status as DeploymentStatus] ?? deployment.status,
          title: deployment.title,
          trigger: deployment.trigger,
          error: deployment.error,
          startedAt: deployment.created_at.toISOString(),
          finishedAt: deployment.finished_at?.toISOString() ?? null,
        }))
      : "You need permission to see this service's deployments.";
    return {
      target: onServer(service),
      refs: serviceRefs(service),
      result: { service: describeService(service), ...build, hostnames, deployments },
    };
  },
});
