import {
  AUDIT_STATE_LABELS,
  type AuditView,
  type DockerCleanupView,
  SETUP_MESSAGES,
  SETUP_STATE_LABELS,
  SETUP_STEP_COUNT,
  type SetupRunView,
  type SetupState,
  type SetupView,
  suggestedUserButtonLabel,
  VALIDATION_CHECKING,
  VALIDATION_STATE_LABELS,
  type ValidationView,
} from "@nearzero/shared/browser";
import { browserCopyEnvironment, COPY_REFUSED_MESSAGE, copyText } from "../lib/copy-text.ts";
import { asApiError, callApi, refreshPage } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * The server setup and details dialogs (spec 09 9.3–9.5; docs/api/server-setup.md).
 *
 * The Servers page asks for them with `nz:server-setup` and `nz:server-details` on `document`
 * ({ serverId, server }); this module answers with `preventDefault()` when its dialogs are on the
 * page. Setup starts (or rejoins the run already going, or retries a stalled one), then follows
 * the run's log and state over server-sent events, which resume by themselves after a dropped
 * connection. The DNS card refreshes in place and never closes a dialog.
 */

type PillStatus = "ok" | "run" | "warn" | "fail" | "idle";

interface DnsCard {
  shown: boolean;
  title?: string;
  subtitle?: string;
  record?: { type: string; name: string; value: string | null; proxy: string };
  zoneLine?: string;
  provider?: { id: string; name: string } | null;
  steps?: string[];
  badge?: "points_here" | "points_elsewhere" | "not_added" | "couldnt_check";
  badgeLabel?: string;
  ready?: boolean;
  readyText?: string;
  checkHint?: string;
  message?: string | null;
  /** "Add it now, while setup runs.": shown in the setup dialog only (G3-07). */
  whileSetup?: string;
  /** What Check again says when it ends (G3-07). */
  checkToast?: string;
}

interface ServerView {
  id: string;
  name: string;
  description: string;
  address: string;
  port: number;
  sshUser: string;
  sshKey: { id: string; name: string } | null;
  hostKeyFingerprint: string | null;
  setup: {
    state: SetupState;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  readiness: "ready" | "setup_needed" | "setup_running" | "setup_failed" | "inactive";
  runner: { state: string; version: string | null; message: string | null };
}

const READINESS: Record<ServerView["readiness"], { label: string; status: PillStatus }> = {
  ready: { label: "Ready", status: "ok" },
  setup_needed: { label: "Setup Needed", status: "idle" },
  setup_running: { label: "Setup running", status: "run" },
  setup_failed: { label: "Setup failed", status: "fail" },
  inactive: { label: "Inactive", status: "warn" },
};

const SETUP_PILL: Record<SetupState, PillStatus> = {
  not_started: "idle",
  running: "run",
  ready: "ok",
  failed: "fail",
};

const DNS_PILL: Record<NonNullable<DnsCard["badge"]>, PillStatus> = {
  points_here: "ok",
  points_elsewhere: "fail",
  not_added: "warn",
  couldnt_check: "idle",
};

function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function text(root: ParentNode, selector: string, value: string): void {
  const element = q(root, selector);
  if (element) element.textContent = value;
}

function pill(element: HTMLElement | null, status: PillStatus, label: string): void {
  if (!element) return;
  element.dataset.status = status;
  element.textContent = label;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function show(element: HTMLElement | null, visible: boolean): void {
  if (element) element.hidden = !visible;
}

async function copy(value: string, done = "Copied to clipboard"): Promise<void> {
  const ok = await copyText(value, browserCopyEnvironment());
  showToast(ok ? done : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" });
}

// ---- The DNS card (spec 9.5)

const dnsCards = new WeakMap<HTMLElement, DnsCard>();

async function loadDns(
  dialog: HTMLElement,
  serverId: string,
  fresh: boolean,
): Promise<DnsCard | null> {
  const slot = q(dialog, "[data-dns-card-slot]");
  const template = document.querySelector<HTMLTemplateElement>("#nz-dns-card-template");
  if (!slot || !template) return null;
  let card: DnsCard;
  try {
    const answer = await callApi<{ card: DnsCard }>(
      "GET",
      `/servers/${encodeURIComponent(serverId)}/dns-card${fresh ? "?fresh=1" : ""}`,
    );
    card = answer.card;
  } catch {
    // The card is optional: a server whose DNS can't be read now just doesn't show it.
    slot.replaceChildren();
    return null;
  }
  if (!card?.shown || !card.record) {
    slot.replaceChildren();
    return card ?? null;
  }
  let section = q(slot, ".nz-dns-card");
  if (!section) {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    slot.replaceChildren(fragment);
    section = q(slot, ".nz-dns-card");
  }
  if (!section) return card;
  dnsCards.set(section, card);
  text(section, "[data-dns-title]", card.title ?? "");
  text(section, "[data-dns-subtitle]", card.subtitle ?? "");
  // "Add it now, while setup runs." belongs to the setup dialog, while the record is missing.
  const whileSetup = dialog === setupDialog() && !card.ready ? (card.whileSetup ?? "") : "";
  text(section, "[data-dns-while-setup]", whileSetup);
  show(q(section, "[data-dns-while-setup]"), whileSetup !== "");
  // A ready card is only its title and sentence: no table, steps or check (G3-07).
  for (const part of section.querySelectorAll<HTMLElement>("[data-dns-detail]"))
    part.hidden = Boolean(card.ready);
  pill(
    q(section, "[data-dns-badge]"),
    card.ready ? "ok" : DNS_PILL[card.badge ?? "couldnt_check"],
    card.ready ? (card.readyText ?? card.badgeLabel ?? "") : (card.badgeLabel ?? ""),
  );
  text(section, "[data-dns-type]", card.record.type);
  text(section, "[data-dns-name]", card.record.name);
  text(section, "[data-dns-value]", card.record.value ?? "(server address unknown)");
  text(section, "[data-dns-proxy]", card.record.proxy);
  text(section, "[data-dns-zone]", card.zoneLine ?? "");
  const steps = q(section, "[data-dns-steps]");
  const stepsWrap = q(section, "[data-dns-steps-wrap]");
  steps?.replaceChildren(
    ...(card.steps ?? []).map((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      return item;
    }),
  );
  text(
    section,
    "[data-dns-steps-title]",
    card.provider ? `Steps for ${card.provider.name}` : "Steps",
  );
  show(stepsWrap, (card.steps ?? []).length > 0);
  text(section, "[data-dns-message]", card.message ?? "");
  text(section, "[data-dns-hint]", card.checkHint ?? "");
  return card;
}

function dnsPending(card: DnsCard | null): boolean {
  return Boolean(card?.shown && card.record && !card.ready);
}

// ---- The setup dialog (spec 9.3)

interface SetupSession {
  serverId: string;
  source: EventSource | null;
  runId: string | null;
  lines: string[];
  lastSeq: number;
  failureMessage: string | null;
  /** Runs whose success or failure was already announced. */
  announced: Set<string>;
  /** Runs this dialog saw going: only their failure gets a toast, not an old one (G3-08). */
  followed: Set<string>;
  view: SetupView | null;
}

let session: SetupSession | null = null;

function setupDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("#nz-server-setup");
}

function lineKind(line: string, failure: string | null): string | null {
  if (/^\[\d+\/\d+\] /.test(line)) return "step";
  if (line === SETUP_MESSAGES.finished || line === SETUP_MESSAGES.completedToast) return "ok";
  if (failure && line === failure) return "fail";
  if (/^Setup stopped at step /.test(line)) return "fail";
  return null;
}

function appendLines(dialog: HTMLElement, lines: { seq: number; text: string }[]): void {
  if (!session) return;
  const box = q(dialog, "[data-setup-log]");
  if (!box) return;
  if (session.lines.length === 0) box.replaceChildren();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  for (const line of lines) {
    if (line.seq <= session.lastSeq) continue;
    session.lastSeq = line.seq;
    session.lines.push(line.text);
    const row = document.createElement("div");
    row.className = "nz-log-line";
    const kind = lineKind(line.text, session.failureMessage);
    if (kind) row.dataset.kind = kind;
    row.textContent = line.text || " ";
    box.append(row);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function resetLog(dialog: HTMLElement, placeholder = "Waiting for logs…"): void {
  if (session) {
    session.lines = [];
    session.lastSeq = 0;
  }
  const box = q(dialog, "[data-setup-log]");
  const row = document.createElement("div");
  row.className = "nz-log-line nz-dim";
  row.textContent = placeholder;
  box?.replaceChildren(row);
}

function renderProgress(dialog: HTMLElement, run: SetupRunView | null): void {
  const bar = q(dialog, "[data-setup-progress]");
  if (!bar) return;
  const steps = run?.steps ?? [];
  bar.replaceChildren(
    ...Array.from({ length: SETUP_STEP_COUNT }, (_, index) => {
      const segment = document.createElement("span");
      segment.dataset.state = steps[index]?.state ?? "waiting";
      segment.title = `${index + 1}. ${steps[index]?.title ?? ""}`;
      return segment;
    }),
  );
  const done = steps.filter((step) => step.state === "done" || step.state === "skipped").length;
  text(dialog, "[data-setup-progress-text]", run ? `${done} of ${SETUP_STEP_COUNT} steps` : "");
}

function renderRun(dialog: HTMLElement, run: SetupRunView | null): void {
  if (!session) return;
  const failure = run?.state === "failed" ? run.failure : null;
  session.failureMessage = failure?.message ?? null;
  text(dialog, "[data-setup-state]", run?.stateLine ?? "Setup hasn't run yet.");
  renderProgress(dialog, run);
  const box = q(dialog, "[data-setup-failure]");
  show(box, Boolean(failure));
  if (failure) {
    text(dialog, "[data-setup-failure-message]", failure.message);
    q(dialog, "[data-setup-failure-hints]")?.replaceChildren(
      ...failure.hints.map((hint) => {
        const item = document.createElement("li");
        item.textContent = hint;
        return item;
      }),
    );
    const fix = q(dialog, "[data-setup-fix]");
    show(fix, Boolean(failure.fixCommand));
    text(dialog, "[data-setup-fix-command]", failure.fixCommand ?? "");
    const fixCopy = q(dialog, "[data-setup-fix-copy]");
    if (fixCopy) fixCopy.dataset.copy = failure.fixCommand ?? "";
  }
  const useUser = q<HTMLButtonElement>(dialog, "[data-setup-use-user]");
  if (useUser) {
    useUser.hidden = !failure?.suggestedUser;
    useUser.dataset.user = failure?.suggestedUser ?? "";
    const label = useUser.querySelector<HTMLElement>("[data-setup-use-user-label]");
    if (label)
      label.textContent = failure?.suggestedUser
        ? suggestedUserButtonLabel(failure.suggestedUser)
        : "";
  }
  const trust = q<HTMLButtonElement>(dialog, "[data-setup-trust]");
  if (trust) {
    trust.hidden = failure?.kind !== "host_key_unknown" || !failure.presentedFingerprint;
    trust.dataset.fingerprint = failure?.presentedFingerprint ?? "";
  }
  // A changed host key: the person can forget the old one here (R3-05).
  show(q(dialog, "[data-setup-forget]"), failure?.kind === "host_key_changed");
  show(q(dialog, "[data-setup-again]"), Boolean(failure) && !failure?.suggestedUser);
  show(q(dialog, "[data-setup-open-details]"), run?.state === "succeeded");
  const state: SetupState =
    run?.state === "succeeded"
      ? "ready"
      : run?.state === "failed"
        ? "failed"
        : run
          ? "running"
          : "not_started";
  pill(q(dialog, "[data-setup-badge]"), SETUP_PILL[state], SETUP_STATE_LABELS[state]);
  if (run && state === "running") session.followed.add(run.id);
  if (run?.state === "succeeded") void finished(dialog, run);
  // A run that fails while the dialog follows it says so, as a success does (G3-08).
  if (run?.state === "failed" && session.followed.has(run.id) && !session.announced.has(run.id)) {
    session.announced.add(run.id);
    showToast(SETUP_MESSAGES.failedToast, { tone: "error" });
  }
}

async function finished(dialog: HTMLElement, run: SetupRunView): Promise<void> {
  if (!session || session.announced.has(run.id)) return;
  session.announced.add(run.id);
  const serverId = session.serverId;
  showToast(SETUP_MESSAGES.completedToast, { tone: "success" });
  const card = await loadDns(dialog, serverId, true);
  if (dnsPending(card)) {
    const notice = q(dialog, "[data-setup-notice]");
    if (notice) {
      notice.textContent = SETUP_MESSAGES.completedDnsPending;
      notice.dataset.tone = "ok";
      notice.hidden = false;
    }
    return;
  }
  // Nothing left to do here: the page shows the server as ready.
  window.setTimeout(() => {
    if (session?.serverId === serverId && setupDialog()?.open) setupDialog()?.close();
    void refreshPage();
  }, 1200);
}

function follow(dialog: HTMLElement, serverId: string): void {
  if (!session) return;
  session.source?.close();
  if (typeof EventSource === "undefined") return;
  const source = new EventSource(`/api/v1/servers/${encodeURIComponent(serverId)}/setup/events`, {
    withCredentials: true,
  });
  session.source = source;
  source.addEventListener("run", (event) => {
    if (!session || session.serverId !== serverId) return;
    try {
      const { run } = JSON.parse((event as MessageEvent).data) as { run: SetupRunView | null };
      if (run && run.id !== session.runId) {
        session.runId = run.id;
        resetLog(dialog);
      }
      renderRun(dialog, run);
    } catch {
      // A state that doesn't parse is skipped; the next one replaces it.
    }
  });
  source.addEventListener("log", (event) => {
    if (!session || session.serverId !== serverId) return;
    try {
      appendLines(dialog, [
        JSON.parse((event as MessageEvent).data) as { seq: number; text: string },
      ]);
    } catch {
      // Skipped; "Copy" reads the stored log.
    }
  });
}

function renderSetup(dialog: HTMLElement, view: SetupView): void {
  if (!session) return;
  session.view = view;
  text(dialog, "[data-setup-name]", view.server.name);
  text(dialog, "[data-setup-target]", view.server.target);
  const notice = q(dialog, "[data-setup-notice]");
  if (notice) {
    notice.textContent = view.notice ?? "";
    delete notice.dataset.tone;
    notice.hidden = !view.notice;
  }
  if (view.run && view.run.id !== session.runId) {
    session.runId = view.run.id;
    resetLog(dialog);
  }
  renderRun(dialog, view.run);
}

async function start(
  dialog: HTMLElement,
  serverId: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  try {
    const answer = await callApi<{ setup: SetupView; started: boolean }>(
      "POST",
      `/servers/${encodeURIComponent(serverId)}/setup`,
      body,
    );
    // A run this dialog started is followed from its first state, however fast it fails.
    if (answer.setup.run && session) session.followed.add(answer.setup.run.id);
    renderSetup(dialog, answer.setup);
  } catch (error) {
    const message = asApiError(error).message;
    text(dialog, "[data-setup-state]", message);
    showToast(message, { tone: "error" });
  }
}

export async function openSetup(
  serverId: string,
  options: { start: boolean; opener?: Element | null; name?: string; target?: string } = {
    start: true,
  },
): Promise<void> {
  const dialog = setupDialog();
  if (!dialog) return;
  session?.source?.close();
  session = {
    serverId,
    source: null,
    runId: null,
    lines: [],
    lastSeq: 0,
    failureMessage: null,
    announced: new Set(),
    followed: new Set(),
    view: null,
  };
  text(dialog, "[data-setup-name]", options.name ?? "");
  text(dialog, "[data-setup-target]", options.target ?? "");
  text(dialog, "[data-setup-state]", SETUP_MESSAGES.starting);
  show(q(dialog, "[data-setup-notice]"), false);
  show(q(dialog, "[data-setup-failure]"), false);
  for (const selector of [
    "[data-setup-use-user]",
    "[data-setup-trust]",
    "[data-setup-forget]",
    "[data-setup-again]",
    "[data-setup-open-details]",
  ]) {
    show(q(dialog, selector), false);
  }
  q(dialog, "[data-dns-card-slot]")?.replaceChildren();
  renderProgress(dialog, null);
  resetLog(dialog);
  openDialog(dialog, options.opener ?? null);
  void loadDns(dialog, serverId, false);
  if (options.start) await start(dialog, serverId);
  else {
    try {
      const answer = await callApi<{ setup: SetupView }>(
        "GET",
        `/servers/${encodeURIComponent(serverId)}/setup`,
      );
      renderSetup(dialog, answer.setup);
    } catch (error) {
      text(dialog, "[data-setup-state]", asApiError(error).message);
    }
  }
  follow(dialog, serverId);
}

// ---- The details dialog (spec 9.4)

let detailsServer: string | null = null;

function detailsDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("#nz-server-details");
}

function field(
  label: string,
  value: string,
  options: { code?: boolean; copy?: boolean; wide?: boolean } = {},
): HTMLElement {
  const row = document.createElement("div");
  if (options.wide) row.className = "nz-details-wide";
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  const span = document.createElement(options.code ? "code" : "span");
  if (options.code) span.className = "nz-code";
  span.textContent = value;
  detail.append(span);
  if (options.copy && value && value !== "—") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nz-btn nz-btn--icon";
    button.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
    button.dataset.copy = value;
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
    detail.append(button);
  }
  row.append(term, detail);
  return row;
}

function renderServer(dialog: HTMLElement, server: ServerView): void {
  text(dialog, "[data-details-name]", server.name);
  text(dialog, "[data-details-target]", `${server.sshUser}@${server.address}:${server.port}`);
  const readiness = READINESS[server.readiness] ?? READINESS.setup_needed;
  pill(q(dialog, "[data-details-badge]"), readiness.status, readiness.label);
  q(dialog, "[data-details-fields]")?.replaceChildren(
    field("Address", server.address, { code: true, copy: true }),
    field("Port", String(server.port)),
    field("User", server.sshUser, { code: true }),
    field("SSH key", server.sshKey?.name ?? "—"),
    field("Host key fingerprint", server.hostKeyFingerprint ?? "Recorded on the first connection", {
      code: Boolean(server.hostKeyFingerprint),
      copy: Boolean(server.hostKeyFingerprint),
      wide: true,
    }),
    field("Setup finished", when(server.setup.finishedAt)),
    field(
      "Runner",
      server.runner.state === "online"
        ? `Connected${server.runner.version ? ` (${server.runner.version})` : ""}${server.runner.message ? `. ${server.runner.message}` : ""}`
        : (server.runner.message ?? "Not connected"),
    ),
    field("Description", server.description || "—", { wide: true }),
  );
  // Forget host key (spec 9.2: "it can be forgotten later"), for who may set the server up.
  // The API refuses it for people who can't set the server up, with its own words.
  show(q(dialog, "[data-details-forget-key]"), Boolean(server.hostKeyFingerprint));
}

/** A check that shows a version reads it on its badge ("28.5.1"); others read Ready. */
function versionWord(check: ValidationView["checks"][number]): string | null {
  if (check.state !== "version") return null;
  const first = check.value?.split(" ")[0] ?? "";
  return /^v?\d/.test(first) ? first : null;
}

/** While a check runs, the dialog says so and shows no older result (R3-06). */
function renderChecking(dialog: HTMLElement): void {
  const verdict = q(dialog, "[data-validation-verdict]");
  if (verdict) {
    verdict.textContent = VALIDATION_CHECKING;
    delete verdict.dataset.ok;
  }
  text(dialog, "[data-validation-checked]", "");
  q(dialog, "[data-validation-checks]")?.replaceChildren();
}

function renderValidation(dialog: HTMLElement, view: ValidationView | null): void {
  const verdict = q(dialog, "[data-validation-verdict]");
  if (verdict) {
    verdict.textContent =
      view?.verdict ?? "Not checked yet. Setup checks the server when it finishes.";
    if (view) verdict.dataset.ok = String(view.ok);
    else delete verdict.dataset.ok;
  }
  text(dialog, "[data-validation-checked]", view ? `Checked ${when(view.checkedAt)}` : "");
  q(dialog, "[data-validation-checks]")?.replaceChildren(
    ...(view?.checks ?? []).map((check) => {
      const item = document.createElement("div");
      item.className = "nz-check-item";
      const words = document.createElement("p");
      words.className = "min-w-0";
      const label = document.createElement("span");
      label.className = "nz-block";
      label.textContent = check.mandatory ? check.label : `${check.label} (optional)`;
      const value = document.createElement("span");
      value.className = "nz-block nz-small nz-dim nz-truncate";
      value.textContent = check.value ?? "";
      words.append(label, value);
      const badge = document.createElement("span");
      badge.className = "nz-pill";
      const status: PillStatus =
        check.state === "not_ready"
          ? check.mandatory
            ? "fail"
            : "idle"
          : check.state === "unknown"
            ? "idle"
            : "ok";
      pill(badge, status, versionWord(check) ?? VALIDATION_STATE_LABELS[check.state]);
      item.append(words, badge);
      return item;
    }),
  );
}

function renderAudit(dialog: HTMLElement, view: AuditView | null): void {
  text(dialog, "[data-audit-checked]", view ? `Checked ${when(view.checkedAt)}` : "");
  const list = q(dialog, "[data-audit-items]");
  if (!list) return;
  if (view?.error) {
    const item = document.createElement("li");
    item.className = "nz-danger-text nz-small";
    item.textContent = view.error;
    list.replaceChildren(item);
    return;
  }
  list.replaceChildren(
    ...(view?.items ?? []).map((entry) => {
      const item = document.createElement("li");
      item.className = "nz-audit-item";
      const title = document.createElement("p");
      title.innerHTML = "";
      const strong = document.createElement("strong");
      strong.textContent = entry.label;
      const value = document.createElement("span");
      value.className = "nz-dim";
      value.textContent = ` · ${entry.value}`;
      title.append(strong, value);
      const advice = document.createElement("p");
      advice.className = "nz-small nz-dim";
      advice.textContent = entry.recommendation;
      const badge = document.createElement("span");
      badge.className = "nz-pill";
      pill(
        badge,
        entry.state === "good" ? "ok" : entry.state === "attention" ? "warn" : "idle",
        AUDIT_STATE_LABELS[entry.state],
      );
      item.append(title, badge, advice);
      return item;
    }),
  );
  if (!view) {
    const item = document.createElement("li");
    item.className = "nz-small nz-dim";
    item.textContent = "Not run yet.";
    list.replaceChildren(item);
  }
}

function renderCleanup(dialog: HTMLElement, view: DockerCleanupView | null): void {
  const toggle = q<HTMLInputElement>(dialog, "[data-cleanup-switch]");
  if (toggle && view) {
    toggle.checked = view.enabled;
    toggle.disabled = false;
  }
  let words = "";
  if (view?.last?.error) words = `Last cleanup failed: ${view.last.error}`;
  else if (view?.last)
    words = `Last cleanup ${when(view.last.at)} freed ${view.last.freedText ?? "0 B"}.`;
  if (view?.enabled && view.nextRunAt) {
    words = `${words}${words ? " " : ""}Next: ${when(view.nextRunAt)} (${view.timeZone} on the server).`;
  }
  text(dialog, "[data-cleanup-last]", words);
}

export async function openDetails(serverId: string, opener: Element | null = null): Promise<void> {
  const dialog = detailsDialog();
  if (!dialog) return;
  detailsServer = serverId;
  q(dialog, "[data-details-fields]")?.replaceChildren();
  q(dialog, "[data-dns-card-slot]")?.replaceChildren();
  renderChecking(dialog);
  renderAudit(dialog, null);
  text(dialog, "[data-cleanup-last]", "");
  openDialog(dialog, opener);
  // The monitoring view and its alert settings follow the server shown (client/monitoring.ts).
  q(dialog, "[data-server-monitoring-mount] [data-monitoring]")?.dispatchEvent(
    new CustomEvent("nz:monitoring-target", { detail: { target: serverId }, bubbles: true }),
  );
  const id = encodeURIComponent(serverId);
  // A set-up server is checked now unless its stored check is under a minute old (R3-06); the
  // rest of the details don't wait for it.
  const checkButton = q<HTMLButtonElement>(dialog, "[data-validation-run]");
  const check = async () => {
    try {
      const answer = await callApi<{ validation: ValidationView | null }>(
        "GET",
        `/servers/${id}/validation?fresh=1`,
      );
      if (detailsServer === serverId) renderValidation(dialog, answer.validation);
    } catch (error) {
      if (detailsServer !== serverId) return;
      renderValidation(dialog, null);
      text(dialog, "[data-validation-checked]", asApiError(error).message);
    }
  };
  checkButton?.setAttribute("aria-busy", "true");
  if (checkButton) checkButton.disabled = true;
  void check().finally(() => {
    if (detailsServer !== serverId || !checkButton) return;
    checkButton.disabled = false;
    checkButton.removeAttribute("aria-busy");
  });
  const [server, audit, cleanup] = await Promise.allSettled([
    callApi<{ server: ServerView }>("GET", `/servers/${id}`),
    callApi<{ audit: AuditView | null }>("GET", `/servers/${id}/security-audit`),
    callApi<{ cleanup: DockerCleanupView }>("GET", `/servers/${id}/docker-cleanup`),
  ]);
  if (detailsServer !== serverId) return;
  if (server.status === "fulfilled") renderServer(dialog, server.value.server);
  else showToast(asApiError(server.reason).message, { tone: "error" });
  renderAudit(dialog, audit.status === "fulfilled" ? audit.value.audit : null);
  renderCleanup(dialog, cleanup.status === "fulfilled" ? cleanup.value.cleanup : null);
  void loadDns(dialog, serverId, false);
}

async function busy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await work();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

export function initServerSetup(): void {
  document.addEventListener("nz:server-setup", (event) => {
    if (!setupDialog()) return;
    const detail = (event as CustomEvent<{ serverId: string; server?: ServerView | null }>).detail;
    event.preventDefault();
    const server = detail.server ?? null;
    if (server?.readiness === "ready") {
      void openDetails(detail.serverId);
      return;
    }
    void openSetup(detail.serverId, {
      start: true,
      name: server?.name ?? "",
      target: server ? `${server.sshUser}@${server.address}:${server.port}` : "",
    });
  });

  document.addEventListener("nz:server-details", (event) => {
    if (!detailsDialog()) return;
    const detail = (event as CustomEvent<{ serverId: string }>).detail;
    event.preventDefault();
    void openDetails(detail.serverId);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const setup = setupDialog();
    const details = detailsDialog();
    if (setup && target && setup.contains(target)) {
      const serverId = session?.serverId;
      if (!serverId) return;
      const useUser = target.closest<HTMLButtonElement>("[data-setup-use-user]");
      if (useUser) {
        void busy(useUser, async () => {
          resetLog(setup);
          await start(setup, serverId, { sshUser: useUser.dataset.user ?? "" });
        });
        return;
      }
      const trust = target.closest<HTMLButtonElement>("[data-setup-trust]");
      if (trust) {
        void busy(trust, async () => {
          try {
            await callApi("POST", `/servers/${encodeURIComponent(serverId)}/host-key/trust`, {
              fingerprint: trust.dataset.fingerprint ?? "",
            });
            resetLog(setup);
            await start(setup, serverId);
          } catch (error) {
            showToast(asApiError(error).message, { tone: "error" });
          }
        });
        return;
      }
      const forget = target.closest<HTMLButtonElement>("[data-setup-forget]");
      if (forget) {
        void busy(forget, async () => {
          try {
            await callApi("DELETE", `/servers/${encodeURIComponent(serverId)}/host-key`);
            resetLog(setup);
            await start(setup, serverId);
          } catch (error) {
            showToast(asApiError(error).message, { tone: "error" });
          }
        });
        return;
      }
      const again = target.closest<HTMLButtonElement>("[data-setup-again]");
      if (again) {
        void busy(again, async () => {
          resetLog(setup);
          await start(setup, serverId);
        });
        return;
      }
      if (target.closest("[data-setup-open-details]")) {
        setup.close();
        void openDetails(serverId);
        return;
      }
      if (target.closest("[data-setup-log-copy]") && event.isTrusted) {
        void copy((session?.lines ?? []).join("\n"), "Logs copied");
        return;
      }
    }
    for (const dialog of [setup, details]) {
      if (!dialog || !target || !dialog.contains(target)) continue;
      const serverId = dialog === setup ? session?.serverId : detailsServer;
      if (!serverId) continue;
      const check = target.closest<HTMLButtonElement>("[data-dns-check]");
      if (check) {
        void busy(check, async () => {
          const card = await loadDns(dialog, serverId, true);
          // Check again always ends by saying what it found (G3-07).
          if (card?.checkToast)
            showToast(card.checkToast, { tone: card.ready ? "success" : "info" });
        });
        return;
      }
      const dnsCopy = target.closest<HTMLElement>("[data-dns-copy]");
      if (dnsCopy && event.isTrusted) {
        const card = dnsCards.get(dnsCopy.closest<HTMLElement>(".nz-dns-card") as HTMLElement);
        const which = dnsCopy.dataset.dnsCopy as "type" | "name" | "value" | "proxy";
        const value = card?.record?.[which];
        if (value) void copy(value);
        return;
      }
    }
    if (details && target && details.contains(target) && detailsServer) {
      const serverId = detailsServer;
      const validate = target.closest<HTMLButtonElement>("[data-validation-run]");
      if (validate) {
        void busy(validate, async () => {
          renderChecking(details);
          try {
            const answer = await callApi<{ validation: ValidationView }>(
              "POST",
              `/servers/${encodeURIComponent(serverId)}/validation`,
            );
            if (detailsServer === serverId) renderValidation(details, answer.validation);
          } catch (error) {
            if (detailsServer !== serverId) return;
            renderValidation(details, null);
            text(details, "[data-validation-checked]", asApiError(error).message);
          }
        });
        return;
      }
      const audit = target.closest<HTMLButtonElement>("[data-audit-run]");
      if (audit) {
        void busy(audit, async () => {
          text(details, "[data-audit-checked]", "Reading the server…");
          try {
            const answer = await callApi<{ audit: AuditView }>(
              "POST",
              `/servers/${encodeURIComponent(serverId)}/security-audit`,
            );
            renderAudit(details, answer.audit);
          } catch (error) {
            text(details, "[data-audit-checked]", asApiError(error).message);
          }
        });
        return;
      }
      const forgetKey = target.closest<HTMLButtonElement>("[data-details-forget-key]");
      if (forgetKey) {
        void busy(forgetKey, async () => {
          try {
            await callApi("DELETE", `/servers/${encodeURIComponent(serverId)}/host-key`);
            const answer = await callApi<{ server: ServerView }>(
              "GET",
              `/servers/${encodeURIComponent(serverId)}`,
            );
            renderServer(details, answer.server);
            showToast("Host key forgotten. The next setup records the server's new one.", {
              tone: "success",
            });
          } catch (error) {
            showToast(asApiError(error).message, { tone: "error" });
          }
        });
        return;
      }
      if (target.closest("[data-details-setup]")) {
        details.close();
        void openSetup(serverId, { start: true });
      }
    }
  });

  document.addEventListener("change", (event) => {
    const toggle = event.target as HTMLInputElement | null;
    if (!toggle?.matches?.("[data-cleanup-switch]") || !detailsServer) return;
    const details = detailsDialog();
    if (!details) return;
    const enabled = toggle.checked;
    toggle.disabled = true;
    void callApi<{ cleanup: DockerCleanupView }>(
      "PUT",
      `/servers/${encodeURIComponent(detailsServer)}/docker-cleanup`,
      { enabled },
    )
      .then((answer) => {
        renderCleanup(details, answer.cleanup);
        showToast(enabled ? "Daily Docker cleanup is on" : "Daily Docker cleanup is off", {
          tone: "success",
        });
      })
      .catch((error) => {
        toggle.checked = !enabled;
        toggle.disabled = false;
        showToast(asApiError(error).message, { tone: "error" });
      });
  });

  // Closing the setup dialog stops following the run (it keeps going on the server).
  document.addEventListener(
    "close",
    (event) => {
      if (event.target === setupDialog()) {
        session?.source?.close();
        if (session) session.source = null;
      }
      if (event.target === detailsDialog()) detailsServer = null;
    },
    true,
  );
}
