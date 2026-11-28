import {
  AppError,
  isEmailAddress,
  normalizeEmail,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { setVouchedEmail } from "../identity/email-confirmation.ts";
import { createPerson, findPersonByEmail } from "../identity/people.ts";
import { endOtherSessions } from "../identity/sessions.ts";
import { disableTwoFactor, twoFactorStatus } from "../identity/two-factor.ts";
import {
  MIGRATION_USAGE,
  type MigrationCliOptions,
  runMigrationCommand,
} from "../migration/cli.ts";
import type { ControlServices } from "../services.ts";
import { AUDIT_USAGE, exportAudit } from "./audit-export.ts";
import { RUNNER_LINK_USAGE, runnerLinkCommand } from "./runner-link.ts";

/**
 * The account commands the `nearzero` server command runs inside the container (spec 03 3.4):
 * create-owner, reset-password, set-email and reset-2fa, and owner-status for the installer. Each reads
 * from a terminal when there is one, or from standard input lines when there isn't, and never
 * prints a password. create-owner and owner-status also answer in JSON for scripts.
 */

export interface CliIo {
  /** True when standard input is a terminal a person types into. */
  interactive: boolean;
  /** One line of input, or null at the end of input. */
  readLine(prompt: string): Promise<string | null>;
  /** Like readLine, without echoing what is typed. */
  readSecret(prompt: string): Promise<string | null>;
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = [
  "Usage: nearzero-control <command> [options]",
  "",
  "Commands:",
  "  create-owner [--json]     Create the admin account if none exists",
  "  owner-status [--json]     Say whether the admin account exists, and its email",
  "  console-hostname [--json] Say the console's hostname saved under About Nearzero, if any",
  "  host-work [--json]        Count the task runs, backups and restores running on the host",
  "  reset-password [email]    Set a new password and sign out its sessions. Without an email,",
  "                            the first line names the account (empty: the owner)",
  "  set-email <old> <new>     Change an account's email address; it counts as confirmed",
  "  reset-2fa [email] [--yes] Turn off two-factor sign-in for an account (defaults to the owner)",
  AUDIT_USAGE,
  ...RUNNER_LINK_USAGE,
  ...MIGRATION_USAGE,
  "  help                      Show this help",
  "",
  "With --json, the answer is one JSON line on standard output for scripts (the installer), and",
  "the messages for people go to standard error. create-owner --json exits 0 when the account was",
  "created, 2 when the input was missing or invalid, 3 when an owner exists, and 4 when the email",
  "already has an account.",
];

/**
 * The machine-readable answers of create-owner --json (and their exit codes) and of
 * owner-status --json, which the installer reads instead of the wording of the messages.
 */
export type OwnerOutcome =
  | { result: "created"; email: string }
  | { result: "owner_exists"; email: string | null }
  | { result: "account_exists"; email: string }
  | { result: "invalid_input"; field: "email" | "password" }
  | { result: "no_input" };

export const OWNER_EXIT_CODES: Record<OwnerOutcome["result"], number> = {
  created: 0,
  invalid_input: 2,
  no_input: 2,
  owner_exists: 3,
  account_exists: 4,
};

export type OwnerStatus = { owner: "exists"; email: string } | { owner: "missing" };

const BAD_EMAIL = "Enter a valid email address, like you@company.com.";
const BAD_PASSWORD_LENGTH = `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`;
const PASSWORDS_DIFFER = "The passwords don't match. Try again.";
const RESET_PASSWORD_LENGTH = `Use a password between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`;

function passwordLengthOk(password: string): boolean {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

async function ownerEmail(services: ControlServices): Promise<string | null> {
  const row = await services.db
    .selectFrom("install_state as s")
    .innerJoin("membership as m", (join) =>
      join.onRef("m.workspace_id", "=", "s.first_workspace_id").on("m.role", "=", "owner"),
    )
    .innerJoin("person as p", "p.id", "m.person_id")
    .select("p.email")
    .executeTakeFirst();
  return row?.email ?? null;
}

/**
 * Asks for a new password twice on a terminal; reads one line otherwise. Null at the end of the
 * input, "invalid" for a line of the wrong length.
 */
async function readNewPassword(
  io: CliIo,
  prompt: string,
  lengthMessage: string,
): Promise<string | "invalid" | null> {
  if (!io.interactive) {
    const line = await io.readLine("");
    if (line === null || !passwordLengthOk(line)) {
      io.err(lengthMessage);
      return line === null ? null : "invalid";
    }
    return line;
  }
  for (;;) {
    const first = await io.readSecret(prompt);
    if (first === null) return null;
    if (!passwordLengthOk(first)) {
      io.err(lengthMessage);
      continue;
    }
    const second = await io.readSecret("Confirm password: ");
    if (second === null) return null;
    if (first !== second) {
      io.err(PASSWORDS_DIFFER);
      continue;
    }
    return first;
  }
}

async function createOwner(services: ControlServices, io: CliIo): Promise<OwnerOutcome> {
  const existing = await ownerEmail(services);
  if (existing) {
    io.err(`This server already has an owner: ${existing}`);
    io.err("Forgot the password? Run: sudo nearzero reset-password");
    return { result: "owner_exists", email: existing };
  }

  let email: string | null = null;
  if (io.interactive) {
    io.out("Create your admin account");
    for (;;) {
      const line = await io.readLine("Email: ");
      if (line === null) return { result: "no_input" };
      const candidate = normalizeEmail(line);
      if (isEmailAddress(candidate)) {
        email = candidate;
        break;
      }
      io.err(BAD_EMAIL);
    }
  } else {
    const line = await io.readLine("");
    const candidate = line === null ? "" : normalizeEmail(line);
    if (!isEmailAddress(candidate)) {
      io.err(BAD_EMAIL);
      return candidate === ""
        ? { result: "no_input" }
        : { result: "invalid_input", field: "email" };
    }
    email = candidate;
  }
  const password = await readNewPassword(
    io,
    `Password (${PASSWORD_MIN}+ characters): `,
    BAD_PASSWORD_LENGTH,
  );
  if (password === null) return { result: "no_input" };
  if (password === "invalid") return { result: "invalid_input", field: "password" };

  const hash = await services.passwords.hash(password);
  const outcome = await services.db.transaction().execute(async (trx) => {
    // Two create-owner runs at once can't both make an owner.
    await sql`select pg_advisory_xact_lock(7204315120)`.execute(trx);
    const state = await trx.selectFrom("install_state").select("singleton").executeTakeFirst();
    if (state) return "owner-exists" as const;
    if (await findPersonByEmail(trx, email)) return "account-exists" as const;
    // No name yet, so the first sign-in runs onboarding (spec 04 4.3).
    const created = await createPerson(trx, {
      email,
      passwordHash: hash,
      emailVerified: true,
      onboardingStep: "workspace",
    });
    await trx
      .insertInto("install_state")
      .values({ first_workspace_id: created.personalWorkspaceId })
      .execute();
    return created;
  });
  if (outcome === "owner-exists") {
    const owner = await ownerEmail(services);
    io.err(`This server already has an owner: ${owner ?? "unknown"}`);
    io.err("Forgot the password? Run: sudo nearzero reset-password");
    return { result: "owner_exists", email: owner };
  }
  if (outcome === "account-exists") {
    io.err(`An account already exists for ${email}. Use another email address.`);
    return { result: "account_exists", email };
  }
  await recordAudit(
    services.db,
    services.log,
    { kind: "command", personId: outcome.personId, label: email },
    { action: "command.create-owner", workspaceId: outcome.personalWorkspaceId },
  );
  const address = services.consoleUrl() ?? "http://<this server's IP address>:4321";
  io.out(`Admin account created. Sign in at ${address} as ${email}`);
  return { result: "created", email };
}

/** Whether the admin account exists (read-only; it never asks for anything). */
async function ownerStatus(services: ControlServices, io: CliIo): Promise<OwnerStatus> {
  const email = await ownerEmail(services);
  if (email) {
    io.out(`The admin account is ${email}.`);
    return { owner: "exists", email };
  }
  io.out("This server has no owner yet. Run: sudo nearzero create-owner");
  return { owner: "missing" };
}

async function targetAccount(
  services: ControlServices,
  io: CliIo,
  given: string | undefined,
): Promise<{ id: string; email: string } | null> {
  const email = given ? normalizeEmail(given) : await ownerEmail(services);
  if (!email) {
    io.err("This server has no owner yet. Run: sudo nearzero create-owner");
    return null;
  }
  const person = await findPersonByEmail(services.db, email);
  if (!person) {
    io.err(`No account exists for ${email}.`);
    return null;
  }
  return { id: person.id, email: person.email };
}

/**
 * The account reset-password works on (31a G1-01, spec 03 3.4): the email argument, else the
 * first line of input, where an empty line (or Enter at "Email [<owner>]:") means the owner. So
 * 0.1.x's `printf 'bob@example.com\nNewPass123\n' | sudo nearzero reset-password` resets Bob.
 */
async function resetPasswordAccount(
  services: ControlServices,
  io: CliIo,
  given: string | undefined,
): Promise<{ id: string; email: string } | null> {
  if (given) return targetAccount(services, io, given);
  const owner = await ownerEmail(services);
  const line = await io.readLine(io.interactive ? `Email [${owner ?? "no owner yet"}]: ` : "");
  if (line === null) {
    io.err("No email was given, so no password was changed.");
    return null;
  }
  const typed = normalizeEmail(line);
  if (typed !== "" && !isEmailAddress(typed)) {
    io.err(BAD_EMAIL);
    return null;
  }
  return targetAccount(services, io, typed === "" ? undefined : typed);
}

async function resetPassword(
  services: ControlServices,
  io: CliIo,
  email: string | undefined,
): Promise<number> {
  const person = await resetPasswordAccount(services, io, email);
  if (!person) return 1;
  const password = await readNewPassword(
    io,
    `New password for ${person.email} (${PASSWORD_MIN}+ characters): `,
    RESET_PASSWORD_LENGTH,
  );
  if (password === null || password === "invalid") return 1;
  const hash = await services.passwords.hash(password);
  await services.db
    .updateTable("person")
    .set({ password_hash: hash, password_changed_at: sql<Date>`now()`, updated_at: new Date() })
    .where("id", "=", person.id)
    .execute();
  await endOtherSessions(services.db, person.id, null);
  // A locked-out person can sign in again at once.
  await services.db
    .deleteFrom("attempt_record")
    .where((eb) =>
      eb.or([
        eb.and([eb("bucket", "=", "sign-in"), eb("subject", "like", `${person.email}|%`)]),
        eb.and([eb("bucket", "=", "sign-in-email"), eb("subject", "=", person.email)]),
        eb.and([eb("bucket", "=", "password-check"), eb("subject", "=", person.id)]),
      ]),
    )
    .execute();
  await recordAudit(
    services.db,
    services.log,
    { kind: "command", label: "nearzero reset-password" },
    { action: "command.reset-password", target: { kind: "person", id: person.id } },
  );
  io.out(`Password updated for ${person.email}. Its other sessions were signed out.`);
  return 0;
}

export const SET_EMAIL_USAGE = "Usage: sudo nearzero set-email <current email> <new email>";

/**
 * Gives an account a new address from the server (31a G1-02, the decision in spec 31): root
 * vouches for it, so it counts as confirmed, the account's sessions end and the change is
 * audited. Giving the account's own unconfirmed address again confirms it.
 */
async function setEmail(
  services: ControlServices,
  io: CliIo,
  args: readonly string[],
): Promise<number> {
  const [currentArg, nextArg, extra] = args;
  if (!currentArg || !nextArg || extra !== undefined) {
    io.err(SET_EMAIL_USAGE);
    return 1;
  }
  const current = normalizeEmail(currentArg);
  const next = normalizeEmail(nextArg);
  if (!isEmailAddress(next)) {
    io.err(BAD_EMAIL);
    return 1;
  }
  const person = await findPersonByEmail(services.db, current);
  if (!person) {
    io.err(`No account exists for ${current}.`);
    return 1;
  }
  try {
    const result = await setVouchedEmail(services, person.id, next, {
      actor: { kind: "command", label: "nearzero set-email" },
    });
    if (!result.updated) io.out(`${next} is already this account's confirmed address.`);
    else if (result.changed) {
      io.out(
        `Email changed from ${current} to ${next}. It counts as confirmed, and the account's sessions were signed out.`,
      );
    } else io.out(`${next} is confirmed.`);
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function resetTwoFactor(
  services: ControlServices,
  io: CliIo,
  email: string | undefined,
  confirmed: boolean,
): Promise<number> {
  const person = await targetAccount(services, io, email);
  if (!person) return 1;
  const status = await twoFactorStatus(services.db, person.id);
  if (!status.enabled) {
    io.out(`Two-factor sign-in is already off for ${person.email}.`);
    return 0;
  }
  if (!confirmed) {
    if (!io.interactive) {
      io.err(
        "No terminal to confirm on, so nothing was changed. Run it again with --yes to turn off two-factor sign-in.",
      );
      return 1;
    }
    const answer = await io.readLine(`Turn off two-factor sign-in for ${person.email}? [y/N] `);
    if (answer?.trim().toLowerCase() !== "y") {
      io.out("Nothing was changed.");
      return 1;
    }
  }
  await disableTwoFactor(services.db, person.id);
  await recordAudit(
    services.db,
    services.log,
    { kind: "command", label: "nearzero reset-2fa" },
    { action: "command.reset-two-factor", target: { kind: "person", id: person.id } },
  );
  io.out(
    `Two-factor sign-in is off for ${person.email}. They sign in with their password until they turn it on again in Profile.`,
  );
  return 0;
}

/** Runs one command and returns the exit code. */
/** Long work running on the Nearzero host now, which its runner carries out (C2-10). */
export async function hostWork(
  services: ControlServices,
): Promise<{ taskRuns: number; backups: number; restores: number }> {
  const tasks = await services.db
    .selectFrom("task_run as r")
    .innerJoin("task as t", "t.id", "r.task_id")
    .leftJoin("service as s", "s.id", "t.service_id")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("r.status", "=", "running")
    .where((eb) =>
      eb.or([
        eb("t.place", "=", "host"),
        eb.and([eb("t.place", "=", "container"), eb("s.server_id", "is", null)]),
      ]),
    )
    .executeTakeFirst();
  const runs = await services.db
    .selectFrom("backup_run")
    .select(["operation", (eb) => eb.fn.countAll<string>().as("n")])
    .where("status", "=", "running")
    .where("server_id", "is", null)
    .groupBy("operation")
    .execute();
  const count = (operation: string) =>
    Number(runs.find((row) => row.operation === operation)?.n ?? 0);
  return {
    taskRuns: Number(tasks?.n ?? 0),
    backups: count("backup"),
    restores: count("restore"),
  };
}

export async function runCommand(
  args: readonly string[],
  services: ControlServices,
  io: CliIo,
  migration: MigrationCliOptions = {
    env: process.env,
    // "-" reads the export from standard input (the nearzero command streams it in).
    readFile: async (path) =>
      new Uint8Array(await (path === "-" ? Bun.stdin : Bun.file(path)).arrayBuffer()),
  },
  /** The runner link's certificate folder (NEARZERO_RUNNER_TLS_DIR), for runner-link. */
  runnerTlsDirectory: string | null = null,
): Promise<number> {
  // Moving a 0.1.x install to 1.0 (spec 29): import and migrate.
  const moved = await runMigrationCommand(args, services, io, migration);
  if (moved !== null) return moved;
  const [command, ...rest] = args;
  const flags = new Set(rest.filter((arg) => arg.startsWith("-")));
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  const json = flags.has("--json");
  // In JSON mode standard output carries only the answer; people's messages go to standard error.
  const quiet: CliIo = json ? { ...io, out: (line) => io.err(line) } : io;
  switch (command) {
    case "create-owner": {
      const outcome = await createOwner(services, quiet);
      if (!json) return outcome.result === "created" ? 0 : 1;
      io.out(JSON.stringify(outcome));
      return OWNER_EXIT_CODES[outcome.result];
    }
    case "owner-status": {
      const status = await ownerStatus(services, quiet);
      if (json) io.out(JSON.stringify(status));
      return 0;
    }
    case "console-hostname": {
      // The installer asks before its domain question (G4-20): a hostname saved under About
      // Nearzero counts as the console's, so a rerun neither asks again nor sets another.
      const row = await services.db
        .selectFrom("address_setting")
        .select("value")
        .where("key", "=", "console_hostname")
        .executeTakeFirst();
      const hostname = row?.value ?? null;
      if (json) io.out(JSON.stringify({ hostname }));
      else
        io.out(
          hostname
            ? `The console's hostname, saved under About Nearzero, is ${hostname}.`
            : "No hostname is saved under About Nearzero.",
        );
      return 0;
    }
    case "host-work": {
      // The installer asks before it replaces the host's runner on an upgrade (C2-10): that
      // stops what the runner runs, so it waits for this to reach nothing first.
      const work = await hostWork(services);
      if (json) io.out(JSON.stringify(work));
      else
        io.out(
          `On the Nearzero host: ${work.taskRuns} task runs, ${work.backups} backups and ${work.restores} restores running.`,
        );
      return 0;
    }
    case "reset-password":
      return resetPassword(services, io, positional[0]);
    case "set-email":
      return setEmail(services, io, positional);
    case "reset-2fa":
      return resetTwoFactor(services, io, positional[0], flags.has("--yes") || flags.has("-y"));
    case "audit":
      return exportAudit(services, io, rest);
    case "runner-link":
      return runnerLinkCommand(rest, services, io, runnerTlsDirectory);
    case "help":
    case "--help":
    case undefined:
      for (const line of USAGE) io.out(line);
      return command === undefined ? 1 : 0;
    default:
      io.err(`Unknown command: ${command}`);
      for (const line of USAGE) io.err(line);
      return 1;
  }
}
