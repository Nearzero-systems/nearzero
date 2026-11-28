import { usableProviders } from "../../git-providers/area.ts";
import type { WorkspaceActor } from "../../http/actor.ts";
import type { ControlServices } from "../../services.ts";
import { GUIDED_CAPABILITY, type GuidedState } from "../flows.ts";
import { answerForm } from "../messages.ts";
import type { WaitState } from "../turns.ts";

/**
 * Coming back from a Connect button (spec 19.7 step 1): the Git import waits on its Connect
 * form (or the model's Git action on its access card), and when its author opens the chat again
 * within 30 minutes with a Git account they can now use, it carries on by itself, as if they had
 * answered the form.
 */
export async function resumeAfterConnect(
  services: ControlServices,
  actor: WorkspaceActor,
  sessionId: string,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const turn = await services.db
    .selectFrom("agent_turn as t")
    .innerJoin("agent_session as s", "s.id", "t.session_id")
    .select(["t.id", "t.wait", "s.author_id"])
    .where("t.session_id", "=", sessionId)
    .where("t.workspace_id", "=", actor.workspace.id)
    .where("t.state", "=", "waiting")
    .executeTakeFirst();
  if (!turn || turn.author_id !== actor.personId) return;
  const wait = turn.wait as WaitState | null;
  if (wait?.kind !== "form") return;
  // The guided import's Connect form, or the model's Git action's access card (31d R4-01).
  const until =
    wait.capability === GUIDED_CAPABILITY
      ? (wait.context as GuidedState).connectUntil
      : typeof wait.context.connectUntil === "string"
        ? wait.context.connectUntil
        : null;
  if (!until || Date.parse(until) < Date.now()) return;
  const ready = (await usableProviders(services, actor)).some((provider) => provider.ready);
  if (!ready) return;
  await answerForm(services, actor, turn.id, wait.formId, {
    outcome: "connected",
    label: "Connected a Git account",
  });
}
