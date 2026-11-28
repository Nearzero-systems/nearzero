import {
  hostKeyChangedMessage,
  hostKeyUnknownMessage,
  SETUP_MESSAGES,
  type SetupFailureKind,
  type SetupFailureView,
  sudoFixCommand,
  unreachableMessage,
  wrongUserMessage,
} from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import type { ControlServices } from "../services.ts";
import { openPrivateKey } from "../ssh-keys/keys.ts";
import {
  askedForUser,
  parseFacts,
  type SudoProblem,
  type SystemFacts,
  sudoProblem,
  sudoProblemMessage,
} from "./parse.ts";
import { FACTS_PROBE, remoteCommand } from "./scripts.ts";
import { setupSettings } from "./settings.ts";
import { SshFailure, type SshSession } from "./ssh.ts";

/**
 * Signing in to a server the way every SSH part of Nearzero does (setup, validation, the audit,
 * removing the runner): the server's own key, its host key checked against the one recorded,
 * then a first command that tells a cloud image's refusal of the user apart from a working
 * sign-in, and passwordless sudo for users other than root (spec 09 9.3 "Failure messages").
 */

export interface ServerAccess {
  id: string;
  workspaceId: string;
  name: string;
  address: string;
  port: number;
  user: string;
  sshKeyId: string;
  hostKeyFingerprint: string | null;
}

export async function loadServerAccess(db: Db, serverId: string): Promise<ServerAccess | null> {
  const row = await db
    .selectFrom("server")
    .select([
      "id",
      "workspace_id",
      "name",
      "address",
      "port",
      "ssh_user",
      "ssh_key_id",
      "host_key_fingerprint",
    ])
    .where("id", "=", serverId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    address: row.address,
    port: row.port,
    user: row.ssh_user,
    sshKeyId: row.ssh_key_id,
    hostKeyFingerprint: row.host_key_fingerprint,
  };
}

/** A sign-in that didn't work, as the setup dialog shows it. */
export class AccessFailure extends Error {
  readonly failure: SetupFailureView;
  constructor(failure: SetupFailureView) {
    super(failure.message);
    this.name = "AccessFailure";
    this.failure = failure;
  }
}

export function failure(
  kind: SetupFailureKind,
  message: string,
  extra: Partial<Omit<SetupFailureView, "kind" | "message">> = {},
): SetupFailureView {
  return {
    kind,
    message,
    hints: extra.hints ?? [],
    suggestedUser: extra.suggestedUser ?? null,
    fixCommand: extra.fixCommand ?? null,
    presentedFingerprint: extra.presentedFingerprint ?? null,
  };
}

/** The failure people see for an SSH error while connecting. */
export function failureFromSsh(error: SshFailure, server: ServerAccess): SetupFailureView {
  switch (error.kind) {
    case "key_rejected":
      return failure("key_rejected", SETUP_MESSAGES.keyRejected, {
        hints: [...SETUP_MESSAGES.keyRejectedHints],
      });
    case "host_key_unknown":
      return failure(
        "host_key_unknown",
        hostKeyUnknownMessage(error.fingerprint ?? "an unknown key"),
        {
          presentedFingerprint: error.fingerprint,
        },
      );
    case "host_key_changed":
      return failure(
        "host_key_changed",
        hostKeyChangedMessage(
          server.hostKeyFingerprint ?? "another key",
          error.fingerprint ?? "a new key",
        ),
        { presentedFingerprint: error.fingerprint },
      );
    default:
      return failure("unreachable", unreachableMessage(server.address, server.port, error.detail), {
        hints: [...SETUP_MESSAGES.unreachableHints],
      });
  }
}

export interface OpenedSession {
  session: SshSession;
  /** True when this connection recorded the host key for the first time. */
  recordedNow: boolean;
}

/** Connects with the server's key and records its host key on the first connection. */
export async function openSession(
  services: ControlServices,
  server: ServerAccess,
  signal?: AbortSignal,
): Promise<OpenedSession> {
  const settings = setupSettings(services);
  const privateKey = await openPrivateKey(services, server.workspaceId, server.sshKeyId);
  let session: SshSession;
  try {
    session = await settings.connector.connect(
      { address: server.address, port: server.port, user: server.user, privateKey },
      { expected: server.hostKeyFingerprint, strict: settings.strictHostKeyChecking },
      signal ? { signal } : {},
    );
  } catch (error) {
    if (error instanceof SshFailure) throw new AccessFailure(failureFromSsh(error, server));
    throw error;
  }
  let recordedNow = false;
  if (!server.hostKeyFingerprint && session.fingerprint) {
    const updated = await services.db
      .updateTable("server")
      .set({ host_key_fingerprint: session.fingerprint, updated_at: new Date() })
      .where("id", "=", server.id)
      .where("host_key_fingerprint", "is", null)
      .executeTakeFirst();
    recordedNow = Number(updated.numUpdatedRows) > 0;
    server.hostKeyFingerprint = session.fingerprint;
  }
  return { session, recordedNow };
}

const OK_MARKER = "::nz-ok::";

/**
 * The first command: a cloud image that refuses this user answers with its own message (and
 * runs nothing), which names the user it wants.
 */
export async function checkUser(session: SshSession, user: string): Promise<void> {
  let output = "";
  try {
    const result = await session.exec(`echo ${OK_MARKER}`, { timeoutMs: 30_000 });
    output = `${result.stdout}\n${result.stderr}`;
    if (result.stdout.includes(OK_MARKER)) return;
  } catch (error) {
    if (!(error instanceof SshFailure)) throw error;
    output = error.detail;
  }
  const asked = askedForUser(output, user);
  if (asked) {
    throw new AccessFailure(
      failure("wrong_user", wrongUserMessage(user, asked), { suggestedUser: asked }),
    );
  }
  const said = output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 300);
  throw new AccessFailure(
    failure(
      "internal",
      `The server signed "${user}" in but didn't run commands${said ? `; it said: ${said}` : ""}. Check the user's shell and its authorized_keys options, then run setup again.`,
    ),
  );
}

/** Passwordless sudo for users other than root; null when it works. */
export async function checkSudo(session: SshSession, user: string): Promise<SudoProblem | null> {
  if (user === "root") return null;
  try {
    const result = await session.exec("sudo -n true", { timeoutMs: 30_000 });
    return sudoProblem(`${result.stdout}\n${result.stderr}`, result.code);
  } catch (error) {
    if (error instanceof SshFailure) return "needs_password";
    throw error;
  }
}

export function sudoFailure(problem: SudoProblem, user: string): SetupFailureView {
  return failure("sudo_missing", sudoProblemMessage(problem, user), {
    fixCommand: problem === "needs_password" ? sudoFixCommand(user) : null,
  });
}

/** What the server is: its user, system, architecture and init system (read-only). */
export async function readFacts(session: SshSession): Promise<SystemFacts> {
  const result = await session.exec(remoteCommand({ shell: "sh", sudo: false }), {
    stdin: FACTS_PROBE,
    timeoutMs: 60_000,
  });
  // A probe that didn't run says why, instead of reading as an unsupported system (B2-35).
  if (result.code !== 0 || !result.stdout.includes("::os-release::end")) {
    const cause =
      result.code === 97
        ? "its script couldn't be saved in the temporary folder (is /tmp full or read-only?)"
        : `it ended with exit code ${result.code ?? "unknown"}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").at(-1)}` : ""}`;
    throw new AccessFailure(
      failure(
        "step_failed",
        `Nearzero couldn't read what system this server runs, so setup stopped before changing anything. Cause: ${cause}. Fix it, then run setup again.`,
      ),
    );
  }
  return parseFacts(result.stdout);
}

/**
 * Signs in, checks the user and sudo, and reads the facts: everything the later SSH parts need.
 * Throws AccessFailure with the dialog's words.
 */
export async function signIn(
  services: ControlServices,
  server: ServerAccess,
  signal?: AbortSignal,
): Promise<OpenedSession & { facts: SystemFacts; sudo: boolean }> {
  const opened = await openSession(services, server, signal);
  try {
    await checkUser(opened.session, server.user);
    const problem = await checkSudo(opened.session, server.user);
    if (problem) throw new AccessFailure(sudoFailure(problem, server.user));
    const facts = await readFacts(opened.session);
    return { ...opened, facts, sudo: facts.uid !== 0 };
  } catch (error) {
    opened.session.close();
    throw error;
  }
}
