import {
  AGENT_LIMITS,
  AGENT_MESSAGES,
  AGENT_STARTERS,
  ATTACHMENT_KIND_MAX_BYTES,
} from "@nearzero/shared/browser";
import { useState } from "react";
import type { HomeView, SessionView } from "../../lib/agent/types.ts";
import { StoreContext } from "./context.tsx";
import { SessionsPanel } from "./Sessions.tsx";
import { AgentStore } from "./store.ts";

/** The real sessions list with sample rows, for the living style guide (/dev/components). */

const SAMPLE_HOME: HomeView = {
  enabled: true,
  greeting: { name: "Maya", askName: false, secondLine: "How can I help?", fixed: null },
  starters: AGENT_STARTERS.map((starter) => ({ ...starter })),
  research: { keySaved: false, canAddKey: true, whoCanAdd: AGENT_MESSAGES.researchNoKey },
  model: { keySaved: true, keyUsable: true },
  limits: {
    filesPerMessage: AGENT_LIMITS.filesPerMessage,
    totalBytes: 25 * 1024 * 1024,
    perKind: ATTACHMENT_KIND_MAX_BYTES,
    quoteChars: AGENT_LIMITS.quoteMax,
    messageChars: AGENT_LIMITS.messageMax,
    concurrentUploads: AGENT_LIMITS.concurrentUploads,
  },
  can: { allowPolicies: true },
};

export interface SampleSession {
  id: string;
  title: string | null;
  lastMessageAt: string;
  working: boolean;
}

export default function SessionsPreview({
  workspace,
  sessions,
  currentId,
}: {
  workspace: string;
  sessions: SampleSession[];
  currentId?: string;
}) {
  const [store] = useState(() => {
    const views: SessionView[] = sessions.map((session, index) => ({
      id: session.id,
      title: session.title,
      titleSource: session.title ? "generated" : null,
      shared: false,
      mine: true,
      author: { id: "preview", name: "Maya Lopez" },
      position: sessions.length - index,
      state: session.working ? "working" : "idle",
      liveTurnId: null,
      lastMessageAt: session.lastMessageAt,
      createdAt: session.lastMessageAt,
    }));
    const store = new AgentStore({
      workspace,
      viewerId: "preview",
      viewerName: "Maya Lopez",
      home: SAMPLE_HOME,
      list: { sessions: views, shared: [], limit: 50 },
      detail: null,
      detailError: null,
      hour: 9,
      greetingVariant: 0,
      renderedAt: Date.now(),
    });
    if (currentId) store.state = { ...store.state, chat: { ...store.state.chat, id: currentId } };
    return store;
  });
  return (
    <StoreContext.Provider value={store}>
      <SessionsPanel variant="column" />
    </StoreContext.Provider>
  );
}
