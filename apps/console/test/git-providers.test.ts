import { describe, expect, test } from "bun:test";
import type { GitProviderView } from "../src/lib/data/index.ts";
import {
  authorizeLabel,
  connectPath,
  connectRequest,
  providerBadges,
  sourceFacts,
  withProvider,
} from "../src/lib/git-providers.ts";
import { settingsVisibility } from "../src/lib/routes.ts";

/** Git providers in the console (spec 16.1, 18.1, 6.1, 6.3). */

function provider(overrides: Partial<GitProviderView> = {}): GitProviderView {
  return {
    id: "p1",
    kind: "gitlab",
    kindLabel: "GitLab",
    name: "GitLab",
    owner: { id: "o", name: "Olivia" },
    mine: true,
    shared: false,
    status: "ready",
    statusMessage: null,
    deprecated: false,
    account: "olivia",
    lastError: null,
    createdAt: "2026-11-25T00:00:00.000Z",
    connectedAt: null,
    details: {},
    configured: {},
    openUrl: null,
    can: { share: true, edit: true, delete: true, install: false, authorize: true },
    ...overrides,
  };
}

describe("Settings → Git providers", () => {
  test("members who may use a shared account see the entry; others don't", () => {
    const can = { manageMembers: false, manageAgentPolicies: false, manageApiKeys: false };
    const member = { role: "member" as const, isInstanceAdmin: false, capabilities: [], can };
    expect(settingsVisibility(member)["git-providers"]).toBe(false);
    expect(settingsVisibility({ ...member, usesGitAccounts: true })["git-providers"]).toBe(true);
    expect(
      settingsVisibility({ ...member, capabilities: ["git.connect-own"] })["git-providers"],
    ).toBe(true);
  });

  test("badges: Shared when not yours, Action required, Deprecated", () => {
    expect(providerBadges(provider({ mine: false, shared: true })).map((b) => b.label)).toEqual([
      "Shared",
    ]);
    expect(providerBadges(provider({ mine: true, shared: true })).map((b) => b.label)).toEqual([
      "Shared with workspace",
    ]);
    expect(
      providerBadges(provider({ status: "action_required", deprecated: true })).map((b) => b.label),
    ).toEqual(["Action required", "Deprecated"]);
    expect(authorizeLabel(provider({ status: "action_required" }))).toBe("Authorize");
    expect(authorizeLabel(provider())).toBe("Reconnect");
  });

  test("Connect account comes back to where the person started, and only there", () => {
    const back = withProvider("/acme/dashboard/projects/p/e/new-application", "gitea");
    const path = connectPath("acme", "gitea", back);
    expect(path).toStartWith("/acme/dashboard/settings/git-providers?connect=gitea&return=");
    expect(connectRequest(new URL(`http://console${path}`))).toEqual({
      kind: "gitea",
      install: null,
      returnTo: back,
    });
    expect(
      connectRequest(new URL("http://console/x?connect=svn&return=https://evil.example.com")),
    ).toEqual({ kind: null, install: null, returnTo: null });
    expect(connectPath("acme", "github", "//evil.example.com")).not.toContain("return=");
  });

  test("C3-01: ?install= names a provider by id only, and comes back to the chat", () => {
    const id = "0b3c9a5e-2f14-4c8e-9d7a-6f1e2a3b4c5d";
    const chat = "/acme/dashboard/agent?session=s1";
    expect(
      connectRequest(
        new URL(
          `http://console/acme/dashboard/settings/git-providers?install=${id}&return=${encodeURIComponent(chat)}`,
        ),
      ),
    ).toEqual({ kind: null, install: id, returnTo: chat });
    expect(
      connectRequest(new URL("http://console/x?install=../../etc&return=//evil.example.com")),
    ).toEqual({ kind: null, install: null, returnTo: null });
  });

  test("a service's summary names its provider, or No Git source once the provider is gone", () => {
    const source = {
      type: "provider",
      provider: "gitea",
      providerId: "p",
      repository: "team/web",
      branch: "main",
    };
    expect(sourceFacts({ settings: { source } })).toEqual({
      source: "Gitea",
      branch: "main",
      repository: "team/web",
    });
    expect(sourceFacts({ settings: { source: { ...source, providerId: null } } })?.source).toBe(
      "No Git source",
    );
    expect(sourceFacts({ settings: { source: { type: "image", image: "nginx" } } })).toBeNull();
  });
});
