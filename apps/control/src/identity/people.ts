import type { AvatarColor, AvatarKind } from "@nearzero/shared";
import type { Selectable } from "kysely";
import type { Db } from "../db/database.ts";
import type { OnboardingStep, PersonTable } from "../db/schema.ts";
import { sha256Hex } from "../security/tokens.ts";
import { createWorkspace, PERSONAL_WORKSPACE_NAME } from "../workspaces/workspaces.ts";
import { displayName, isRealName } from "./names.ts";

/** Accounts (spec 04): creating them, reading them and how they are shown. */

export type PersonRow = Selectable<PersonTable>;

export interface NewPerson {
  email: string;
  passwordHash: string;
  /** Whether the person proved they receive mail at this address (or an administrator vouched). */
  emailVerified: boolean;
  firstName?: string | null;
  lastName?: string | null;
  onboardingStep: OnboardingStep | null;
}

/**
 * Creates an account and its personal "My Workspace", where the person is owner (spec 04 4.4).
 * Run inside a transaction.
 */
export async function createPerson(
  db: Db,
  input: NewPerson,
): Promise<{ personId: string; personalWorkspaceId: string }> {
  const person = await db
    .insertInto("person")
    .values({
      email: input.email,
      email_verified_at: input.emailVerified ? new Date() : null,
      password_hash: input.passwordHash,
      password_changed_at: new Date(),
      first_name: input.firstName ?? null,
      last_name: input.lastName ?? null,
      onboarding_step: input.onboardingStep,
      onboarding_completed_at: input.onboardingStep === null ? new Date() : null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const workspace = await createWorkspace(db, {
    name: PERSONAL_WORKSPACE_NAME,
    ownerId: person.id,
    personal: true,
  });
  await db
    .updateTable("person")
    .set({ last_workspace_id: workspace.id })
    .where("id", "=", person.id)
    .execute();
  return { personId: person.id, personalWorkspaceId: workspace.id };
}

/** True for the database's refusal of a second account with the same email (person_email_idx). */
export function isDuplicateEmail(error: unknown): boolean {
  const failure = error as { code?: string; constraint?: string } | null;
  return failure?.code === "23505" && failure.constraint === "person_email_idx";
}

export async function findPersonByEmail(db: Db, email: string): Promise<PersonRow | undefined> {
  return db.selectFrom("person").selectAll().where("email", "=", email).executeTakeFirst();
}

export async function getPerson(db: Db, personId: string): Promise<PersonRow> {
  return db.selectFrom("person").selectAll().where("id", "=", personId).executeTakeFirstOrThrow();
}

export interface AvatarView {
  kind: AvatarKind;
  color: AvatarColor | string;
  initials: string;
  /** Where the image is, for uploaded and Gravatar avatars. */
  imageUrl: string | null;
}

export function initialsOf(person: Pick<PersonRow, "first_name" | "last_name" | "email">): string {
  const first = person.first_name?.trim()?.[0];
  const last = person.last_name?.trim()?.[0];
  if (first) return `${first}${last ?? ""}`.toUpperCase();
  return (person.email[0] ?? "?").toUpperCase();
}

export function avatarOf(person: PersonRow, hasImage: boolean): AvatarView {
  let imageUrl: string | null = null;
  if (person.avatar_kind === "image" && hasImage) {
    imageUrl = `/api/v1/people/${person.id}/avatar?v=${person.updated_at.getTime()}`;
  } else if (person.avatar_kind === "gravatar") {
    // Hashed on the server: the browser has no crypto API on plain HTTP (spec 21.9).
    imageUrl = `https://gravatar.com/avatar/${sha256Hex(person.email)}?d=identicon&s=160`;
  }
  return {
    kind: person.avatar_kind,
    color: person.avatar_color,
    initials: initialsOf(person),
    imageUrl,
  };
}

/** A person as other people see them (member lists, "Added by"). */
export interface PersonSummary {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  avatar: AvatarView;
}

export function summarizePerson(person: PersonRow, hasImage: boolean): PersonSummary {
  return {
    id: person.id,
    email: person.email,
    name: displayName(person),
    firstName: person.first_name,
    lastName: person.last_name,
    avatar: avatarOf(person, hasImage),
  };
}

export function hasRealName(person: Pick<PersonRow, "first_name">): boolean {
  return isRealName(person.first_name);
}

export async function avatarImageIds(db: Db, personIds: readonly string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = await db
    .selectFrom("person_avatar_image")
    .select("person_id")
    .where("person_id", "in", [...new Set(personIds)])
    .execute();
  return new Set(rows.map((row) => row.person_id));
}
