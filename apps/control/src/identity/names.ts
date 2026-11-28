/**
 * Whether a name is a person's real name, for greetings and onboarding (spec 04 4.3). A name
 * that only repeats the email's handle never counts: one with digits, a single word longer than
 * 12 letters, or a generic handle such as admin, owner or root.
 */

const GENERIC_HANDLES = new Set([
  "admin",
  "administrator",
  "owner",
  "root",
  "user",
  "users",
  "info",
  "contact",
  "hello",
  "hi",
  "support",
  "team",
  "test",
  "tester",
  "mail",
  "email",
  "me",
  "dev",
  "devops",
  "ops",
  "sysadmin",
  "webmaster",
  "postmaster",
  "hostmaster",
  "noreply",
  "no-reply",
  "nearzero",
  "office",
  "sales",
  "billing",
  "security",
  "it",
]);

export function isRealName(firstName: string | null | undefined): boolean {
  const name = firstName?.trim() ?? "";
  if (name === "") return false;
  if (/\d/.test(name)) return false;
  const lowered = name.toLowerCase();
  if (GENERIC_HANDLES.has(lowered)) return false;
  // A single run of letters longer than 12 reads like a joined-up handle ("johnsmithdev").
  if (!/[\s'-]/.test(name) && name.length > 12) return false;
  if (name.includes("@") || name.includes("_")) return false;
  return true;
}

/** Splits "Ada Lovelace" into a first name and the rest. */
export function splitFullName(full: string): { firstName: string; lastName: string } {
  const clean = full.trim().replace(/\s+/g, " ");
  const space = clean.indexOf(" ");
  if (space === -1) return { firstName: clean, lastName: "" };
  return { firstName: clean.slice(0, space), lastName: clean.slice(space + 1) };
}

export function displayName(person: {
  first_name: string | null;
  last_name: string | null;
  email: string;
}): string {
  const full = [person.first_name, person.last_name].filter((part) => part?.trim()).join(" ");
  return full || person.email;
}
