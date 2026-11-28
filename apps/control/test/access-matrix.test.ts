import { describe, expect, test } from "bun:test";
import { CAPABILITIES, type Capability, type Role, type ScopeKind } from "@nearzero/shared";
import {
  canSee,
  decide,
  type GrantSource,
  type Grants,
  sourceCovers,
} from "../src/access/evaluate.ts";
import { ACTIONS, type Action } from "../src/access/matrix.ts";
import type { AccessTarget } from "../src/access/objects.ts";

/**
 * The permission matrix of spec 22.3, written out independently of the implementation's table,
 * and checked row by row: owners and admins allowed, a member refused by default, a member
 * allowed by the capability or scope the spec names. Rows for objects that arrive in later
 * milestones are here already, so those milestones only plug their objects in.
 */

type MemberDefault =
  /** "own services": allowed inside the member's scope, hidden outside it. */
  | "own"
  /** Refused unless the member holds the capability (and, with a target, can see it). */
  | "capability"
  /** Owners and admins only. */
  | "admins"
  | "everyone";

interface Row {
  action: Action;
  target: ScopeKind | null;
  member: MemberDefault;
  capability?: Capability;
}

const MATRIX: Row[] = [
  { action: "project.see", target: "project", member: "own" },
  { action: "project.create", target: null, member: "capability", capability: "projects.create" },
  {
    action: "project.delete",
    target: "project",
    member: "capability",
    capability: "projects.delete",
  },
  // Renaming goes with the right to create (M3b; not a row of the spec's table).
  {
    action: "project.update",
    target: "project",
    member: "capability",
    capability: "projects.create",
  },
  { action: "environment.see", target: "environment", member: "own" },
  {
    action: "environment.create",
    target: "project",
    member: "capability",
    capability: "environments.create",
  },
  {
    action: "environment.delete",
    target: "environment",
    member: "capability",
    capability: "environments.delete",
  },
  {
    action: "environment.update",
    target: "environment",
    member: "capability",
    capability: "environments.create",
  },
  { action: "environment.shared-variables", target: "environment", member: "own" },
  { action: "service.see", target: "service", member: "own" },
  {
    action: "service.create",
    target: "environment",
    member: "capability",
    capability: "services.create",
  },
  {
    action: "service.delete",
    target: "service",
    member: "capability",
    capability: "services.delete",
  },
  { action: "service.deploy", target: "service", member: "own" },
  {
    action: "service.configure",
    target: "service",
    member: "capability",
    capability: "services.create",
  },
  { action: "service.variables", target: "service", member: "own" },
  { action: "service.hostnames", target: "service", member: "own" },
  { action: "service.backups", target: "service", member: "own" },
  { action: "service.restore", target: "service", member: "own" },
  { action: "service.tasks", target: "service", member: "own" },
  { action: "service.deployments", target: "service", member: "own" },
  {
    action: "certificates.manage",
    target: null,
    member: "capability",
    capability: "certificates.manage",
  },
  { action: "dns.manage", target: null, member: "capability", capability: "dns.manage" },
  {
    action: "destinations.use",
    target: null,
    member: "capability",
    capability: "backups.use-destinations",
  },
  {
    action: "destinations.manage",
    target: null,
    member: "capability",
    capability: "backups.manage-destinations",
  },
  { action: "server.see", target: "server", member: "own" },
  { action: "servers.add", target: null, member: "capability", capability: "servers.manage" },
  { action: "server.manage", target: "server", member: "capability", capability: "servers.manage" },
  { action: "server.tasks", target: "server", member: "capability", capability: "servers.manage" },
  {
    action: "server.router-files",
    target: "server",
    member: "capability",
    capability: "router-files.read",
  },
  { action: "ssh-keys.use", target: null, member: "capability", capability: "ssh-keys.use" },
  { action: "ssh-keys.manage", target: null, member: "capability", capability: "ssh-keys.manage" },
  { action: "git-account.use", target: "git_account", member: "own" },
  {
    action: "git-accounts.connect-own",
    target: null,
    member: "capability",
    capability: "git.connect-own",
  },
  {
    action: "notifications.manage",
    target: null,
    member: "capability",
    capability: "notifications.manage",
  },
  { action: "members.see", target: null, member: "admins" },
  { action: "members.manage", target: null, member: "admins" },
  { action: "invitations.manage", target: null, member: "admins" },
  { action: "policies.manage", target: null, member: "admins" },
  { action: "agent-policies.manage", target: null, member: "admins" },
  { action: "api-keys.manage", target: null, member: "admins" },
  { action: "workspace-email.manage", target: null, member: "admins" },
  { action: "agent.use", target: null, member: "everyone" },
];

/** Actions only instance administrators may take (spec 22.2). */
const INSTANCE_ACTIONS: Action[] = [
  "workspaces.add",
  "workspace.rename",
  "workspace.delete",
  "members.add-with-password",
  "members.set-email",
  "host.use",
  "host.manage",
  "analytics.see",
  "console-domain.configure",
];

const ME = "person-me";

const TARGETS: Record<ScopeKind, AccessTarget> = {
  project: { kind: "project", id: "p1" },
  environment: { kind: "environment", id: "e1", projectId: "p1" },
  service: { kind: "service", id: "s1", environmentId: "e1", projectId: "p1" },
  server: { kind: "server", id: "srv1" },
  git_account: {
    kind: "git_account",
    id: "g1",
    ownerPersonId: "someone-else",
    sharedWithWorkspace: false,
  },
};

function source(partial: Partial<GrantSource> = {}): GrantSource {
  return {
    policy: null,
    capabilities: new Set(),
    allProjects: false,
    allServers: false,
    allGitAccounts: false,
    projects: new Set(),
    environments: new Map(),
    services: new Map(),
    servers: new Set(),
    gitAccounts: new Set(),
    ...partial,
  };
}

const EVERYTHING_IN_SCOPE = source({
  policy: { id: "pol", name: "Developers" },
  allProjects: true,
  allServers: true,
  allGitAccounts: true,
});

function grants(role: Role, sources: GrantSource[] = [], isInstanceAdmin = false): Grants {
  return { personId: ME, workspaceId: "w1", role, isInstanceAdmin, sources };
}

function targetFor(row: Row): AccessTarget | undefined {
  return row.target ? TARGETS[row.target] : undefined;
}

describe("the matrix table covers every action", () => {
  test("every action the code knows is in the spec table above, or is an instance action", () => {
    const listed = new Set<string>([...MATRIX.map((row) => row.action), ...INSTANCE_ACTIONS]);
    expect(Object.keys(ACTIONS).filter((action) => !listed.has(action))).toEqual([]);
  });
});

describe("permission matrix (spec 22.3)", () => {
  for (const row of MATRIX) {
    describe(row.action, () => {
      const target = targetFor(row);

      test("owners and admins are allowed", () => {
        expect(decide(grants("owner"), row.action, target).allowed).toBe(true);
        expect(decide(grants("admin"), row.action, target).allowed).toBe(true);
      });

      test("a member with nothing granted is refused, or allowed where everyone is", () => {
        const decision = decide(grants("member"), row.action, target);
        if (row.member === "everyone") {
          expect(decision.allowed).toBe(true);
          return;
        }
        expect(decision.allowed).toBe(false);
        if (decision.allowed) return;
        // Something the member can't see answers like something that doesn't exist (rule 3).
        expect(decision.hide).toBe(target !== undefined);
        if (row.member === "admins") expect(decision.message).toStartWith("Only owners and admins");
        if (row.member === "capability" && !target && row.capability) {
          expect(decision.message).toContain(CAPABILITIES[row.capability].label);
        }
      });

      if (row.member === "own") {
        test("a member reaches it inside their scope", () => {
          expect(decide(grants("member", [EVERYTHING_IN_SCOPE]), row.action, target).allowed).toBe(
            true,
          );
        });
      }

      if (row.member === "capability" && row.capability) {
        const capability = row.capability;
        if (target) {
          test("in scope without the capability, the member is refused and told what's needed", () => {
            const decision = decide(grants("member", [EVERYTHING_IN_SCOPE]), row.action, target);
            expect(decision.allowed).toBe(false);
            if (decision.allowed) return;
            expect(decision.hide).toBe(false);
            expect(decision.message).toContain(`"${CAPABILITIES[capability].label}"`);
          });

          test("the capability without scope on the object still hides it", () => {
            const holder = source({ capabilities: new Set([capability]) });
            const decision = decide(grants("member", [holder]), row.action, target);
            expect(decision).toMatchObject({ allowed: false, hide: true });
          });
        }

        test(`"${CAPABILITIES[capability].label}" adds it`, () => {
          const holder = source({
            ...EVERYTHING_IN_SCOPE,
            capabilities: new Set([capability]),
          });
          expect(decide(grants("member", [holder]), row.action, target).allowed).toBe(true);
        });

        test("another capability doesn't", () => {
          const others = new Set(
            (Object.keys(CAPABILITIES) as Capability[]).filter((key) => key !== capability),
          );
          const holder = source({ ...EVERYTHING_IN_SCOPE, capabilities: others });
          expect(decide(grants("member", [holder]), row.action, target).allowed).toBe(false);
        });
      }

      if (row.member === "admins") {
        test("no capability or scope gives it to a member", () => {
          const holder = source({
            ...EVERYTHING_IN_SCOPE,
            capabilities: new Set(Object.keys(CAPABILITIES) as Capability[]),
          });
          expect(decide(grants("member", [holder]), row.action, target).allowed).toBe(false);
        });
      }
    });
  }
});

describe("instance administrators (spec 22.2)", () => {
  for (const action of INSTANCE_ACTIONS) {
    test(`${action}: refused for a workspace owner who isn't an instance administrator`, () => {
      const decision = decide(grants("owner"), action);
      expect(decision.allowed).toBe(false);
    });

    test(`${action}: allowed for an instance administrator who is an owner here`, () => {
      expect(decide(grants("owner", [], true), action).allowed).toBe(true);
    });
  }

  test("workspaces: the spec's refusal for everyone else", () => {
    for (const action of ["workspaces.add", "workspace.rename", "workspace.delete"] as Action[]) {
      expect(decide(grants("owner"), action)).toEqual({
        allowed: false,
        hide: false,
        message: "Only Nearzero administrators can add, rename or delete workspaces.",
      });
    }
  });

  test("renaming needs an owner or admin of the workspace too", () => {
    expect(decide(grants("member", [], true), "workspace.rename")).toMatchObject({
      allowed: false,
      message: "Only this workspace's owner and admins can rename it.",
    });
    expect(decide(grants("admin", [], true), "workspace.rename").allowed).toBe(true);
  });

  test("adding people with a password: role first, then instance administrator", () => {
    expect(decide(grants("member", [], true), "members.add-with-password")).toMatchObject({
      allowed: false,
      message: "Only owners and admins can add people with a password.",
    });
    expect(decide(grants("admin", [], false), "members.add-with-password")).toMatchObject({
      allowed: false,
      message:
        "Only this server's administrators can add people with a password. Send an invitation instead.",
    });
    expect(decide(grants("admin", [], true), "members.add-with-password").allowed).toBe(true);
  });

  test("setting someone's email address (31a G1-02): role first, then instance administrator", () => {
    expect(decide(grants("member", [], true), "members.set-email")).toMatchObject({
      allowed: false,
      message: "Only owners and admins can change a member's email address.",
    });
    expect(decide(grants("owner", [], false), "members.set-email")).toMatchObject({
      allowed: false,
      message:
        "Only this server's administrators can change someone's email address. Ask a Nearzero administrator.",
    });
    expect(decide(grants("admin", [], true), "members.set-email").allowed).toBe(true);
  });
});

describe("scope: projects → environments → services", () => {
  const P = "p1";
  const otherEnv: AccessTarget = { kind: "environment", id: "e2", projectId: P };
  const serviceInE1: AccessTarget = TARGETS.service;
  const otherServiceInE1: AccessTarget = {
    kind: "service",
    id: "s2",
    environmentId: "e1",
    projectId: P,
  };
  const serviceInE2: AccessTarget = {
    kind: "service",
    id: "s3",
    environmentId: "e2",
    projectId: P,
  };
  const otherProject: AccessTarget = { kind: "project", id: "p2" };

  test("a ticked project with no ticked children covers all of it, including new things", () => {
    const s = source({ projects: new Set([P]) });
    for (const target of [
      TARGETS.project,
      TARGETS.environment,
      otherEnv,
      serviceInE1,
      serviceInE2,
    ]) {
      expect(sourceCovers(s, target)).toBe(true);
    }
    expect(sourceCovers(s, otherProject)).toBe(false);
  });

  test("a ticked environment narrows its project to that environment", () => {
    const s = source({ projects: new Set([P]), environments: new Map([["e1", P]]) });
    expect(sourceCovers(s, TARGETS.project)).toBe(true);
    expect(sourceCovers(s, TARGETS.environment)).toBe(true);
    expect(sourceCovers(s, serviceInE1)).toBe(true);
    expect(sourceCovers(s, otherServiceInE1)).toBe(true);
    expect(sourceCovers(s, otherEnv)).toBe(false);
    expect(sourceCovers(s, serviceInE2)).toBe(false);
  });

  test("a ticked service narrows its environment to that service", () => {
    const s = source({
      projects: new Set([P]),
      environments: new Map([["e1", P]]),
      services: new Map([["s1", "e1"]]),
    });
    expect(sourceCovers(s, serviceInE1)).toBe(true);
    expect(sourceCovers(s, otherServiceInE1)).toBe(false);
    expect(sourceCovers(s, TARGETS.environment)).toBe(true);
    expect(sourceCovers(s, otherEnv)).toBe(false);
  });

  test("all projects covers every project, environment and service", () => {
    const s = source({ allProjects: true });
    for (const target of [otherProject, otherEnv, serviceInE2])
      expect(sourceCovers(s, target)).toBe(true);
    expect(sourceCovers(s, TARGETS.server)).toBe(false);
  });

  test("access is the union of direct grants and every policy", () => {
    const direct = source({ projects: new Set(["p2"]) });
    const policy = source({ policy: { id: "a", name: "A" }, projects: new Set([P]) });
    const g = grants("member", [direct, policy]);
    expect(canSee(g, otherProject)).toBe(true);
    expect(canSee(g, TARGETS.project)).toBe(true);
    expect(canSee(g, { kind: "project", id: "p3" })).toBe(false);
  });
});

describe("scope: servers and Git accounts", () => {
  test("servers are reached by id or by all servers", () => {
    expect(canSee(grants("member", [source({ servers: new Set(["srv1"]) })]), TARGETS.server)).toBe(
      true,
    );
    expect(canSee(grants("member", [source({ allServers: true })]), TARGETS.server)).toBe(true);
    expect(canSee(grants("member", [source({ servers: new Set(["srv2"]) })]), TARGETS.server)).toBe(
      false,
    );
  });

  test("a member reaches their own and shared Git accounts by default", () => {
    const own: AccessTarget = { kind: "git_account", id: "g2", ownerPersonId: ME };
    const shared: AccessTarget = {
      kind: "git_account",
      id: "g3",
      ownerPersonId: "x",
      sharedWithWorkspace: true,
    };
    expect(canSee(grants("member"), own)).toBe(true);
    expect(canSee(grants("member"), shared)).toBe(true);
    expect(canSee(grants("member"), TARGETS.git_account)).toBe(false);
  });

  test("other people's private accounts need the account or all Git accounts", () => {
    expect(
      canSee(grants("member", [source({ gitAccounts: new Set(["g1"]) })]), TARGETS.git_account),
    ).toBe(true);
    expect(canSee(grants("member", [source({ allGitAccounts: true })]), TARGETS.git_account)).toBe(
      true,
    );
  });
});
