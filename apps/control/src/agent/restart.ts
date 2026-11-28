import { sql } from "kysely";
import type { ControlServices } from "../services.ts";
import { TurnEvents } from "./events.ts";
import { pruneUnsentFiles } from "./files.ts";
import { rerunAfterKey } from "./messages.ts";
import { agentSettings, THIS_HOST } from "./settings.ts";
import { finishTurn, runningHere, type WaitState } from "./turns.ts";
import "./tables.ts";

/**
 * Turns and restarts (spec 19.6): a turn that was working when its process went away is finished
 * as "Stopped (Nearzero restarted)" with what it did so far; turns waiting on a form survive and
 * continue when answered; a question waiting for a model key is answered once a key is saved
 * (spec 19.10, new in 1.0). Runs at start and then every few seconds in every process.
 */

export async function sweepTurns(
  services: ControlServices,
): Promise<{ stopped: number; resumed: number }> {
  const settings = agentSettings(services);
  const { db } = services;
  const staleBefore = new Date(settings.now() - settings.staleAfterMs);
  // Working turns whose process is gone: no heartbeat for a while, or an earlier boot of this host.
  const candidates = await db
    .selectFrom("agent_turn")
    .select(["id", "owner"])
    .where("state", "=", "working")
    .where((eb) =>
      eb.or([
        eb("heartbeat_at", "is", null),
        eb("heartbeat_at", "<", staleBefore),
        eb.and([eb("owner", "like", `${THIS_HOST}/%`), eb("owner", "!=", settings.owner)]),
      ]),
    )
    .execute();
  let stopped = 0;
  for (const turn of candidates) {
    if (runningHere(turn.id)) continue;
    const claimed = await db
      .updateTable("agent_turn")
      .set({ owner: settings.owner, heartbeat_at: new Date() })
      .where("id", "=", turn.id)
      .where("state", "=", "working")
      .where((eb) => (turn.owner === null ? eb("owner", "is", null) : eb("owner", "=", turn.owner)))
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) continue;
    const events = await TurnEvents.open(db, services.log, turn.id, settings.textFlushMs);
    await finishTurn(services, turn.id, events, null, {
      state: "stopped",
      stoppedBy: "restart",
      suggest: false,
    });
    stopped++;
  }

  // Questions waiting for a model key: answered as soon as one is saved.
  const waiting = await db
    .selectFrom("agent_turn as t")
    .innerJoin("workspace_secret as k", (join) =>
      join.onRef("k.workspace_id", "=", "t.workspace_id").on("k.kind", "=", "model-key"),
    )
    .select(["t.id", "t.wait", "k.added_at"])
    .where("t.state", "=", "waiting")
    .where(sql<boolean>`t.wait->>'kind' = 'model_key'`)
    .execute();
  let resumed = 0;
  for (const turn of waiting) {
    const wait = turn.wait as WaitState | null;
    if (wait?.kind !== "model_key") continue;
    if (turn.added_at.getTime() <= Date.parse(wait.since)) continue;
    if (await rerunAfterKey(services, turn.id)) resumed++;
  }
  return { stopped, resumed };
}

export interface AgentBackground {
  stop(): void;
}

const UNSENT_PRUNE_MS = 5 * 60_000;

export function startAgentBackground(services: ControlServices): AgentBackground {
  const settings = agentSettings(services);
  let busy = false;
  let prunedAt = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await sweepTurns(services);
      // Uploads nobody sent within a day go, every few minutes (B1-23).
      if (Date.now() - prunedAt > UNSENT_PRUNE_MS) {
        prunedAt = Date.now();
        await pruneUnsentFiles(services.db);
      }
    } catch (error) {
      services.log.warn("couldn't check the Agent's turns", { error });
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), settings.sweepMs);
  return { stop: () => clearInterval(timer) };
}
