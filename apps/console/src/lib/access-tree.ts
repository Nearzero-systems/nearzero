import type { AccessScope, ProjectTree } from "./data/types.ts";

/**
 * The "Projects and environments" tree of the policy and member access dialogs (spec 04 4.7):
 * project → environment → service. Ticking a child ticks its parents; unticking a parent
 * unticks its children. A ticked node with no ticked children covers everything under it,
 * including things made later.
 */

export type TreeKind = "project" | "environment" | "service";

/** "project:prj_1", "environment:env_2", "service:svc_3". */
export type TreeKey = `${TreeKind}:${string}`;

export interface TreeShape {
  parent: Map<TreeKey, TreeKey>;
  children: Map<TreeKey, TreeKey[]>;
}

export function treeKey(kind: TreeKind, id: string): TreeKey {
  return `${kind}:${id}`;
}

export function splitKey(key: TreeKey): { kind: TreeKind; id: string } {
  const index = key.indexOf(":");
  return { kind: key.slice(0, index) as TreeKind, id: key.slice(index + 1) };
}

export function shapeOf(projects: readonly ProjectTree[]): TreeShape {
  const parent = new Map<TreeKey, TreeKey>();
  const children = new Map<TreeKey, TreeKey[]>();
  const link = (child: TreeKey, of: TreeKey) => {
    parent.set(child, of);
    const list = children.get(of) ?? [];
    list.push(child);
    children.set(of, list);
  };
  for (const project of projects) {
    const projectKey = treeKey("project", project.id);
    children.set(projectKey, children.get(projectKey) ?? []);
    for (const environment of project.environments) {
      const environmentKey = treeKey("environment", environment.id);
      link(environmentKey, projectKey);
      for (const service of environment.services) {
        link(treeKey("service", service.id), environmentKey);
      }
    }
  }
  return { parent, children };
}

function ancestors(shape: TreeShape, key: TreeKey): TreeKey[] {
  const result: TreeKey[] = [];
  for (let up = shape.parent.get(key); up; up = shape.parent.get(up)) result.push(up);
  return result;
}

function descendants(shape: TreeShape, key: TreeKey): TreeKey[] {
  const result: TreeKey[] = [];
  const stack = [...(shape.children.get(key) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as TreeKey;
    result.push(next);
    stack.push(...(shape.children.get(next) ?? []));
  }
  return result;
}

/** Ticks or unticks one node and returns the new set (the input is left as it was). */
export function toggleNode(
  shape: TreeShape,
  ticked: ReadonlySet<TreeKey>,
  key: TreeKey,
  on: boolean,
): Set<TreeKey> {
  const next = new Set(ticked);
  if (on) {
    next.add(key);
    for (const up of ancestors(shape, key)) next.add(up);
  } else {
    next.delete(key);
    for (const down of descendants(shape, key)) next.delete(down);
  }
  return next;
}

/** The scope's project part as ticked keys (ids not in the tree are kept as they are). */
export function tickedFromScope(
  scope: Pick<AccessScope, "projectIds" | "environmentIds" | "serviceIds">,
): Set<TreeKey> {
  return new Set<TreeKey>([
    ...scope.projectIds.map((id) => treeKey("project", id)),
    ...scope.environmentIds.map((id) => treeKey("environment", id)),
    ...scope.serviceIds.map((id) => treeKey("service", id)),
  ]);
}

export function scopeFromTicked(
  ticked: Iterable<TreeKey>,
): Pick<AccessScope, "projectIds" | "environmentIds" | "serviceIds"> {
  const scope = {
    projectIds: [] as string[],
    environmentIds: [] as string[],
    serviceIds: [] as string[],
  };
  for (const key of ticked) {
    const { kind, id } = splitKey(key);
    if (kind === "project") scope.projectIds.push(id);
    else if (kind === "environment") scope.environmentIds.push(id);
    else scope.serviceIds.push(id);
  }
  return scope;
}

/** An empty scope: no projects, no servers, only Git accounts shared with everyone. */
export function emptyScope(): AccessScope {
  return {
    allProjects: false,
    projectIds: [],
    environmentIds: [],
    serviceIds: [],
    allServers: false,
    serverIds: [],
    allGitAccounts: false,
    gitAccountIds: [],
  };
}

/**
 * What each attached policy already grants, for the member access dialog's "From <policy>"
 * marks: item keys ("capability:projects.create", "project:prj_1", "server:srv_1", "git:acc_1",
 * "all:projects", "all:servers", "all:git") → the names of the policies that grant them.
 */
export function grantSources(
  policies: readonly {
    id: string;
    name: string;
    capabilities: readonly string[];
    scope: AccessScope;
  }[],
  attached: ReadonlySet<string>,
): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  const add = (key: string, name: string) => {
    const list = sources.get(key) ?? [];
    if (!list.includes(name)) list.push(name);
    sources.set(key, list);
  };
  for (const policy of policies) {
    if (!attached.has(policy.id)) continue;
    for (const capability of policy.capabilities) add(`capability:${capability}`, policy.name);
    const { scope } = policy;
    if (scope.allProjects) add("all:projects", policy.name);
    for (const key of tickedFromScope(scope)) add(key, policy.name);
    if (scope.allServers) add("all:servers", policy.name);
    for (const id of scope.serverIds) add(`server:${id}`, policy.name);
    if (scope.allGitAccounts) add("all:git", policy.name);
    for (const id of scope.gitAccountIds) add(`git:${id}`, policy.name);
  }
  return sources;
}
