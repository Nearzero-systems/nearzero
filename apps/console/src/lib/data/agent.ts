import type { HomeView, SessionDetail, SessionList } from "../agent/types.ts";
import { ApiError } from "../api-error.ts";
import { ControlClient } from "../control-client.ts";
import type { DataContext } from "./types.ts";

/**
 * The Agent page's data from the control plane (docs/api/agent.md): the home, the sessions
 * list and one session with its newest turns, for the first paint. Everything after that the
 * page loads in the browser.
 */

export interface AgentData {
  agentHome(): Promise<HomeView>;
  agentSessionList(): Promise<SessionList>;
  /** null: gone, or not visible to this person (they look the same). */
  agentSession(sessionId: string): Promise<SessionDetail | null>;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function agentData(ctx: DataContext): AgentData {
  const api = new ControlClient(ctx);
  return {
    agentHome: () => api.get<HomeView>("/agent"),
    agentSessionList: () => api.get<SessionList>("/agent/sessions"),
    async agentSession(sessionId) {
      if (!ID.test(sessionId)) return null;
      try {
        return await api.get<SessionDetail>(`/agent/sessions/${sessionId}`);
      } catch (error) {
        if (error instanceof ApiError && (error.code === "not_found" || error.status === 404)) {
          return null;
        }
        throw error;
      }
    },
  };
}
