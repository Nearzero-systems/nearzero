import type { DockerClient } from "../docker/client.ts";
import { type DatabaseTarget, libsqlExchangeStep } from "./database-steps.ts";
import {
  type HelperContext,
  type HelperStep,
  readScratchFile,
  runHelper,
  SCRATCH_PATH,
  writeScratchFile,
} from "./helpers.ts";

/**
 * Loading a libSQL dump (spec 08 8.3). libSQL takes SQL over its HTTP API (Hrana pipelines), so
 * the runner builds the requests itself and a helper on the database's network sends them,
 * each from a file in the scratch volume, with the credentials in a file written into the
 * helper (database-steps.ts): one request lists the tables, views and triggers, the next drops
 * them and runs the dump, in one transaction.
 */

/** Dumps larger than this are refused (the request is built in memory). */
export const LIBSQL_RESTORE_MAX_BYTES = 512 * 1024 * 1024;

const LIST_OBJECTS =
  "SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'libsql\\_%' ESCAPE '\\' AND name NOT LIKE '\\_litestream%' ESCAPE '\\'";

interface PipelineResult {
  type: "ok" | "error";
  response?: { type: string; result?: { rows?: { type: string; value?: unknown }[][] } };
  error?: { message?: string };
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type SqlState = "code" | "single" | "double" | "bracket" | "backtick" | "block";

/** Where a line of SQL leaves the reader: inside a string, a quoted name or a comment, or not. */
function stateAfter(line: string, start: SqlState): SqlState {
  let state = start;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];
    switch (state) {
      case "code":
        if (char === "'") state = "single";
        else if (char === '"') state = "double";
        else if (char === "[") state = "bracket";
        else if (char === "`") state = "backtick";
        else if (char === "-" && next === "-") return "code";
        else if (char === "/" && next === "*") {
          state = "block";
          index++;
        }
        break;
      // A doubled quote inside a string closes and opens it again, which comes to the same.
      case "single":
        if (char === "'") state = "code";
        break;
      case "double":
        if (char === '"') state = "code";
        break;
      case "bracket":
        if (char === "]") state = "code";
        break;
      case "backtick":
        if (char === "`") state = "code";
        break;
      case "block":
        if (char === "*" && next === "/") {
          state = "code";
          index++;
        }
        break;
    }
  }
  return state;
}

/**
 * The dump without its own transaction lines, so it runs inside the restore's transaction. Only a
 * line that is a statement of its own is dropped: a text value whose line reads `COMMIT;` stays
 * exactly as it is (B2-21). The pinned libSQL server writes line breaks in values as
 * replace('…\n…','\n',char(10)), but a dump from another version or tool may carry them as
 * they are.
 */
export function unwrapDump(sql: string): string {
  const kept: string[] = [];
  let state: SqlState = "code";
  for (const line of sql.split("\n")) {
    if (state === "code") {
      const trimmed = line.trim().toUpperCase();
      if (trimmed === "BEGIN TRANSACTION;" || trimmed === "BEGIN;" || trimmed === "COMMIT;") {
        continue;
      }
    }
    kept.push(line);
    state = stateAfter(line, state);
  }
  return kept.join("\n");
}

/** The statements that replace the database's objects with the dump's. */
export function restoreSql(objects: { type: string; name: string }[], dump: string): string {
  const order = { trigger: 0, view: 1, table: 2 } as Record<string, number>;
  const drops = [...objects]
    .sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3))
    .map((item) => `DROP ${item.type.toUpperCase()} IF EXISTS ${quoteIdentifier(item.name)};`);
  return ["PRAGMA foreign_keys=OFF;", "BEGIN;", ...drops, unwrapDump(dump), "COMMIT;"].join("\n");
}

export function pipelineBody(requests: unknown[]): string {
  return JSON.stringify({ baton: null, requests: [...requests, { type: "close" }] });
}

export function pipelineErrors(answer: string): string | null {
  let parsed: { results?: PipelineResult[] };
  try {
    parsed = JSON.parse(answer) as { results?: PipelineResult[] };
  } catch {
    return "libSQL's answer wasn't readable.";
  }
  const failed = (parsed.results ?? []).find((result) => result.type === "error");
  if (failed) return failed.error?.message ?? "libSQL refused the request.";
  return null;
}

export function objectsFrom(answer: string): { type: string; name: string }[] {
  const parsed = JSON.parse(answer) as { results?: PipelineResult[] };
  const rows = parsed.results?.[0]?.response?.result?.rows ?? [];
  return rows
    .map((row) => ({ type: String(row[0]?.value ?? ""), name: String(row[1]?.value ?? "") }))
    .filter((item) => item.name !== "" && ["table", "view", "trigger"].includes(item.type));
}

function postStep(
  toolsImage: string,
  target: DatabaseTarget,
  scratch: string,
  title: string,
  body: { file: string; bytes: number },
  answer: string,
): HelperStep {
  const step = libsqlExchangeStep(toolsImage, target, {
    title,
    method: "POST",
    path: "/v2/pipeline",
    body: { file: `${SCRATCH_PATH}/${body.file}`, bytes: body.bytes },
    answerFile: `${SCRATCH_PATH}/${answer}`,
  });
  return { ...step, mounts: [{ source: scratch, target: SCRATCH_PATH }] };
}

async function post(
  context: HelperContext,
  toolsImage: string,
  target: DatabaseTarget,
  scratch: string,
  title: string,
  body: string,
  index: number,
): Promise<string> {
  const docker: DockerClient = context.docker;
  const bytes = new TextEncoder().encode(body);
  await writeScratchFile(
    docker,
    toolsImage,
    context.runId,
    scratch,
    `request-${index}.json`,
    bytes,
  );
  context.out(`→ ${title}\n`);
  const result = await runHelper(
    context,
    postStep(
      toolsImage,
      target,
      scratch,
      title,
      { file: `request-${index}.json`, bytes: bytes.length },
      `answer-${index}.json`,
    ),
    100 + index,
  );
  if (result.exitCode !== 0) {
    throw new Error(`${title} failed (exit code ${result.exitCode ?? "none"}).`);
  }
  const answer = new TextDecoder().decode(
    await readScratchFile(
      docker,
      toolsImage,
      context.runId,
      scratch,
      `answer-${index}.json`,
      16 * 1024 * 1024,
    ),
  );
  const problem = pipelineErrors(answer);
  if (problem) throw new Error(`${title} failed: ${problem}`);
  context.out(`✓ ${title}\n`);
  return answer;
}

/** Replaces the libSQL database's contents with the dump in the scratch volume (dump.sql). */
export async function loadLibsqlDump(
  context: HelperContext,
  toolsImage: string,
  target: DatabaseTarget,
  scratch: string,
): Promise<void> {
  const dump = new TextDecoder().decode(
    await readScratchFile(
      context.docker,
      toolsImage,
      context.runId,
      scratch,
      "dump.sql",
      LIBSQL_RESTORE_MAX_BYTES,
    ),
  );
  if (dump.trim() === "")
    throw new Error("The backup holds an empty dump, so nothing was restored.");
  const listed = await post(
    context,
    toolsImage,
    target,
    scratch,
    "Listing the database's tables",
    pipelineBody([{ type: "execute", stmt: { sql: LIST_OBJECTS } }]),
    1,
  );
  const objects = objectsFrom(listed);
  await post(
    context,
    toolsImage,
    target,
    scratch,
    `Replacing ${objects.length} ${objects.length === 1 ? "object" : "objects"} with the dump`,
    pipelineBody([{ type: "sequence", sql: restoreSql(objects, dump) }]),
    2,
  );
}
