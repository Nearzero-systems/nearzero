import type { FakeHost } from "../test-support/fake-runner-link.ts";
import { ApiSession } from "../test-support/stack.ts";
import { OWNER_EMAIL, PASSWORD, type Seeded } from "./seed.ts";

/**
 * The operations area's seed for the sweep (spec 6, 9, 10, 11, 18.2), on top of seed.ts: with
 * the pretend host runner connected, the storefront app and its database deploy for real, a
 * second app ("api", from a Git URL) is left building so its page shows a deploy in progress,
 * a managed DNS zone with a hostname in it, an SSH key and a server. Everything goes through the
 * API as a browser would.
 */

export interface OperationsSeed {
  /** The app's finished deployment. */
  deployment: string;
  /** The app left building. */
  building: string;
  buildingDeployment: string;
}

async function until<T>(
  what: string,
  read: () => Promise<T | null>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(400);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

type DeploymentRow = { id: string; status: string; error: string | null };

async function finished(owner: ApiSession, serviceId: string): Promise<DeploymentRow> {
  return until(`the deploy of ${serviceId}`, async () => {
    const { deployments } = await owner.call<{ deployments: DeploymentRow[] }>(
      "GET",
      `/services/${serviceId}/deployments`,
    );
    const newest = deployments[0];
    if (!newest || newest.status === "queued" || newest.status === "building") return null;
    if (newest.status !== "active") {
      throw new Error(`The deploy of ${serviceId} ended ${newest.status}: ${newest.error}`);
    }
    return newest;
  });
}

export async function seedOperations(
  base: string,
  ids: Seeded,
  host: FakeHost,
): Promise<OperationsSeed> {
  const owner = await ApiSession.signIn(base, OWNER_EMAIL, PASSWORD);
  // A new session may open in the owner's other workspace; the seed lives in Acme.
  const { workspaces } = await owner.call<{ workspaces: { id: string; slug: string }[] }>(
    "GET",
    "/workspaces",
  );
  const acme = workspaces.find((workspace) => workspace.slug === "acme");
  if (acme) await owner.call("POST", `/workspaces/${acme.id}/switch`);

  // A managed zone first, so hostnames can be added in it without waiting for real DNS.
  const zone = await owner.call<{ zone: { id: string } }>("POST", "/domains/zones", {
    domain: "acme-shop.test",
    adminEmail: "dns@acme-shop.test",
  });
  await owner.call("POST", `/domains/zones/${zone.zone.id}/apply`).catch(() => null);

  // The app and its database deploy against the pretend runner.
  for (const id of [ids.app, ids.database]) {
    await owner
      .call("PATCH", `/services/${id}/deploy-settings`, { stabilitySeconds: 1 })
      .catch(() => null);
    await owner.call("POST", `/services/${id}/deployments`, {});
  }
  const deployment = await finished(owner, ids.app);
  await finished(owner, ids.database);
  await owner.call("POST", "/domains/hostnames", {
    hostname: "shop.acme-shop.test",
    connect: { serviceId: ids.app, port: 8080 },
    dns: "managed",
  });

  // A second app, from a Git URL, whose build waits: its page shows a deploy in progress.
  const api = await owner.call<{ service: { id: string } }>(
    "POST",
    `/environments/${ids.development}/services`,
    { kind: "application", name: "api", serverId: "host", settings: { servicePort: 3000 } },
  );
  await owner.call("PUT", `/services/${api.service.id}/source`, {
    type: "git",
    url: "https://github.com/acme/api.git",
    branch: "main",
  });
  host.runner.holdBuilds();
  const started = await owner.call<{ deployment: { id: string } }>(
    "POST",
    `/services/${api.service.id}/deployments`,
    {},
  );
  await until("the api build to start", async () => {
    const { deployments } = await owner.call<{ deployments: DeploymentRow[] }>(
      "GET",
      `/services/${api.service.id}/deployments`,
    );
    return deployments[0]?.status === "building" ? true : null;
  });

  // An SSH key and a server for the Servers page.
  const generated = await owner.call<{ publicKey: string; privateKey: string }>(
    "POST",
    "/ssh-keys/generate",
    { type: "ed25519", name: "deploy" },
  );
  const key = await owner.call<{ key: { id: string } }>("POST", "/ssh-keys", {
    name: "deploy",
    description: "The team's deploy key",
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  });
  await owner.call("POST", "/servers", {
    name: "prod-1",
    description: "The main production server in Frankfurt.",
    sshKeyId: key.key.id,
    address: "203.0.113.50",
    port: 22,
    sshUser: "ubuntu",
  });

  return {
    deployment: deployment.id,
    building: api.service.id,
    buildingDeployment: started.deployment.id,
  };
}

/** Who a route is loaded as, as sweep/run.ts names them. */
type As = "owner" | "member";

export interface OperationsRoute {
  path: string;
  as: As;
  status?: number;
  shot?: string;
  /** The page keeps a live stream open, so it never goes network-idle. */
  live?: boolean;
}

/**
 * The operations pages, as the owner and as Sam, a one-project member (spec 21.2, 21.8). Shots
 * go to test-artifacts/m2d/ in Dusk and Light at 1440 and 375px.
 */
export function operationsRoutes(ids: Seeded, seed: OperationsSeed): OperationsRoute[] {
  const W = "/acme/dashboard";
  const dev = `${W}/projects/${ids.project}/${ids.development}`;
  const app = `${dev}/services/${ids.app}`;
  const building = `${dev}/services/${seed.building}`;
  return [
    { path: app, as: "owner", shot: "m2d/app-after-deploy" },
    { path: building, as: "owner", shot: "m2d/app-during-deploy", live: true },
    { path: `${app}/logs`, as: "owner", live: true },
    { path: `${app}/advanced`, as: "owner" },
    { path: `${app}/settings`, as: "owner" },
    { path: `${dev}/services/${ids.database}`, as: "owner" },
    { path: `${W}/deployments`, as: "owner", shot: "m2d/deployments", live: true },
    {
      path: `${W}/deployments?status=active&type=application&pageSize=10`,
      as: "owner",
      live: true,
    },
    { path: `${W}/deployments/${seed.deployment}`, as: "owner", shot: "m2d/deployment" },
    { path: `${W}/deployments/${seed.buildingDeployment}`, as: "owner", live: true },
    { path: `${W}/deployments/not-a-deployment`, as: "owner", status: 404 },
    { path: `${W}/domains`, as: "owner", shot: "m2d/domains" },
    { path: `${W}/domains?show=attention&q=shop`, as: "owner" },
    { path: `${W}/domains?tab=dns-zones`, as: "owner" },
    { path: `${W}/domains?tab=environment-defaults`, as: "owner" },
    { path: `${W}/domains?tab=uploaded-certificates`, as: "owner" },
    { path: `${W}/servers`, as: "owner", shot: "m2d/servers" },
    { path: `${W}/servers?tab=ssh-keys`, as: "owner", shot: "m2d/ssh-keys" },
    { path: `${W}/servers?q=nothing-matches`, as: "owner" },
    { path: `${W}/settings`, as: "owner", shot: "m2d/about" },
    { path: app, as: "member" },
    { path: `${app}/settings`, as: "member" },
    { path: `${W}/deployments`, as: "member", live: true },
    { path: `${W}/deployments/${seed.deployment}`, as: "member" },
    { path: `${W}/domains`, as: "member" },
    { path: `${W}/servers`, as: "member" },
    { path: `${W}/settings`, as: "member" },
  ];
}
