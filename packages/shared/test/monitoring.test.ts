import { describe, expect, test } from "bun:test";
import {
  ALERT_QUIET_MS,
  type AlertState,
  INITIAL_ALERT_STATE,
  memoryPercent,
  stepAlert,
  thresholdProblem,
  uptimeText,
} from "../src/index.ts";

/** Alert hysteresis (spec 14.3): 3 samples over fire once; then 30 minutes of quiet unless it drops. */

function run(
  values: number[],
  threshold: number | null,
  startAt = 0,
  everyMs = 5_000,
  from: AlertState = INITIAL_ALERT_STATE,
) {
  let state = from;
  const fired: number[] = [];
  values.forEach((value, index) => {
    const at = startAt + index * everyMs;
    const step = stepAlert(state, value, threshold, at);
    state = step.state;
    if (step.fire) fired.push(index);
  });
  return { state, fired };
}

describe("server alerts fire after 3 samples over the threshold", () => {
  test("two samples over don't fire; the third does", () => {
    expect(run([60, 70], 50).fired).toEqual([]);
    expect(run([60, 70, 80], 50).fired).toEqual([2]);
  });

  test("a value equal to the threshold isn't over it", () => {
    expect(run([50, 50, 50, 50], 50).fired).toEqual([]);
  });

  test("a 30-second stress run (6 samples) sends exactly one alert (spec 14 acceptance)", () => {
    expect(run([5, 99, 99, 99, 99, 99, 99, 4, 3], 50).fired).toEqual([3]);
  });

  test("staying over fires again only after 30 minutes", () => {
    const samples = Array.from({ length: ALERT_QUIET_MS / 5_000 + 10 }, () => 90);
    const { fired } = run(samples, 50);
    expect(fired).toEqual([2, 2 + ALERT_QUIET_MS / 5_000]);
  });

  test("dropping and rising again fires again at once (after 3 samples)", () => {
    expect(run([90, 90, 90, 10, 90, 90, 90], 50).fired).toEqual([2, 6]);
    // A single dip that doesn't last 3 samples over again doesn't.
    expect(run([90, 90, 90, 10, 90, 90, 10], 50).fired).toEqual([2]);
  });

  test("no threshold means no alert, and resets the state", () => {
    const { state, fired } = run([99, 99, 99, 99], null);
    expect(fired).toEqual([]);
    expect(state).toEqual(INITIAL_ALERT_STATE);
  });

  test("the state carries over between batches", () => {
    const first = run([90, 90], 50, 0);
    const second = run([90], 50, 10_000, 5_000, first.state);
    expect(second.fired).toEqual([0]);
  });
});

describe("thresholds and figures", () => {
  test("blank is off; otherwise 1 to 100", () => {
    expect(thresholdProblem(null)).toBeNull();
    expect(thresholdProblem(1)).toBeNull();
    expect(thresholdProblem(100)).toBeNull();
    expect(thresholdProblem(0)).toContain("1 to 100");
    expect(thresholdProblem(101)).toContain("1 to 100");
    expect(thresholdProblem(50.5)).toContain("whole");
  });
  test("memory percent and uptime words", () => {
    expect(memoryPercent(512, 1024)).toBe(50);
    expect(memoryPercent(1, 0)).toBe(0);
    expect(uptimeText(40)).toBe("40 seconds");
    expect(uptimeText(3 * 3600 + 120)).toBe("3 hours, 2 minutes");
    expect(uptimeText(2 * 86400 + 3600)).toBe("2 days, 1 hour");
  });
});
