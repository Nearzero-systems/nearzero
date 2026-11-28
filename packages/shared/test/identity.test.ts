import { describe, expect, test } from "bun:test";
import {
  AGENT_POLICIES,
  CAPABILITIES,
  CAPABILITY_GROUPS,
  defaultAgentPolicies,
  INVITABLE_ROLES,
} from "../src/access.ts";
import {
  accessPolicyRequestSchema,
  avatarTextColor,
  compactAuthenticatorCode,
  createInvitationRequestSchema,
  emailSettingsRequestSchema,
  isAvatarColor,
  isSenderAddress,
  maskKey,
  normalizeEmail,
  signInRequestSchema,
  splitEmailList,
  twoFactorCodeRequestSchema,
  twoFactorEnableRequestSchema,
  updateProfileRequestSchema,
} from "../src/identity.ts";

describe("sign-in form rules (spec 04 4.1)", () => {
  test("uses the page's words", () => {
    const empty = signInRequestSchema.safeParse({ email: "", password: "" });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual([
      "Enter your email address.",
      "Enter your password.",
    ]);
    const bad = signInRequestSchema.safeParse({ email: "a@b", password: "1234567" });
    expect(bad.error?.issues.map((issue) => issue.message)).toEqual([
      "Use a valid email address.",
      "Password must be at least 8 characters.",
    ]);
  });

  test("emails are trimmed and lowercased", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    const parsed = signInRequestSchema.parse({ email: " Ada@Example.com", password: "12345678" });
    expect(parsed.email).toBe("ada@example.com");
  });
});

describe("two-factor codes (spec 04 4.1, 30a R1-07)", () => {
  test("a 6-digit code typed or pasted with spaces is the code", () => {
    for (const typed of ["123 456", " 123456 ", "12 34 56", "123\t456", "123456"]) {
      expect(twoFactorCodeRequestSchema.parse({ code: typed }).code).toBe("123456");
      expect(twoFactorEnableRequestSchema.parse({ code: typed }).code).toBe("123456");
    }
  });

  test("backup codes keep their own text, only trimmed", () => {
    expect(compactAuthenticatorCode(" abcde-fghij ")).toBe("abcde-fghij");
    expect(compactAuthenticatorCode("ABCD EFGH")).toBe("ABCD EFGH");
    expect(twoFactorCodeRequestSchema.parse({ code: " abcde-fghij " }).code).toBe("abcde-fghij");
  });

  test("an empty code and a short one are still refused", () => {
    expect(twoFactorCodeRequestSchema.safeParse({ code: "   " }).success).toBe(false);
    expect(twoFactorEnableRequestSchema.safeParse({ code: "123 45" }).success).toBe(false);
    expect(twoFactorEnableRequestSchema.safeParse({ code: "abcdef" }).success).toBe(false);
  });
});

describe("invitations", () => {
  test("the owner role can't be given", () => {
    const owner = createInvitationRequestSchema.safeParse({ email: "a@b.co", role: "owner" });
    expect(owner.error?.issues[0]?.message).toBe("Cannot invite a user with the owner role");
    expect(INVITABLE_ROLES).toEqual(["admin", "member"]);
  });

  test("teammate lists split on commas, semicolons and new lines", () => {
    expect(splitEmailList("a@x.co, b@x.co;c@x.co\n\n d@x.co ")).toEqual([
      "a@x.co",
      "b@x.co",
      "c@x.co",
      "d@x.co",
    ]);
  });
});

describe("access policies", () => {
  test("names up to 60, descriptions up to 240, known capabilities only", () => {
    expect(accessPolicyRequestSchema.safeParse({ name: "x".repeat(60) }).success).toBe(true);
    expect(accessPolicyRequestSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
    expect(
      accessPolicyRequestSchema.safeParse({ name: "P", description: "d".repeat(241) }).success,
    ).toBe(false);
    expect(
      accessPolicyRequestSchema.safeParse({ name: "P", capabilities: ["servers.manage", "nope"] })
        .success,
    ).toBe(false);
  });

  test("the capability catalog is the spec's 16, with 0.1.79's groups, names and hints", () => {
    expect(Object.keys(CAPABILITIES)).toHaveLength(16);
    // 31a G1-06: "Workspace settings" holds Manage certificates, Manage DNS and See Traefik files.
    expect(
      Object.values(CAPABILITIES)
        .filter((c) => c.group === "Workspace settings")
        .map((c) => c.label),
    ).toEqual(["Manage certificates", "Manage DNS", "See Traefik files"]);
    expect(CAPABILITY_GROUPS).toEqual([
      "Projects and services",
      "Git and SSH",
      "Servers",
      "Backups",
      "Notifications",
      "Workspace settings",
    ]);
    // 31a G1-05: every capability explains itself in one line.
    for (const capability of Object.values(CAPABILITIES)) {
      expect(capability.hint.length).toBeGreaterThan(10);
      expect(capability.hint).toEndWith(".");
    }
    expect(CAPABILITIES["projects.create"].hint).toBe(
      "Start new projects. They get access to the projects they create.",
    );
  });
});

describe("Agent policies (spec 19.9)", () => {
  test("defaults", () => {
    const defaults = defaultAgentPolicies();
    expect(Object.keys(defaults)).toHaveLength(Object.keys(AGENT_POLICIES).length);
    expect(defaults).toMatchObject({
      "projects.create": true,
      "projects.delete-without-production": false,
      "ssh-keys.read": false,
      "servers.remove": false,
      "keys.ask-model-key": true,
      production: false,
    });
  });
});

describe("email settings (spec 04 4.7)", () => {
  test("senders are an address or a name with an address", () => {
    expect(isSenderAddress("team@acme.com")).toBe(true);
    expect(isSenderAddress("Acme Team <team@acme.com>")).toBe(true);
    expect(isSenderAddress("Acme Team")).toBe(false);
    expect(isSenderAddress("<team@acme.com")).toBe(false);
    expect(isSenderAddress(`${"a".repeat(320)}@acme.com`)).toBe(false);
  });

  test("SMTP needs a host and a port from 1 to 65535", () => {
    const bad = emailSettingsRequestSchema.safeParse({
      provider: "smtp",
      host: "",
      port: 70000,
      from: "a@b.co",
    });
    expect(bad.error?.issues.map((issue) => issue.message)).toEqual([
      "Enter the SMTP server's host name.",
      "Use a port from 1 to 65535.",
    ]);
  });
});

describe("masking keys (spec 04 4.8)", () => {
  test("prefix up to an early dash, else 3 characters, then … and the last 4", () => {
    expect(maskKey("sk-or-v1-0123456789abcdef")).toBe("sk-…cdef");
    expect(maskKey("fc-0123456789abcdef")).toBe("fc-…cdef");
    expect(maskKey("re_0123456789")).toBe("re_…6789");
    expect(maskKey("abcdefghijk-lmnop")).toBe("abc…mnop");
  });
});

describe("avatar colors (spec 4.6)", () => {
  test("a named color or any #rrggbb; the initials read on either", () => {
    expect(isAvatarColor("teal")).toBe(true);
    expect(isAvatarColor("#1e90ff")).toBe(true);
    expect(isAvatarColor("#1E90FF")).toBe(false);
    expect(isAvatarColor("#fff")).toBe(false);
    expect(isAvatarColor("red; background: url(x)")).toBe(false);
    expect(avatarTextColor("#111111")).toBe("#ffffff");
    expect(avatarTextColor("#7c3aed")).toBe("#ffffff");
    expect(avatarTextColor("#fde047")).toBe("#111827");
    expect(avatarTextColor("#ffffff")).toBe("#111827");
    expect(
      updateProfileRequestSchema.safeParse({ avatarColor: " #ABCDEF " }).data?.avatarColor,
    ).toBe("#abcdef");
  });
});
