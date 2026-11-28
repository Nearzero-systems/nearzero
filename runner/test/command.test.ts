import { describe, expect, test } from "bun:test";
import { REDACTED, Redactor, redact, runCommand } from "../src/exec/command.ts";

/** The safe command runner (spec 23.1): no shell, closed stdin, timeouts, secrets cut out. */

describe("redaction", () => {
  const secret = "s3cr3t-Value-42";

  test("cuts a secret out wherever it appears", () => {
    expect(redact(`a ${secret} b ${secret}`, [secret])).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  test("finds a secret split across pieces at every possible place", () => {
    const text = `before ${secret} middle ${secret}after`;
    for (let cut = 0; cut <= text.length; cut++) {
      for (let second = cut; second <= text.length; second += 3) {
        const redactor = new Redactor([secret]);
        const out =
          redactor.push(text.slice(0, cut)) +
          redactor.push(text.slice(cut, second)) +
          redactor.push(text.slice(second)) +
          redactor.flush();
        expect(out).toBe(`before ${REDACTED} middle ${REDACTED}after`);
      }
    }
  });

  test("a secret that contains another is cut out whole", () => {
    expect(redact("x token-and-more y", ["token", "token-and-more"])).toBe(`x ${REDACTED} y`);
  });

  test("text without secrets passes through as it came", () => {
    const redactor = new Redactor([]);
    expect(redactor.push("hello")).toBe("hello");
    expect(redactor.flush()).toBe("");
  });
});

describe("running a command", () => {
  test("arguments are never interpreted by a shell", async () => {
    const result = await runCommand({
      argv: ["echo", "$(whoami)", "`id`", "; rm -rf /", "a b"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("$(whoami) `id` ; rm -rf / a b\n");
  });

  test("standard input is closed unless given", async () => {
    const closed = await runCommand({ argv: ["cat"], timeoutMs: 5000 });
    expect(closed).toMatchObject({ exitCode: 0, output: "", timedOut: false });
    const given = await runCommand({ argv: ["cat"], stdin: "fed in\n", timeoutMs: 5000 });
    expect(given.output).toBe("fed in\n");
  });

  test("a command that runs over its timeout is stopped", async () => {
    const started = Date.now();
    const result = await runCommand({ argv: ["sleep", "10"], timeoutMs: 200 });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("cancelling stops it", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runCommand({
      argv: ["sleep", "10"],
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ cancelled: true, exitCode: null });
  });

  test("secrets are cut out of output and streamed pieces", async () => {
    const pieces: string[] = [];
    const result = await runCommand({
      argv: ["sh", "-c", 'printf "pass=%s\\n" "$SECRET"; printf "%s" "$SECRET" >&2'],
      env: { SECRET: "hunter2-very-secret" },
      secrets: ["hunter2-very-secret"],
      timeoutMs: 5000,
      onOutput: (text) => pieces.push(text),
    });
    expect(result.output).not.toContain("hunter2");
    expect(pieces.join("")).not.toContain("hunter2");
    expect(result.output).toContain(`pass=${REDACTED}`);
  });

  test("the runner's own environment isn't passed on", async () => {
    process.env.NEARZERO_TEST_INHERITED = "leaked";
    try {
      const result = await runCommand({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template.
        argv: ["sh", "-c", 'printf "%s|%s" "${NEARZERO_TEST_INHERITED:-none}" "$GIVEN"'],
        env: { GIVEN: "yes" },
        timeoutMs: 5000,
      });
      expect(result.output).toBe("none|yes");
    } finally {
      delete process.env.NEARZERO_TEST_INHERITED;
    }
  });

  test("a command needs a program and a timeout", async () => {
    await expect(runCommand({ argv: [], timeoutMs: 1000 })).rejects.toThrow("needs a program");
    await expect(runCommand({ argv: ["true"], timeoutMs: 0 })).rejects.toThrow("needs a timeout");
  });
});
