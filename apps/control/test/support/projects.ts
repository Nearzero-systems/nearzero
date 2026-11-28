import type { Capability } from "@nearzero/shared";
import { sql } from "kysely";
import type { AccessTarget } from "../../src/access/objects.ts";
import { ObjectRegistry } from "../../src/access/objects.ts";
import { removeServicesJob } from "../../src/deletion/job.ts";
import type {
  ServiceTeardown,
  TeardownOptions,
  TeardownResult,
  TeardownTarget,
} from "../../src/deletion/teardown.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { JobWorker } from "../../src/jobs/worker.ts";
import { silentLogger } from "../../src/log.ts";
import { registerProjectObjects } from "../../src/projects/objects.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
} from "./harness.ts";

/**
 * A control plane with the real project, environment and service objects, fake servers and Git
 * accounts (they arrive in later milestones), a fake teardown that records what it was asked to
 * remove, and a job worker the test drives by hand.
 */

export class FakeTeardown implements ServiceTeardown {
  readonly calls: { target: TeardownTarget; options: Omit<TeardownOptions, "signal"> }[] = [];
  /** Service names whose removal fails with this reason. */
  readonly failures = new Map<string, string>();
  /** Service names whose removal throws (an unreachable server). */
  readonly throws = new Set<string>();

  async remove(target: TeardownTarget, options: TeardownOptions): Promise<TeardownResult> {
    this.calls.push({
      target: { ...target },
      options: { stopFirst: options.stopFirst, removeVolumes: options.removeVolumes },
    });
    if (this.throws.has(target.name)) throw new Error("connect ECONNREFUSED 10.0.0.9:22");
    const reason = this.failures.get(target.name);
    return reason ? { removed: false, reason } : { removed: true };
  }

  reset(): void {
    this.calls.length = 0;
    this.failures.clear();
    this.throws.clear();
  }
}

/** Servers and Git accounts by workspace, until their milestones register real ones. */
export class FakeServers {
  readonly items: (AccessTarget & { workspaceId: string })[] = [];

  add(workspaceId: string, id: string): string {
    this.items.push({ workspaceId, kind: "server", id });
    return id;
  }

  register(registry: ObjectRegistry): void {
    for (const kind of ["server", "git_account"] as const) {
      registry.register(kind, {
        resolve: async (_db, workspaceId, ids) =>
          this.items.filter(
            (item) =>
              item.kind === kind && item.workspaceId === workspaceId && ids.includes(item.id),
          ),
      });
    }
  }
}

export interface ProjectsHarness {
  h: Harness;
  servers: FakeServers;
  teardown: FakeTeardown;
  /** Runs every due job (deletes) until none is left. */
  runJobs(): Promise<number>;
  reset(): Promise<void>;
  drop(): Promise<void>;
}

export async function createProjectsHarness(): Promise<ProjectsHarness> {
  const registry = new ObjectRegistry();
  registerProjectObjects(registry);
  const servers = new FakeServers();
  servers.register(registry);
  const h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects: registry } });
  const teardown = new FakeTeardown();
  const queue = new JobQueue(h.test.db, { workerId: "test-worker" });
  const worker = new JobWorker({
    db: h.test.db,
    queue,
    definitions: [removeServicesJob(teardown)],
    log: silentLogger,
  });
  return {
    h,
    servers,
    teardown,
    async runJobs() {
      let ran = 0;
      while (await worker.runOnce()) ran++;
      return ran;
    },
    async reset() {
      await h.reset();
      await sql`truncate job restart identity`.execute(h.test.db);
      servers.items.length = 0;
      teardown.reset();
    },
    drop: () => h.drop(),
  };
}

export async function workspaceIdOf(browser: Browser): Promise<string> {
  return (await browser.get("/workspace")).body.workspace.id;
}

export interface Scope {
  allProjects?: boolean;
  projectIds?: string[];
  environmentIds?: string[];
  serviceIds?: string[];
  allServers?: boolean;
  serverIds?: string[];
}

/** Sets a member's direct access through the API, as an owner would. */
export async function giveAccess(
  harness: Harness,
  owner: Browser,
  email: string,
  access: { capabilities?: Capability[]; scope?: Scope },
): Promise<void> {
  const personId = await personIdOf(harness, email);
  const reply = await owner.put(`/workspace/members/${personId}/access`, {
    policyIds: [],
    capabilities: access.capabilities ?? [],
    scope: {
      allProjects: false,
      projectIds: [],
      environmentIds: [],
      serviceIds: [],
      allServers: false,
      serverIds: [],
      allGitAccounts: false,
      gitAccountIds: [],
      ...access.scope,
    },
  });
  if (reply.status !== 200) throw new Error(JSON.stringify(reply.body));
}

export async function addMember(
  harness: Harness,
  owner: Browser,
  email: string,
  access: { capabilities?: Capability[]; scope?: Scope; role?: "admin" | "member" } = {},
): Promise<Browser> {
  const browser = await addMemberThroughInvitation(harness, owner, email, {
    role: access.role ?? "member",
  });
  if ((access.role ?? "member") === "member" && (access.capabilities || access.scope)) {
    await giveAccess(harness, owner, email, access);
  }
  return browser;
}

export interface ProjectFixture {
  projectId: string;
  environments: Record<string, string>;
}

/** A project with the named environments (development always exists). */
export async function makeProject(
  browser: Browser,
  name: string,
  environments: string[] = [],
  description = "",
): Promise<ProjectFixture> {
  const created = await browser.post("/projects", { name, description });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const projectId = created.body.project.id as string;
  const result: ProjectFixture = {
    projectId,
    environments: { development: created.body.environmentId },
  };
  for (const environment of environments) {
    const reply = await browser.post(`/projects/${projectId}/environments`, { name: environment });
    if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
    result.environments[environment] = reply.body.environment.id;
  }
  return result;
}

export async function makeService(
  browser: Browser,
  environmentId: string,
  body: Record<string, unknown>,
) {
  const reply = await browser.post(`/environments/${environmentId}/services`, {
    serverId: "host",
    ...body,
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  return reply.body;
}
