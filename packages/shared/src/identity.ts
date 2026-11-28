import { z } from "zod";
import { CAPABILITY_KEYS, type Capability, INVITABLE_ROLES, POLICY_LIMITS } from "./access.ts";

/**
 * Request schemas and limits for sign-in, registration, profile, workspaces, members, access
 * policies and keys (spec 04). The control plane validates every request with these; the
 * console can use the same ones for its own checks so the words match.
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 320;
export const NAME_MAX = 100;
export const WORKSPACE_NAME_MAX = 100;
export const SLUG_MAX = 48;
export const SESSION_DAYS = 7;
export const INVITATION_DAYS = 7;
export const ONBOARDING_INVITE_MAX = 10;
export const AVATAR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const KEY_MIN = 8;
export const KEY_MAX = 512;
export const SENDER_MAX = 320;

/** The session cookie and the short-lived cookie that carries a two-factor challenge. */
export const SESSION_COOKIE = "nz_session";
export const CHALLENGE_COOKIE = "nz_challenge";

export const AVATAR_KINDS = ["initials", "image", "gravatar"] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

/** Colors an initials avatar can use. */
export const AVATAR_COLORS = [
  "violet",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "slate",
] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

/** Any other color for initials (spec 4.6: a color picker beside the named swatches). */
export const AVATAR_CUSTOM_COLOR = /^#[0-9a-f]{6}$/;

/** A named color, or `#rrggbb` (lowercase). */
export function isAvatarColor(value: string): boolean {
  return (AVATAR_COLORS as readonly string[]).includes(value) || AVATAR_CUSTOM_COLOR.test(value);
}

/**
 * The initials' color on a custom background: white on dark colors, near-black on light ones,
 * whichever reads better (WCAG relative luminance).
 */
export function avatarTextColor(background: string): "#ffffff" | "#111827" {
  if (!AVATAR_CUSTOM_COLOR.test(background)) return "#ffffff";
  const channel = (offset: number) => {
    const value = Number.parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Contrast against white vs. against #111827 (luminance about 0.0116).
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.0616 ? "#ffffff" : "#111827";
}

// A pragmatic address check: something@something.tld, no spaces, no angle brackets.
const EMAIL_PATTERN = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]{2,}$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= EMAIL_MAX && EMAIL_PATTERN.test(value);
}

/** Emails are compared and stored lowercase and trimmed. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** An email field with the sign-in page's wording (spec 04 4.1). */
export const emailField = z
  .string({ error: "Enter your email address." })
  .transform((value) => normalizeEmail(value))
  .pipe(
    z
      .string()
      .min(1, { error: "Enter your email address.", abort: true })
      .refine(isEmailAddress, "Use a valid email address."),
  );

/** A password typed to sign in: only presence and the minimum length are checked. */
export const signInPasswordField = z
  .string({ error: "Enter your password." })
  .min(1, { error: "Enter your password.", abort: true })
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters.`)
  .max(1024, "That password is too long.");

/** A new password (sign-up, change, reset): 8 to 128 characters. */
export const newPasswordField = z
  .string({ error: "New password is required" })
  .min(1, { error: "New password is required", abort: true })
  .min(PASSWORD_MIN, `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`)
  .max(PASSWORD_MAX, `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);

const currentPasswordField = z
  .string({ error: "Enter your current password." })
  .min(1, "Enter your current password.")
  .max(1024, "That password is too long.");

const nameField = (message: string) =>
  z
    .string({ error: message })
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1, message).max(NAME_MAX, `Use at most ${NAME_MAX} characters.`));

const optionalLastName = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().max(NAME_MAX, `Use at most ${NAME_MAX} characters.`));

export const workspaceNameField = z
  .string({ error: "Enter a workspace name." })
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Enter a workspace name.")
      .max(WORKSPACE_NAME_MAX, `Use at most ${WORKSPACE_NAME_MAX} characters.`),
  );

const logoUrlField = z
  .string()
  .trim()
  .max(2048, "Use a logo address of at most 2048 characters.")
  .refine((value) => {
    if (value === "") return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "Use a logo address that starts with https:// or http://.")
  .transform((value) => (value === "" ? null : value));

// ---- Sign-in and registration (spec 04 4.1, 4.2)

export const signInRequestSchema = z.object({
  email: emailField,
  password: signInPasswordField,
});
export type SignInRequest = z.input<typeof signInRequestSchema>;

/**
 * An authenticator code typed or pasted with spaces ("123 456", " 123456 ") is the 6-digit code
 * (spec 04 4.1). Anything else, a backup code included, keeps its own text, only trimmed.
 */
export function compactAuthenticatorCode(value: string): string {
  const compact = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(compact) ? compact : value.trim();
}

export const twoFactorCodeRequestSchema = z.object({
  code: z
    .string({ error: "Enter the 6-digit code or a backup code." })
    .trim()
    .min(1, "Enter the 6-digit code or a backup code.")
    .max(32, "That code is not valid. Try again.")
    .transform(compactAuthenticatorCode),
});

export const invitationTokenSchema = z.object({
  token: z
    .string({ error: "This link is incomplete" })
    .trim()
    .min(16, "This link is incomplete")
    .max(256, "This link is incomplete"),
});

/** The token of a link that confirms an email address (spec 04 4.6). */
export const emailConfirmationRequestSchema = z.object({
  token: z
    .string({ error: "This link is incomplete. Open it again from the email." })
    .trim()
    .min(16, "This link is incomplete. Open it again from the email.")
    .max(256, "This link is incomplete. Open it again from the email."),
});

export const registerRequestSchema = invitationTokenSchema.extend({
  /** The proof carried by the link emailed to the invited address (spec 24 G5). */
  proof: z.string().trim().max(256).optional(),
  /** When sent, must be the invited address (the sign-up page locks it). */
  email: emailField.optional(),
  password: newPasswordField,
});
export type RegisterRequest = z.input<typeof registerRequestSchema>;

// ---- Profile (spec 04 4.6)

export const updateProfileRequestSchema = z
  .object({
    firstName: nameField("Enter your first name.").optional(),
    lastName: optionalLastName.optional(),
    avatarKind: z.enum(AVATAR_KINDS).optional(),
    avatarColor: z
      .string()
      .trim()
      .toLowerCase()
      .refine(isAvatarColor, "Pick one of the colors, or any color as #rrggbb.")
      .optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Nothing to change.",
  });

export const changeEmailRequestSchema = z.object({
  email: emailField,
  currentPassword: currentPasswordField,
});

export const changePasswordRequestSchema = z.object({
  currentPassword: currentPasswordField,
  newPassword: newPasswordField,
});

export const passwordConfirmationSchema = z.object({
  password: currentPasswordField,
});

export const twoFactorSetupRequestSchema = passwordConfirmationSchema.extend({
  issuer: z.string().trim().max(60, "Use an issuer label of at most 60 characters.").optional(),
});

export const twoFactorEnableRequestSchema = z.object({
  code: z
    .string({ error: "Enter the 6-digit code from your authenticator app." })
    .transform(compactAuthenticatorCode)
    .pipe(z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.")),
});

// ---- Onboarding (spec 04 4.3)

export const onboardingWorkspaceRequestSchema = z.object({
  name: nameField("Enter your name."),
  workspaceName: workspaceNameField,
});

export const onboardingNameRequestSchema = z.object({
  name: nameField("Enter your name."),
});

export const onboardingInvitesRequestSchema = z.object({
  /** Comma, semicolon or newline separated, or a list. */
  emails: z.union([z.string().max(10_000), z.array(z.string().max(EMAIL_MAX)).max(100)]),
});

/** Splits "a@x.com, b@x.com; c@x.com" and newline-separated lists into addresses. */
export function splitEmailList(value: string | string[]): string[] {
  const parts = Array.isArray(value) ? value : value.split(/[,;\n\r]+/);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

// ---- Workspaces (spec 04 4.4)

export const createWorkspaceRequestSchema = z.object({
  name: workspaceNameField,
  logoUrl: logoUrlField.optional(),
});

export const updateWorkspaceRequestSchema = z
  .object({
    name: workspaceNameField.optional(),
    /** An empty string or null removes the logo. */
    logoUrl: z.union([logoUrlField, z.null()]).optional(),
  })
  .refine((value) => value.name !== undefined || value.logoUrl !== undefined, {
    message: "Nothing to change.",
  });

// ---- Invitations and members (spec 04 4.5, 4.7)

const roleField = z.enum(INVITABLE_ROLES, {
  error: (issue) =>
    issue.input === "owner"
      ? "Cannot invite a user with the owner role"
      : "Choose Admin or Member.",
});

const idList = z.array(z.string().trim().min(1).max(64)).max(500);

export const createInvitationRequestSchema = z.object({
  email: emailField,
  role: roleField,
  policyIds: idList.default([]),
});

/** Passwords set by an administrator: 8 to 128 characters, no space at either end. */
export const adminSetPasswordField = newPasswordField.refine(
  (value) => value.trim() === value,
  "Remove the spaces at the start or end of the password.",
);

export const addMemberWithPasswordRequestSchema = z.object({
  email: emailField,
  role: roleField,
  policyIds: idList.default([]),
  password: adminSetPasswordField,
});

export const changeRoleRequestSchema = z.object({
  role: z.enum(INVITABLE_ROLES, {
    error: (issue) =>
      issue.input === "owner" ? "The owner role is nontransferable" : "Choose Admin or Member.",
  }),
});

/**
 * An instance administrator sets someone else's address on a server that can't send email
 * (31a G1-02): it counts as confirmed at once.
 */
export const setMemberEmailRequestSchema = z.object({ email: emailField });

// ---- Access (spec 04 4.7)

const capabilityList = z
  .array(z.string())
  .max(CAPABILITY_KEYS.length * 2)
  .superRefine((values, ctx) => {
    for (const value of values) {
      if (!(CAPABILITY_KEYS as string[]).includes(value)) {
        ctx.addIssue({ code: "custom", message: `"${value}" is not a capability Nearzero knows.` });
      }
    }
  })
  .transform((values) => [...new Set(values)] as Capability[]);

/** What a set of grants reaches: projects tree, servers and Git accounts. */
export const accessScopeSchema = z.object({
  allProjects: z.boolean().default(false),
  projectIds: idList.default([]),
  environmentIds: idList.default([]),
  serviceIds: idList.default([]),
  allServers: z.boolean().default(false),
  serverIds: idList.default([]),
  allGitAccounts: z.boolean().default(false),
  gitAccountIds: idList.default([]),
});
export type AccessScopeInput = z.input<typeof accessScopeSchema>;
export type AccessScope = z.output<typeof accessScopeSchema>;

export const accessPolicyRequestSchema = z.object({
  name: z
    .string({ error: "Enter a name for the policy." })
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(
      z
        .string()
        .min(1, "Enter a name for the policy.")
        .max(POLICY_LIMITS.nameMax, `Use at most ${POLICY_LIMITS.nameMax} characters.`),
    ),
  description: z
    .string()
    .trim()
    .max(POLICY_LIMITS.descriptionMax, `Use at most ${POLICY_LIMITS.descriptionMax} characters.`)
    .default(""),
  capabilities: capabilityList.default([]),
  scope: accessScopeSchema.default({
    allProjects: false,
    projectIds: [],
    environmentIds: [],
    serviceIds: [],
    allServers: false,
    serverIds: [],
    allGitAccounts: false,
    gitAccountIds: [],
  }),
});

export const memberAccessRequestSchema = z.object({
  policyIds: idList.default([]),
  capabilities: capabilityList.default([]),
  scope: accessScopeSchema.default({
    allProjects: false,
    projectIds: [],
    environmentIds: [],
    serviceIds: [],
    allServers: false,
    serverIds: [],
    allGitAccounts: false,
    gitAccountIds: [],
  }),
});

// ---- Email settings (spec 04 4.7, decision D4)

/** `team@yourdomain.com` or `Your Team <team@yourdomain.com>`. */
export function isSenderAddress(value: string): boolean {
  if (value.length === 0 || value.length > SENDER_MAX) return false;
  const named = /^([^<>]{1,200}?)\s*<([^<>\s]+)>$/.exec(value);
  if (named?.[2]) return isEmailAddress(named[2]);
  return isEmailAddress(value);
}

const senderField = z
  .string({ error: "Enter the sender as team@yourdomain.com or Your Team <team@yourdomain.com>." })
  .trim()
  .refine(
    isSenderAddress,
    "Enter the sender as team@yourdomain.com or Your Team <team@yourdomain.com>.",
  );

export const SMTP_SECURITY = ["tls", "starttls", "none"] as const;

export const emailSettingsRequestSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("resend"),
    /** Blank keeps the saved key. */
    apiKey: z.string().trim().max(KEY_MAX).optional(),
    from: senderField,
  }),
  z.object({
    provider: z.literal("smtp"),
    host: z
      .string({ error: "Enter the SMTP server's host name." })
      .trim()
      .min(1, "Enter the SMTP server's host name.")
      .max(253, "Use a host name of at most 253 characters.")
      .refine((value) => !/[\s/]/.test(value), "Enter only the host name, like smtp.example.com."),
    port: z.coerce
      .number({ error: "Use a port from 1 to 65535." })
      .int("Use a port from 1 to 65535.")
      .min(1, "Use a port from 1 to 65535.")
      .max(65535, "Use a port from 1 to 65535."),
    security: z.enum(SMTP_SECURITY).default("starttls"),
    username: z.string().trim().max(320).default(""),
    /** Blank keeps the saved password. */
    password: z.string().max(KEY_MAX).optional(),
    from: senderField,
  }),
]);

// ---- Model and research keys (spec 04 4.8)

export const KEY_KINDS = ["model", "research"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

export const saveKeyRequestSchema = z.object({
  key: z
    .string({ error: "Paste the whole key." })
    .trim()
    .min(KEY_MIN, "Paste the whole key.")
    .max(KEY_MAX, "Paste the whole key."),
});

/**
 * How a saved key is shown: its prefix up to an early dash (the first dash, when it is within
 * the first 8 characters) or else its first 3 characters, then "…", then its last 4
 * (spec 04 4.8). "fc-0123…cdef" stays "fc-…cdef"; "re_abc…" becomes "re_…".
 */
export function maskKey(key: string): string {
  const dash = key.indexOf("-");
  const prefix = dash >= 1 && dash < 8 ? key.slice(0, dash + 1) : key.slice(0, 3);
  return `${prefix}…${key.slice(-4)}`;
}
