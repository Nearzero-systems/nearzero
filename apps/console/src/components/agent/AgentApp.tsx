import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";
import { Icon, StoreContext, useAgent, useStore } from "./context.tsx";
import { Home } from "./Home.tsx";
import { SessionsPanel } from "./Sessions.tsx";
import { AgentStore, type Initial } from "./store.ts";

/**
 * The Agent page (spec 19.1, 21.10): the sessions list on the left and the chat beside it. An
 * empty chat holds the message box right under the greeting; once there is a conversation the
 * box docks at the bottom. Under 720px the list slides over the chat from the left, opened from
 * the history button in the 34px row (spec 19.5, 21.8). Escape stops a running answer when no
 * other field or dialog has focus (spec 19.6).
 */

function editableOtherThanComposer(element: Element | null): boolean {
  if (!element || element === document.body) return false;
  if (element.matches("[data-composer-input]")) return false;
  return element.matches("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function useEscapeToStop() {
  const store = useStore();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (
        document.querySelector(
          'dialog[open], .nz-session-menu:not([data-motion="out"]), .nz-dropdown-panel:not([data-motion="out"])',
        )
      )
        return;
      if (editableOtherThanComposer(document.activeElement)) return;
      if (!store.workingTurn()) return;
      event.preventDefault();
      store.stop();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [store]);
}

function SessionsSheet() {
  const store = useStore();
  const open = useAgent((state) => state.sheetOpen);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        store.setSheet(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, store]);
  return (
    <div
      className="nz-sheet-layer"
      data-open={open ? "true" : "false"}
      aria-hidden={open ? undefined : "true"}
    >
      <button
        type="button"
        className="nz-sheet-backdrop"
        aria-label="Close chat history"
        tabIndex={-1}
        onClick={() => store.setSheet(false)}
      />
      <div
        ref={panel}
        className="nz-sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Chat history"
        inert={!open}
      >
        <div className="nz-sheet-head">
          <span className="nz-subtitle">Chat history</span>
          <button
            type="button"
            className="nz-btn nz-btn--icon"
            aria-label="Close chat history"
            onClick={() => store.setSheet(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <SessionsPanel variant="sheet" />
      </div>
    </div>
  );
}

function Chat() {
  const store = useStore();
  const empty = useAgent((state) => state.chat.turns.length === 0 && !state.chat.loading);
  const loading = useAgent((state) => state.chat.loading);
  useEscapeToStop();
  return (
    <section className="nz-chat" data-empty={empty ? "true" : "false"} aria-label="Chat">
      {/* Phones: a 34px row with icon-only history and new-session buttons (spec 21.10). */}
      <div className="nz-chat-bar">
        <button
          type="button"
          className="nz-btn nz-btn--icon"
          title="Chat history"
          onClick={() => store.setSheet(true)}
        >
          <Icon name="history" />
          <span className="nz-visually-hidden">Chat history</span>
        </button>
        <button
          type="button"
          className="nz-btn nz-btn--icon"
          title="New session"
          onClick={() => store.newSession()}
        >
          <Icon name="edit" />
          <span className="nz-visually-hidden">New session</span>
        </button>
      </div>
      <div className="nz-scene" aria-hidden="true">
        <div className="nz-moon" />
        <div className="nz-sunrise" />
      </div>
      {loading ? (
        <div className="nz-chat-scroll">
          <div className="nz-thread nz-thread--loading">
            <span className="nz-spinner" role="img" aria-label="Loading" />
          </div>
        </div>
      ) : empty ? (
        <div className="nz-chat-scroll">
          <Home composer={<Composer placement="home" />} />
        </div>
      ) : (
        <Conversation />
      )}
      {!empty && <Composer placement="dock" />}
      <SessionsSheet />
    </section>
  );
}

export default function AgentApp({ initial }: { initial: Initial }) {
  const [store] = useState(() => new AgentStore(initial));
  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <div className="nz-agent" data-agent-app>
        <aside className="nz-secondary nz-secondary--sessions" aria-label="Sessions">
          <SessionsPanel variant="column" />
        </aside>
        <Chat />
      </div>
    </StoreContext.Provider>
  );
}
