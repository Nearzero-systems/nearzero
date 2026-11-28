import type { AccessLogCommandKind, ParsedCommandParams } from "@nearzero/shared";
import { type CommandContext, CommandError } from "../commands.ts";
import { clearFile, readPiece, trimToNewest } from "./file.ts";
import { accessLogFor } from "./runtime.ts";

/**
 * The runner's handlers for the router's request log (spec 13). commands.ts adds them to its
 * table.
 */

type Handler<K extends AccessLogCommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

function runtime(context: CommandContext) {
  const found = accessLogFor(context.router);
  if (!found)
    throw new CommandError(
      "unsupported",
      "This runner doesn't keep a request log. Update the runner.",
    );
  return found;
}

export const accessLogHandlers: { [K in AccessLogCommandKind]: Handler<K> } = {
  "access-log.configure": async (params, context) => runtime(context).configure(params.enabled),
  "access-log.status": async (_params, context) => runtime(context).status(),
  "access-log.read": async (params, context) =>
    readPiece(runtime(context).path, params.fromOffset, params.maxBytes, params.tailBytes),
  "access-log.trim": async (params, context) =>
    trimToNewest(runtime(context).path, params.keepLines),
  "access-log.clear": async (_params, context) => {
    await clearFile(runtime(context).path);
    return { cleared: true };
  },
};
