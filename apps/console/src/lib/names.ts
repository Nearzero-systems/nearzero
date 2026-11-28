/**
 * Real names only (spec 19.2): a first name that looks derived from the email address is never
 * used in a greeting. It looks derived when it contains digits, has more than 12 letters, or is a
 * generic handle.
 */

const GENERIC_HANDLES = new Set([
  "admin",
  "administrator",
  "account",
  "contact",
  "demo",
  "dev",
  "developer",
  "devops",
  "guest",
  "hello",
  "hi",
  "info",
  "mail",
  "me",
  "nearzero",
  "noreply",
  "no-reply",
  "office",
  "ops",
  "owner",
  "root",
  "sales",
  "support",
  "sysadmin",
  "team",
  "test",
  "user",
  "webmaster",
]);

export const NAME_MAX_LENGTH = 80;

export function looksEmailDerived(firstName: string | null | undefined): boolean {
  const name = (firstName ?? "").trim();
  if (!name) return true;
  if (/\d/.test(name)) return true;
  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters.length > 12) return true;
  return GENERIC_HANDLES.has(name.toLowerCase());
}

/** The name a greeting uses: the real first name, or "there". */
export function greetingName(firstName: string | null | undefined): string {
  return looksEmailDerived(firstName) ? "there" : (firstName ?? "").trim();
}

export const SECOND_LINES = [
  "What should we deploy today?",
  "What are we shipping?",
  "How can I help?",
  "What should we work on?",
] as const;

export function timeOfDayGreeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The two greeting lines for a new chat. `pick(n)` returns an integer in [0, n); pages pass a
 * random source, tests a fixed one.
 */
export function greetingLines(
  firstName: string | null | undefined,
  hour: number,
  pick: (choices: number) => number,
): [string, string] {
  const name = greetingName(firstName);
  const first = pick(2) === 0 ? `${timeOfDayGreeting(hour)}, ${name}` : `Hi ${name},`;
  const second = SECOND_LINES[pick(SECOND_LINES.length)] ?? SECOND_LINES[0];
  return [first, second];
}

export function initials(firstName: string, lastName: string, email: string): string {
  const fromName = `${firstName.trim().charAt(0)}${lastName.trim().charAt(0)}`.trim();
  if (fromName && !looksEmailDerived(firstName)) return fromName.toUpperCase();
  return email.trim().charAt(0).toUpperCase() || "?";
}
