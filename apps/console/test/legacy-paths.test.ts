import { describe, expect, test } from "bun:test";
import { legacyGitCallbackTarget } from "@nearzero/shared/browser";
import {
  LEGACY_PUBLIC_PATHS,
  legacyDashboardTarget,
  legacyInvitationPath,
  legacyObjectPath,
  legacyObjectTarget,
  legacyPublicTarget,
  movedDashboardPage,
  movedSettingsPath,
} from "../src/lib/legacy-paths.ts";

/** Old addresses keep working (spec 18.1, 29.5). */

const ID = "3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

describe("old addresses", () => {
  test("the path form of 0.1.x's invitation link opens the invitation page (30a R1-08)", () => {
    expect(legacyInvitationPath("tok_abc123")).toBe("/invitation?token=tok_abc123");
    expect(legacyInvitationPath("a/b c", "?proof=p1&token=x")).toBe(
      "/invitation?token=a%2Fb%20c&proof=p1",
    );
  });

  test("settings pages that moved go where spec 18.1 says", () => {
    expect(movedSettingsPath("acme", "server")).toBe("/acme/dashboard/settings");
    expect(movedSettingsPath("acme", "certificates")).toBe(
      "/acme/dashboard/domains?tab=uploaded-certificates",
    );
    expect(movedSettingsPath("acme", "dns")).toBe("/acme/dashboard/domains");
    expect(movedSettingsPath("acme", "profile")).toBe("/acme/dashboard/profile");
    expect(movedSettingsPath("acme", "users")).toBe("/acme/dashboard/settings/members");
    expect(movedSettingsPath("acme", "agent")).toBe("/acme/dashboard/settings/agent-policies");
    expect(movedSettingsPath("acme", "notifications")).toBe("/acme/dashboard/settings/channels");
    expect(movedSettingsPath("acme", "traefik")).toBe("/acme/dashboard/settings/router-files");
    expect(movedSettingsPath("acme", "nothing-like-it")).toBeNull();
  });

  test("addresses without a workspace go to the same page under the active one", () => {
    expect(legacyDashboardTarget("", "", "acme")).toEqual({
      kind: "redirect",
      to: "/acme/dashboard",
    });
    expect(legacyDashboardTarget("projects", "?sort=name", "acme")).toEqual({
      kind: "redirect",
      to: "/acme/dashboard/projects?sort=name",
    });
    expect(legacyDashboardTarget("settings/certificates", "", "acme")).toEqual({
      kind: "redirect",
      to: "/acme/dashboard/domains?tab=uploaded-certificates",
    });
  });

  test("service and deployment links are looked up by id", () => {
    expect(legacyDashboardTarget(`deployments/${ID}`, "", "acme")).toEqual({
      kind: "lookup",
      id: ID,
      deployment: true,
      fallback: `/acme/dashboard/deployments/${ID}`,
    });
    expect(
      legacyDashboardTarget(`project/p1/services/application/${ID}`, "", "acme"),
    ).toMatchObject({ kind: "lookup", id: ID, deployment: false });
    expect(
      legacyDashboardTarget(`projects/${ID}/env/services/${ID.replace("3f", "4f")}`, "", "acme"),
    ).toMatchObject({ kind: "lookup", id: ID.replace("3f", "4f") });
  });

  test("old sign-in, registration and invitation pages", () => {
    expect(LEGACY_PUBLIC_PATHS["/register"]).toBe("/sign-up");
    expect(LEGACY_PUBLIC_PATHS["/accept-invitation"]).toBe("/invitation");
    expect(LEGACY_PUBLIC_PATHS["/login"]).toBe("/sign-in");
    expect(legacyPublicTarget("/login", "?callbackUrl=%2Fdashboard")).toBe(
      "/sign-in?callbackUrl=%2Fdashboard",
    );
    expect(legacyPublicTarget("/sign-in", "")).toBeNull();
  });

  test("31a G1-04: a registration link with its token is the invitation link", () => {
    for (const path of ["/register", "/signup", "/sign-up", "/sign-up/"]) {
      expect(legacyPublicTarget(path, "?token=abc123&email=bob%40example.com")).toBe(
        "/invitation?token=abc123&email=bob%40example.com",
      );
    }
    expect(legacyPublicTarget("/register", "")).toBe("/sign-up");
    expect(legacyPublicTarget("/sign-up", "")).toBeNull();
  });

  test("31a G1-03: 0.1.79's own page addresses and the retired setup wizard", () => {
    expect(movedDashboardPage("acme", "about-nearzero")).toBe("/acme/dashboard/settings");
    expect(movedDashboardPage("acme", "monitoring")).toBe("/acme/dashboard/settings");
    expect(movedDashboardPage("acme", "traefik", "?server=s1")).toBe(
      "/acme/dashboard/settings/router-files?server=s1",
    );
    expect(movedDashboardPage("acme", "home")).toBe("/acme/dashboard/agent");
    expect(movedDashboardPage("acme", "get-started")).toBe("/acme/dashboard/agent");
    expect(movedDashboardPage("acme", "projects")).toBeNull();
    // Without the workspace in the address too.
    expect(legacyDashboardTarget("about-nearzero", "", "acme")).toEqual({
      kind: "redirect",
      to: "/acme/dashboard/settings",
    });
    expect(legacyDashboardTarget("traefik", "?server=s1", "acme")).toEqual({
      kind: "redirect",
      to: "/acme/dashboard/settings/router-files?server=s1",
    });
    expect(legacyPublicTarget("/setup", "")).toBe("/sign-in");
    expect(legacyPublicTarget("/setup/owner", "")).toBe("/sign-in");
    expect(legacyPublicTarget("/setups", "")).toBeNull();
  });
});

describe("old object addresses (spec 29a.9.1)", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const E = "22222222-2222-4222-8222-222222222222";

  test("each kind opens its 1.0 page", () => {
    expect(
      legacyObjectPath({ kind: "project", workspace: "acme", projectId: P, environmentId: E }),
    ).toBe(`/acme/dashboard/projects/${P}/${E}/overview`);
    expect(
      legacyObjectPath({ kind: "environment", workspace: "acme", projectId: P, environmentId: E }),
    ).toBe(`/acme/dashboard/projects/${P}/${E}/overview`);
    expect(
      legacyObjectPath({
        kind: "service",
        workspace: "acme",
        projectId: P,
        environmentId: E,
        serviceId: ID,
      }),
    ).toBe(`/acme/dashboard/projects/${P}/${E}/services/${ID}`);
    expect(legacyObjectPath({ kind: "deployment", workspace: "acme", deploymentId: ID })).toBe(
      `/acme/dashboard/deployments/${ID}`,
    );
    expect(legacyObjectPath({ kind: "server", workspace: "acme", serverId: ID })).toBe(
      "/acme/dashboard/servers",
    );
    expect(legacyObjectPath({ kind: "service", workspace: "acme" })).toBeNull();
  });

  test("the lookup's answer becomes a redirect, a sign-in, or nothing", async () => {
    const asked: string[] = [];
    const target = await legacyObjectTarget("/acme/project/p-1", async (path) => {
      asked.push(path);
      return { target: { kind: "deployment", workspace: "acme", deploymentId: ID } };
    });
    expect(asked).toEqual(["/acme/project/p-1"]);
    expect(target).toEqual({ kind: "redirect", to: `/acme/dashboard/deployments/${ID}` });
    expect(await legacyObjectTarget("/x/y", async () => ({ signIn: true }))).toEqual({
      kind: "sign-in",
    });
    expect(await legacyObjectTarget("/x/y", async () => null)).toBeNull();
    expect(
      await legacyObjectTarget("/x/y", async () => {
        throw new Error("control plane unreachable");
      }),
    ).toBeNull();
    expect(
      await legacyObjectTarget(`/${"a".repeat(2001)}`, async () => ({ signIn: true })),
    ).toBeNull();
  });
});

describe("0.1.x's Git return addresses (R3-41, R4-15)", () => {
  test("GitLab's and Gitea's OAuth redirects go on to 1.0's pages with their query", () => {
    expect(legacyGitCallbackTarget("/api/providers/gitlab/callback", "?code=c1&state=s1")).toBe(
      "/git-providers/gitlab/callback?code=c1&state=s1",
    );
    expect(legacyGitCallbackTarget("/api/providers/gitea/callback/", "code=c2&state=s2")).toBe(
      "/git-providers/gitea/callback?code=c2&state=s2",
    );
  });

  test("a GitHub App's setup return is an install, or with a code alone the app just created", () => {
    expect(
      legacyGitCallbackTarget(
        "/api/providers/github/setup",
        "?installation_id=42&setup_action=install&state=s3",
      ),
    ).toBe("/git-providers/github/installed?installation_id=42&setup_action=install&state=s3");
    expect(legacyGitCallbackTarget("/api/providers/github/setup", "?code=m1&state=s4")).toBe(
      "/git-providers/github/created?code=m1&state=s4",
    );
    expect(legacyGitCallbackTarget("/api/providers/bitbucket/callback", "")).toBeNull();
  });
});
