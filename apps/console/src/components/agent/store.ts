import {
  AGENT_MESSAGES,
  type AttachmentKind,
  GREETING_SECOND_LINES,
  greetingFirstLine,
} from "@nearzero/shared/browser";
import { announceProfileSaved, type ProfileSaved } from "../../client/user-button.ts";
import {
  addProblem,
  checkFile,
  shrinkable,
  shrunkSize,
  uploadsToStart,
} from "../../lib/agent/composer-rules.ts";
import {
  agentApi,
  failureWords,
  type UploadHandle,
  uploadWithProgress,
} from "../../lib/agent/http.ts";
import { moveBy, orderRequest, withSwappedPositions } from "../../lib/agent/ordering.ts";
import { reconnectDelay, SseParser } from "../../lib/agent/sse.ts";
import { applyEvent, emptyTurn, isWorking, turnFromView } from "../../lib/agent/turn-model.ts";
import type {
  FileView,
  HomeView,
  PersonMessage,
  SentMessage,
  SessionDetail,
  SessionList,
  SessionView,
  TurnModel,
  WireEvent,
} from "../../lib/agent/types.ts";
import { ApiError } from "../../lib/api-error.ts";

/**
 * The Agent page's state and everything that changes it (spec 19.2–19.6): the sessions list,
 * the open conversation and the one live turn it follows, the message box with its uploads.
 * React components read it through `useAgent` (AgentApp.tsx); nothing here touches the page
 * until `start()` runs in the browser.
 */

export interface ComposerFile {
  key: string;
  name: string;
  sizeBytes: number;
  kind: AttachmentKind | null;
  contentType: string;
  state: "preparing" | "queued" | "uploading" | "done" | "failed";
  progress: number;
  error: string | null;
  notice: string | null;
  fileId: string | null;
  /** An object URL for image thumbnails. */
  preview: string | null;
  url: string | null;
}

export interface Initial {
  workspace: string;
  viewerId: string;
  viewerName: string;
  home: HomeView;
  list: SessionList;
  detail: SessionDetail | null;
  detailError: string | null;
  hour: number;
  /**
   * Whether `hour` came from the person's own time zone (the `nz_tz` cookie). On a first visit
   * without it the server could only use its own clock, so the browser corrects line 1 (B3-11).
   */
  hourKnown?: boolean;
  /** Picks for the greeting, chosen on the server so the first paint and the page agree. */
  greetingVariant: number;
  /** The server's clock when it rendered the page: relative times start from it. */
  renderedAt: number;
}

export interface Conversation {
  id: string | null;
  session: SessionView | null;
  turns: TurnModel[];
  more: boolean;
  loadingMore: boolean;
  loading: boolean;
}

export interface AgentState {
  /** The time the first paint used, so the browser's first render matches it. */
  renderedAt: number;
  workspace: string;
  viewerId: string;
  viewerName: string;
  home: HomeView;
  greeting: [string, string | null];
  sessions: SessionView[];
  shared: SessionView[];
  listError: string | null;
  chat: Conversation;
  composer: {
    text: string;
    quote: string | null;
    files: ComposerFile[];
    deepResearch: boolean;
    researchCard: boolean;
    /** Send pressed while uploads run: it goes out when they finish. */
    queued: boolean;
    error: string | null;
    /** Bumped to ask the box to take focus. */
    focus: number;
  };
  sheetOpen: boolean;
  /** Bumped when the conversation should scroll to the end and follow again. */
  follow: number;
  /** The person scrolled up: new text no longer scrolls the chat, "Jump to latest" shows. */
  away: boolean;
}

type Listener = () => void;

const PRELOAD_MS = 15_000;
const LIST_REFRESH_MS = 15_000;

function greetingFor(home: HomeView, hour: number, variant: number): [string, string | null] {
  if (home.greeting.fixed) return [home.greeting.fixed, null];
  return [greetingFirstLine(hour, home.greeting.name, variant), home.greeting.secondLine];
}

let pendingCount = 0;

export class AgentStore {
  state: AgentState;
  readonly #listeners = new Set<Listener>();
  #follower: { turnId: string; controller: AbortController } | null = null;
  #preloads = new Map<string, { at: number; detail: Promise<SessionDetail | null> }>();
  #uploads = new Map<string, UploadHandle>();
  #rawFiles = new Map<string, File | Blob>();
  #stopWhenAccepted = new Set<string>();
  #queue: { turnId: string; event: WireEvent }[] = [];
  #flushScheduled = false;
  #timers: number[] = [];
  #started = false;
  #clock: { hour: number; known: boolean; variant: number };

  constructor(initial: Initial) {
    const detail = initial.detail;
    this.#clock = {
      hour: initial.hour,
      known: initial.hourKnown !== false,
      variant: initial.greetingVariant,
    };
    this.state = {
      renderedAt: initial.renderedAt,
      workspace: initial.workspace,
      viewerId: initial.viewerId,
      viewerName: initial.viewerName,
      home: initial.home,
      greeting: greetingFor(initial.home, initial.hour, initial.greetingVariant),
      sessions: initial.list.sessions,
      shared: initial.list.shared,
      listError: initial.detailError,
      chat: {
        id: detail?.session.id ?? null,
        session: detail?.session ?? null,
        turns: detail
          ? detail.turns.map((turn) => turnFromView(turn)).filter((turn) => !turn.replacedBy)
          : [],
        more: detail?.more ?? false,
        loadingMore: false,
        loading: false,
      },
      composer: {
        text: "",
        quote: null,
        files: [],
        deepResearch: false,
        researchCard: false,
        queued: false,
        error: null,
        focus: 0,
      },
      sheetOpen: false,
      follow: 0,
      away: false,
    };
  }

  // ---- Subscription

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): AgentState => this.state;

  #set(next: Partial<AgentState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.#listeners) listener();
  }

  #setChat(next: Partial<Conversation>): void {
    this.#set({ chat: { ...this.state.chat, ...next } });
  }

  #setComposer(next: Partial<AgentState["composer"]>): void {
    this.#set({ composer: { ...this.state.composer, ...next } });
  }

  #updateTurn(id: string, change: (turn: TurnModel) => TurnModel): void {
    const turns = this.state.chat.turns;
    const index = turns.findIndex((turn) => turn.id === id);
    if (index === -1) return;
    const next = turns.slice();
    next[index] = change(turns[index] as TurnModel);
    this.#setChat({ turns: next });
  }

  // ---- Life cycle

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#greetByLocalClock();
    const live = this.#liveTurn();
    if (live) this.#follow(live.id, live.lastEventId);
    this.#timers.push(
      window.setInterval(() => {
        if (document.visibilityState === "visible") void this.refreshList(true);
      }, LIST_REFRESH_MS),
    );
  }

  /** The first visit's greeting follows the browser's clock once it runs (spec 19.2, B3-11). */
  #greetByLocalClock(): void {
    const clock = this.#clock;
    if (clock.known) return;
    clock.known = true;
    const hour = new Date().getHours();
    if (hour === clock.hour) return;
    this.#set({ greeting: greetingFor(this.state.home, hour, clock.variant) });
  }

  dispose(): void {
    this.#unfollow();
    for (const timer of this.#timers) window.clearInterval(timer);
    this.#timers = [];
    for (const upload of this.#uploads.values()) upload.abort();
    this.#uploads.clear();
    for (const file of this.state.composer.files)
      if (file.preview) URL.revokeObjectURL(file.preview);
    this.#started = false;
  }

  #liveTurn(): TurnModel | null {
    const turns = this.state.chat.turns;
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index] as TurnModel;
      if (turn.live && turn.accepted) return turn;
    }
    return null;
  }

  /** The turn the chat is working on now (for Stop and the send button), if any. */
  workingTurn(): TurnModel | null {
    const last = this.state.chat.turns.at(-1);
    return last && isWorking(last) && last.state === "working" ? last : null;
  }

  readOnly(): boolean {
    const session = this.state.chat.session;
    return session !== null && !session.mine;
  }

  // ---- Following the live turn (spec 19.6)

  #unfollow(): void {
    this.#follower?.controller.abort();
    this.#follower = null;
  }

  #follow(turnId: string, fromId: string): void {
    this.#unfollow();
    const controller = new AbortController();
    this.#follower = { turnId, controller };
    void this.#readStream(turnId, fromId, controller);
  }

  async #readStream(turnId: string, fromId: string, controller: AbortController): Promise<void> {
    let lastId = fromId;
    let attempt = 0;
    while (!controller.signal.aborted) {
      let ended = false;
      try {
        const query = lastId ? `?lastEventId=${encodeURIComponent(lastId)}` : "";
        const response = await fetch(
          `/api/v1/agent/turns/${encodeURIComponent(turnId)}/events${query}`,
          {
            headers: { accept: "text/event-stream" },
            credentials: "same-origin",
            signal: controller.signal,
            cache: "no-store",
          },
        );
        if (response.status === 404 || response.status === 403 || response.status === 401) {
          this.#updateTurn(turnId, (turn) => ({ ...turn, live: false, status: null }));
          return;
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const message of parser.push(decoder.decode(value, { stream: true }))) {
            if (message.type === "end") {
              ended = true;
              continue;
            }
            let data: Record<string, unknown> = {};
            try {
              data = message.data ? (JSON.parse(message.data) as Record<string, unknown>) : {};
            } catch {
              continue;
            }
            if (message.id) lastId = message.id;
            this.#enqueue(turnId, { id: message.id ?? lastId, type: message.type, data });
          }
          if (ended) break;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      if (ended) {
        this.#enqueue(turnId, { id: lastId, type: "end", data: {} });
        if (this.#follower?.controller === controller) this.#follower = null;
        return;
      }
      // The connection dropped: resume right after the last event seen.
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt)));
      attempt += 1;
    }
  }

  /** Events are applied once per frame, so a fast stream costs one render per frame. */
  #enqueue(turnId: string, event: WireEvent): void {
    this.#queue.push({ turnId, event });
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const flush = () => {
      this.#flushScheduled = false;
      this.#flush();
    };
    if (document.visibilityState === "visible") requestAnimationFrame(flush);
    else setTimeout(flush, 50);
  }

  #flush(): void {
    const batch = this.#queue;
    this.#queue = [];
    if (batch.length === 0) return;
    const now = Date.now();
    let turns = this.state.chat.turns;
    const after: (() => void)[] = [];
    for (const { turnId, event } of batch) {
      const index = turns.findIndex((turn) => turn.id === turnId);
      if (index === -1) continue;
      const updated = applyEvent(turns[index] as TurnModel, event, { now });
      turns = turns.slice();
      turns[index] = updated;
      if (event.type === "session.titled") {
        const title = typeof event.data.title === "string" ? event.data.title : null;
        if (title) after.push(() => this.#patchSession(this.state.chat.id, { title }));
      }
      if (event.type === "turn.replaced" && updated.replacedBy) {
        const newId = updated.replacedBy;
        after.push(() => this.#replaceTurn(turnId, newId));
      }
      if (event.type === "turn.finished" || event.type === "end") {
        after.push(() => {
          this.#patchSession(this.state.chat.id, { state: "idle", liveTurnId: null });
          void this.refreshList(true);
        });
      }
      if (event.type === "waiting") {
        after.push(() => this.#patchSession(this.state.chat.id, { state: "waiting" }));
      }
    }
    this.#setChat({ turns });
    for (const run of after) run();
  }

  #replaceTurn(oldId: string, newId: string): void {
    const turns = this.state.chat.turns;
    const old = turns.find((turn) => turn.id === oldId);
    if (!old) return;
    if (turns.some((turn) => turn.id === newId)) {
      this.#setChat({ turns: turns.filter((turn) => turn.id !== oldId) });
      return;
    }
    const fresh = emptyTurn(newId, old.message, true);
    this.#setChat({ turns: turns.map((turn) => (turn.id === oldId ? fresh : turn)) });
    this.#follow(newId, `${newId}:0`);
  }

  #patchSession(id: string | null, change: Partial<SessionView>): void {
    if (!id) return;
    const patch = (list: SessionView[]) =>
      list.map((session) => (session.id === id ? { ...session, ...change } : session));
    const current = this.state.chat.session;
    this.#set({
      sessions: patch(this.state.sessions),
      shared: patch(this.state.shared),
      chat:
        current && current.id === id
          ? { ...this.state.chat, session: { ...current, ...change } }
          : this.state.chat,
    });
  }

  // ---- Sessions (spec 19.5)

  showListError(message: string | null): void {
    this.#set({ listError: message });
  }

  async refreshList(quiet = false): Promise<void> {
    try {
      const list = await agentApi<SessionList>("GET", "/agent/sessions");
      // The open session's live state comes from its own stream, which is ahead of the list.
      const currentId = this.state.chat.id;
      const live = this.#liveTurn();
      const fix = (session: SessionView) =>
        session.id === currentId && live
          ? {
              ...session,
              state: live.state === "waiting" ? ("waiting" as const) : ("working" as const),
            }
          : session;
      this.#set({ sessions: list.sessions.map(fix), shared: list.shared.map(fix) });
    } catch (error) {
      if (!quiet) this.showListError(failureWords(error));
    }
  }

  preload(id: string): void {
    if (id === this.state.chat.id) return;
    const existing = this.#preloads.get(id);
    if (existing && Date.now() - existing.at < PRELOAD_MS) return;
    this.#preloads.set(id, {
      at: Date.now(),
      detail: agentApi<SessionDetail>("GET", `/agent/sessions/${encodeURIComponent(id)}`).catch(
        () => null,
      ),
    });
  }

  #takePreload(id: string): Promise<SessionDetail | null> | null {
    const existing = this.#preloads.get(id);
    this.#preloads.delete(id);
    if (!existing || Date.now() - existing.at >= PRELOAD_MS) return null;
    return existing.detail;
  }

  #setAddress(sessionId: string | null): void {
    const url = new URL(location.href);
    if (sessionId) url.searchParams.set("session", sessionId);
    else url.searchParams.delete("session");
    if (url.href !== location.href) history.replaceState(history.state, "", url.href);
  }

  async openSession(id: string): Promise<void> {
    this.#set({ sheetOpen: false });
    if (id === this.state.chat.id && !this.state.chat.loading) return;
    this.#unfollow();
    const session =
      this.state.sessions.find((item) => item.id === id) ??
      this.state.shared.find((item) => item.id === id) ??
      null;
    this.#set({
      chat: { id, session, turns: [], more: false, loadingMore: false, loading: true },
      listError: null,
    });
    this.#setAddress(id);
    let detail = await (this.#takePreload(id) ?? Promise.resolve(null));
    if (this.state.chat.id !== id) return;
    if (!detail) {
      try {
        detail = await agentApi<SessionDetail>("GET", `/agent/sessions/${encodeURIComponent(id)}`);
      } catch (error) {
        if (this.state.chat.id !== id) return;
        this.#set({ listError: failureWords(error) });
        this.newSession();
        return;
      }
    }
    if (this.state.chat.id !== id) return;
    this.#set({
      chat: {
        id,
        session: detail.session,
        turns: detail.turns.map((turn) => turnFromView(turn)).filter((turn) => !turn.replacedBy),
        more: detail.more,
        loadingMore: false,
        loading: false,
      },
      follow: this.state.follow + 1,
    });
    const live = this.#liveTurn();
    if (live) this.#follow(live.id, live.lastEventId);
  }

  async loadEarlier(): Promise<void> {
    const chat = this.state.chat;
    const oldest = chat.turns.find((turn) => turn.accepted);
    if (!chat.id || !chat.more || chat.loadingMore || !oldest) return;
    this.#setChat({ loadingMore: true });
    try {
      const detail = await agentApi<SessionDetail>(
        "GET",
        `/agent/sessions/${encodeURIComponent(chat.id)}?before=${encodeURIComponent(oldest.id)}`,
      );
      if (this.state.chat.id !== chat.id) return;
      const earlier = detail.turns
        .map((turn) => turnFromView(turn))
        .filter((turn) => !turn.replacedBy);
      this.#setChat({
        turns: [...earlier, ...this.state.chat.turns],
        more: detail.more,
        loadingMore: false,
      });
    } catch (error) {
      this.#setChat({ loadingMore: false });
      this.showListError(failureWords(error));
    }
  }

  newSession(): void {
    this.#unfollow();
    const hour = new Date().getHours();
    const variant = Math.floor(Math.random() * 4);
    const home = {
      ...this.state.home,
      greeting: {
        ...this.state.home.greeting,
        secondLine:
          GREETING_SECOND_LINES[Math.floor(Math.random() * GREETING_SECOND_LINES.length)] ??
          this.state.home.greeting.secondLine,
      },
    };
    this.#set({
      home,
      greeting: greetingFor(home, hour, variant),
      chat: { id: null, session: null, turns: [], more: false, loadingMore: false, loading: false },
      sheetOpen: false,
    });
    this.#setComposer({ focus: this.state.composer.focus + 1 });
    this.#setAddress(null);
  }

  async rename(id: string, title: string): Promise<string | null> {
    try {
      const { session } = await agentApi<{ session: SessionView }>(
        "PATCH",
        `/agent/sessions/${encodeURIComponent(id)}`,
        { title },
      );
      this.#patchSession(id, { title: session.title, titleSource: session.titleSource });
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500)
        return error.field("title") ?? error.message;
      this.showListError(failureWords(error));
      return null;
    }
  }

  async reorder(next: SessionView[]): Promise<void> {
    const seen = this.state.sessions.slice(0, 50);
    const shown = next.slice(0, 50);
    if (shown.every((item, index) => item.id === seen[index]?.id)) return;
    this.#set({ sessions: withSwappedPositions(seen, shown), listError: null });
    try {
      const list = await agentApi<SessionList>(
        "PUT",
        "/agent/sessions/order",
        orderRequest(seen, shown),
      );
      this.#set({ sessions: list.sessions, shared: list.shared });
    } catch (error) {
      this.#set({ sessions: seen });
      this.showListError(
        error instanceof ApiError && error.status === 409
          ? AGENT_MESSAGES.sessionsChanged
          : failureWords(error),
      );
      void this.refreshList(true);
    }
  }

  async move(id: string, delta: -1 | 1): Promise<void> {
    const next = moveBy(this.state.sessions.slice(0, 50), id, delta);
    if (next) await this.reorder(next);
  }

  async share(id: string, shared: boolean): Promise<void> {
    try {
      const reply = await agentApi<{ session: SessionView; message: string }>(
        "POST",
        `/agent/sessions/${encodeURIComponent(id)}/share`,
        { shared },
      );
      this.#patchSession(id, { shared: reply.session.shared });
      const { showToast } = await import("../../client/toasts.ts");
      showToast(reply.message, { tone: "success" });
    } catch (error) {
      this.showListError(failureWords(error));
    }
  }

  /** Delete: true when it went (or was already gone). */
  async remove(id: string): Promise<boolean> {
    try {
      await agentApi("DELETE", `/agent/sessions/${encodeURIComponent(id)}`);
    } catch (error) {
      this.showListError(failureWords(error));
      return false;
    }
    this.#set({
      sessions: this.state.sessions.filter((session) => session.id !== id),
      shared: this.state.shared.filter((session) => session.id !== id),
    });
    if (this.state.chat.id === id) this.newSession();
    return true;
  }

  setSheet(open: boolean): void {
    this.#set({ sheetOpen: open });
  }

  setAway(away: boolean): void {
    if (this.state.away !== away) this.#set({ away });
  }

  jumpToLatest(): void {
    this.#set({ away: false, follow: this.state.follow + 1 });
  }

  // ---- The message box (spec 19.3)

  setText(text: string): void {
    this.#setComposer({ text, error: null });
  }

  fill(text: string): void {
    this.#setComposer({ text, focus: this.state.composer.focus + 1, error: null });
  }

  setQuote(quote: string | null): void {
    this.#setComposer({ quote, focus: this.state.composer.focus + 1 });
  }

  toggleResearch(): void {
    const on = !this.state.composer.deepResearch;
    const missingKey = !this.state.home.research.keySaved;
    this.#setComposer({
      deepResearch: on,
      researchCard: on && missingKey ? true : this.state.composer.researchCard && on,
    });
  }

  closeResearchCard(): void {
    this.#setComposer({ researchCard: false });
  }

  async saveResearchKey(key: string): Promise<string | null> {
    try {
      const reply = await agentApi<{ message?: string }>("PUT", "/workspace/keys/research", {
        key,
      });
      this.#set({
        home: { ...this.state.home, research: { ...this.state.home.research, keySaved: true } },
      });
      this.#setComposer({ researchCard: false, deepResearch: true });
      const { showToast } = await import("../../client/toasts.ts");
      showToast(reply.message ?? "Saved.", { tone: "success" });
      return null;
    } catch (error) {
      if (error instanceof ApiError) return error.field("key") ?? error.message;
      return failureWords(error);
    }
  }

  async saveName(name: string): Promise<string | null> {
    let saved: { person?: ProfileSaved } | null = null;
    try {
      saved = await agentApi<{ person?: ProfileSaved }>("PATCH", "/me", { firstName: name });
    } catch (error) {
      if (error instanceof ApiError) return error.field("firstName") ?? error.message;
      return failureWords(error);
    }
    const home = {
      ...this.state.home,
      greeting: { ...this.state.home.greeting, name, askName: false },
    };
    const variant = Math.floor(Math.random() * 3);
    this.#set({
      home,
      greeting: greetingFor(home, new Date().getHours(), variant),
      viewerName: name,
    });
    // The shell's user button shows the new name too (B3-10).
    if (saved?.person) announceProfileSaved(saved.person);
    return null;
  }

  // ---- Attachments (spec 19.3, 19.10)

  #setFile(key: string, change: Partial<ComposerFile>): void {
    this.#setComposer({
      files: this.state.composer.files.map((file) =>
        file.key === key ? { ...file, ...change } : file,
      ),
    });
  }

  addFiles(list: readonly File[]): void {
    const limits = this.state.home.limits;
    const added: ComposerFile[] = [];
    for (const file of list) {
      pendingCount += 1;
      const key = `file-${pendingCount}`;
      const check = checkFile({ name: file.name, type: file.type, size: file.size }, limits);
      const current = [...this.state.composer.files, ...added].map((item) => ({
        sizeBytes: item.sizeBytes,
        failed: item.state === "failed",
      }));
      const tooMany = check.ok ? addProblem(current, file.size, limits) : null;
      const image = check.ok && check.kind === "image";
      const entry: ComposerFile = {
        key,
        name: file.name || "pasted file",
        sizeBytes: file.size,
        kind: check.ok ? check.kind : null,
        contentType: check.ok ? check.contentType : file.type,
        state: !check.ok || tooMany ? "failed" : image ? "preparing" : "queued",
        progress: 0,
        error: check.ok ? tooMany : check.reason,
        notice: null,
        fileId: null,
        preview: image ? URL.createObjectURL(file) : null,
        url: null,
      };
      added.push(entry);
      if (entry.state !== "failed") this.#rawFiles.set(key, file);
    }
    this.#setComposer({ files: [...this.state.composer.files, ...added], error: null });
    for (const entry of added) {
      if (entry.state === "preparing") void this.#shrink(entry.key);
    }
    this.#pump();
  }

  async #shrink(key: string): Promise<void> {
    const file = this.#rawFiles.get(key);
    const entry = this.state.composer.files.find((item) => item.key === key);
    if (!file || !entry) return;
    let blob: Blob = file;
    if (shrinkable(entry.contentType)) {
      try {
        blob = (await shrinkImage(file, entry.contentType)) ?? file;
      } catch {
        blob = file;
      }
    }
    if (!this.state.composer.files.some((item) => item.key === key)) return;
    this.#rawFiles.set(key, blob);
    const limits = this.state.home.limits;
    const tooBig = blob.size > limits.perKind.image;
    this.#setFile(key, {
      sizeBytes: blob.size,
      state: tooBig ? "failed" : "queued",
      error: tooBig
        ? `Images can be up to ${Math.round(limits.perKind.image / 1048576)} MB.`
        : null,
    });
    this.#pump();
  }

  /** Starts queued uploads, at most three at once. */
  #pump(): void {
    const limit = this.state.home.limits.concurrentUploads || 3;
    const items = this.state.composer.files
      .filter((file) => file.state !== "preparing")
      .map((file) => ({
        id: file.key,
        state: file.state as "queued" | "uploading" | "done" | "failed",
      }));
    const start = uploadsToStart(items, limit);
    for (const key of start) this.#upload(key);
    if (this.state.composer.queued && !this.uploading()) {
      this.#setComposer({ queued: false });
      void this.send();
    }
  }

  #upload(key: string): void {
    const entry = this.state.composer.files.find((item) => item.key === key);
    const blob = this.#rawFiles.get(key);
    if (!entry || !blob) return;
    this.#setFile(key, { state: "uploading", progress: 0 });
    const sessionId = this.state.chat.session?.mine ? this.state.chat.id : null;
    const query = new URLSearchParams({ name: entry.name });
    if (sessionId) query.set("sessionId", sessionId);
    const handle = uploadWithProgress(
      `/agent/files?${query}`,
      blob,
      entry.contentType,
      (fraction) => this.#setFile(key, { progress: fraction }),
    );
    this.#uploads.set(key, handle);
    handle.promise.then(
      (reply) => {
        this.#uploads.delete(key);
        const file = (reply as { file?: FileView }).file;
        if (!this.state.composer.files.some((item) => item.key === key)) {
          if (file)
            void agentApi("DELETE", `/agent/files/${encodeURIComponent(file.id)}`).catch(() => {});
          return;
        }
        this.#setFile(key, {
          state: "done",
          progress: 1,
          fileId: file?.id ?? null,
          notice: file?.notice ?? null,
          url: file?.url ?? null,
        });
        this.#rawFiles.delete(key);
        this.#pump();
      },
      (error: unknown) => {
        this.#uploads.delete(key);
        if (!this.state.composer.files.some((item) => item.key === key)) return;
        const cancelled = error instanceof ApiError && error.code === "aborted";
        this.#setFile(key, {
          state: "failed",
          error: cancelled
            ? "Upload cancelled."
            : error instanceof ApiError
              ? (error.field("file") ?? error.message)
              : "The upload failed. Try again.",
        });
        this.#pump();
      },
    );
  }

  cancelUpload(key: string): void {
    this.#uploads.get(key)?.abort();
  }

  removeFile(key: string): void {
    const entry = this.state.composer.files.find((item) => item.key === key);
    if (!entry) return;
    this.#uploads.get(key)?.abort();
    this.#uploads.delete(key);
    this.#rawFiles.delete(key);
    if (entry.preview) URL.revokeObjectURL(entry.preview);
    if (entry.fileId) {
      void agentApi("DELETE", `/agent/files/${encodeURIComponent(entry.fileId)}`).catch(() => {});
    }
    this.#setComposer({ files: this.state.composer.files.filter((item) => item.key !== key) });
    this.#pump();
  }

  uploading(): boolean {
    return this.state.composer.files.some(
      (file) => file.state === "uploading" || file.state === "queued" || file.state === "preparing",
    );
  }

  // ---- Sending (spec 19.6)

  /** Sends the box (or `text` from a starter or suggestion). */
  async send(override?: string): Promise<void> {
    const composer = this.state.composer;
    const text = (override ?? composer.text).trim();
    const files =
      override === undefined ? composer.files.filter((file) => file.state === "done") : [];
    if (text === "" && files.length === 0) return;
    if (this.readOnly()) return;
    if (this.workingTurn()) {
      this.#setComposer({ error: AGENT_MESSAGES.busy });
      return;
    }
    if (override === undefined && this.uploading()) {
      this.#setComposer({ queued: true });
      return;
    }
    const quote = override === undefined ? composer.quote : null;
    if (override === undefined) {
      for (const file of composer.files)
        if (file.preview && file.state !== "done") URL.revokeObjectURL(file.preview);
      this.#setComposer({ text: "", quote: null, files: [], queued: false, error: null });
    }
    await this.#post(
      {
        text,
        quote,
        fileIds: files.map((file) => file.fileId as string),
        deepResearch: composer.deepResearch,
      },
      {
        text,
        quote,
        files: files.map((file) => ({
          id: file.fileId as string,
          name: file.name,
          kind: file.kind ?? "text",
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          sent: true,
          notice: file.notice,
          url: file.url ?? "",
        })),
      },
    );
  }

  async retry(turn: TurnModel): Promise<void> {
    if (this.workingTurn()) return;
    if (!turn.accepted) {
      // A send the platform refused: send the same words again.
      this.#setChat({ turns: this.state.chat.turns.filter((item) => item.id !== turn.id) });
      await this.#post(
        {
          text: turn.message.text,
          quote: turn.message.quote,
          fileIds: turn.message.files.map((file) => file.id),
          deepResearch: turn.deepResearch,
        },
        turn.message,
      );
      return;
    }
    await this.#post(
      { text: "", quote: null, fileIds: [], deepResearch: turn.deepResearch, retryOf: turn.id },
      turn.message,
    );
  }

  edit(turn: TurnModel): void {
    this.#setComposer({
      text: turn.message.text,
      quote: turn.message.quote,
      focus: this.state.composer.focus + 1,
      error: null,
    });
  }

  async #post(
    body: {
      text: string;
      quote: string | null;
      fileIds: string[];
      deepResearch: boolean;
      retryOf?: string;
    },
    shown: Pick<PersonMessage, "text" | "quote" | "files">,
  ): Promise<void> {
    pendingCount += 1;
    const pendingId = `pending-${pendingCount}`;
    const message: PersonMessage = {
      id: pendingId,
      text: shown.text,
      quote: shown.quote,
      files: shown.files,
      author: { id: this.state.viewerId, name: this.state.viewerName },
      createdAt: new Date().toISOString(),
    };
    const pending = { ...emptyTurn(pendingId, message, false), deepResearch: body.deepResearch };
    const sessionId = this.state.chat.id;
    this.#setChat({ turns: [...this.state.chat.turns, pending] });
    this.#set({ follow: this.state.follow + 1 });
    let sent: SentMessage;
    try {
      sent = await agentApi<SentMessage>(
        "POST",
        sessionId ? `/agent/sessions/${encodeURIComponent(sessionId)}/messages` : "/agent/messages",
        body.retryOf ? { text: "", retryOf: body.retryOf, deepResearch: body.deepResearch } : body,
      );
    } catch (error) {
      const words =
        error instanceof ApiError ? (error.field("text") ?? error.message) : failureWords(error);
      this.#updateTurn(pendingId, (turn) => ({
        ...turn,
        live: false,
        state: "failed",
        status: null,
        sendError: words,
      }));
      this.#stopWhenAccepted.delete(pendingId);
      return;
    }
    if (this.state.chat.id !== sessionId) return;
    const stopRequested = this.#stopWhenAccepted.delete(pendingId);
    const accepted: TurnModel = {
      ...emptyTurn(sent.turn.id, sent.message, true),
      deepResearch: body.deepResearch,
      status: stopRequested
        ? { kind: "stopping", label: "Stopping" }
        : { kind: "thinking", label: "Thinking" },
      workingSince: Date.now(),
    };
    const session = { ...sent.session, state: "working" as const, liveTurnId: sent.turn.id };
    const listed = this.state.sessions.some((item) => item.id === session.id);
    this.#set({
      chat: {
        ...this.state.chat,
        id: session.id,
        session,
        turns: this.state.chat.turns.map((turn) => (turn.id === pendingId ? accepted : turn)),
      },
      sessions: listed
        ? this.state.sessions.map((item) => (item.id === session.id ? session : item))
        : [session, ...this.state.sessions],
    });
    this.#setAddress(session.id);
    // From the start: the few events written before the answer arrived replay in order.
    this.#follow(sent.turn.id, `${sent.turn.id}:0`);
    if (stopRequested) void this.#postStop(sent.turn.id);
  }

  // ---- Stop (spec 19.6)

  stop(): void {
    const turn = this.workingTurn();
    if (!turn) return;
    this.#updateTurn(turn.id, (item) => ({
      ...item,
      status: { kind: "stopping", label: "Stopping" },
    }));
    if (!turn.accepted) {
      // Sent as soon as the chat exists on the platform.
      this.#stopWhenAccepted.add(turn.id);
      return;
    }
    void this.#postStop(turn.id);
  }

  async #postStop(turnId: string): Promise<void> {
    try {
      await agentApi("POST", `/agent/turns/${encodeURIComponent(turnId)}/stop`);
    } catch (error) {
      this.#setComposer({ error: failureWords(error) });
    }
  }

  // ---- Forms and the permission card (spec 19.8, 19.9)

  /** Posts a form's answer (never its secret values); the turn continues on its stream. */
  async answerForm(
    turnId: string,
    formId: string,
    answer: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const reply = await agentApi<{ turn: { id: string; lastEventId: string } }>(
        "POST",
        `/agent/turns/${encodeURIComponent(turnId)}/forms/${encodeURIComponent(formId)}`,
        answer,
      );
      if (reply.turn.id !== turnId) {
        this.#replaceTurn(turnId, reply.turn.id);
      } else if (this.#follower?.turnId !== turnId) {
        const turn = this.state.chat.turns.find((item) => item.id === turnId);
        this.#follow(turnId, turn?.lastEventId ?? `${turnId}:0`);
      }
      this.#updateTurn(reply.turn.id, (turn) => ({
        ...turn,
        state: "working",
        live: true,
        status: { kind: "thinking", label: "Thinking" },
      }));
      this.#patchSession(this.state.chat.id, { state: "working" });
      return null;
    } catch (error) {
      return error instanceof ApiError ? error.message : failureWords(error);
    }
  }

  async allow(turnId: string, policy: string): Promise<string | null> {
    if (this.workingTurn()) return AGENT_MESSAGES.busy;
    try {
      const sent = await agentApi<SentMessage>(
        "POST",
        `/agent/turns/${encodeURIComponent(turnId)}/permission`,
        { policy },
      );
      this.#updateTurn(turnId, (turn) => ({
        ...turn,
        permissions: turn.permissions.map((card) =>
          card.policy === policy ? { ...card, allowed: true } : card,
        ),
      }));
      const turn = {
        ...emptyTurn(sent.turn.id, sent.message, true),
        workingSince: Date.now(),
        status: { kind: "thinking" as const, label: "Thinking" },
      };
      this.#set({
        chat: {
          ...this.state.chat,
          turns: [...this.state.chat.turns, turn],
          session: sent.session,
        },
        follow: this.state.follow + 1,
      });
      this.#follow(sent.turn.id, `${sent.turn.id}:0`);
      return null;
    } catch (error) {
      return error instanceof ApiError ? error.message : failureWords(error);
    }
  }
}

/** Draws an image at most 2,048px on its long side (spec 19.10); null when it is small enough. */
async function shrinkImage(file: Blob, contentType: string): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = shrunkSize(bitmap.width, bitmap.height);
    if (!size.changed) return null;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const type = contentType === "image/png" ? "image/png" : contentType;
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  } finally {
    bitmap.close();
  }
}
