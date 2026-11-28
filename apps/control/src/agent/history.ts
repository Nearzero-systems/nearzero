import type { Db } from "../db/database.ts";
import { type FileRow, newBudget, renderMessage, sessionFiles } from "./files.ts";
import type { ModelInputs, ModelMessage, ToolCall } from "./provider/provider.ts";
import "./tables.ts";

/**
 * What the model has been told in a session, stored item by item (agent_model_item) so a turn
 * waiting on a form can continue after a restart, and the next question sees the earlier ones.
 * Items never hold a value typed into a secure form; tool results are already redacted and cut.
 */

export type ModelItem =
  | { role: "user"; text: string; fileIds: string[] }
  | {
      role: "assistant";
      text: string;
      toolCalls: { id: string; name: string; arguments: string }[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string }
  | { role: "note"; text: string }
  | { role: "files"; fileIds: string[] };

export interface StoredItem {
  turnId: string;
  item: ModelItem;
}

export async function loadItems(db: Db, sessionId: string): Promise<StoredItem[]> {
  const rows = await db
    .selectFrom("agent_model_item as i")
    .innerJoin("agent_turn as t", "t.id", "i.turn_id")
    .select(["i.turn_id", "i.item"])
    .where("i.session_id", "=", sessionId)
    .where("t.hidden", "=", false)
    .orderBy("i.id")
    .execute();
  return rows.map((row) => ({ turnId: row.turn_id, item: row.item as ModelItem }));
}

export async function saveItem(
  db: Db,
  sessionId: string,
  turnId: string,
  item: ModelItem,
): Promise<void> {
  await db
    .insertInto("agent_model_item")
    .values({ session_id: sessionId, turn_id: turnId, item: JSON.stringify(item) })
    .execute();
}

const HISTORY_TURNS = 40;
const HISTORY_CHARS = 400_000;

/** Keeps the newest whole turns that fit, so action calls and their results stay together. */
function window(items: StoredItem[], currentTurnId: string): StoredItem[] {
  const order: string[] = [];
  for (const entry of items) if (order.at(-1) !== entry.turnId) order.push(entry.turnId);
  let turns = order.slice(-HISTORY_TURNS);
  const size = (ids: string[]) =>
    items
      .filter((entry) => ids.includes(entry.turnId))
      .reduce((sum, entry) => sum + JSON.stringify(entry.item).length, 0);
  while (turns.length > 1 && turns[0] !== currentTurnId && size(turns) > HISTORY_CHARS)
    turns = turns.slice(1);
  const keep = new Set(turns);
  return items.filter((entry) => keep.has(entry.turnId));
}

/**
 * The chat as model messages after the system prompt. Every action call gets a result (a turn
 * stopped mid-action left none), and images are budgeted newest message first.
 */
export async function buildMessages(
  db: Db,
  sessionId: string,
  items: StoredItem[],
  currentTurnId: string,
  inputs: ModelInputs,
): Promise<ModelMessage[]> {
  const kept = window(items, currentTurnId);
  const files = new Map<string, FileRow>(
    (await sessionFiles(db, sessionId)).map((row) => [row.id, row]),
  );
  const budget = newBudget();
  const rendered: (ModelMessage | null)[] = new Array(kept.length).fill(null);
  // Newest first, so the newest images win the request's budget.
  for (let index = kept.length - 1; index >= 0; index--) {
    const { item, turnId } = kept[index] as StoredItem;
    if (item.role === "user") {
      const attached = item.fileIds
        .map((id) => files.get(id))
        .filter((row): row is FileRow => !!row);
      rendered[index] = {
        role: "user",
        content: await renderMessage(
          db,
          item.text,
          attached,
          inputs,
          budget,
          turnId === currentTurnId,
        ),
      };
    } else if (item.role === "files") {
      const attached = item.fileIds
        .map((id) => files.get(id))
        .filter((row): row is FileRow => !!row);
      const content = await renderMessage(
        db,
        "Here are the files you asked to look at again.",
        attached,
        inputs,
        budget,
        true,
      );
      rendered[index] = { role: "user", content };
    } else if (item.role === "note") {
      rendered[index] = {
        role: "user",
        content: `[Note from Nearzero, not written by the person] ${item.text}`,
      };
    } else if (item.role === "assistant") {
      const toolCalls: ToolCall[] = item.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
      rendered[index] = {
        role: "assistant",
        content: item.text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    } else {
      rendered[index] = { role: "tool", tool_call_id: item.toolCallId, content: item.content };
    }
  }
  // Pair every call with a result, in order.
  const messages: ModelMessage[] = [];
  let open: string[] = [];
  const closeOpen = () => {
    for (const id of open) {
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: "No result: the request was stopped before this finished.",
      });
    }
    open = [];
  };
  for (const message of rendered) {
    if (!message) continue;
    if (message.role === "tool") {
      if (!open.includes(message.tool_call_id)) continue;
      open = open.filter((id) => id !== message.tool_call_id);
      messages.push(message);
      continue;
    }
    closeOpen();
    messages.push(message);
    if (message.role === "assistant" && message.tool_calls)
      open = message.tool_calls.map((call) => call.id);
  }
  // Calls of the turn in progress are answered by the loop itself.
  if (open.length > 0) closeOpen();
  return messages;
}
