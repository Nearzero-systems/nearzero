import { describe, expect, test } from "bun:test";
import {
  createTaskRequestSchema,
  describeTaskSchedule,
  inspectScript,
  isIanaTimeZone,
  MULTI_LINE_COMMAND_WARNING,
  nextTaskRun,
  parseCron,
  shebangInterpreter,
  syntaxErrorNote,
  TASK_SCHEDULE_PRESETS,
  taskListEmptyState,
  timeZoneProblem,
  zonedTimeText,
} from "../src/index.ts";

/** Task rules (spec 12.2): script checks, cron and zone, the next run, words. */

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("script checks without a shell (spec 12.2)", () => {
  test("Windows line endings are converted, and the script is otherwise kept", () => {
    const result = inspectScript("echo one\r\necho two\r\n", "bash");
    expect(result.script).toBe("echo one\necho two\n");
    expect(result.converted).toBe(true);
    expect(result.errors).toEqual([]);
    expect(inspectScript("echo hi\n", "bash").converted).toBe(false);
  });

  test("a null byte is refused and its line named", () => {
    const result = inspectScript("echo a\necho b\necho \0c\n", "sh");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(3);
    expect(result.errors[0]?.message).toContain("Line 3");
  });

  test("at most 64 KB", () => {
    expect(inspectScript(`${"a".repeat(64 * 1024)}`, "bash").errors).toEqual([]);
    const big = inspectScript(`${"a".repeat(64 * 1024 + 1)}`, "bash");
    expect(big.errors[0]?.message).toContain("64 KB");
    // Multi-byte characters count as bytes.
    expect(inspectScript("é".repeat(40 * 1024), "bash").errors[0]?.message).toContain("64 KB");
  });

  test("an empty script is refused", () => {
    expect(inspectScript("  \n ", "bash").errors[0]?.message).toBe("Enter the script to run.");
  });

  test("a shebang for something that isn't a shell warns that the shell still runs it", () => {
    const python = inspectScript("#!/usr/bin/env python3\nprint(1)\n", "bash");
    expect(python.errors).toEqual([]);
    expect(python.warnings[0]?.message).toContain("python3");
    expect(python.warnings[0]?.message).toContain("still runs under bash");
    expect(inspectScript("#!/bin/bash\necho\n", "bash").warnings).toEqual([]);
    expect(inspectScript("#!/usr/bin/env -S bash -e\necho\n", "sh").warnings).toEqual([]);
    expect(inspectScript("#!/bin/sh\necho\n", "sh").warnings).toEqual([]);
    expect(shebangInterpreter("#!/usr/bin/node")).toBe("node");
    expect(shebangInterpreter("echo")).toBeNull();
  });
});

describe("the shell's own syntax errors name the line (spec 12.2 acceptance)", () => {
  test("bash", () => {
    const note = syntaxErrorNote(
      "bash: -c: line 3: syntax error near unexpected token `fi'\nbash: -c: line 3: `fi'\n",
    );
    expect(note.line).toBe(3);
    expect(note.message).toContain("line 3");
    expect(note.message).toContain("unexpected token");
  });
  test("dash", () => {
    const note = syntaxErrorNote('sh: 3: Syntax error: "fi" unexpected\n');
    expect(note.line).toBe(3);
    expect(note.message).toBe('The shell found a syntax error on line 3: "fi" unexpected');
  });
  test("BusyBox", () => {
    const note = syntaxErrorNote('sh: line 3: syntax error: unexpected "fi"\n');
    expect(note.line).toBe(3);
    expect(note.message).toContain("line 3");
  });
  test("without a line", () => {
    expect(syntaxErrorNote("something odd").line).toBeNull();
  });

  // What each shell prints for these scripts with `-n -c`: bash 5.2 and dash from Ubuntu 24.04,
  // BusyBox from Alpine 3.22, bash 3.2 from macOS.
  test("a script that ends too soon is named by its last line with content, whatever the shell", () => {
    const script = "echo one\necho two\nif true; then\n";
    for (const output of [
      "bash: -c: line 4: syntax error: unexpected end of file",
      'sh: 4: Syntax error: end of file unexpected (expecting "fi")',
      'sh: syntax error: unexpected end of file (expecting "fi")',
      "sh: -c: line 3: syntax error: unexpected end of file",
    ]) {
      const note = syntaxErrorNote(output, script);
      expect(note.line).toBe(3);
      expect(note.message).toStartWith("The shell found a syntax error on line 3: ");
    }
    // Blank lines at the end move where the shell stops reading, not the line to fix.
    for (const output of [
      "bash: -c: line 6: syntax error: unexpected end of file",
      'sh: 6: Syntax error: end of file unexpected (expecting "fi")',
      "sh: -c: line 5: syntax error: unexpected end of file",
    ]) {
      expect(syntaxErrorNote(output, `${script}  \n\n`).line).toBe(3);
    }
    expect(syntaxErrorNote("bash: -c: line 4: syntax error: unexpected end of file").line).toBe(4);
  });

  test("an open quote keeps the line bash names for it; other shells name the last line", () => {
    const script = 'echo one\necho "two\necho three\n';
    expect(
      syntaxErrorNote("bash: -c: line 2: unexpected EOF while looking for matching `\"'", script)
        .line,
    ).toBe(2);
    expect(syntaxErrorNote("sh: 4: Syntax error: Unterminated quoted string", script).line).toBe(3);
    expect(syntaxErrorNote("sh: syntax error: unterminated quoted string", script).line).toBe(3);
  });

  test("other errors keep the line the shell names, or none", () => {
    const script = "echo one\nfi\necho three\n";
    expect(
      syntaxErrorNote("bash: -c: line 2: syntax error near unexpected token `fi'", script).line,
    ).toBe(2);
    expect(syntaxErrorNote('sh: 2: Syntax error: "fi" unexpected', script).line).toBe(2);
    expect(syntaxErrorNote('sh: syntax error: unexpected "fi"', script).line).toBeNull();
  });
});

describe("a container's multi-line command (G3-15)", () => {
  const warned = (script: string, place: "container" | "server" | "host" = "container") =>
    inspectScript(script, "sh", place).warnings.some(
      (note) => note.message === MULTI_LINE_COMMAND_WARNING,
    );

  test("two lines in a container warn; on a server or the host they don't", () => {
    expect(warned("false\necho done")).toBe(true);
    expect(warned("false\necho done", "server")).toBe(false);
    expect(warned("false\necho done", "host")).toBe(false);
    expect(inspectScript("false\necho done", "sh").warnings).toEqual([]);
  });

  test("one logical line, comments, blank lines and errexit don't", () => {
    expect(warned("echo hi\n")).toBe(false);
    expect(warned("false && \\\n  echo done\n")).toBe(false);
    expect(warned("# rotate\n\necho hi\n")).toBe(false);
    expect(warned("set -e\nfalse\necho done")).toBe(false);
    expect(warned("set -euo pipefail\nfalse\necho done")).toBe(false);
    expect(warned("set -o errexit\nfalse\necho done")).toBe(false);
    expect(warned("set -x\nfalse\necho done")).toBe(true);
  });
});

describe("cron, time zone and the next run (spec 12.2)", () => {
  test("IANA names and UTC are zones; offsets and made-up names aren't", () => {
    expect(isIanaTimeZone("Asia/Kolkata")).toBe(true);
    expect(isIanaTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isIanaTimeZone("UTC")).toBe(true);
    expect(isIanaTimeZone("UTC+05:30")).toBe(false);
    expect(isIanaTimeZone("Mars/Olympus")).toBe(false);
    expect(timeZoneProblem("Mars/Olympus")).toContain("isn't a time zone");
    expect(timeZoneProblem("")).toBeNull();
  });

  test("every minute in Asia/Kolkata runs at the next minute", () => {
    const now = Date.parse("2026-11-25T10:15:30Z");
    expect(iso(nextTaskRun("* * * * *", "Asia/Kolkata", now))).toBe("2026-11-25T10:16:00.000Z");
  });

  test("midnight in Asia/Kolkata is 18:30 UTC the day before", () => {
    const now = Date.parse("2026-11-25T10:00:00Z");
    expect(iso(nextTaskRun("0 0 * * *", "Asia/Kolkata", now))).toBe("2026-11-25T18:30:00.000Z");
    expect(zonedTimeText(Date.parse("2026-11-25T18:30:00Z"), "Asia/Kolkata")).toBe(
      "Thu, Nov 26, 00:00 (Asia/Kolkata)",
    );
  });

  test("daylight saving: 02:30 in Europe/Berlin on the night clocks go forward", () => {
    // 2027-03-28 02:00 → 03:00 in Berlin; 02:30 doesn't happen, so it runs at 03:30 (after the gap).
    const now = Date.parse("2027-03-27T23:00:00Z");
    expect(iso(nextTaskRun("30 2 * * *", "Europe/Berlin", now))).toBe("2027-03-28T01:30:00.000Z");
  });

  test("an invalid cron has no next run", () => {
    expect(nextTaskRun("* * *", "UTC", Date.now())).toBeNull();
    expect(nextTaskRun("61 * * * *", "UTC", Date.now())).toBeNull();
  });

  test("presets and common shapes in words", () => {
    for (const preset of TASK_SCHEDULE_PRESETS)
      expect(describeTaskSchedule(preset.cron)).toBe(preset.label);
    expect(describeTaskSchedule("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeTaskSchedule("30 2 * * 1-5")).toBe("Every weekday at 02:30");
    expect(describeTaskSchedule("0 */6 * * *")).toBe("Every 6 hours at minute 0");
    expect(describeTaskSchedule("15 * * * *")).toBe("Every hour at minute 15");
    expect(describeTaskSchedule("0 9 * * 1")).toBe("Every Monday at 09:00");
    expect(describeTaskSchedule("0 9 15 * *")).toBe("Every month on the 15th at 09:00");
    expect(describeTaskSchedule("0 9 1 1 *")).toBe("Cron 0 9 1 1 *");
  });
});

describe("the cron extensions 0.1.x ran: L, nL, # and ? (G3-14, spec 12.2)", () => {
  const after = Date.parse("2026-11-25T12:00:00Z");

  test("L in the day of month is its last day, whatever its length", () => {
    expect(iso(nextTaskRun("0 0 L * *", "UTC", after))).toBe("2026-11-30T00:00:00.000Z");
    expect(iso(nextTaskRun("0 0 L * *", "UTC", Date.parse("2026-11-30T00:00:00Z")))).toBe(
      "2026-12-31T00:00:00.000Z",
    );
    expect(iso(nextTaskRun("0 0 L * *", "UTC", Date.parse("2027-02-01T00:00:00Z")))).toBe(
      "2027-02-28T00:00:00.000Z",
    );
    expect(iso(nextTaskRun("0 0 L 2 *", "UTC", Date.parse("2027-03-01T00:00:00Z")))).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    // In a list with plain days, and in the task's own zone.
    expect(iso(nextTaskRun("0 0 1,L * *", "UTC", Date.parse("2026-11-30T00:00:00Z")))).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(iso(nextTaskRun("0 0 L * *", "Asia/Kolkata", after))).toBe("2026-11-29T18:30:00.000Z");
  });

  test("1#1 is the first Monday, and the nth of any weekday by number or name", () => {
    // 2026-12-01 is a Tuesday, so December's first Monday is the 7th.
    expect(iso(nextTaskRun("0 9 * * 1#1", "UTC", after))).toBe("2026-12-07T09:00:00.000Z");
    expect(iso(nextTaskRun("0 9 * * mon#1", "UTC", after))).toBe("2026-12-07T09:00:00.000Z");
    expect(iso(nextTaskRun("0 9 * * 4#4", "UTC", after))).toBe("2026-11-26T09:00:00.000Z");
    expect(iso(nextTaskRun("0 9 * * 0#5", "UTC", after))).toBe("2026-11-29T09:00:00.000Z");
    expect(iso(nextTaskRun("0 9 * * 7#1", "UTC", after))).toBe("2026-12-06T09:00:00.000Z");
  });

  test("5L is the last Friday of the month", () => {
    expect(iso(nextTaskRun("0 9 * * 5L", "UTC", after))).toBe("2026-11-27T09:00:00.000Z");
    expect(iso(nextTaskRun("0 9 * * FRIL", "UTC", Date.parse("2026-11-28T00:00:00Z")))).toBe(
      "2026-12-25T09:00:00.000Z",
    );
  });

  test("? in a day field means any day", () => {
    expect(iso(nextTaskRun("0 9 ? * 1#1", "UTC", after))).toBe("2026-12-07T09:00:00.000Z");
    expect(iso(nextTaskRun("0 0 L * ?", "UTC", after))).toBe("2026-11-30T00:00:00.000Z");
    expect(iso(nextTaskRun("30 2 ? * *", "UTC", after))).toBe("2026-11-26T02:30:00.000Z");
  });

  test("in words, and the forms that still aren't read are named", () => {
    expect(describeTaskSchedule("0 0 L * *")).toBe("Every month on the last day at 00:00");
    expect(describeTaskSchedule("0 9 * * 1#1")).toBe("Every month on the first Monday at 09:00");
    expect(describeTaskSchedule("0 9 ? * 5L")).toBe("Every month on the last Friday at 09:00");
    expect(describeTaskSchedule("0 9 ? * 1")).toBe("Every Monday at 09:00");
    for (const cron of ["0 0 L * *", "0 9 * * 1#1", "0 9 * * 5L", "0 9 ? * *", "0 0 15,L * ?"])
      expect(parseCron(cron).ok).toBe(true);
    for (const [cron, message] of [
      [
        "0 9 * * 1#6",
        'In "1#6", the number after "#" must be from 1 to 5 (1#1 is the first Monday).',
      ],
      [
        "0 9 * * L",
        'A day of week of "L" needs the weekday before it, like 5L for the last Friday.',
      ],
      ["0 9 * * 8#1", '"8#1" isn\'t a valid day of week.'],
      ["0 9 LW * *", '"LW" isn\'t a valid day of month.'],
      ["L 9 * * *", '"L" isn\'t a valid minute.'],
      ["0 ? * * *", '"?" isn\'t a valid hour.'],
    ] as const)
      expect(parseCron(cron)).toEqual({ ok: false, message });
  });
});

describe("the create request (spec 12.2, 20.12)", () => {
  test("name up to 100 characters, description up to 500", () => {
    const base = { place: "host", cron: "* * * * *", script: "echo" };
    expect(createTaskRequestSchema.safeParse({ ...base, name: "x".repeat(100) }).success).toBe(
      true,
    );
    expect(createTaskRequestSchema.safeParse({ ...base, name: "x".repeat(101) }).success).toBe(
      false,
    );
    expect(
      createTaskRequestSchema.safeParse({ ...base, name: "ok", description: "d".repeat(501) })
        .success,
    ).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...base, name: " " }).success).toBe(false);
  });
  test("enabled by default, bash by default, not forced", () => {
    const parsed = createTaskRequestSchema.parse({
      place: "host",
      name: "n",
      cron: "* * * * *",
      script: "echo",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.shell).toBe("bash");
    expect(parsed.force).toBe(false);
  });
});

describe("the Tasks list's empty state (R3-32)", () => {
  test("a search or filter that matches nothing says to change them, and offers no Add task", () => {
    expect(taskListEmptyState({ search: "", status: "all", place: "all" })).toEqual({
      title: "No tasks found",
      text: "Create your first scheduled task to automate workflows.",
      filtered: false,
    });
    for (const query of [
      { search: "backup", status: "all", place: "all" },
      { search: "", status: "failed", place: "all" },
      { search: "", status: "all", place: "host" },
    ]) {
      expect(taskListEmptyState(query)).toEqual({
        title: "No tasks found",
        text: "Try adjusting your search or filters.",
        filtered: true,
      });
    }
  });
});
