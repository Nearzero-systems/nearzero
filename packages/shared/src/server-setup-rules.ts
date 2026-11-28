/**
 * Setting a server up over SSH: the steps, the words people read, and the shapes the console
 * shows (spec 09 9.3, 9.4, 9.6; 14.4; 22.5; 25 D1 option C). Browser-safe: no zod, no Node.
 *
 * The control plane writes every message here into the setup log and its answers, and the
 * console uses the same words for its states, so the two never drift apart.
 */

/** The numbered steps of a setup run, in order (spec 9.3). */
export const SETUP_STEPS = [
  "Clean up leftovers from an earlier run",
  "Install basic tools",
  "Check ports 80 and 443",
  "Install rclone",
  "Install Docker",
  "Prepare the container runtime, the private network and the runner",
  "Add swap",
  "Create Nearzero's folders",
  "Start the router",
  "Open web ports in the firewall",
  "Install the builders",
  "Set up monitoring",
  "Add the SSH user to the Docker group",
  "Harden SSH",
  "Configure monitoring",
] as const;
export type SetupStepTitle = (typeof SETUP_STEPS)[number];
export const SETUP_STEP_COUNT = SETUP_STEPS.length;

/** A run that showed no sign of life for this long counts as stalled and is retried. */
export const SETUP_STALLED_MS = 5 * 60_000;

export const SETUP_MESSAGES = {
  title: "Server setup",
  description: "Nearzero installs Docker, the router, build tools and monitoring.",
  logsHeading: "Setup logs · live",
  alreadyRunning: "Setup is already running…",
  stalledRetrying: "Previous setup looks stalled. Retrying…",
  starting: "Starting setup…",
  finished: "Setup Server: ✅",
  completedToast: "Server setup completed",
  /** The toast when a run this dialog followed fails (G3-08). */
  failedToast: "Setup failed",
  completedDnsPending:
    "Server setup completed. Add the DNS record above so apps here get their own address.",
  keyRejected: "Couldn't connect to your server — the SSH key was not accepted.",
  keyRejectedHints: [
    "Check that the public half of this key is in ~/.ssh/authorized_keys of the SSH user on the server.",
    "Check the SSH user: cloud images often refuse root and expect ubuntu, admin or ec2-user.",
    "If the server was rebuilt, add the key to it again.",
  ],
  unreachable: "Couldn't connect to your server…",
  unreachableHints: [
    "Check the address and the SSH port.",
    "Check that a firewall or security group lets Nearzero reach that port.",
    "Check that the server is on.",
  ],
  unsupportedSystem:
    "This script only supports Debian, Red Hat, Arch Linux, Alpine Linux, or SUSE based operating systems for now.",
  cloudFirewall:
    "Open 80/tcp, 443/tcp and 443/udp in your cloud provider's firewall or security group too, if it has one: setup can only change the server's own firewall.",
  noControlAddress:
    "Setup needs an encrypted address servers reach Nearzero at, and this Nearzero has none yet: servers never get a plain http:// address. Run the install command again on the Nearzero host so it knows its public IP address (or give it a domain), then run setup again.",
  hostOpensDetails: "The Nearzero host is set up by the installer, not over SSH.",
  removalStarted: "Deleting the server's services, then the server.",
  serverDeleted: "Server deleted",
} as const;

export const SETUP_STATES = ["not_started", "running", "ready", "failed"] as const;
export type SetupState = (typeof SETUP_STATES)[number];

export const SETUP_STATE_LABELS: Record<SetupState, string> = {
  not_started: "Not started",
  running: "Running",
  ready: "Ready",
  failed: "Failed",
};

/** What stopped a run, so the dialog can offer the right button. */
export const SETUP_FAILURE_KINDS = [
  "key_rejected",
  "unreachable",
  "wrong_user",
  "sudo_missing",
  "host_key_unknown",
  "host_key_changed",
  "unsupported_system",
  "step_failed",
  "validation_failed",
  "no_control_address",
  "stalled",
  "internal",
] as const;
export type SetupFailureKind = (typeof SETUP_FAILURE_KINDS)[number];

export function wrongUserMessage(current: string, expected: string): string {
  return `This server does not allow logging in as "${current}". It asks for the user "${expected}": change the server's SSH user to "${expected}" and run setup again.`;
}

export function suggestedUserButtonLabel(expected: string): string {
  return `Use ${expected} and run setup again`;
}

/** The exact command that gives a user passwordless sudo (spec 9.3). */
export function sudoFixCommand(user: string): string {
  return `echo '${user} ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/${user}`;
}

export function passwordlessSudoMessage(user: string): string {
  return `The user "${user}" needs passwordless sudo for setup. On the server, run: ${sudoFixCommand(user)}, then run setup again.`;
}

export function sudoNotInstalledMessage(user: string): string {
  return `The user "${user}" needs passwordless sudo for setup, and sudo isn't installed on this server. As root, install sudo and run: echo '${user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${user}, then run setup again.`;
}

export function sudoTtyMessage(user: string): string {
  return `sudo on this server only works in a terminal (the requiretty setting), so setup can't use it as "${user}". Remove "Defaults requiretty" with visudo, then run setup again.`;
}

export function unreachableMessage(address: string, port: number, detail: string): string {
  const cause = detail ? ` (${detail})` : "";
  return `Couldn't connect to your server at ${address}:${port}${cause}. The address or port may be wrong, a firewall may block SSH from Nearzero, or the server may be off.`;
}

export function hostKeyUnknownMessage(fingerprint: string): string {
  return `Nearzero hasn't seen this server's host key before, and strict host key checking is on, so setup didn't sign in. The server presented ${fingerprint}. Compare it with the host key shown in your provider's console; if it matches, trust it and run setup again.`;
}

export function hostKeyChangedMessage(expected: string, presented: string): string {
  return `This server's host key changed: Nearzero recorded ${expected}, and the server now presents ${presented}. Someone may be in the middle, or the server was rebuilt. If you rebuilt it, forget the old host key on the server's details, then run setup again.`;
}

/** "Setup stopped at step N (<title>): <reason>. Cause: … (exit code X)" (spec 9.3). */
export function stepFailureMessage(input: {
  number: number;
  title: string;
  reason: string;
  cause: string;
  exitCode: number | null;
}): string {
  const reason = input.reason.replace(/[.\s]+$/, "");
  const cause = input.cause.replace(/[.\s]+$/, "") || "no output";
  const code = input.exitCode === null ? "no exit code" : `exit code ${input.exitCode}`;
  return `Setup stopped at step ${input.number} (${input.title}): ${reason}. Cause: ${cause} (${code})`;
}

export function missingChecksMessage(missing: readonly string[]): string {
  return `Server setup did not complete. Missing: ${missing.join(", ")}`;
}

export function stepHeading(number: number, title: string): string {
  return `[${number}/${SETUP_STEP_COUNT}] ${title}`;
}

export function stateLine(state: SetupState, step: number | null, title: string | null): string {
  if (state === "running") {
    return step && title ? `Step ${step} of ${SETUP_STEP_COUNT}: ${title}` : "Connecting…";
  }
  if (state === "ready") return "Setup finished.";
  if (state === "failed") return "Setup stopped.";
  return "Setup hasn't run yet.";
}

// ---- Validation (spec 9.4)

export const VALIDATION_CHECK_STATES = ["ready", "not_ready", "version", "unknown"] as const;
export type ValidationCheckState = (typeof VALIDATION_CHECK_STATES)[number];

export interface ValidationCheckView {
  id: string;
  label: string;
  mandatory: boolean;
  state: ValidationCheckState;
  /** A version, or why it isn't ready, in a few words. */
  value: string | null;
}

export interface ValidationView {
  checkedAt: string;
  checks: ValidationCheckView[];
  /** True when every mandatory check is ready (or shows a version). */
  ok: boolean;
  verdict: string;
  /** Readable as "Ready" / "Not ready" next to each check. */
}

export const VALIDATION_VERDICTS = {
  ready: "All mandatory checks passed and the server is ready for deployments.",
  unconfirmed: "Nearzero could not confirm every mandatory server check.",
} as const;

/**
 * Opening a set-up server's details checks it again unless its stored validation is younger than
 * this; the dialog says VALIDATION_CHECKING meanwhile (spec 30 decisions part 2, R3-06).
 */
export const VALIDATION_FRESH_MS = 60_000;
export const VALIDATION_CHECKING = "Checking server configuration…";

export function reportedAsVerdict(label: string, reason: string): string {
  return `Nearzero reports this server as ${label} (${reason}). Finish setup before deploying.`;
}

export function missingVerdict(missing: readonly string[]): string {
  return `Mandatory checks still missing: ${missing.join(", ")}`;
}

export const VALIDATION_STATE_LABELS: Record<ValidationCheckState, string> = {
  ready: "Ready",
  not_ready: "Not ready",
  version: "Ready",
  unknown: "Unknown",
};

// ---- Security audit (spec 9.4)

export const AUDIT_STATES = ["good", "attention", "unknown"] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

export interface AuditItemView {
  id: "firewall" | "ssh_password" | "ssh_keys" | "ssh_root" | "intrusion_ban";
  label: string;
  state: AuditState;
  /** What was found, in a few words. */
  value: string;
  recommendation: string;
}

export interface AuditView {
  checkedAt: string;
  items: AuditItemView[];
  /** Set when the audit couldn't run at all (the server couldn't be reached). */
  error: string | null;
}

export const AUDIT_STATE_LABELS: Record<AuditState, string> = {
  good: "Good",
  attention: "Needs attention",
  unknown: "Unknown",
};

// ---- Daily Docker cleanup (spec 9.4, 14.4, 15.3)

export const DOCKER_CLEANUP_LOCAL_TIME = "23:50";
export const DOCKER_CLEANUP_EVENT = "server.docker-cleanup";
export const DOCKER_CLEANUP_TEXT =
  "Removes unused images and build cache every day at 23:50 server time.";

export interface DockerCleanupView {
  enabled: boolean;
  /** The default for this server: on for the Nearzero host, off for the others. */
  defaultEnabled: boolean;
  description: string;
  timeZone: string;
  nextRunAt: string | null;
  last: {
    at: string;
    freedBytes: number | null;
    freedText: string | null;
    error: string | null;
  } | null;
}

// ---- Setup runs as the console follows them

export interface SetupStepView {
  number: number;
  title: string;
  state: "waiting" | "running" | "done" | "skipped" | "failed";
  note: string | null;
}

export interface SetupFailureView {
  kind: SetupFailureKind;
  message: string;
  hints: string[];
  /** Wrong user: the user the server asks for ("Use <user> and run setup again"). */
  suggestedUser: string | null;
  /** No passwordless sudo: the exact command to run on the server. */
  fixCommand: string | null;
  /** Host key unknown (strict mode): the fingerprint to compare and trust. */
  presentedFingerprint: string | null;
}

export interface SetupRunView {
  id: string;
  state: "running" | "succeeded" | "failed";
  /** The step running now, or the one it stopped at. */
  step: number | null;
  stepTitle: string | null;
  steps: SetupStepView[];
  stateLine: string;
  failure: SetupFailureView | null;
  /** True when this run replaced a stalled one. */
  retriedStalled: boolean;
  startedAt: string;
  lastActivityAt: string;
  finishedAt: string | null;
  /** The last log sequence number written, for following the log from here. */
  logSeq: number;
}

export interface SetupView {
  server: {
    id: string;
    name: string;
    target: string;
    setupState: SetupState;
    setupStateLabel: string;
    hostKeyFingerprint: string | null;
  };
  run: SetupRunView | null;
  /** "Setup is already running…" or "Previous setup looks stalled. Retrying…", when it applies. */
  notice: string | null;
  canManage: boolean;
}

/** "1 attached service", "3 attached services" (G3-08), for the delete dialog. */
export function attachedServicesText(count: number): string {
  return `${count} attached service${count === 1 ? "" : "s"}`;
}
