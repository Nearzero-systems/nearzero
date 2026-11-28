import {
  AppError,
  createHostnameSchema,
  createServiceRequestSchema,
  DATABASE_KINDS,
  generateHostnameSchema,
  portNumberSchema,
  providerSourceRequestSchema,
  SERVICE_KIND_LABELS,
} from "@nearzero/shared";
import { parseDocument } from "yaml";
import { z } from "zod";
import { createHostname, generateForService, previewHostname } from "../../domains/hostnames.ts";
import { usableProviders } from "../../git-providers/reads.ts";
import { saveProviderSource } from "../../git-providers/sources.ts";
import { createService } from "../../services/records.ts";
import { defineCapability } from "../capability.ts";
import { agentCreateOptions, InputRefusal, requireProductionAllowed } from "../context.ts";
import { matchByName, ResolveFailure } from "../resolve.ts";
import {
  asRequest,
  findProjectEnvironment,
  findService,
  guardService,
  nameRef,
  placeService,
  requireServerReady,
  serviceInput,
  serviceRefs,
} from "./common.ts";

/** Spec 20.4 (Compose), 20.5 (databases) and 20.6 (domains). */

const placementFields = {
  project: nameRef("project"),
  environment: z.string().trim().max(100).optional(),
  name: z.string().trim().min(1).max(100),
  server: z.string().trim().max(300).optional(),
};

/**
 * Pasted Compose YAML may not carry variable values or config file contents (spec 20.4): those
 * go through the variables form. `${NAME}` placeholders are fine.
 */
export function composeYamlProblem(text: string): string | null {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    return `That isn't valid YAML: ${document.errors[0]?.message.split("\n")[0] ?? "it couldn't be read"}.`;
  }
  const root = document.toJS() as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return "That isn't a Compose file: it has no services.";
  const servicesValue = root.services;
  if (!servicesValue || typeof servicesValue !== "object")
    return "That isn't a Compose file: it has no services.";
  const literal = (value: unknown) =>
    value !== null &&
    value !== undefined &&
    String(value).trim() !== "" &&
    !/^\$\{[A-Za-z_][A-Za-z0-9_]*(:?-[^}]*)?\}$/.test(String(value).trim());
  for (const [name, service] of Object.entries(servicesValue as Record<string, unknown>)) {
    const environment = (service as Record<string, unknown> | null)?.environment;
    if (Array.isArray(environment)) {
      for (const entry of environment) {
        const text = String(entry);
        const eq = text.indexOf("=");
        if (eq > 0 && literal(text.slice(eq + 1))) {
          return `The service "${name}" sets a value for ${text.slice(0, eq)} in the file. Leave values out (use \${${text.slice(0, eq)}}) and ask for them with the variables form.`;
        }
      }
    } else if (environment && typeof environment === "object") {
      for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
        if (literal(value)) {
          return `The service "${name}" sets a value for ${key} in the file. Leave values out (use \${${key}}) and ask for them with the variables form.`;
        }
      }
    }
  }
  for (const section of ["configs", "secrets"]) {
    const entries = root[section];
    if (entries && typeof entries === "object") {
      for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
        const item = value as Record<string, unknown> | null;
        if (item && (item.content !== undefined || item.environment !== undefined)) {
          return `The ${section.slice(0, -1)} "${key}" has its contents in the file. File contents go through the console, not the Agent.`;
        }
      }
    }
  }
  return null;
}

export const createComposeFromYaml = defineCapability({
  name: "create_compose_from_yaml",
  area: "compose",
  description:
    "Create a Compose service from pasted YAML (Compose or stack format). Variable values and config file contents in the YAML are refused: use $NAME-style placeholders and ask for values with request_variables.",
  input: z.object({
    ...placementFields,
    yaml: z
      .string()
      .min(1)
      .max(512 * 1024),
    format: z.enum(["compose", "stack"]).optional(),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Creating Compose service", done: "Created Compose service" },
  startTarget: (input) => input.name,
  async run(ctx, input) {
    const problem = composeYamlProblem(input.yaml);
    if (problem) throw new InputRefusal(problem);
    const { environment } = await findProjectEnvironment(ctx, input);
    requireProductionAllowed(ctx, environment.name);
    const place = await placeService(ctx, input.server);
    const created = await createService(
      ctx.services,
      ctx.actor,
      environment.id,
      asRequest(createServiceRequestSchema, {
        kind: "compose",
        name: input.name,
        serverId: place.id,
        settings: { composeFile: input.yaml, ...(input.format ? { format: input.format } : {}) },
        variables: [],
      }),
      agentCreateOptions(ctx),
    );
    return {
      target: `${created.service.name} on ${place.name}`,
      refs: [{ kind: "service", id: created.service.id }],
      result: {
        created: { id: created.service.id, name: created.service.name, server: place.name },
        alsoAddedTo: created.alsoAddedTo.map((copy) => copy.environmentName),
        notes: [
          ...(place.note ? [place.note] : []),
          ...(created.message ? [created.message] : []),
          ...created.notes,
          ...created.notAddedTo.map((left) => `${left.environmentName}: ${left.reason}`),
        ],
      },
    };
  },
});

export const createComposeFromRepository = defineCapability({
  name: "create_compose_from_repository",
  area: "compose",
  description:
    "Create a Compose service from a Compose file in a connected Git provider's repository.",
  input: z.object({
    ...placementFields,
    provider: z.string().trim().min(1).max(200),
    repository: z.string().trim().min(1).max(300),
    branch: z.string().trim().max(255).optional(),
    composePath: z.string().trim().max(500).optional().describe("Default ./docker-compose.yml"),
  }),
  policies: ["services.configure", "services.import-git"],
  changes: true,
  label: { running: "Creating Compose service", done: "Created Compose service" },
  startTarget: (input) => `${input.name} from ${input.repository}`,
  async run(ctx, input) {
    const providers = (await usableProviders(ctx.services, ctx.actor)).filter((item) => item.ready);
    const match = matchByName(providers, input.provider);
    if (match.kind !== "one") {
      throw new ResolveFailure(
        `No connected Git provider matches "${input.provider}".`,
        providers.map((item) => item.name),
      );
    }
    const request = asRequest(providerSourceRequestSchema, {
      providerId: match.item.id,
      repository: input.repository,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.composePath ? { composePath: input.composePath } : {}),
    });
    const { environment } = await findProjectEnvironment(ctx, input);
    requireProductionAllowed(ctx, environment.name);
    const place = await placeService(ctx, input.server);
    const created = await createService(
      ctx.services,
      ctx.actor,
      environment.id,
      asRequest(createServiceRequestSchema, {
        kind: "compose",
        name: input.name,
        serverId: place.id,
        settings: {},
        variables: [],
      }),
      agentCreateOptions(ctx),
    );
    const saved = await saveProviderSource(ctx.services, ctx.actor, created.service.id, request);
    return {
      target: `${created.service.name} from ${input.repository}`,
      refs: [{ kind: "service", id: created.service.id }],
      result: {
        created: { id: created.service.id, name: created.service.name, server: place.name },
        notes: [
          ...(place.note ? [place.note] : []),
          ...saved.notes,
          ...created.notAddedTo.map((left) => `${left.environmentName}: ${left.reason}`),
        ],
      },
    };
  },
});

/** Which databases take a database name and a user (spec 08 8.1). */
const TAKES_DATABASE_NAME = new Set(["postgres", "mysql", "mariadb"]);
const TAKES_USER = new Set(["postgres", "mysql", "mariadb", "mongodb", "libsql"]);

/**
 * The settings a new database starts with (30d R4-07): an image, a database name and a user, each
 * checked by the console's own rules when the service is created. Passwords never come from the
 * model.
 */
function databaseSettingsFrom(input: {
  kind: (typeof DATABASE_KINDS)[number];
  image?: string | undefined;
  databaseName?: string | undefined;
  user?: string | undefined;
  password?: string | undefined;
}): Record<string, string> {
  if (input.password !== undefined) {
    throw new InputRefusal(
      "Passwords can't go through the Agent: Nearzero generates the database's password, and the person sees it on the database's page.",
    );
  }
  const label = SERVICE_KIND_LABELS[input.kind];
  if (input.databaseName && !TAKES_DATABASE_NAME.has(input.kind)) {
    throw new InputRefusal(`${label} has no database name to choose. Leave it out.`);
  }
  if (input.user && !TAKES_USER.has(input.kind)) {
    throw new InputRefusal(`${label} has no user name to choose. Leave it out.`);
  }
  return {
    ...(input.image ? { image: input.image } : {}),
    ...(input.databaseName ? { databaseName: input.databaseName } : {}),
    ...(input.user ? { user: input.user } : {}),
  };
}

export const createDatabase = defineCapability({
  name: "create_database",
  area: "databases",
  description:
    "Create a Postgres, MySQL, MariaDB, MongoDB, Redis or libSQL database, optionally with its image (like postgres:15), database name (Postgres, MySQL, MariaDB) and user name (all but Redis). Credentials are always generated (never pass a password). It gets its own data volume and an automatic public port. The result gives internal and public host and port; full connection URLs are on the database's page.",
  input: z.object({
    ...placementFields,
    kind: z.enum(DATABASE_KINDS),
    image: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("The image and tag, like postgres:15; the kind's default when left out."),
    databaseName: z.string().trim().max(63).optional(),
    user: z.string().trim().max(63).optional(),
    password: z.string().optional().describe("Never pass this: passwords are always generated."),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Creating database", done: "Created database" },
  startTarget: (input) => input.name,
  async run(ctx, input) {
    const settings = databaseSettingsFrom(input);
    const { environment } = await findProjectEnvironment(ctx, input);
    requireProductionAllowed(ctx, environment.name);
    const place = await placeService(ctx, input.server);
    const created = await createService(
      ctx.services,
      ctx.actor,
      environment.id,
      asRequest(createServiceRequestSchema, {
        kind: input.kind,
        name: input.name,
        serverId: place.id,
        settings,
        variables: [],
      }),
      agentCreateOptions(ctx),
    );
    const saved = created.service.settings as Record<string, unknown>;
    const server =
      place.id === "host"
        ? null
        : await ctx.services.db
            .selectFrom("server")
            .select(["address"])
            .where("id", "=", place.id)
            .executeTakeFirst();
    const port = Number(saved.port ?? 0) || null;
    return {
      target: `${created.service.name} on ${place.name}`,
      refs: [{ kind: "service", id: created.service.id }],
      result: {
        created: {
          id: created.service.id,
          name: created.service.name,
          kind: SERVICE_KIND_LABELS[input.kind],
          server: place.name,
          image: typeof saved.image === "string" ? saved.image : null,
          databaseName: typeof saved.databaseName === "string" ? saved.databaseName : null,
          user: typeof saved.user === "string" ? saved.user : null,
        },
        internal: { host: created.service.appName, port, from: "apps on the same server" },
        public: created.service.publicPort
          ? { host: server?.address ?? "the server's public IP", port: created.service.publicPort }
          : { note: created.service.publicPortNote ?? "Not public." },
        password:
          "Generated and stored by Nearzero. The person sees it and the full connection URLs on the database's page.",
        alsoAddedTo: created.alsoAddedTo.map((copy) => copy.environmentName),
        notes: [
          ...(place.note ? [place.note] : []),
          ...(created.message ? [created.message] : []),
          ...created.notes,
          ...created.notAddedTo.map((left) => `${left.environmentName}: ${left.reason}`),
        ],
        next: "Deploy it to start it.",
      },
    };
  },
});

function recordTable(
  record: { type: string; name: string; value: string | null } | null | undefined,
) {
  if (!record) return null;
  return `| Type | Name | Value | Proxy |\n| --- | --- | --- | --- |\n| ${record.type} | ${record.name} | ${record.value ?? "the server's IP"} | DNS only |`;
}

export const addHostname = defineCapability({
  name: "add_hostname",
  area: "domains",
  description:
    "Add a hostname to an app or Compose service: the person's own domain (it must point at the service's server first, unless it is in a Nearzero-managed zone), or, without a hostname, a generated one. Port, path and the Compose service are optional; HTTPS with Let's Encrypt is always on. Returns the DNS record to add unless the name already points at the server.",
  input: z.object({
    ...serviceInput,
    hostname: z.string().trim().max(300).optional(),
    port: portNumberSchema.optional(),
    path: z.string().trim().max(1024).optional(),
    composeService: z.string().trim().max(63).optional(),
  }),
  policies: ["services.configure", "services.assign-domains"],
  changes: true,
  label: { running: "Adding domain", done: "Added domain" },
  startTarget: (input) => input.hostname ?? input.service,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    guardService(ctx, service);
    await requireServerReady(ctx, { id: service.serverId, name: service.serverName }, "changed");
    if (!input.hostname) {
      const generated = await generateForService(
        ctx.services,
        ctx.actor,
        service.id,
        asRequest(generateHostnameSchema, {
          ...(input.port ? { port: input.port } : {}),
          ...(input.path ? { path: input.path } : {}),
          ...(input.composeService ? { composeService: input.composeService } : {}),
        }),
      );
      return {
        target: generated.hostname.hostname,
        refs: serviceRefs(service),
        result: {
          hostname: generated.hostname.url,
          message: generated.message,
          dnsRecord: generated.missingRecord
            ? recordTable(generated.missingRecord.record as never)
            : null,
          dnsMessage: generated.missingRecord?.message ?? null,
          note:
            service.status === "running" ? null : "It isn't live until the service is deployed.",
        },
      };
    }
    try {
      const added = await createHostname(
        ctx.services,
        ctx.actor,
        asRequest(createHostnameSchema, {
          hostname: input.hostname,
          connect: {
            serviceId: service.id,
            ...(input.port ? { port: input.port } : {}),
            ...(input.path ? { path: input.path } : {}),
            ...(input.composeService ? { composeService: input.composeService } : {}),
          },
        }),
      );
      const record = added.hostname.dns.status === "points_here" ? null : added.hostname.dns.record;
      return {
        target: added.hostname.hostname,
        refs: serviceRefs(service),
        result: {
          hostname: added.hostname.url,
          message: added.message,
          dnsRecord: recordTable(record),
          dns: added.hostname.dns.note,
        },
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "conflict") throw error;
      // DNS doesn't point at the server yet: give the record to add.
      const preview = (await previewHostname(ctx.services, ctx.actor, {
        hostname: input.hostname,
        serviceId: service.id,
      })) as {
        record?: { type: string; name: string; value: string | null };
        message?: string;
      };
      return {
        target: input.hostname,
        refs: serviceRefs(service),
        failed: error.message,
        result: {
          error: error.message,
          dnsRecord: recordTable(preview.record),
          next: "Ask the person to add this record at their DNS provider (DNS only, not proxied), then try again.",
        },
      };
    }
  },
});

export const moreServiceCapabilities = [
  createComposeFromYaml,
  createComposeFromRepository,
  createDatabase,
  addHostname,
];
