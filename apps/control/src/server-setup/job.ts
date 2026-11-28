import {
  formatBytes,
  missingChecksMessage,
  type RunnerLinkAddress,
  runnerMoveTarget,
  SETUP_MESSAGES,
  SETUP_STEPS,
  type SetupFailureView,
  stepFailureMessage,
  stepHeading,
  VERSION,
} from "@nearzero/shared";
import { z } from "zod";
import { TOOL_RELEASES } from "../../../../runner/tools/pins.ts";
import { recordAudit } from "../audit/audit.ts";
import { savedAcmeEmail } from "../domains/addresses.ts";
import { defineJob, type JobContext } from "../jobs/definition.ts";
import { createJoinToken } from "../runners/credentials.ts";
import { pinnedRunnerLink } from "../runners/link.ts";
import type { ControlServices } from "../services.ts";
import {
  AccessFailure,
  checkSudo,
  checkUser,
  failure,
  loadServerAccess,
  openSession,
  readFacts,
  type ServerAccess,
  sudoFailure,
} from "./connection.ts";
import { SetupLog, setupBus } from "./log.ts";
import {
  causeOf,
  containersPublishing,
  keyValues,
  looksLikeError,
  portHolders,
  portVerdict,
  type ScriptFailure,
  type SystemFacts,
  scriptLine,
  section,
  swapPlan,
} from "./parse.ts";
import { loadRunnerBinary, MissingRunnerError } from "./runner-binaries.ts";
import { loadRun, type RunRow, SETUP_JOB, touchRun } from "./runs.ts";
import {
  bashBootstrap,
  basicToolsScript,
  buildersScript,
  cleanupScript,
  dockerGroupScript,
  dockerScript,
  firewallScript,
  foldersScript,
  installRunnerScript,
  portsScript,
  rcloneScript,
  registerRunnerScript,
  remoteCommand,
  runnerLogScript,
  runtimeScript,
  type ScriptInputs,
  sshHardeningScript,
  sshRollbackScript,
  startRunnerScript,
  swapScript,
} from "./scripts.ts";
import { setupSettings } from "./settings.ts";
import { SshFailure, type SshSession, shellQuote } from "./ssh.ts";
import type { StoredStep } from "./tables.ts";
import { validateServer } from "./validation.ts";

/**
 * The setup job (spec 09 9.3): signs in over SSH, then runs the fifteen numbered steps, each
 * titled in the live log, and ends with the validation of 9.4. Any failure stops the run with
 * the dialog's words; the server is kept and "Run setup again" is offered. Running it again is
 * safe: every step checks what is there first and keeps running apps, databases and routes.
 *
 * The job may run twice (the control plane stopped mid-run): the second attempt starts again
 * from the first step, which is what "Run setup again" would do.
 */

/** A known stop: the run ends with this failure. */
class SetupStop extends Error {
  readonly failure: SetupFailureView;
  constructor(failure: SetupFailureView) {
    super(failure.message);
    this.failure = failure;
  }
}

const MINUTE = 60_000;
const HEARTBEAT_MS = 30_000;

interface CurrentStep {
  number: number;
  title: string;
  doing: string | null;
  skipped: string | null;
  notes: string[];
}

interface ScriptOptions {
  timeoutMs?: number;
  /** Plain output lines go to the log (markers always do). */
  echo?: boolean;
  /** Values to cut from the output on top of the log's own. */
  secrets?: string[];
}

class SetupProcess {
  readonly #services: ControlServices;
  readonly #run: RunRow;
  readonly #server: ServerAccess;
  readonly #log: SetupLog;
  readonly #signal: AbortSignal;
  readonly #steps: StoredStep[];
  #session: SshSession | null = null;
  #facts: SystemFacts | null = null;
  #sudo = false;
  #current: CurrentStep | null = null;
  #runnerSince = 0;
  /** Where this server's runner reaches Nearzero, chosen once when setup connects. */
  #link: RunnerLinkAddress | null = null;

  constructor(
    services: ControlServices,
    run: RunRow,
    server: ServerAccess,
    log: SetupLog,
    signal: AbortSignal,
  ) {
    this.#services = services;
    this.#run = run;
    this.#server = server;
    this.#log = log;
    this.#signal = signal;
    this.#steps = SETUP_STEPS.map(() => ({ state: "waiting", note: null }));
  }

  get #db() {
    return this.#services.db;
  }

  get #session_(): SshSession {
    if (!this.#session) throw new Error("not connected");
    return this.#session;
  }

  get #factsOrThrow(): SystemFacts {
    if (!this.#facts) throw new Error("no facts");
    return this.#facts;
  }

  #line(text: string): void {
    this.#log.line(text);
  }

  async #saveRun(fields: { step?: number | null }): Promise<void> {
    await this.#db
      .updateTable("server_setup_run")
      .set({
        steps: JSON.stringify(this.#steps),
        ...(fields.step === undefined ? {} : { step: fields.step }),
        last_activity_at: new Date(),
      })
      .where("id", "=", this.#run.id)
      .execute();
    setupBus.emit(this.#server.id, { type: "run", runId: this.#run.id });
  }

  // ---- The run

  async run(attempt: number): Promise<void> {
    this.#line(`Initializing server setup (Nearzero ${VERSION})`);
    if (attempt > 1) {
      this.#line(
        "Nearzero restarted while setup was running, so setup starts again from the first step.",
      );
    }
    try {
      await this.#connect();
      for (let number = 1; number <= SETUP_STEPS.length; number++) {
        await this.#step(number);
      }
      this.#line("");
      this.#line(SETUP_MESSAGES.finished);
      await this.#validate();
      await this.#succeed();
    } catch (error) {
      if (this.#signal.aborted && !(error instanceof SetupStop)) {
        this.#line("Nearzero is stopping; setup starts again when it is back.");
        await this.#log.flush();
        throw error;
      }
      const stop =
        error instanceof SetupStop
          ? error.failure
          : error instanceof AccessFailure
            ? error.failure
            : failure(
                "internal",
                `Setup stopped because of an error in Nearzero: ${(error as Error).message}. Run setup again; if it happens again, check Nearzero's log.`,
              );
      this.#services.log.warn("server setup failed", {
        serverId: this.#server.id,
        runId: this.#run.id,
        kind: stop.kind,
        error: error instanceof SetupStop || error instanceof AccessFailure ? undefined : error,
      });
      await this.#fail(stop);
    } finally {
      this.#session?.close();
      await this.#log.flush();
    }
  }

  async #connect(): Promise<void> {
    const server = this.#server;
    // Servers only ever get an encrypted address (spec 31 "Remote runners are always
    // encrypted"): the console's hostname with a valid certificate, or Nearzero's own TLS port
    // with its certificate's fingerprint.
    const link = await this.#services.runnerLink();
    if (!link || !runnerMoveTarget.safeParse(link).success)
      throw new SetupStop(failure("no_control_address", SETUP_MESSAGES.noControlAddress));
    this.#link = link;
    this.#line(`Connecting to ${server.user}@${server.address}:${server.port}`);
    const opened = await openSession(this.#services, server, this.#signal);
    this.#session = opened.session;
    this.#line(
      opened.recordedNow
        ? `Host key ${opened.session.fingerprint} (first connection: recorded; compare it with the host key in your provider's console).`
        : `Host key ${opened.session.fingerprint} matches the one recorded.`,
    );
    await checkUser(opened.session, server.user);
    const problem = await checkSudo(opened.session, server.user);
    if (problem) throw new SetupStop(sudoFailure(problem, server.user));
    this.#line(
      server.user === "root"
        ? "Signed in as root."
        : `Signed in as ${server.user}; passwordless sudo works.`,
    );
    const facts = await readFacts(opened.session);
    this.#facts = facts;
    this.#sudo = facts.uid !== 0;
    if (!facts.family) {
      throw new SetupStop(failure("unsupported_system", SETUP_MESSAGES.unsupportedSystem));
    }
    if (!facts.architecture) {
      throw new SetupStop(
        failure(
          "unsupported_system",
          `Nearzero runs on 64-bit x86 (amd64) and ARM (arm64) servers; this one is ${facts.machine || "something else"}.`,
        ),
      );
    }
    this.#line(
      `System: ${facts.os.prettyName || facts.os.id} (${facts.architecture}, ${facts.libc}, ${facts.init === "none" ? "no init system" : facts.init})`,
    );
    if (!facts.hasBash) {
      this.#line("Installing bash first: setup's steps run under bash.");
      const result = await this.#session_.exec(remoteCommand({ shell: "sh", sudo: this.#sudo }), {
        stdin: bashBootstrap(facts.family),
        timeoutMs: 10 * MINUTE,
        signal: this.#signal,
      });
      if (result.code !== 0) {
        const said = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).at(-1) ?? "";
        throw new SetupStop(
          failure(
            "internal",
            `Setup couldn't install bash, which its steps need: ${said || "no output"} (exit code ${result.code ?? "none"}).`,
          ),
        );
      }
    }
  }

  get #inputs(): ScriptInputs {
    return { facts: this.#factsOrThrow, user: this.#server.user, builders: TOOL_RELEASES };
  }

  async #step(number: number): Promise<void> {
    const title = SETUP_STEPS[number - 1] as string;
    this.#current = { number, title, doing: null, skipped: null, notes: [] };
    this.#steps[number - 1] = { state: "running", note: null };
    await this.#saveRun({ step: number });
    this.#line("");
    this.#line(stepHeading(number, title));
    const started = Date.now();
    try {
      await this.#body(number);
    } catch (error) {
      this.#steps[number - 1] = { state: "failed", note: null };
      await this.#saveRun({});
      throw error;
    }
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    const current = this.#current;
    const skipped = current.skipped !== null && current.notes.length === 0;
    this.#steps[number - 1] = {
      state: skipped ? "skipped" : "done",
      note: current.skipped ?? current.notes.at(-1) ?? null,
    };
    await this.#saveRun({});
    this.#line(skipped ? `  Skipped (${seconds}s)` : `  Done (${seconds}s)`);
  }

  #note(text: string): void {
    this.#current?.notes.push(text);
    this.#line(`  ${text}`);
  }

  #skip(text: string): void {
    if (this.#current) this.#current.skipped = text;
    this.#line(`  ${text}`);
  }

  /** A known failure of the current step, decided here rather than by an exit code. */
  #stopHere(reason: string): never {
    const current = this.#current as CurrentStep;
    throw new SetupStop(
      failure(
        "step_failed",
        `Setup stopped at step ${current.number} (${current.title}): ${reason}`,
      ),
    );
  }

  async #script(text: string, options: ScriptOptions = {}): Promise<string> {
    const current = this.#current as CurrentStep;
    const state: ScriptFailure & { exitCode: number | null } = {
      doing: null,
      command: null,
      lastError: null,
      exitCode: null,
    };
    const partial = { out: "", err: "" };
    const secrets = options.secrets ?? [];
    for (const secret of secrets) this.#log.addSecret(secret);
    const handle = (raw: string, from: "out" | "err") => {
      const line = this.#log.clean(raw);
      const parsed = scriptLine(line);
      switch (parsed.kind) {
        case "doing":
          state.doing = parsed.text;
          current.doing = parsed.text;
          this.#line(`  · ${parsed.text}`);
          return;
        case "note":
          this.#note(parsed.text);
          return;
        case "skip":
          this.#skip(parsed.text);
          return;
        case "failed":
          state.exitCode = parsed.exitCode;
          state.command = parsed.command;
          return;
        default:
          if (line.trim() === "") return;
          if (from === "err" && looksLikeError(line)) state.lastError = line.trim();
          else if (from === "err" && state.lastError === null) state.lastError = line.trim();
          if (options.echo !== false || from === "err") this.#line(`    ${line}`);
      }
    };
    const onData = (chunk: string, from: "out" | "err") => {
      const text = partial[from] + chunk;
      const lines = text.split(/\r?\n/);
      partial[from] = lines.pop() ?? "";
      for (const line of lines) handle(line, from);
    };
    let result: Awaited<ReturnType<SshSession["exec"]>>;
    try {
      result = await this.#session_.exec(remoteCommand({ shell: "bash", sudo: this.#sudo }), {
        stdin: text,
        timeoutMs: options.timeoutMs ?? 10 * MINUTE,
        signal: this.#signal,
        onData,
      });
    } catch (error) {
      if (this.#signal.aborted) throw error;
      const detail =
        error instanceof SshFailure
          ? error.kind === "timeout"
            ? `it didn't finish within ${Math.round((options.timeoutMs ?? 10 * MINUTE) / MINUTE)} minutes`
            : `the connection to the server dropped (${error.detail})`
          : (error as Error).message;
      throw new SetupStop(
        failure(
          "step_failed",
          stepFailureMessage({
            number: current.number,
            title: current.title,
            reason: state.doing ?? current.title,
            cause: detail,
            exitCode: null,
          }),
        ),
      );
    }
    for (const from of ["out", "err"] as const) {
      if (partial[from]) handle(partial[from], from);
    }
    if (result.code === 0) return result.stdout;
    const output = `${result.stdout}\n${result.stderr}`;
    if (
      this.#sudo &&
      /sudo: .*(password is required|a terminal is required|must have a tty)/i.test(output)
    ) {
      const problem = await checkSudo(this.#session_, this.#server.user);
      if (problem) throw new SetupStop(sudoFailure(problem, this.#server.user));
    }
    const exitCode = result.code ?? state.exitCode;
    const cause =
      result.code === 97
        ? "the step's script couldn't be saved in the temporary folder (is /tmp full or read-only?)"
        : causeOf(state);
    throw new SetupStop(
      failure(
        "step_failed",
        stepFailureMessage({
          number: current.number,
          title: current.title,
          reason: state.doing ?? current.title,
          cause,
          exitCode,
        }),
      ),
    );
  }

  // ---- The fifteen steps (spec 9.3)

  async #body(number: number): Promise<void> {
    const facts = this.#factsOrThrow;
    switch (number) {
      case 1:
        await this.#script(cleanupScript());
        return;
      case 2:
        await this.#script(basicToolsScript(this.#inputs), { timeoutMs: 20 * MINUTE });
        return;
      case 3: {
        const out = await this.#script(portsScript(), { echo: false });
        const verdict = portVerdict(
          portHolders(section(out, "listeners")),
          containersPublishing(section(out, "containers")),
        );
        if (!verdict.ok) {
          this.#stopHere(
            `${verdict.holder} holds a web port that Nearzero's router needs. Stop it or move it to other ports, then run setup again.`,
          );
        }
        this.#note(verdict.note);
        return;
      }
      case 4:
        await this.#script(rcloneScript(this.#inputs), { timeoutMs: 15 * MINUTE });
        return;
      case 5:
        await this.#script(dockerScript(this.#inputs), { timeoutMs: 30 * MINUTE });
        return;
      case 6:
        await this.#runtimeAndRunner();
        return;
      case 7: {
        if (facts.container) {
          this.#skip(
            "Swap not added: this server runs in a container, which uses its host's memory.",
          );
          return;
        }
        const plan = swapPlan(facts);
        if (!plan.add) {
          this.#skip(`Swap not added: ${plan.reason}.`);
          return;
        }
        await this.#script(swapScript(plan.megabytes), { timeoutMs: 20 * MINUTE });
        return;
      }
      case 8:
        await this.#script(foldersScript(this.#inputs));
        return;
      case 9:
        await this.#startRouter();
        return;
      case 10:
        await this.#script(firewallScript());
        this.#note(SETUP_MESSAGES.cloudFirewall);
        return;
      case 11:
        await this.#script(buildersScript(this.#inputs), { timeoutMs: 30 * MINUTE });
        return;
      case 12:
        this.#note(
          "Monitoring runs inside the runner: it samples CPU, memory and disk every 5 seconds and listens on no port, so nothing is opened in the firewall.",
        );
        return;
      case 13:
        await this.#script(dockerGroupScript(this.#server.user));
        return;
      case 14:
        await this.#hardenSsh();
        return;
      case 15:
        await this.#configureMonitoring();
        return;
    }
  }

  async #runtimeAndRunner(): Promise<void> {
    const facts = this.#factsOrThrow;
    const settings = setupSettings(this.#services);
    const out = await this.#script(runtimeScript(), { echo: false });
    const installed = keyValues(out).get("runner_sha256") ?? "";
    let binary: Awaited<ReturnType<typeof loadRunnerBinary>>;
    try {
      binary = await loadRunnerBinary(
        settings.runnerBinariesDirectory,
        facts.architecture ?? "amd64",
        facts.libc,
      );
    } catch (error) {
      if (error instanceof MissingRunnerError) this.#stopHere(error.message);
      throw error;
    }
    if (installed === binary.sha256) {
      this.#note("This runner is already installed.");
    } else {
      const upload = `/tmp/nearzero-runner.upload.${crypto.randomUUID().slice(0, 12)}`;
      this.#line(`  · Sending the runner (${binary.file}, ${formatBytes(binary.bytes.length)})`);
      if (this.#current) this.#current.doing = "Sending the runner";
      try {
        const sent = await this.#session_.exec(
          `sh -c ${shellQuote(`umask 077; cat > ${upload}`)}`,
          {
            stdin: binary.bytes,
            timeoutMs: 20 * MINUTE,
            signal: this.#signal,
          },
        );
        if (sent.code !== 0) {
          this.#stopHere(
            `the runner couldn't be saved in /tmp on the server: ${sent.stderr.trim() || `exit code ${sent.code}`}.`,
          );
        }
      } catch (error) {
        if (error instanceof SetupStop || this.#signal.aborted) throw error;
        this.#stopHere(`sending the runner failed: ${(error as Error).message}.`);
      }
      await this.#script(installRunnerScript(upload, binary.sha256));
    }
    const link = this.#link as RunnerLinkAddress;
    // Nearzero's own TLS port with its fingerprint, which the runner tries when the address above
    // stops answering (C4-06): written also when that address is the console's domain.
    const fallback = await pinnedRunnerLink(
      this.#services,
      this.#services.runnerLinkSettings,
    ).catch(() => null);
    const { token } = await createJoinToken(this.#db, this.#server.id, {
      createdBy: this.#run.requested_by,
    });
    await this.#script(
      registerRunnerScript({
        init: facts.init,
        environment: {
          controlUrl: link.url,
          controlFingerprint: link.fingerprint,
          controlFallback: fallback?.fingerprint && fallback.url !== link.url ? fallback : null,
          routerImage: settings.routerImage,
          // The email saved under About Nearzero wins, so the router starts with it (spec 10.1).
          acmeEmail: (await savedAcmeEmail(this.#services).catch(() => null)) ?? settings.acmeEmail,
          // The server's tasks run as the user setup runs as (R3-28).
          serverUser: this.#server.user,
          extra: settings.runnerEnvironment,
        },
        joinToken: token,
      }),
      { secrets: [token] },
    );
  }

  async #startRouter(): Promise<void> {
    const facts = this.#factsOrThrow;
    const settings = setupSettings(this.#services);
    const hub = this.#services.runners;
    const before = hub.state(this.#server.id);
    const since = Date.now();
    this.#runnerSince = since;
    await this.#script(startRunnerScript(facts.init));
    if (this.#current) this.#current.doing = "Waiting for the runner to connect";
    this.#line("  · Waiting for the runner to connect");
    const deadline = since + settings.runnerWaitMs;
    let connected = false;
    let lastRouterError: string | null = null;
    while (Date.now() < deadline) {
      if (this.#signal.aborted) throw new Error("stopping");
      const connection = hub.connection(this.#server.id);
      if (!connected && connection && connection.connectedAt >= since - 1_000) {
        connected = true;
        this.#line(`  The runner connected (version ${connection.runnerVersion}).`);
        this.#line("  · Waiting for the router");
        if (this.#current) this.#current.doing = "Waiting for the router to start";
      }
      const state = hub.state(this.#server.id);
      if (connected && state && state !== before) {
        lastRouterError = state.router.lastError;
        const { checks } = state;
        if (
          state.router.running &&
          checks.docker &&
          checks.network &&
          checks.router &&
          checks.routerDirectory
        ) {
          this.#note(
            `The router is running (${state.router.image ?? "Traefik"}), with HTTPS and its middlewares, configured only by the runner's route files.`,
          );
          return;
        }
      }
      await Bun.sleep(1_000);
      await touchRun(this.#db, this.#run.id);
    }
    const logText = await this.#script(runnerLogScript(facts.init), { echo: false }).catch(
      () => "",
    );
    const lastLine = logText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1);
    const minutes = Math.round(settings.runnerWaitMs / MINUTE);
    this.#stopHere(
      connected
        ? `the router didn't start within ${minutes} minutes${lastRouterError ? `: ${lastRouterError}` : ""}.`
        : `the runner didn't connect to Nearzero within ${minutes} minutes. Check that this server can reach ${this.#link?.url ?? "Nearzero"}${this.#link?.url ? ` (TCP ${new URL(this.#link.url).port || "443"})` : ""}${lastLine ? `. The runner said: ${this.#log.clean(lastLine).slice(0, 300)}` : ""}.`,
    );
  }

  async #hardenSsh(): Promise<void> {
    const facts = this.#factsOrThrow;
    await this.#script(sshHardeningScript(facts.init, this.#server.user));
    if (this.#current?.skipped) return;
    if (this.#current) this.#current.doing = "Checking that a new sign-in with the key works";
    this.#line("  · Checking that a new sign-in with the key works");
    try {
      const opened = await this.#signInAfterReload();
      try {
        await checkUser(opened.session, this.#server.user);
      } finally {
        opened.session.close();
      }
      this.#note("A new sign-in with the key works.");
    } catch (error) {
      if (this.#signal.aborted) throw error;
      await this.#script(sshRollbackScript(facts.init)).catch(() => "");
      this.#stopHere(
        `a new sign-in with the key failed after the change (${(error as Error).message}), so the SSH configuration from before setup was put back.`,
      );
    }
  }

  /**
   * A new SSH session right after the reload. Reloading restarts the SSH server's listener (on a
   * server without an init system, a HUP makes it start over), so a connection in that moment
   * can be closed before SSH answers: that is tried again a few times. A refused key or user
   * fails at once.
   */
  async #signInAfterReload(): Promise<Awaited<ReturnType<typeof openSession>>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await openSession(this.#services, { ...this.#server }, this.#signal);
      } catch (error) {
        const unreachable = error instanceof AccessFailure && error.failure.kind === "unreachable";
        if (!unreachable || attempt >= 4 || this.#signal.aborted) throw error;
        await Bun.sleep(2_000);
      }
    }
  }

  async #configureMonitoring(): Promise<void> {
    const settings = setupSettings(this.#services);
    const deadline = Date.now() + settings.metricsWaitMs;
    while (Date.now() < deadline) {
      const row = await this.#db
        .selectFrom("server_metric")
        .select("at")
        .where("target", "=", this.#server.id)
        .where("at", ">=", new Date(this.#runnerSince - 5_000))
        .limit(1)
        .executeTakeFirst();
      if (row) {
        this.#note("Monitoring is on: the server's details show CPU, memory and disk.");
        return;
      }
      await Bun.sleep(1_000);
    }
    this.#skip(
      "Monitoring setup skipped: the runner hasn't sent metrics yet; they show on the server's details once it does.",
    );
  }

  // ---- The end

  async #validate(): Promise<void> {
    this.#line("");
    this.#line("Setup validation");
    const view = await validateServer(this.#services, {
      serverId: this.#server.id,
      user: this.#server.user,
      session: this.#session_,
      sudo: this.#sudo,
      readiness: null,
    });
    for (const item of view.checks) {
      const state =
        item.state === "not_ready" ? "not ready" : item.state === "unknown" ? "unknown" : "ready";
      this.#line(
        `  ${item.label}: ${item.value ? `${item.value} (${state})` : state}${item.mandatory ? "" : " (optional)"}`,
      );
    }
    this.#line(`  ${view.verdict}`);
    if (!view.ok) {
      const missing = view.checks
        .filter((item) => item.mandatory && item.state !== "ready" && item.state !== "version")
        .map((item) => item.label);
      throw new SetupStop(
        failure(
          "validation_failed",
          missing.length > 0 ? missingChecksMessage(missing) : view.verdict,
        ),
      );
    }
  }

  async #succeed(): Promise<void> {
    const now = new Date();
    await this.#db.transaction().execute(async (trx) => {
      // Only a run still running succeeds: one marked stalled meanwhile, with another setup
      // started in its place, stays as it was, and so does the server's state (C2-23).
      const updated = await trx
        .updateTable("server_setup_run")
        .set({
          state: "succeeded",
          finished_at: now,
          steps: JSON.stringify(this.#steps),
          last_activity_at: now,
        })
        .where("id", "=", this.#run.id)
        .where("state", "=", "running")
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) return;
      await trx
        .updateTable("server")
        .set({ setup_state: "ready", setup_error: null, setup_finished_at: now, updated_at: now })
        .where("id", "=", this.#server.id)
        .execute();
    });
    this.#line(SETUP_MESSAGES.completedToast);
    await recordAudit(
      this.#db,
      this.#services.log,
      { kind: "system", personId: null, label: "server setup" },
      {
        action: "server.setup-finished",
        workspaceId: this.#server.workspaceId,
        target: { kind: "server", id: this.#server.id },
        details: { runId: this.#run.id, result: "ready" },
      },
    ).catch(() => {});
    await this.#log.flush();
    setupBus.emit(this.#server.id, { type: "run", runId: this.#run.id });
  }

  async #fail(stop: SetupFailureView): Promise<void> {
    const failed: SetupFailureView = {
      ...stop,
      message: this.#log.clean(stop.message),
    };
    this.#line("");
    this.#line(failed.message);
    for (const hint of failed.hints) this.#line(`  ${hint}`);
    if (failed.fixCommand) this.#line(`  ${failed.fixCommand}`);
    const now = new Date();
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .updateTable("server_setup_run")
        .set({
          state: "failed",
          failure: JSON.stringify(failed),
          finished_at: now,
          steps: JSON.stringify(this.#steps),
          last_activity_at: now,
        })
        .where("id", "=", this.#run.id)
        .where("state", "=", "running")
        .execute();
      await trx
        .updateTable("server")
        .set({ setup_state: "failed", setup_error: failed.message, updated_at: now })
        .where("id", "=", this.#server.id)
        .execute();
    });
    await recordAudit(
      this.#db,
      this.#services.log,
      { kind: "system", personId: null, label: "server setup" },
      {
        action: "server.setup-finished",
        workspaceId: this.#server.workspaceId,
        target: { kind: "server", id: this.#server.id },
        details: { runId: this.#run.id, result: "failed", kind: failed.kind },
      },
    ).catch(() => {});
    await this.#log.flush();
    setupBus.emit(this.#server.id, { type: "run", runId: this.#run.id });
  }
}

export async function carryOutSetup(
  services: ControlServices,
  runId: string,
  context: Pick<JobContext, "signal" | "job">,
): Promise<void> {
  const run = await loadRun(services.db, runId);
  if (run?.state !== "running") return;
  const server = await loadServerAccess(services.db, run.server_id);
  if (!server) return;
  // The user the run was started with (a later edit doesn't change a running setup).
  server.user = run.ssh_user;
  const log = new SetupLog(services.db, run.id, server.id, run.log_seq);
  const heartbeat = setInterval(() => {
    void touchRun(services.db, run.id).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    await new SetupProcess(services, run, server, log, context.signal).run(context.job.attempt);
  } finally {
    clearInterval(heartbeat);
  }
}

export function runSetupJob(services: ControlServices) {
  return defineJob({
    kind: SETUP_JOB,
    payload: z.object({ runId: z.string().regex(/^[0-9a-f-]{36}$/) }),
    maxAttempts: 2,
    // Setups take 10 to 20 minutes a step, on lanes of their own (R4-03).
    lane: "setup",
    retryDelayMs: () => 5_000,
    async run({ runId }, context) {
      await carryOutSetup(services, runId, context);
    },
  });
}
