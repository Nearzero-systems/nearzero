import {
  AVATAR_COLORS,
  AVATAR_KINDS,
  type AvatarColor,
  type AvatarKind,
  isEmailAddress,
  maskKey,
  normalizeEmail,
  SLUG_MAX,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { WorkspaceSecretKind } from "../db/schema.ts";
import { secretContext as workspaceSecretContext } from "../email/transport.ts";
import { parseLegacyPassword } from "../security/legacy-passwords.ts";
import { hashToken, randomToken } from "../security/tokens.ts";
import { base32Encode } from "../security/totp.ts";
import { chooseSlug, lockSlugs, RESERVED_SLUGS } from "../workspaces/slugs.ts";
import { type ImportRun, NotImported, validDate } from "./importer.ts";
import { agentPolicyNamed, capabilityNamed, roleNamed } from "./labels.ts";
import type { BundleRecord, BundleScope } from "./records.ts";

/**
 * People, workspaces, access policies, members and invitations (spec 29a.5.2–29a.5.6, 29.5
 * "Identity"). Passwords keep their 0.1.x hash (checked and replaced at the first sign-in),
 * two-factor secrets are sealed unchanged with their backup codes' hashes, and workspace slugs
 * and old slugs are kept exactly when they are free.
 */

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INVITATION_DAYS = 7;

function totpContext(personId: string): string {
  return `person:${personId}:totp`;
}

function invitationContext(invitationId: string): string {
  return `invitation:${invitationId}`;
}

function clip(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(0, max);
}

// ---- People

/** The authenticator secret as 1.0 keeps it (base32), from either form the bundle gives. */
function totpSecretOf(twoFactor: NonNullable<BundleRecord<"people">["twoFactor"]>): string | null {
  const given = twoFactor.secretBase32?.replace(/\s+/g, "").toUpperCase().replace(/=+$/, "");
  if (given && /^[A-Z2-7]{16,}$/.test(given)) return given;
  // The HMAC key is the text's UTF-8 bytes (29a.5.1, keyEncoding utf8).
  if (twoFactor.secret) return base32Encode(new TextEncoder().encode(twoFactor.secret));
  return null;
}

async function importPerson(run: ImportRun, record: BundleRecord<"people">): Promise<string> {
  const email = normalizeEmail(record.email);
  if (!isEmailAddress(email)) {
    throw new NotImported(
      record.email,
      "this isn't a valid email address, so the account was left out.",
    );
  }
  if (record.banned) {
    throw new NotImported(email, "the account was banned on 0.1.x, so it was left out.");
  }
  const existing = await run.db
    .selectFrom("person")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirst();
  if (existing) {
    run.collision(
      "people",
      email,
      `An account for ${email} already exists on this server. The import uses it, and it keeps its current password.`,
    );
    return existing.id;
  }

  let passwordHash: string | null = null;
  const password = record.password;
  if (password && password.algorithm !== "unknown") {
    const parsed = parseLegacyPassword({
      algorithm: password.algorithm,
      hash: password.encoded,
      parameters: password.params ?? {},
    });
    if (parsed.ok) passwordHash = parsed.stored;
    else {
      run.changed(
        "people",
        email,
        `${email} can't sign in with their old password: ${parsed.reason}. Set a new one with: sudo nearzero reset-password ${email}`,
      );
    }
  } else {
    run.changed(
      "people",
      email,
      password
        ? `${email}'s password can't be checked by 1.0. Set a new one with: sudo nearzero reset-password ${email}`
        : `${email} has no password. Set one with: sudo nearzero reset-password ${email}`,
    );
  }
  const others = record.otherSignIns ?? [];
  if (others.length > 0) {
    run.dropped(
      "people",
      email,
      `${email} also signed in with ${others.join(", ")}. 1.0 signs in with email and password (spec 27), so they use their password.`,
    );
  }

  // The avatar choice: one of 1.0's kinds, or a color for the initials.
  const avatar = (record.avatar ?? "").trim().toLowerCase();
  const avatarKind: AvatarKind = avatar === "gravatar" ? "gravatar" : "initials";
  const avatarColor: AvatarColor = (AVATAR_COLORS as readonly string[]).includes(avatar)
    ? (avatar as AvatarColor)
    : "violet";
  if (
    avatar === "image" ||
    ((AVATAR_KINDS as readonly string[]).includes(avatar) === false && avatar.includes("/"))
  ) {
    run.changed(
      "people",
      email,
      `${email}'s avatar image isn't in the export, so their initials show instead.`,
    );
  }

  const firstName = clip(record.firstName, 100);
  const created = await run.db
    .insertInto("person")
    .values({
      email,
      // 0.1.x never checked addresses, so its "not verified" flag says nothing: moved accounts
      // count as confirmed and keep seeing their invitations in the bell (30a R1-02).
      email_verified_at: new Date(),
      password_hash: passwordHash,
      first_name: firstName,
      last_name: clip(record.lastName, 100),
      avatar_kind: avatarKind,
      avatar_color: avatarColor,
      // People with a name start where they were; anyone else is asked for it at sign-in.
      onboarding_step: firstName ? null : "name",
      onboarding_completed_at: firstName ? new Date() : null,
      ...(validDate(record.createdAt) ? { created_at: validDate(record.createdAt) as Date } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const twoFactor = record.twoFactor;
  if (twoFactor?.enabled) {
    const secret = twoFactor.unreadable ? null : totpSecretOf(twoFactor);
    if (!secret) {
      run.changed(
        "people",
        email,
        `${email}'s two-factor secret couldn't be carried over, so two-factor sign-in is off for them until they set it up again in Profile.`,
      );
    } else {
      await run.db
        .insertInto("two_factor")
        .values({
          person_id: created.id,
          secret_sealed: run.services.secrets.seal(secret, totpContext(created.id)),
          enabled_at: new Date(),
        })
        .execute();
      // SHA-256 of each unused code as it was shown (29a.5.1); sign-in tries the typed text too.
      const codes = twoFactor.backupCodes;
      const hashes = (codes?.hashes ?? [])
        .map((item) => item.trim().toLowerCase())
        .filter((item) => /^[0-9a-f]{64}$/.test(item));
      const usable =
        codes &&
        (codes.algorithm ?? "sha256").toLowerCase() === "sha256" &&
        (codes.encoding ?? "hex").toLowerCase() === "hex";
      if (usable && hashes.length > 0) {
        await run.db
          .insertInto("two_factor_backup_code")
          .values(
            [...new Set(hashes)].map((hex) => ({
              person_id: created.id,
              code_hash: Buffer.from(hex, "hex"),
            })),
          )
          .execute();
      } else if (codes && (codes.hashes ?? []).length > 0) {
        run.changed(
          "people",
          email,
          `${email}'s backup codes use a form 1.0 can't check. Their authenticator works as before, and they can make new codes in Profile.`,
        );
      }
    }
  }
  return created.id;
}

// ---- Workspaces

async function slugTaken(run: ImportRun, slug: string): Promise<boolean> {
  const row = await sql<{ n: number }>`
    select 1 as n from workspace where slug = ${slug}
    union all
    select 1 as n from workspace_old_slug where slug = ${slug}
    limit 1
  `.execute(run.db);
  return row.rows.length > 0;
}

function usableSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && slug.length <= SLUG_MAX && !RESERVED_SLUGS.has(slug);
}

async function storeWorkspaceSecret(
  run: ImportRun,
  workspaceId: string,
  kind: WorkspaceSecretKind,
  value: string,
): Promise<void> {
  await run.db
    .insertInto("workspace_secret")
    .values({
      workspace_id: workspaceId,
      kind,
      sealed: run.services.secrets.seal(value, workspaceSecretContext(workspaceId, kind)),
      masked: maskKey(value),
    })
    .execute();
}

async function importWorkspace(
  run: ImportRun,
  record: BundleRecord<"workspaces">,
): Promise<string> {
  const name = record.name.trim().slice(0, 100) || "Workspace";
  await lockSlugs(run.db);
  const given = (record.slug ?? "").trim().toLowerCase();
  let slug: string;
  if (given && usableSlug(given) && !(await slugTaken(run, given))) slug = given;
  else {
    slug = await chooseSlug(run.db, given || name);
    if (given && !usableSlug(given)) {
      run.changed(
        "workspaces",
        name,
        `Workspace ${name}: its web address ${given} isn't one 1.0 allows, so it is ${slug} now.`,
      );
    } else if (given) {
      run.collision(
        "workspaces",
        name,
        `Workspace ${name}: the web address ${given} is taken on this server, so it is ${slug} here.`,
      );
    }
  }
  const created = await run.db
    .insertInto("workspace")
    .values({
      name,
      slug,
      logo_url: clip(record.logo, 2048),
      is_personal: record.personal === true,
      created_by: run.id("people", record.ownerRef) ?? null,
      ...(validDate(record.createdAt) ? { created_at: validDate(record.createdAt) as Date } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const id = created.id;

  for (const old of new Set((record.oldSlugs ?? []).map((item) => item.trim().toLowerCase()))) {
    if (old === slug || old === "" || !SLUG_PATTERN.test(old) || old.length > SLUG_MAX) continue;
    if (await slugTaken(run, old)) {
      run.collision(
        "workspaces",
        name,
        `Workspace ${name}: its old web address ${old} is taken on this server, so links to it don't lead here.`,
      );
      continue;
    }
    await run.db.insertInto("workspace_old_slug").values({ slug: old, workspace_id: id }).execute();
  }

  if (record.agentPolicies) {
    const switches: Record<string, boolean> = {};
    for (const [policy, value] of Object.entries(record.agentPolicies)) {
      const known = agentPolicyNamed(policy);
      if (known && typeof value === "boolean") switches[known] = value;
      else {
        run.dropped(
          "workspaces",
          name,
          `Workspace ${name}: the Agent policy "${policy}" isn't in 1.0, so it was left out.`,
        );
      }
    }
    await run.db
      .insertInto("workspace_settings")
      .values({ workspace_id: id, agent_policies: JSON.stringify(switches) })
      .execute();
  }
  if (record.modelKey) await storeWorkspaceSecret(run, id, "model-key", record.modelKey);
  if (record.researchKey) await storeWorkspaceSecret(run, id, "research-key", record.researchKey);
  const email = record.invitationEmail;
  if (email?.resendKey && email.sender) {
    await run.db
      .insertInto("workspace_email")
      .values({ workspace_id: id, provider: "resend", sender: email.sender })
      .execute();
    await storeWorkspaceSecret(run, id, "email-resend-key", email.resendKey);
  } else if (email?.resendKey || email?.sender) {
    run.changed(
      "workspaces",
      name,
      `Workspace ${name}: its invitation email settings are incomplete, so invitations use the server's email until they are set under Settings.`,
    );
  }
  if (record.hostsAllowed) {
    await run.db
      .insertInto("host_allowed_workspace")
      .values({ workspace_id: id })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }
  if (record.firstWorkspace) run.firstWorkspaceId = id;
  return id;
}

/** People and workspaces: everything else hangs off them. */
export async function importIdentity(run: ImportRun): Promise<void> {
  await run.each("people", (record) => importPerson(run, record));
  await run.each("workspaces", (record) => importWorkspace(run, record));
}

// ---- Access: policies, members, invitations (after the objects their scopes name)

interface ScopeItem {
  object_kind: "project" | "environment" | "service" | "server" | "git_account";
  object_id: string;
  parent_id: string | null;
}

/** The scope's objects as 1.0 ids; refs that weren't imported are counted, not fatal. */
async function scopeItems(
  run: ImportRun,
  scope: BundleScope,
): Promise<{ items: ScopeItem[]; missing: number }> {
  const items: ScopeItem[] = [];
  let missing = 0;
  const add = (
    kind: ScopeItem["object_kind"],
    id: string | undefined,
    parent: string | null = null,
  ) => {
    if (id) items.push({ object_kind: kind, object_id: id, parent_id: parent });
    else missing++;
  };
  for (const ref of scope?.projectRefs ?? []) add("project", run.id("projects", ref));
  for (const ref of scope?.environmentRefs ?? []) {
    const id = run.id("environments", ref);
    const row = id
      ? await run.db
          .selectFrom("environment")
          .select("project_id")
          .where("id", "=", id)
          .executeTakeFirst()
      : undefined;
    add("environment", row ? id : undefined, row?.project_id ?? null);
  }
  for (const ref of scope?.serviceRefs ?? []) {
    const id = run.id("services", ref);
    const row = id
      ? await run.db
          .selectFrom("service")
          .select("environment_id")
          .where("id", "=", id)
          .executeTakeFirst()
      : undefined;
    add("service", row ? id : undefined, row?.environment_id ?? null);
  }
  for (const ref of scope?.serverRefs ?? []) add("server", run.id("servers", ref));
  for (const ref of scope?.gitProviderRefs ?? []) add("git_account", run.id("gitProviders", ref));
  return { items, missing };
}

function knownCapabilities(
  run: ImportRun,
  kind: "policies" | "memberships",
  label: string,
  given: string[],
): string[] {
  const known: string[] = [];
  for (const capability of new Set(given)) {
    const key = capabilityNamed(capability);
    if (key) {
      if (!known.includes(key)) known.push(key);
    } else {
      run.dropped(
        kind,
        label,
        `${label}: the capability "${capability}" isn't in 1.0, so it was left out.`,
      );
    }
  }
  return known;
}

async function importPolicy(run: ImportRun, record: BundleRecord<"policies">): Promise<string> {
  const workspaceId = run.id("workspaces", record.workspaceRef);
  if (!workspaceId) {
    throw new NotImported(`Access policy ${record.name}`, "its workspace wasn't imported.");
  }
  let name = record.name.trim().slice(0, 60);
  const label = `Access policy ${name}`;
  const taken = async (candidate: string) =>
    (await run.db
      .selectFrom("access_policy")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where(sql<string>`lower(name)`, "=", candidate.toLowerCase())
      .executeTakeFirst()) !== undefined;
  if (await taken(name)) {
    let n = 2;
    while (await taken(`${name.slice(0, 55)} (${n})`)) n++;
    const next = `${name.slice(0, 55)} (${n})`;
    run.collision(
      "policies",
      name,
      `${label}: this workspace already has a policy with that name, so it is called ${next}.`,
    );
    name = next;
  }
  const scope = await scopeItems(run, record.scope);
  const created = await run.db
    .insertInto("access_policy")
    .values({
      workspace_id: workspaceId,
      name,
      description: (record.description ?? "").slice(0, 240),
      capabilities: knownCapabilities(run, "policies", label, record.capabilities ?? []),
      all_projects: record.scope?.allProjects === true,
      all_servers: record.scope?.allServers === true,
      all_git_accounts: record.scope?.allGitProviders === true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (scope.items.length > 0) {
    await run.db
      .insertInto("access_scope_item")
      .values(
        scope.items.map((item) => ({ ...item, workspace_id: workspaceId, policy_id: created.id })),
      )
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }
  if (scope.missing > 0) {
    run.changed(
      "policies",
      name,
      `${label}: ${scope.missing} of the objects it named weren't imported, so it covers the rest.`,
    );
  }
  return created.id;
}

async function importMembership(
  run: ImportRun,
  record: BundleRecord<"memberships">,
): Promise<string> {
  const personId = run.id("people", record.personRef);
  const workspaceId = run.id("workspaces", record.workspaceRef);
  if (!personId || !workspaceId) {
    throw new NotImported(`Member ${record.ref}`, "their account or workspace wasn't imported.");
  }
  const person = await run.db
    .selectFrom("person")
    .select(["email", "last_workspace_id"])
    .where("id", "=", personId)
    .executeTakeFirstOrThrow();
  const workspace = await run.db
    .selectFrom("workspace")
    .select("name")
    .where("id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  const label = `${person.email} in ${workspace.name}`;
  let role = roleNamed(record.role) ?? "member";
  if (!roleNamed(record.role)) {
    run.changed(
      "memberships",
      label,
      `${label}: the role "${record.role}" isn't in 1.0, so they are a member with their capabilities.`,
    );
  }
  const existing = await run.db
    .selectFrom("membership")
    .select("role")
    .where("workspace_id", "=", workspaceId)
    .where("person_id", "=", personId)
    .executeTakeFirst();
  if (existing) {
    run.collision(
      "memberships",
      label,
      `${label}: already a member here, so their role and access were kept.`,
    );
    return `${workspaceId}:${personId}`;
  }
  if (role === "owner") {
    const owner = await run.db
      .selectFrom("membership")
      .select("person_id")
      .where("workspace_id", "=", workspaceId)
      .where("role", "=", "owner")
      .executeTakeFirst();
    if (owner) {
      role = "admin";
      run.changed(
        "memberships",
        label,
        `${label}: a workspace has one owner in 1.0, so they are an admin.`,
      );
    }
  }
  await run.db
    .insertInto("membership")
    .values({ workspace_id: workspaceId, person_id: personId, role })
    .execute();
  const capabilities = knownCapabilities(run, "memberships", label, record.capabilities ?? []);
  const scope = await scopeItems(run, record.scope);
  const everything = {
    all_projects: record.scope?.allProjects === true,
    all_servers: record.scope?.allServers === true,
    all_git_accounts: record.scope?.allGitProviders === true,
  };
  if (
    capabilities.length > 0 ||
    scope.items.length > 0 ||
    Object.values(everything).some(Boolean)
  ) {
    await run.db
      .insertInto("member_access")
      .values({ workspace_id: workspaceId, person_id: personId, capabilities, ...everything })
      .execute();
    if (scope.items.length > 0) {
      await run.db
        .insertInto("access_scope_item")
        .values(
          scope.items.map((item) => ({ ...item, workspace_id: workspaceId, person_id: personId })),
        )
        .onConflict((conflict) => conflict.doNothing())
        .execute();
    }
  }
  if (scope.missing > 0) {
    run.changed(
      "memberships",
      label,
      `${label}: ${scope.missing} of the objects they could reach weren't imported.`,
    );
  }
  for (const ref of new Set(record.policyRefs)) {
    const policyId = run.id("policies", ref);
    if (!policyId) {
      run.changed("memberships", label, `${label}: one of their access policies wasn't imported.`);
      continue;
    }
    await run.db
      .insertInto("policy_attachment")
      .values({ policy_id: policyId, workspace_id: workspaceId, person_id: personId })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }
  // Where the person lands after signing in.
  if (record.defaultWorkspace || !person.last_workspace_id) {
    await run.db
      .updateTable("person")
      .set({ last_workspace_id: workspaceId })
      .where("id", "=", personId)
      .execute();
  }
  return `${workspaceId}:${personId}`;
}

async function importInvitation(
  run: ImportRun,
  record: BundleRecord<"invitations">,
): Promise<string> {
  const workspaceId = run.id("workspaces", record.workspaceRef);
  const email = normalizeEmail(record.email);
  if (!workspaceId) {
    throw new NotImported(`Invitation for ${email}`, "its workspace wasn't imported.");
  }
  if (!isEmailAddress(email)) {
    throw new NotImported(`Invitation for ${record.email}`, "the address isn't valid.");
  }
  const expires = validDate(record.expiresAt);
  if (expires && expires.getTime() <= Date.now()) {
    throw new NotImported(`Invitation for ${email}`, "it has expired.");
  }
  const pending = await run.db
    .selectFrom("invitation")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("email", "=", email)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (pending) {
    run.collision(
      "invitations",
      email,
      `Invitation for ${email}: one is already pending in that workspace, so it was kept.`,
    );
    return pending.id;
  }
  // Tokens are not carried (spec 29.4): a new one is made, sent on the first resend.
  const id = crypto.randomUUID();
  const token = randomToken(32);
  await run.db
    .insertInto("invitation")
    .values({
      id,
      workspace_id: workspaceId,
      email,
      role: roleNamed(record.role) === "admin" ? "admin" : "member",
      token_hash: hashToken(token),
      token_sealed: run.services.secrets.seal(token, invitationContext(id)),
      invited_by: run.id("people", record.invitedByRef) ?? null,
      expires_at: expires ?? new Date(Date.now() + INVITATION_DAYS * 86_400_000),
    })
    .execute();
  for (const ref of new Set(record.policyRefs)) {
    const policyId = run.id("policies", ref);
    if (policyId) {
      await run.db
        .insertInto("invitation_policy")
        .values({ invitation_id: id, policy_id: policyId, workspace_id: workspaceId })
        .execute();
    }
  }
  return id;
}

/**
 * Makes the bundle's first workspace the install's, so its owners and admins are the instance
 * administrators. An install that already has a first workspace keeps it unless it is still
 * empty (a fresh server's owner with nothing in it yet).
 */
async function settleFirstWorkspace(run: ImportRun): Promise<void> {
  const first = run.firstWorkspaceId;
  if (!first) return;
  const state = await run.db
    .selectFrom("install_state")
    .select("first_workspace_id")
    .executeTakeFirst();
  if (!state) {
    await run.db.insertInto("install_state").values({ first_workspace_id: first }).execute();
    return;
  }
  if (state.first_workspace_id === first) return;
  const current = state.first_workspace_id;
  const [projects, servers, members] = await Promise.all([
    run.db
      .selectFrom("project")
      .select("id")
      .where("workspace_id", "=", current)
      .limit(1)
      .execute(),
    run.db.selectFrom("server").select("id").where("workspace_id", "=", current).limit(1).execute(),
    run.db
      .selectFrom("membership")
      .select("person_id")
      .where("workspace_id", "=", current)
      .execute(),
  ]);
  const name = (
    await run.db
      .selectFrom("workspace")
      .select("name")
      .where("id", "=", first)
      .executeTakeFirstOrThrow()
  ).name;
  if (projects.length === 0 && servers.length === 0 && members.length <= 1) {
    await run.db.updateTable("install_state").set({ first_workspace_id: first }).execute();
    run.report.install.push({
      kind: "install",
      name: "install",
      message: `${name} is now this install's first workspace, so its owners and admins administer Nearzero.`,
    });
  } else {
    run.report.install.push({
      kind: "install",
      name: "install",
      message: `This install already has its own first workspace, so ${name}'s admins don't administer Nearzero here.`,
    });
  }
}

export async function importAccess(run: ImportRun): Promise<void> {
  await run.each("policies", (record) => importPolicy(run, record));
  await run.each("memberships", (record) => importMembership(run, record));
  await run.each("invitations", (record) => importInvitation(run, record));
  await settleFirstWorkspace(run);
}
