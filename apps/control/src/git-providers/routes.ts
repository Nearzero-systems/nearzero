import {
  AppError,
  bitbucketProviderRequestSchema,
  bitbucketProviderUpdateSchema,
  GIT_CALLBACK_PATHS,
  giteaProviderRequestSchema,
  giteaProviderUpdateSchema,
  githubCompleteRequestSchema,
  githubInstallationRequestSchema,
  githubManifestRequestSchema,
  githubProviderUpdateSchema,
  gitlabProviderRequestSchema,
  gitlabProviderUpdateSchema,
  gitProviderKindSchema,
  NO_CONNECT_RIGHT_MESSAGE,
  oauthCompleteRequestSchema,
  providerFlowRequestSchema,
  providerShareRequestSchema,
  providerSourceRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import type { z } from "zod";
import { type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { check, readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  completeGithubInstall,
  completeGithubManifest,
  completeOAuth,
  createBitbucketProvider,
  createOAuthProvider,
  deletePlan,
  deleteProvider,
  publicHttpsBase,
  shareProvider,
  startAuthorization,
  startGithubInstall,
  startGithubManifest,
  testProvider,
  updateProvider,
  viewDefaults,
} from "./connect.ts";
import { handleGithubWebhook } from "./push.ts";
import {
  getRepository,
  inspectRepository,
  listBranches,
  listFiles,
  listProviderViews,
  listRepositories,
  readFile,
  usableProviders,
} from "./reads.ts";
import { consoleAddress, usableProvider, viewOf } from "./records.ts";
import { disconnectSource, gitSourceView, reregisterHook, saveProviderSource } from "./sources.ts";

/**
 * Git providers under /api/v1 (spec 16, 6.3, 6.6, 7.1, 19.7): the settings page's list and its
 * connect, edit, test, share and delete actions; the callbacks the console's return pages pass
 * on; repository reads; service sources; and the GitHub App's public webhook.
 */

const UPDATE_SCHEMAS = {
  github: githubProviderUpdateSchema,
  gitlab: gitlabProviderUpdateSchema,
  gitea: giteaProviderUpdateSchema,
  bitbucket: bitbucketProviderUpdateSchema,
} as const;

/** Reads an optional JSON body (Test connection may send the form, or nothing). */
async function optionalJson(c: {
  req: { header(name: string): string | undefined; text(): Promise<string> };
}) {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return null;
  const text = await c.req.text();
  if (!text.trim()) return null;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && Object.keys(value).length > 0
      ? value
      : null;
  } catch {
    throw new AppError("invalid_request", "The request body is not valid JSON.");
  }
}

function query(c: { req: { query(name: string): string | undefined } }, name: string): string {
  return (c.req.query(name) ?? "").slice(0, 500);
}

async function editBody(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  body: unknown,
) {
  const row = await usableProvider(services, actor, providerId);
  const schema = UPDATE_SCHEMAS[row.kind] as z.ZodType;
  // Fields left out keep their saved values; without this a missing url became gitlab.com.
  return check(schema, { ...viewDefaults(row), ...(body as Record<string, unknown>) });
}

export function gitProviderRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- The list and what this person may do (spec 16.1).
  app.get("/git-providers", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const providers = await listProviderViews(services, actor);
    const canConnect = actor.access.can("git-accounts.connect-own");
    return c.json({
      providers,
      can: { connect: canConnect },
      noConnectMessage: canConnect ? null : NO_CONNECT_RIGHT_MESSAGE,
      console: {
        httpsBase: await publicHttpsBase(services),
        redirectUris: {
          gitlab: consoleAddress(services, GIT_CALLBACK_PATHS.gitlab),
          gitea: consoleAddress(services, GIT_CALLBACK_PATHS.gitea),
        },
      },
      isAdmin: actor.role === "owner" || actor.role === "admin",
    });
  });

  app.get("/git-providers/usable", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const kind = c.req.query("kind");
    const parsed = kind ? gitProviderKindSchema.safeParse(kind) : null;
    return c.json({
      providers: await usableProviders(services, actor, parsed?.success ? parsed.data : undefined),
      can: { connect: actor.access.can("git-accounts.connect-own") },
    });
  });

  // ---- Connecting (spec 16.2–16.5).
  app.post("/git-providers/github/manifest", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, githubManifestRequestSchema);
    return c.json(await startGithubManifest(services, actor, input));
  });

  app.post("/git-providers/github/manifest/complete", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, githubCompleteRequestSchema);
    return c.json(await completeGithubManifest(services, actor, input), 201);
  });

  app.post("/git-providers/github/installations", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, githubInstallationRequestSchema);
    return c.json(await completeGithubInstall(services, actor, input));
  });

  app.post("/git-providers/gitlab", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, gitlabProviderRequestSchema);
    return c.json(await createOAuthProvider(services, actor, "gitlab", input), 201);
  });

  app.post("/git-providers/gitea", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, giteaProviderRequestSchema);
    return c.json(await createOAuthProvider(services, actor, "gitea", input), 201);
  });

  app.post("/git-providers/bitbucket", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, bitbucketProviderRequestSchema);
    const result = await createBitbucketProvider(services, actor, input);
    return c.json({ ...result, message: "Bitbucket connected" }, 201);
  });

  app.post("/git-providers/oauth/complete", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, oauthCompleteRequestSchema);
    return c.json(await completeOAuth(services, actor, input));
  });

  // ---- One provider (spec 16.1 row actions).
  app.get("/git-providers/:providerId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await usableProvider(services, actor, c.req.param("providerId"));
    return c.json({ provider: await viewOf(services, actor, row) });
  });

  app.post("/git-providers/:providerId/install", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, providerFlowRequestSchema);
    return c.json(
      await startGithubInstall(services, actor, c.req.param("providerId"), input.returnTo),
    );
  });

  app.post("/git-providers/:providerId/authorize", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, providerFlowRequestSchema);
    return c.json(
      await startAuthorization(services, actor, c.req.param("providerId"), input.returnTo),
    );
  });

  app.patch("/git-providers/:providerId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = c.req.param("providerId");
    const raw = await optionalJson(c);
    const body = await editBody(services, actor, id, raw ?? {});
    return c.json(await updateProvider(services, actor, id, body));
  });

  app.post("/git-providers/:providerId/test", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = c.req.param("providerId");
    const raw = await optionalJson(c);
    const body = raw ? await editBody(services, actor, id, raw) : null;
    return c.json(await testProvider(services, actor, id, body));
  });

  app.post("/git-providers/:providerId/share", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, providerShareRequestSchema);
    return c.json(await shareProvider(services, actor, c.req.param("providerId"), input.shared));
  });

  app.get("/git-providers/:providerId/delete-plan", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await deletePlan(services, actor, c.req.param("providerId")));
  });

  app.delete("/git-providers/:providerId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const understood = ["1", "true", "yes"].includes(query(c, "understood"));
    return c.json(await deleteProvider(services, actor, c.req.param("providerId"), understood));
  });

  // ---- Reads without cloning (spec 16, 19.7).
  app.get("/git-providers/:providerId/repositories", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(
      await listRepositories(services, actor, c.req.param("providerId"), query(c, "search")),
    );
  });

  app.get("/git-providers/:providerId/repository", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      repository: await getRepository(
        services,
        actor,
        c.req.param("providerId"),
        query(c, "repository"),
      ),
    });
  });

  app.get("/git-providers/:providerId/branches", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(
      await listBranches(services, actor, c.req.param("providerId"), query(c, "repository")),
    );
  });

  app.get("/git-providers/:providerId/files", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const depth = c.req.query("depth");
    return c.json(
      await listFiles(services, actor, c.req.param("providerId"), {
        repository: query(c, "repository"),
        ref: query(c, "ref"),
        depth: depth === undefined || depth === "" ? null : Number(depth) || 0,
      }),
    );
  });

  app.get("/git-providers/:providerId/file", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(
      await readFile(services, actor, c.req.param("providerId"), {
        repository: query(c, "repository"),
        ref: query(c, "ref"),
        path: query(c, "path"),
      }),
    );
  });

  app.get("/git-providers/:providerId/inspect", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(
      await inspectRepository(services, actor, c.req.param("providerId"), {
        repository: query(c, "repository"),
        ref: query(c, "ref"),
      }),
    );
  });

  // ---- Service sources (spec 6.3, 7.1).
  app.get("/services/:serviceId/git-source", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await gitSourceView(services, actor, c.req.param("serviceId")));
  });

  app.put("/services/:serviceId/git-source", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, providerSourceRequestSchema);
    return c.json(await saveProviderSource(services, actor, c.req.param("serviceId"), input));
  });

  app.delete("/services/:serviceId/git-source", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await disconnectSource(services, actor, c.req.param("serviceId")));
  });

  app.post("/services/:serviceId/git-source/webhook", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await reregisterHook(services, actor, c.req.param("serviceId")));
  });

  // ---- The GitHub App's events (spec 16.2): no session; the signature is the credential.
  app.post("/webhooks/github/:providerId", async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const result = await handleGithubWebhook(
      services,
      c.req.param("providerId"),
      c.req.raw.headers,
      raw,
    );
    return c.json(result.body, result.status);
  });

  return app;
}
