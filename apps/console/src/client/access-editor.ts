import type { Capability } from "@nearzero/shared";
import { fromLabel } from "../lib/access-text.ts";
import {
  scopeFromTicked,
  type TreeKey,
  type TreeShape,
  tickedFromScope,
  toggleNode,
} from "../lib/access-tree.ts";
import type { AccessScope } from "../lib/data/types.ts";

/**
 * Reads and fills an AccessEditor (components/members/AccessEditor.astro): capabilities, the
 * project tree (ticking a child ticks its parents, unticking a parent unticks its children),
 * servers and Git accounts, each with an "all, including new ones" switch that covers its list.
 */

export interface Grants {
  capabilities: Capability[];
  scope: AccessScope;
}

function inputs(root: HTMLElement, selector: string): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(selector));
}

function shapeFromDom(root: HTMLElement): TreeShape {
  const parent = new Map<TreeKey, TreeKey>();
  const children = new Map<TreeKey, TreeKey[]>();
  for (const input of inputs(root, "[data-tree-key]")) {
    const key = input.dataset.treeKey as TreeKey;
    children.set(key, children.get(key) ?? []);
    const up = input.dataset.treeParent as TreeKey | undefined;
    if (up) {
      parent.set(key, up);
      const list = children.get(up) ?? [];
      list.push(key);
      children.set(up, list);
    }
  }
  return { parent, children };
}

/** Ids a scope names that this page's lists don't show (kept so saving never drops them). */
const hidden = new WeakMap<HTMLElement, { tree: TreeKey[]; servers: string[]; git: string[] }>();

function syncCovered(root: HTMLElement): void {
  const covers: [string, string][] = [
    ["projects", "[data-tree-key]"],
    ["servers", "[data-server]"],
    ["git", "[data-git]"],
  ];
  for (const [name, selector] of covers) {
    const all = root.querySelector<HTMLInputElement>(`[data-all="${name}"]`)?.checked ?? false;
    for (const input of inputs(root, selector)) {
      input.disabled = all;
      input.closest("label")?.toggleAttribute("data-covered", all);
    }
  }
}

export function fillEditor(root: HTMLElement, grants: Grants): void {
  const capabilities = new Set<string>(grants.capabilities);
  for (const input of inputs(root, "[data-capability]"))
    input.checked = capabilities.has(input.value);
  const ticked = tickedFromScope(grants.scope);
  const shown = new Set<string>();
  for (const input of inputs(root, "[data-tree-key]")) {
    const key = input.dataset.treeKey as TreeKey;
    input.checked = ticked.has(key);
    shown.add(key);
  }
  const servers = new Set(grants.scope.serverIds);
  const shownServers = new Set<string>();
  for (const input of inputs(root, "[data-server]")) {
    input.checked = servers.has(input.value);
    shownServers.add(input.value);
  }
  const git = new Set(grants.scope.gitAccountIds);
  const shownGit = new Set<string>();
  for (const input of inputs(root, "[data-git]")) {
    input.checked = git.has(input.value);
    shownGit.add(input.value);
  }
  hidden.set(root, {
    tree: Array.from(ticked).filter((key) => !shown.has(key)),
    servers: grants.scope.serverIds.filter((id) => !shownServers.has(id)),
    git: grants.scope.gitAccountIds.filter((id) => !shownGit.has(id)),
  });
  const set = (name: string, value: boolean) => {
    const input = root.querySelector<HTMLInputElement>(`[data-all="${name}"]`);
    if (input) input.checked = value;
  };
  set("projects", grants.scope.allProjects);
  set("servers", grants.scope.allServers);
  set("git", grants.scope.allGitAccounts);
  syncCovered(root);
}

export function readEditor(root: HTMLElement): Grants {
  const extra = hidden.get(root) ?? { tree: [], servers: [], git: [] };
  const all = (name: string) =>
    root.querySelector<HTMLInputElement>(`[data-all="${name}"]`)?.checked ?? false;
  const checked = (selector: string) =>
    inputs(root, selector)
      .filter((input) => input.checked)
      .map((input) => input.value);
  const ticked = inputs(root, "[data-tree-key]")
    .filter((input) => input.checked)
    .map((input) => input.dataset.treeKey as TreeKey);
  const allProjects = all("projects");
  const allServers = all("servers");
  const allGitAccounts = all("git");
  const tree = allProjects
    ? { projectIds: [], environmentIds: [], serviceIds: [] }
    : scopeFromTicked([...ticked, ...extra.tree]);
  return {
    capabilities: checked("[data-capability]") as Capability[],
    scope: {
      allProjects,
      ...tree,
      allServers,
      serverIds: allServers ? [] : [...checked("[data-server]"), ...extra.servers],
      allGitAccounts,
      gitAccountIds: allGitAccounts ? [] : [...checked("[data-git]"), ...extra.git],
    },
  };
}

/** Fills the "From <policy>" marks; an empty map clears them. */
export function showSources(root: HTMLElement, sources: Map<string, string[]>): void {
  for (const slot of root.querySelectorAll<HTMLElement>("[data-from]")) {
    const label = fromLabel(sources.get(slot.dataset.from ?? "") ?? []);
    slot.textContent = label;
    slot.hidden = label === "";
  }
}

export function initAccessEditors(): void {
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const root = input.closest<HTMLElement>("[data-access-editor]");
    if (!root) return;
    if (input.dataset.all !== undefined) {
      syncCovered(root);
      return;
    }
    const key = input.dataset.treeKey as TreeKey | undefined;
    if (!key) return;
    const before = new Set(
      inputs(root, "[data-tree-key]")
        .filter((item) => item !== input && item.checked)
        .map((item) => item.dataset.treeKey as TreeKey),
    );
    if (!input.checked) before.add(key);
    const after = toggleNode(shapeFromDom(root), before, key, input.checked);
    for (const item of inputs(root, "[data-tree-key]")) {
      item.checked = after.has(item.dataset.treeKey as TreeKey);
    }
  });
}
