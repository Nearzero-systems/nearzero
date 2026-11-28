import { describe, expect, test } from "bun:test";
import { AGENT_POLICY_DESCRIPTIONS, defaultAgentPolicies } from "@nearzero/shared";
import {
  accessNote,
  capabilitySummary,
  fromLabel,
  gitScopeSummary,
  holdersSummary,
  invitationSent,
  invitationStatus,
  joinNames,
  projectScopeSummary,
  serverScopeSummary,
} from "../src/lib/access-text.ts";
import {
  emptyScope,
  grantSources,
  scopeFromTicked,
  shapeOf,
  type TreeKey,
  tickedFromScope,
  toggleNode,
} from "../src/lib/access-tree.ts";
import {
  applySwitch,
  changedSwitches,
  dependencyNotice,
  needsProductionPhrase,
  productionPhraseMatches,
} from "../src/lib/agent-policy-rules.ts";
import { ApiError, apiErrorFrom } from "../src/lib/api-error.ts";
import { avatarProblem } from "../src/lib/avatar.ts";
import { cookieHeader, parseCookieHeader, parseSetCookie } from "../src/lib/cookie-jar.ts";
import type { ProjectTree } from "../src/lib/data/types.ts";
import {
  invitationByIdView,
  invitationNote,
  invitationView,
  looksLikeToken,
} from "../src/lib/invitation-view.ts";
import {
  destinationAfter,
  onboardingPath,
  prefilledEmail,
  requestedPage,
  safeLocalPath,
  signInPath,
} from "../src/lib/next-step.ts";
import { GENERATED_LENGTH, generatePassword, PASSWORD_ALPHABET } from "../src/lib/passwords.ts";
import { settingsVisibility } from "../src/lib/routes.ts";

const NOW = new Date("2026-11-25T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("policy cards and access notes (spec 04 4.7)", () => {
  test("Can: the first two capabilities and N more, in catalog order", () => {
    expect(capabilitySummary([])).toBe("No extra permissions");
    expect(capabilitySummary(["servers.manage"])).toBe("Add and remove servers");
    expect(capabilitySummary(["projects.delete", "projects.create"])).toBe(
      "Create projects, delete projects",
    );
    expect(
      capabilitySummary(["dns.manage", "projects.create", "services.create", "servers.manage"]),
    ).toBe("Create projects, create services and 2 more");
  });

  test("Projects, Servers and Git read the scope", () => {
    const scope = emptyScope();
    expect(projectScopeSummary(scope)).toBe("No projects");
    expect(serverScopeSummary(scope)).toBe("No servers");
    expect(gitScopeSummary(scope)).toBe("Shared Git accounts");
    expect(
      projectScopeSummary({ ...scope, projectIds: ["p1"], environmentIds: ["e1", "e2"] }),
    ).toBe("1 project, 2 environments");
    expect(projectScopeSummary({ ...scope, projectIds: ["p1", "p2"] })).toBe("2 projects");
    expect(projectScopeSummary({ ...scope, allProjects: true, projectIds: ["p1"] })).toBe(
      "All projects",
    );
    expect(serverScopeSummary({ ...scope, allServers: true })).toBe("All servers");
    expect(serverScopeSummary({ ...scope, serverIds: ["s1", "s2"] })).toBe("2 servers");
    expect(gitScopeSummary({ ...scope, allGitAccounts: true })).toBe("All Git accounts");
    expect(gitScopeSummary({ ...scope, gitAccountIds: ["g1"] })).toBe("1 Git account");
  });

  test("holders and From marks name up to three, then count", () => {
    const people = ["Ana", "Ben", "Cy", "Dee", "Eli"].map((name) => ({ name }));
    expect(holdersSummary([])).toBe("Not given to anyone yet.");
    expect(holdersSummary(people.slice(0, 1))).toBe("Given to Ana");
    expect(holdersSummary(people.slice(0, 3))).toBe("Given to Ana, Ben and Cy");
    expect(holdersSummary(people)).toBe("Given to Ana, Ben, Cy and 2 more");
    expect(fromLabel([])).toBe("");
    expect(fromLabel(["Developers"])).toBe("From Developers");
    expect(fromLabel(["A", "B"])).toBe("From A and B");
    expect(fromLabel(["A", "B", "C", "D"])).toBe("From A, B and 2 more");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });

  test("the note under a role", () => {
    const access = { everything: false, policies: [], direct: false };
    expect(accessNote({ role: "owner", access: { ...access, everything: true } })).toBe(
      "Everything",
    );
    expect(accessNote({ role: "admin", access })).toBe("Everything");
    expect(accessNote({ role: "member", access })).toBe("Only what's granted to them");
    expect(
      accessNote({ role: "member", access: { ...access, policies: [{ id: "1", name: "Dev" }] } }),
    ).toBe("Dev");
    expect(
      accessNote({
        role: "member",
        access: { ...access, direct: true, policies: [{ id: "1", name: "Dev" }] },
      }),
    ).toBe("Dev, and direct grants");
  });

  test("invitation statuses", () => {
    const pending = {
      state: "pending" as const,
      expiresAt: new Date(NOW.getTime() + 6 * DAY).toISOString(),
    };
    expect(invitationStatus(pending, NOW)).toEqual({
      label: "Pending",
      detail: "Expires in 6 days",
    });
    // Sent a moment ago, a 7-day link reads "in 7 days" (B3-18).
    const fresh = {
      state: "pending" as const,
      expiresAt: new Date(NOW.getTime() + 7 * DAY - 90_000).toISOString(),
    };
    expect(invitationStatus(fresh, NOW).detail).toBe("Expires in 7 days");
    const late = {
      state: "pending" as const,
      expiresAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    };
    expect(invitationStatus(late, NOW)).toEqual({ label: "Expired", detail: "Expired 2 days ago" });
    expect(
      invitationSent(
        { lastEmailedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), createdAt: "" },
        NOW,
      ),
    ).toBe("Sent 3 hours ago");
    expect(invitationSent({ lastEmailedAt: null, createdAt: NOW.toISOString() }, NOW)).toBe(
      "Sent just now",
    );
  });
});

describe("the projects tree (spec 04 4.7)", () => {
  const projects: ProjectTree[] = [
    {
      id: "p1",
      name: "shop",
      environments: [
        {
          id: "e1",
          name: "development",
          services: [
            { id: "s1", name: "web" },
            { id: "s2", name: "api" },
          ],
        },
        { id: "e2", name: "production", services: [{ id: "s3", name: "web" }] },
      ],
    },
    { id: "p2", name: "site", environments: [] },
  ];
  const shape = shapeOf(projects);

  test("ticking a child ticks its parents", () => {
    const ticked = toggleNode(shape, new Set(), "service:s2", true);
    expect([...ticked].sort()).toEqual(["environment:e1", "project:p1", "service:s2"]);
  });

  test("unticking a parent unticks its children, and leaves the rest", () => {
    const all = new Set<TreeKey>([
      "project:p1",
      "environment:e1",
      "service:s1",
      "environment:e2",
      "service:s3",
      "project:p2",
    ]);
    const after = toggleNode(shape, all, "environment:e1", false);
    expect([...after].sort()).toEqual(["environment:e2", "project:p1", "project:p2", "service:s3"]);
    expect([...toggleNode(shape, all, "project:p1", false)]).toEqual(["project:p2"]);
    // The input set is left as it was.
    expect(all.size).toBe(6);
  });

  test("scopes and ticked keys convert both ways, ids from elsewhere included", () => {
    const scope = { projectIds: ["p1", "gone"], environmentIds: ["e1"], serviceIds: ["s2"] };
    expect(scopeFromTicked(tickedFromScope(scope))).toEqual(scope);
  });

  test("grant sources name the attached policies that give each thing", () => {
    const policies = [
      {
        id: "a",
        name: "Developers",
        capabilities: ["projects.create"],
        scope: { ...emptyScope(), allServers: true, projectIds: ["p1"] },
      },
      {
        id: "b",
        name: "Ops",
        capabilities: ["projects.create", "servers.manage"],
        scope: { ...emptyScope(), serverIds: ["srv"], gitAccountIds: ["g"] },
      },
    ];
    const both = grantSources(policies, new Set(["a", "b"]));
    expect(both.get("capability:projects.create")).toEqual(["Developers", "Ops"]);
    expect(both.get("all:servers")).toEqual(["Developers"]);
    expect(both.get("project:p1")).toEqual(["Developers"]);
    expect(both.get("server:srv")).toEqual(["Ops"]);
    expect(both.get("git:g")).toEqual(["Ops"]);
    const one = grantSources(policies, new Set(["b"]));
    expect(one.get("capability:projects.create")).toEqual(["Ops"]);
    expect(one.has("all:servers")).toBe(false);
  });
});

describe("Agent policies (spec 19.9)", () => {
  const defaults = defaultAgentPolicies();

  test("Import from Git and Assign domains need Create and configure", () => {
    const off = applySwitch(defaults, "services.configure", false);
    expect(off["services.import-git"]).toBe(false);
    expect(off["services.assign-domains"]).toBe(false);
    const on = applySwitch(off, "services.assign-domains", true);
    expect(on["services.configure"]).toBe(true);
    expect(on["services.import-git"]).toBe(false);
    // Other switches are left alone.
    expect(applySwitch(defaults, "ssh-keys.read", true)["services.configure"]).toBe(true);
  });

  test('the page says what else changed: "Also turned on …" and "Also turned off …"', () => {
    const off = applySwitch(defaults, "services.configure", false);
    expect(dependencyNotice(defaults, off, "services.configure")).toBe(
      "Also turned off Import from Git and Assign domains, which need it.",
    );
    const on = applySwitch(off, "services.import-git", true);
    expect(dependencyNotice(off, on, "services.import-git")).toBe(
      "Also turned on Create and configure services, which this needs.",
    );
    expect(
      dependencyNotice(defaults, applySwitch(defaults, "tasks.run", false), "tasks.run"),
    ).toBeNull();
    // Every switch has its one-line description.
    for (const key of Object.keys(defaults)) {
      expect(AGENT_POLICY_DESCRIPTIONS[key as keyof typeof AGENT_POLICY_DESCRIPTIONS]).toMatch(
        /\S/,
      );
    }
  });

  test("production needs the typed phrase only when it is being turned on", () => {
    expect(needsProductionPhrase({ production: false }, { production: true })).toBe(true);
    expect(needsProductionPhrase({ production: true }, { production: true })).toBe(false);
    expect(needsProductionPhrase({ production: true }, { production: false })).toBe(false);
    expect(productionPhraseMatches("ALLOW PRODUCTION AGENT ACTIONS")).toBe(true);
    expect(productionPhraseMatches(" ALLOW PRODUCTION AGENT ACTIONS ")).toBe(true);
    expect(productionPhraseMatches("allow production agent actions")).toBe(false);
  });

  test("only changed switches are reported", () => {
    const next = { ...defaults, "ssh-keys.read": true };
    expect(changedSwitches(defaults, next)).toEqual({ "ssh-keys.read": true });
  });
});

describe("Add user's Generate (spec 04 4.7)", () => {
  test("16 characters without look-alike letters", () => {
    let seed = 7;
    const bytes = (count: number) =>
      Uint8Array.from({ length: count }, () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % 256;
      });
    const password = generatePassword(bytes);
    expect(password).toHaveLength(GENERATED_LENGTH);
    expect(/[0O1lIio]/.test(PASSWORD_ALPHABET)).toBe(false);
    for (const char of password) expect(PASSWORD_ALPHABET).toContain(char);
  });

  test("bytes that would bias the choice are skipped", () => {
    // 255 is above the last whole multiple of the alphabet's size, so it is never used.
    const values = [255, 255, 0, 1];
    let index = 0;
    const password = generatePassword(
      (count) => Uint8Array.from({ length: count }, () => values[index++ % values.length] ?? 0),
      4,
    );
    expect(password).toBe(
      `${PASSWORD_ALPHABET[0]}${PASSWORD_ALPHABET[1]}${PASSWORD_ALPHABET[0]}${PASSWORD_ALPHABET[1]}`,
    );
  });
});

describe("the invitation page (spec 04 4.5)", () => {
  const base = {
    workspaceName: "Acme",
    role: "member" as const,
    email: "sam@example.com",
    signedInEmail: null,
    forAnotherEmail: false,
  };

  test("every state", () => {
    expect(invitationView(null, false)).toEqual({ kind: "incomplete" });
    expect(invitationView({ state: "not_found" }, false)).toEqual({ kind: "not-found" });
    expect(invitationView({ ...base, state: "expired" }, true).kind).toBe("expired");
    expect(invitationView({ ...base, state: "cancelled" }, true).kind).toBe("cancelled");
    expect(invitationView({ ...base, state: "accepted" }, true).kind).toBe("accepted");
    expect(invitationView({ ...base, state: "pending", accountExists: true }, false).kind).toBe(
      "sign-in",
    );
    expect(invitationView({ ...base, state: "pending", accountExists: false }, false).kind).toBe(
      "sign-up",
    );
    expect(invitationView({ ...base, state: "pending" }, true)).toEqual({
      kind: "pending",
      workspaceName: "Acme",
      role: "member",
      email: "sam@example.com",
      inviterName: null,
    });
    expect(
      invitationView(
        { ...base, state: "pending", signedInEmail: "lee@example.com", forAnotherEmail: true },
        true,
      ),
    ).toEqual({
      kind: "other-email",
      workspaceName: "Acme",
      email: "sam@example.com",
      signedInEmail: "lee@example.com",
      inviterName: null,
    });
  });

  test("31a G1-08: used links keep their details, and every state says what to do", () => {
    expect(invitationView({ ...base, state: "accepted" }, true)).toEqual({
      kind: "accepted",
      workspaceName: "Acme",
      inviterName: null,
      role: "member",
      email: "sam@example.com",
    });
    const accepted = invitationView({ ...base, state: "accepted" }, true);
    expect(invitationNote(accepted, true)).toBe("There's nothing left to do with this link.");
    expect(invitationNote(accepted, false)).toBe("Sign in to open Acme.");
    expect(invitationView({ ...base, state: "expired" }, true)).toMatchObject({
      role: "member",
      email: "sam@example.com",
    });
    expect(invitationNote({ kind: "unavailable" })).toBe(
      "Something went wrong on our side. Try again in a moment.",
    );
    expect(invitationNote({ kind: "incomplete" })).toBe(
      "The invitation link is missing its code. Open the link from your invitation email again.",
    );
    expect(invitationNote({ kind: "not-found" })).toBe(
      "This link doesn't match any invitation. It may be mistyped or replaced by a newer one. Ask the person who invited you to send it again.",
    );
  });

  test("the page names who sent it, by their real name (30a R1-09)", () => {
    const from = (state: "pending" | "expired" | "cancelled", inviterName: string | null) =>
      invitationNote(invitationView({ ...base, state, inviterName }, true));
    expect(from("pending", "Ana Ruiz")).toBe("Ana Ruiz invited you to join Acme on Nearzero.");
    expect(from("expired", "Ana Ruiz")).toBe(
      "The invitation to Acme can't be used any more. Ask Ana Ruiz to send it again.",
    );
    expect(from("cancelled", "Ana Ruiz")).toContain("ask Ana Ruiz for a new one.");
    // With no real name, the plain words stay.
    expect(from("pending", null)).toBe("You've been invited to join Acme on Nearzero.");
    expect(from("expired", null)).toBe("The invitation to Acme can't be used any more.");
    expect(
      invitationNote(
        invitationView(
          {
            ...base,
            state: "pending",
            signedInEmail: "lee@example.com",
            forAnotherEmail: true,
            inviterName: "Ana Ruiz",
          },
          true,
        ),
      ),
    ).toBe(
      "Ana Ruiz invited you to join Acme as sam@example.com. You're signed in as lee@example.com.",
    );
    const bell = [
      {
        id: "inv1",
        workspaceName: "Side",
        role: "admin" as const,
        expiresAt: NOW,
        inviterName: "Ana Ruiz",
      },
    ];
    expect(invitationNote(invitationByIdView(bell, "inv1", "lee@example.com"))).toBe(
      "Ana Ruiz invited you to join Side on Nearzero.",
    );
  });

  test("API failures", () => {
    const incomplete = new ApiError({
      status: 400,
      code: "invalid_request",
      message: "This link is incomplete",
      fields: { token: "This link is incomplete" },
    });
    expect(invitationView(incomplete, false)).toEqual({ kind: "incomplete" });
    expect(
      invitationView(
        new ApiError({ status: 503, code: "control_unreachable", message: "x" }),
        false,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(looksLikeToken("short")).toBe(false);
    expect(looksLikeToken("a".repeat(24))).toBe(true);
  });

  test("an invitation named by id", () => {
    const list = [{ id: "inv1", workspaceName: "Side", role: "admin" as const, expiresAt: NOW }];
    expect(invitationByIdView(list, "inv1", "lee@example.com")).toEqual({
      kind: "pending",
      workspaceName: "Side",
      role: "admin",
      email: "lee@example.com",
      inviterName: null,
    });
    expect(invitationByIdView(list, "other", "lee@example.com").kind).toBe("not-found");
  });
});

describe("where people go after signing in (spec 4.1)", () => {
  test("a pending invitation, then onboarding, then the requested page, then the Agent", () => {
    const home = { kind: "home" as const };
    expect(destinationAfter({ next: home, workspaceSlug: "acme", invitationLink: true })).toBe(
      "/invitation",
    );
    expect(
      destinationAfter({
        next: { kind: "invitation", invitationId: "inv 1", workspaceName: "Side" },
        workspaceSlug: "acme",
        requested: "/acme/dashboard/settings",
      }),
    ).toBe("/invitation?id=inv%201");
    expect(
      destinationAfter({
        next: { kind: "onboarding", step: "invite" },
        workspaceSlug: "acme",
        requested: "/acme/dashboard/settings",
      }),
    ).toBe("/onboarding/team");
    expect(
      destinationAfter({
        next: home,
        workspaceSlug: "acme",
        requested: "/acme/dashboard/settings",
      }),
    ).toBe("/acme/dashboard/settings");
    expect(destinationAfter({ next: home, workspaceSlug: "acme" })).toBe("/acme/dashboard/agent");
    expect(onboardingPath("name")).toBe("/onboarding/welcome");
  });

  test("the requested page stays on this console", () => {
    expect(safeLocalPath("/acme/dashboard/projects?q=web")).toBe("/acme/dashboard/projects?q=web");
    expect(safeLocalPath("//evil.example.com/x")).toBeNull();
    expect(safeLocalPath("https://evil.example.com")).toBeNull();
    expect(safeLocalPath("/\\evil.example.com")).toBeNull();
    expect(safeLocalPath("/sign-in?next=/x")).toBeNull();
    expect(safeLocalPath('/x"><script>')).toBeNull();
    expect(signInPath("/acme/dashboard/settings")).toBe(
      "/sign-in?next=%2Facme%2Fdashboard%2Fsettings",
    );
    expect(signInPath("//evil")).toBe("/sign-in");
  });

  test("0.1.x's callbackUrl opens the page it names, with the same check (30a R1-08)", () => {
    const here = new URL("http://203.0.113.10:4321/sign-in");
    const page = (query: string) => requestedPage(new URLSearchParams(query), here);
    expect(page("callbackUrl=/dashboard/projects")).toBe("/dashboard/projects");
    expect(
      page(`callbackUrl=${encodeURIComponent("http://203.0.113.10:4321/dashboard/x?y=1")}`),
    ).toBe("/dashboard/x?y=1");
    expect(page("next=/acme/dashboard/tasks&callbackUrl=/dashboard/projects")).toBe(
      "/acme/dashboard/tasks",
    );
    expect(
      page(`callbackUrl=${encodeURIComponent("https://evil.example.com/dashboard")}`),
    ).toBeNull();
    expect(page("callbackUrl=//evil.example.com/x")).toBeNull();
    expect(page("callbackUrl=javascript:alert(1)")).toBeNull();
    expect(page("callbackUrl=/sign-in")).toBeNull();
    expect(page("")).toBeNull();
  });

  test("?email= fills the sign-in form with a real address only (30a R1-08)", () => {
    expect(prefilledEmail(new URLSearchParams("email=a@b.co"))).toBe("a@b.co");
    expect(prefilledEmail(new URLSearchParams("email=%20sam%40example.com%20"))).toBe(
      "sam@example.com",
    );
    expect(prefilledEmail(new URLSearchParams("email=not-an-email"))).toBe("");
    expect(prefilledEmail(new URLSearchParams(""))).toBe("");
  });
});

describe("the hidden settings entries (spec 18.1)", () => {
  const can = { manageMembers: false, manageAgentPolicies: false, manageApiKeys: false };
  const all = { manageMembers: true, manageAgentPolicies: true, manageApiKeys: true };
  const shown = (visible: Record<string, boolean>) =>
    Object.entries(visible)
      .filter(([, on]) => on)
      .map(([key]) => key);

  test("a member with no extra capabilities sees only About Nearzero", () => {
    const visible = settingsVisibility({
      role: "member",
      isInstanceAdmin: false,
      capabilities: [],
      can,
    });
    expect(shown(visible)).toEqual(["about"]);
  });

  test("an owner who administers the install sees all eight", () => {
    const visible = settingsVisibility({
      role: "owner",
      isInstanceAdmin: true,
      capabilities: [],
      can: all,
    });
    expect(Object.values(visible).every(Boolean)).toBe(true);
    expect(Object.keys(visible)).toHaveLength(8);
  });

  test("router files: instance administrators, owners and admins, and holders of See router files", () => {
    const admin = settingsVisibility({
      role: "admin",
      isInstanceAdmin: false,
      capabilities: [],
      can: all,
    });
    // Owners and admins hold "See router files" for their own workspace's servers (spec 22.3).
    expect(admin["router-files"]).toBe(true);
    expect(admin.members).toBe(true);
    const member = settingsVisibility({
      role: "member",
      isInstanceAdmin: false,
      capabilities: ["servers.manage"],
      can,
    });
    expect(member["router-files"]).toBe(false);
    const reader = settingsVisibility({
      role: "member",
      isInstanceAdmin: false,
      capabilities: ["router-files.read"],
      can,
    });
    expect(reader["router-files"]).toBe(true);
  });

  test("a member's capabilities open Git providers, Backups and Channels", () => {
    expect(
      shown(
        settingsVisibility({
          role: "member",
          isInstanceAdmin: false,
          capabilities: ["git.connect-own", "backups.use-destinations", "notifications.manage"],
          can,
        }),
      ),
    ).toEqual(["about", "git-providers", "backups", "channels"]);
    expect(
      settingsVisibility({
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["backups.manage-destinations"],
        can,
      }).backups,
    ).toBe(true);
  });
});

describe("talking to the API for the browser", () => {
  test("cookies go up as one header and come back from Set-Cookie", () => {
    const jar = parseCookieHeader("nz_theme=dusk; nz_session=abc%3D; nz_theme=light");
    expect(jar.get("nz_theme")).toBe("dusk");
    expect(cookieHeader(jar)).toBe("nz_theme=dusk; nz_session=abc%3D");
    const set = parseSetCookie(
      "nz_session=tok; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    expect(set).toMatchObject({
      name: "nz_session",
      value: "tok",
      maxAge: 604800,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      cleared: false,
    });
    expect(parseSetCookie("nz_session=; Max-Age=0; Path=/")?.cleared).toBe(true);
    expect(
      parseSetCookie("nz_challenge=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")?.cleared,
    ).toBe(true);
    expect(parseSetCookie("garbage")).toBeNull();
  });

  test("errors keep the API's code, words and field messages", () => {
    const error = apiErrorFrom(400, {
      error: {
        code: "invalid_request",
        message: "Enter your first name.",
        fields: { firstName: "Enter your first name.", n: 3 },
        reference: "req_x",
      },
    });
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe("Enter your first name.");
    expect(error.fields).toEqual({ firstName: "Enter your first name." });
    expect(error.reference).toBe("req_x");
    expect(apiErrorFrom(502, "<html>").message).toBe("The request failed (HTTP 502). Try again.");
  });

  test("avatar images: the type and the 2 MB limit", () => {
    const max = 2 * 1024 * 1024;
    expect(avatarProblem({ size: 1000, type: "image/png" }, max)).toBeNull();
    expect(avatarProblem({ size: 1000, type: "image/svg+xml" }, max)).toBe(
      "Use a PNG, JPEG, GIF or WebP image.",
    );
    expect(avatarProblem({ size: max, type: "image/jpeg" }, max)).toBe("Use an image under 2 MB.");
  });
});
