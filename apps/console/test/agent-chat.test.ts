import { describe, expect, test } from "bun:test";
import {
  addProblem,
  checkFile,
  enterSends,
  sendState,
  shrinkable,
  shrunkSize,
  uploadsToStart,
} from "../src/lib/agent/composer-rules.ts";
import {
  clipQuote,
  fileSize,
  foldCode,
  foldResult,
  questionFolds,
  shortReason,
  showMoreLabel,
} from "../src/lib/agent/folding.ts";
import { apiPath, failureWords, GENERIC_RETRY } from "../src/lib/agent/http.ts";
import {
  decodeEntities,
  expandInlineTable,
  expandInlineTables,
  languageLabel,
  lexAnswer,
  safeHref,
} from "../src/lib/agent/markdown.ts";
import {
  canStartDrag,
  dropIndex,
  moveBy,
  moveIndex,
  orderRequest,
  passedThreshold,
  withSwappedPositions,
} from "../src/lib/agent/ordering.ts";
import {
  filterOptions,
  moveHighlight,
  optionHref,
  pickerStyle,
  showsSearch,
} from "../src/lib/agent/picker.ts";
import { reconnectDelay, SseParser } from "../src/lib/agent/sse.ts";
import {
  applyEvent,
  copyTextOf,
  editVisible,
  elapsedLabel,
  emptyTurn,
  retryVisible,
  statusLabel,
  stepCounts,
  suggestionsVisible,
  turnFromView,
} from "../src/lib/agent/turn-model.ts";
import type { PersonMessage, TurnModel, TurnView, WireEvent } from "../src/lib/agent/types.ts";
import {
  counterText,
  initialRows,
  mergeBody,
  multiLineValue,
  newRow,
  pasteEnv,
  rowProblems,
  rowsToSave,
  saveLabel,
} from "../src/lib/agent/variables-form.ts";
import { ApiError } from "../src/lib/api-error.ts";

const TURN = "11111111-2222-4333-8444-555555555555";
const ID = "3f2a9c1e-4b5d-4e6f-8a7b-9c0d1e2f3a4b";

const message: PersonMessage = {
  id: "m1",
  text: "Deploy web",
  quote: null,
  files: [],
  author: { id: "p1", name: "Maya" },
  createdAt: "2026-11-25T10:00:00.000Z",
};

let seq = 0;
function event(type: string, data: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { id: `${TURN}:${seq}`, seq, type, data };
}

function threeStepEvents(): WireEvent[] {
  seq = 0;
  const step = (id: string, label: string, done: string, target: string) => [
    event("step.started", { stepId: id, capability: "x", label, target, startedAt: "" }),
    event("step.finished", {
      stepId: id,
      state: "succeeded",
      label: done,
      target,
      reason: null,
      result: `{"ok":true,"id":"${ID}"}`,
      resultTruncated: false,
      durationMs: 12,
    }),
  ];
  return [
    event("turn.started", {
      turnId: TURN,
      sessionId: "s",
      messageId: "m1",
      deepResearch: false,
      startedAt: "2026-11-25T10:00:00.000Z",
    }),
    event("status", { kind: "thinking", label: "Thinking" }),
    event("text", { delta: "Let me look. " }),
    ...step("a", "Listing projects", "Listed projects", "1 found"),
    ...step("b", "Listing servers", "Listed servers", "prod-1"),
    event("text", { delta: "Halfway. " }),
    ...step("c", "Deploying", "Deployed", "web on prod-1"),
    event("text", { delta: `All done (id: ${ID}).` }),
    event("turn.finished", {
      state: "finished",
      stoppedBy: null,
      workedMs: 34_000,
      steps: 3,
      failedSteps: 0,
      footer: "Worked for 34s · 3 steps",
      canRetry: false,
      finishedAt: "",
    }),
    event("suggestions", { items: ["Show the logs of web", "Deploy web again"] }),
  ];
}

function play(events: WireEvent[]): TurnModel {
  let turn = emptyTurn(TURN, message, true);
  for (const item of events)
    turn = applyEvent(turn, item, { now: Date.parse("2026-11-25T10:00:05Z") });
  return turn;
}

describe("a turn built from its events (spec 19.4)", () => {
  test("three steps show as three rows in order between the words, with targets", () => {
    const turn = play(threeStepEvents());
    expect(turn.parts.map((part) => part.kind)).toEqual([
      "text",
      "step",
      "step",
      "text",
      "step",
      "text",
    ]);
    const steps = turn.parts.filter((part) => part.kind === "step");
    expect(steps.map((step) => (step as { label: string }).label)).toEqual([
      "Listed projects",
      "Listed servers",
      "Deployed",
    ]);
    expect(steps.map((step) => (step as { target: string }).target)).toEqual([
      "1 found",
      "prod-1",
      "web on prod-1",
    ]);
    expect(turn.footer).toBe("Worked for 34s · 3 steps");
    expect(stepCounts(turn)).toEqual({ steps: 3, failed: 0 });
    expect(turn.state).toBe("finished");
    expect(turn.live).toBe(false);
  });

  test("a running row has a present-tense label and the status line follows it", () => {
    seq = 0;
    const turn = play([
      event("turn.started", { startedAt: "2026-11-25T10:00:00Z" }),
      event("step.started", { stepId: "a", label: "Setting up server", target: "prod-1" }),
    ]);
    const step = turn.parts[0];
    expect(step?.kind === "step" && step.state).toBe("running");
    expect(statusLabel(turn)).toBe("Setting up server");
  });

  test("after a reload the saved events give the same rows", () => {
    const events = threeStepEvents();
    const live = play(events);
    const view: TurnView = {
      id: TURN,
      state: "finished",
      message,
      events,
      answerText: "Let me look. Halfway. All done.",
      footer: "Worked for 34s · 3 steps",
      canRetry: false,
      canEdit: true,
      live: false,
      lastEventId: `${TURN}:${events.length}`,
    };
    const reloaded = turnFromView(view);
    expect(reloaded.parts).toEqual(live.parts);
    expect(reloaded.footer).toBe(live.footer);
  });

  test("after a reload the timer counts from the current working stretch, not the turn's start (19.4)", () => {
    seq = 0;
    const events = [
      event("turn.started", { startedAt: "2026-11-25T10:00:00Z" }),
      event("waiting", { label: "Waiting for the SSH key" }),
      event("form.answered", { formId: "f1", outcome: "submitted", label: "Saved" }),
    ];
    const now = Date.parse("2026-11-25T10:05:10Z");
    const base: TurnView = {
      id: TURN,
      state: "working",
      message,
      events,
      answerText: "",
      footer: null,
      canRetry: false,
      canEdit: false,
      live: true,
      lastEventId: `${TURN}:${events.length}`,
      workingSince: "2026-11-25T10:05:00Z",
    };
    // The person answered the form at 10:05; the 5 minutes of waiting don't count.
    expect(turnFromView(base, now).workingSince).toBe(Date.parse("2026-11-25T10:05:00Z"));
    // An older platform without the field: the replayed start.
    const { workingSince: _, ...older } = base;
    expect(turnFromView(older, now).workingSince).toBe(Date.parse("2026-11-25T10:00:00Z"));
    // Waiting or finished: no timer.
    expect(
      turnFromView({ ...base, state: "waiting", workingSince: null }, now).workingSince,
    ).toBeNull();
  });

  test("ids are removed from the text people copy", () => {
    const turn = play(threeStepEvents());
    expect(copyTextOf(turn)).not.toContain(ID);
    expect(copyTextOf(turn)).toContain("All done.");
  });

  test("a failed step keeps its reason; waiting pauses the timer; form answers are recorded", () => {
    seq = 0;
    let turn = play([
      event("turn.started", { startedAt: "2026-11-25T10:00:00Z" }),
      event("step.started", { stepId: "a", label: "Deploying", target: "web" }),
      event("step.finished", {
        stepId: "a",
        state: "failed",
        label: "Deploying",
        target: "web",
        reason: "Build failed.",
      }),
      event("form.requested", {
        formId: "f1",
        form: { kind: "project_name", label: "Project name", suggestion: null },
      }),
      event("waiting", { formId: "f1", label: "Waiting for the project name" }),
    ]);
    expect(turn.state).toBe("waiting");
    expect(turn.workingSince).toBeNull();
    expect(statusLabel(turn)).toBe("Waiting for the project name");
    turn = applyEvent(
      turn,
      event("form.answered", {
        formId: "f1",
        outcome: "named",
        label: "Project name: shop",
        asMessage: true,
      }),
      { now: 99 },
    );
    const form = turn.parts.find((part) => part.kind === "form");
    expect(form?.kind === "form" && form.answered?.label).toBe("Project name: shop");
    expect(turn.workingSince).toBe(99);
    expect(stepCounts(turn)).toEqual({ steps: 1, failed: 1 });
  });

  test("errors stay in the turn, in order; unknown events change nothing", () => {
    seq = 0;
    const turn = play([
      event("text", { delta: "Trying." }),
      event("error", {
        code: "provider_unavailable",
        message: "The model provider couldn't be reached.",
      }),
      event("something.new", { x: 1 }),
    ]);
    expect(turn.parts.map((part) => part.kind)).toEqual(["text", "error"]);
  });

  test("Stop: open rows end as stopped and the footer says so", () => {
    seq = 0;
    const turn = play([
      event("step.started", { stepId: "a", label: "Deploying", target: "web" }),
      event("status", { kind: "stopping", label: "Stopping" }),
      event("turn.finished", {
        state: "stopped",
        stoppedBy: "person",
        footer: "Stopped after 12s",
        canRetry: true,
      }),
    ]);
    const step = turn.parts[0];
    expect(step?.kind === "step" && step.state).toBe("stopped");
    expect(turn.footer).toBe("Stopped after 12s");
  });
});

describe("Retry, Edit and suggestions (spec 19.4)", () => {
  const finished = play(threeStepEvents());
  test("Retry is absent on a successful last turn and present on a failed or stopped one", () => {
    expect(retryVisible(finished, true, true)).toBe(false);
    const failed = { ...finished, state: "failed" as const, canRetry: true };
    expect(retryVisible(failed, true, true)).toBe(true);
    expect(retryVisible(failed, false, true)).toBe(false);
    expect(retryVisible({ ...finished, state: "stopped" as const }, true, true)).toBe(true);
    expect(retryVisible(failed, true, false)).toBe(false);
  });

  test("Edit shows only on the last finished question", () => {
    expect(editVisible(finished, true, true)).toBe(true);
    expect(editVisible(finished, false, true)).toBe(false);
    const running = { ...finished, state: "working" as const, live: true };
    expect(editVisible(running, true, true)).toBe(false);
  });

  test("suggestions only after a normal answer", () => {
    expect(suggestionsVisible(finished, true)).toBe(true);
    expect(suggestionsVisible(finished, false)).toBe(false);
    expect(suggestionsVisible({ ...finished, state: "stopped" }, true)).toBe(false);
    const withError = {
      ...finished,
      parts: [
        ...finished.parts,
        { kind: "error" as const, key: "e", code: "internal", message: "x" },
      ],
    };
    expect(suggestionsVisible(withError, true)).toBe(false);
  });

  test("the status line's time shows after the first second", () => {
    expect(elapsedLabel(1000, 1500)).toBeNull();
    expect(elapsedLabel(1000, 13_000)).toBe("12s");
    expect(elapsedLabel(0, 125_000)).toBe("2m 05s");
    expect(statusLabel(emptyTurn("pending-1", message, false))).toBe("Thinking");
  });
});

describe("folding (spec 19.4)", () => {
  test("code folds after 24 lines with the count of the rest", () => {
    const code = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const folded = foldCode(code, false);
    expect(folded.shown.split("\n")).toHaveLength(24);
    expect(folded.hiddenLines).toBe(6);
    expect(showMoreLabel(folded.hiddenLines)).toBe("Show more (6 more lines)");
    expect(foldCode(code, true).folded).toBe(false);
    expect(foldCode("a\nb", false).folded).toBe(false);
  });

  test("results fold after 14 lines or 1,600 characters and stop at 6,000", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `row ${index}`).join("\n");
    expect(foldResult(lines, false).shown.split("\n")).toHaveLength(14);
    const wide = "x".repeat(2_000);
    expect(foldResult(wide, false).shown).toHaveLength(1_600);
    expect(foldResult("y".repeat(7_000), true).shown).toHaveLength(6_000);
    expect(foldResult("y".repeat(7_000), true).capped).toBe(true);
    expect(foldResult("short", false).folded).toBe(false);
  });

  test("a failed reason under the row is at most 280 characters", () => {
    expect(shortReason("z".repeat(400))?.length).toBe(280);
    expect(shortReason(null)).toBeNull();
  });

  test("long questions fold; quotes keep 1,200 characters", () => {
    expect(questionFolds("a\n".repeat(12))).toBe(true);
    expect(questionFolds("short")).toBe(false);
    expect(clipQuote("q".repeat(1_500))).toHaveLength(1_200);
    expect(fileSize(2_048)).toBe("2 KB");
  });
});

describe("Markdown (spec 19.4)", () => {
  test("a table written on one line becomes a real table", () => {
    const line = "| Service | State | |---|---| | web | Running | | api | Failed |";
    expect(expandInlineTable(line)).toBe(
      "| Service | State |\n|---|---|\n| web | Running |\n| api | Failed |",
    );
    const tokens = lexAnswer(`Here:\n${line}`);
    expect(tokens.some((token) => token.type === "table")).toBe(true);
  });

  test("text before an inline table stays a paragraph; code fences are left alone", () => {
    const expanded = expandInlineTables("Result: | A | B | |---|---| | 1 | 2 |");
    expect(expanded).toContain("Result:\n| A | B |");
    const fenced = "```\n| A | B | |---|---| | 1 | 2 |\n```";
    expect(expandInlineTables(fenced)).toBe(fenced);
    expect(expandInlineTable("no table here | really")).toBeNull();
  });

  test("ids are stripped with the shared function, links are safe", () => {
    const tokens = lexAnswer(`Deployed web (id: ${ID}).`);
    expect(JSON.stringify(tokens)).not.toContain(ID);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("/acme/dashboard")).toBe("/acme/dashboard");
    expect(safeHref("//evil.example")).toBeNull();
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;")).toBe("a & b <c> '");
    expect(languageLabel("yml")).toBe("yaml");
    expect(languageLabel(undefined)).toBe("text");
  });

  test("raw HTML stays text", () => {
    const tokens = lexAnswer("<script>alert(1)</script>");
    expect(JSON.stringify(tokens)).toContain("html");
  });
});

describe("moving sessions (spec 19.5)", () => {
  const rows = [
    { id: "a", position: 9 },
    { id: "b", position: 7 },
    { id: "c", position: 4 },
  ];
  test("Move up and Move down, and the request sends what the page had", () => {
    expect(moveBy(rows, "b", -1)?.map((row) => row.id)).toEqual(["b", "a", "c"]);
    expect(moveBy(rows, "a", -1)).toBeNull();
    expect(moveBy(rows, "c", 1)).toBeNull();
    const next = moveIndex(rows, 2, 0);
    expect(orderRequest(rows, next)).toEqual({ seen: rows, order: ["c", "a", "b"] });
    expect(withSwappedPositions(rows, next).map((row) => [row.id, row.position])).toEqual([
      ["c", 9],
      ["a", 7],
      ["b", 4],
    ]);
  });

  test("drags start after 4px, only from the grip on touch, and land between middles", () => {
    expect(passedThreshold(3, 0)).toBe(false);
    expect(passedThreshold(0, 4)).toBe(true);
    expect(canStartDrag("touch", false)).toBe(false);
    expect(canStartDrag("touch", true)).toBe(true);
    expect(canStartDrag("mouse", false)).toBe(true);
    const middles = [10, 40, 70];
    expect(dropIndex(5, middles, 0)).toBe(0);
    expect(dropIndex(55, middles, 0)).toBe(1);
    expect(dropIndex(95, middles, 0)).toBe(2);
    expect(dropIndex(25, middles, 2)).toBe(1);
  });
});

describe("the message box (spec 19.3, 19.10)", () => {
  const key = (over: Partial<Parameters<typeof enterSends>[0]>) => ({
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...over,
  });
  test("Enter sends on a computer, Return adds a line on a phone, Ctrl/Cmd+Enter everywhere", () => {
    expect(enterSends(key({}), false)).toBe(true);
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false);
    expect(enterSends(key({}), true)).toBe(false);
    expect(enterSends(key({ metaKey: true }), true)).toBe(true);
    expect(enterSends(key({ ctrlKey: true }), false)).toBe(true);
    expect(enterSends(key({ isComposing: true }), false)).toBe(false);
    expect(enterSends(key({ key: "a" }), false)).toBe(false);
  });

  const limits = {
    perKind: { image: 10, pdf: 20, docx: 15, text: 10, video: 25 },
  };
  const mb = (n: number) => n * 1024 * 1024;
  const realLimits = {
    perKind: { image: mb(10), pdf: mb(20), docx: mb(15), text: mb(10), video: mb(25) },
  };
  test("refused kinds come with their reason", () => {
    expect(checkFile({ name: ".env", type: "", size: 10 }, realLimits)).toMatchObject({
      ok: false,
    });
    expect(checkFile({ name: ".env.example", type: "", size: 10 }, realLimits)).toMatchObject({
      ok: true,
      kind: "text",
    });
    const sheet = checkFile({ name: "costs.xlsx", type: "", size: 10 }, realLimits);
    expect(sheet.ok === false && sheet.reason).toContain("Export it as CSV or PDF");
    expect(checkFile({ name: "a.zip", type: "", size: 10 }, realLimits)).toMatchObject({
      ok: false,
    });
    expect(checkFile({ name: "a.heic", type: "", size: 10 }, realLimits)).toMatchObject({
      ok: false,
    });
    const doc = checkFile({ name: "a.doc", type: "", size: 10 }, realLimits);
    expect(doc.ok === false && doc.reason).toContain("Save it as .docx or PDF");
    expect(
      checkFile({ name: "shot.png", type: "image/png", size: mb(11) }, realLimits),
    ).toMatchObject({ ok: false });
    expect(checkFile({ name: "a.txt", type: "", size: 0 }, limits)).toMatchObject({ ok: false });
  });

  test("ten files and the total cap per message", () => {
    const ten = Array.from({ length: 10 }, () => ({ sizeBytes: 1, failed: false }));
    expect(addProblem(ten, 1, { filesPerMessage: 10, totalBytes: 100 })).toContain("up to 10");
    expect(
      addProblem([{ sizeBytes: 90, failed: false }], 20, { filesPerMessage: 10, totalBytes: 100 }),
    ).not.toBeNull();
    expect(
      addProblem([{ sizeBytes: 90, failed: true }], 20, { filesPerMessage: 10, totalBytes: 100 }),
    ).toBeNull();
  });

  test("images shrink to 2,048px on the long side; GIFs are left alone", () => {
    expect(shrunkSize(4096, 3072)).toEqual({ width: 2048, height: 1536, changed: true });
    expect(shrunkSize(1000, 3000)).toEqual({ width: 683, height: 2048, changed: true });
    expect(shrunkSize(800, 600).changed).toBe(false);
    expect(shrinkable("image/gif")).toBe(false);
    expect(shrinkable("image/jpeg")).toBe(true);
  });

  test("at most 3 uploads at once, in order", () => {
    const items = [
      { id: "1", state: "uploading" as const },
      { id: "2", state: "queued" as const },
      { id: "3", state: "queued" as const },
      { id: "4", state: "queued" as const },
      { id: "5", state: "done" as const },
    ];
    expect(uploadsToStart(items, 3)).toEqual(["2", "3"]);
  });

  test("one button: send, wait for uploads, or stop", () => {
    const base = {
      hasContent: true,
      working: false,
      uploading: false,
      readOnly: false,
      disabled: false,
    };
    expect(sendState(base)).toBe("send");
    expect(sendState({ ...base, uploading: true })).toBe("wait");
    expect(sendState({ ...base, working: true })).toBe("stop");
    expect(sendState({ ...base, hasContent: false })).toBe("off");
  });
});

describe("the variables form (spec 19.8)", () => {
  test("fixed rows, a counter and the save label", () => {
    const rows = initialRows(["DATABASE_URL", "API_TOKEN", "DATABASE_URL"]);
    expect(rows.map((row) => row.name)).toEqual(["DATABASE_URL", "API_TOKEN"]);
    expect(rows.every((row) => row.fixed)).toBe(true);
    expect(counterText(rows)).toBe("0 of 2 set");
    const filled = [{ ...(rows[0] as (typeof rows)[0]), value: "x" }, rows[1] as (typeof rows)[0]];
    expect(counterText(filled)).toBe("1 of 2 set");
    expect(rowsToSave(filled)).toEqual([{ name: "DATABASE_URL", value: "x" }]);
    expect(saveLabel("Save 2 variables and deploy", 1)).toBe("Save 1 variable and deploy");
    expect(saveLabel("Save 2 variables", 3)).toBe("Save 3 variables");
  });

  test("a pasted env file fills, adds and reports skipped lines by number only", () => {
    const rows = initialRows(["DATABASE_URL"]);
    const outcome = pasteEnv(rows, "DATABASE_URL=postgres://x\nNEW_ONE=1\nnot a line\n# note\n");
    expect(outcome?.rows.map((row) => [row.name, row.value])).toEqual([
      ["DATABASE_URL", "postgres://x"],
      ["NEW_ONE", "1"],
    ]);
    expect(outcome?.report).toBe(
      "Filled 1 value and added 1 variable from the paste. Skipped line 3: not one-line NAME=value. Comments were skipped.",
    );
    expect(outcome?.report).not.toContain("not a line");
    expect(pasteEnv(rows, "just a value")).toBeNull();
  });

  test("duplicate or invalid names and values on several lines are refused", () => {
    const rows = [
      ...initialRows(["A"]),
      { ...newRow(), name: "A", value: "1" },
      { ...newRow(), name: "9bad", value: "1" },
      { ...newRow(), name: "", value: "" },
    ];
    const problems = rowProblems(rows);
    expect(problems.map((problem) => problem.message)).toEqual([
      "A is set twice, in rows 1 and 2. Keep one.",
      `"9bad" isn't a valid name. Names start with a letter or _, then use letters, digits, _, . or -.`,
    ]);
    const multi = rowProblems([{ ...newRow(), name: "KEY", value: "a\nb" }]);
    expect(multi[0]?.message).toContain("Put it on one line with \\n");
    expect(multiLineValue("one\ntwo")).toBe(true);
    expect(multiLineValue("one\n")).toBe(false);
  });

  test("saving keeps every saved name without reading it, and writes the form's rows", () => {
    expect(
      mergeBody(
        ["KEEP", "DATABASE_URL"],
        [
          { name: "DATABASE_URL", value: "v" },
          { name: "NEW", value: "n" },
        ],
        3,
      ),
    ).toEqual({
      rows: [
        { name: "KEEP", keep: true },
        { name: "DATABASE_URL", value: "v" },
        { name: "NEW", value: "n" },
      ],
      baseVersion: 3,
    });
  });
});

describe("pickers (spec 19.8)", () => {
  const options = Array.from({ length: 9 }, (_, index) => ({
    value: `v${index}`,
    label: `acme/app-${index}`,
  }));
  test("buttons up to 8, a dropdown beyond, and always for repositories and branches", () => {
    expect(pickerStyle("project", options.slice(0, 8), false)).toBe("buttons");
    expect(pickerStyle("project", options, false)).toBe("dropdown");
    expect(pickerStyle("repository", options.slice(0, 2), false)).toBe("dropdown");
    expect(pickerStyle("branch", options.slice(0, 2), false)).toBe("dropdown");
    // The repository access card is actions, so its buttons always show (C3-02).
    expect(pickerStyle("access", options.slice(0, 3), false)).toBe("buttons");
    expect(showsSearch(options.slice(0, 6))).toBe(false);
    expect(showsSearch(options.slice(0, 7))).toBe(true);
  });

  test("Connect options are links to console paths only", () => {
    expect(
      optionHref({
        value: "github",
        label: "Connect GitHub",
        href: "/acme/dashboard/settings/git-providers?connect=github",
      }),
    ).toBe("/acme/dashboard/settings/git-providers?connect=github");
    expect(optionHref({ value: "x", label: "x", href: "https://evil.example" })).toBeNull();
    expect(optionHref({ value: "x", label: "x", href: "//evil.example" })).toBeNull();
    expect(optionHref({ value: "x", label: "x" })).toBeNull();
  });

  test("search and arrow keys", () => {
    expect(filterOptions(options, "app-3").map((option) => option.value)).toEqual(["v3"]);
    expect(filterOptions(options, "")).toHaveLength(9);
    expect(moveHighlight(-1, 3, "ArrowDown")).toBe(0);
    expect(moveHighlight(2, 3, "ArrowDown")).toBe(0);
    expect(moveHighlight(0, 3, "ArrowUp")).toBe(2);
    expect(moveHighlight(1, 3, "End")).toBe(2);
    expect(moveHighlight(1, 0, "ArrowDown")).toBe(-1);
  });
});

describe("the event stream and errors", () => {
  test("events split across chunks, comments ignored", () => {
    const parser = new SseParser();
    expect(parser.push(": keep-alive\n\nevent: text\nid: t:1\nda")).toEqual([]);
    expect(parser.push('ta: {"delta":"hi"}\n\nevent: end\ndata: {}\n\n')).toEqual([
      { type: "text", id: "t:1", data: '{"delta":"hi"}' },
      { type: "end", id: null, data: "{}" },
    ]);
    expect(reconnectDelay(0)).toBe(500);
    expect(reconnectDelay(10)).toBe(8_000);
  });

  test("list failures use the platform's words for refusals, a retry message otherwise", () => {
    expect(
      failureWords(
        new ApiError({ status: 409, code: "conflict", message: "This session is still working." }),
      ),
    ).toBe("This session is still working.");
    expect(failureWords(new ApiError({ status: 503, code: "internal", message: "boom" }))).toBe(
      GENERIC_RETRY,
    );
    expect(failureWords(new Error("network"))).toBe(GENERIC_RETRY);
    expect(apiPath("/api/v1/services/x/variables")).toBe("/services/x/variables");
  });
});
