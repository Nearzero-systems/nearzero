import { describe, expect, spyOn, test } from "bun:test";
import { VERSION } from "@nearzero/shared";
import { readTokenLine, run } from "../src/main.ts";

describe("the runner command", () => {
  test("prints its version by default and with --version", () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(run([])).toBe(0);
      expect(run(["--version"])).toBe(0);
      expect(out.mock.calls).toEqual([
        [`nearzero-runner ${VERSION}`],
        [`nearzero-runner ${VERSION}`],
      ]);
    } finally {
      out.mockRestore();
    }
  });

  test("an unknown command prints usage and fails", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(run(["deploy"])).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toContain("Unknown command: deploy");
    } finally {
      err.mockRestore();
    }
  });

  test("B2-16: join reads the token from standard input, asking when it is a terminal", async () => {
    async function* lines(...items: string[]) {
      for (const item of items) yield item;
    }
    const prompts: string[] = [];
    expect(
      await readTokenLine(lines("", "  nzj1.secret  "), (text) => prompts.push(text), true),
    ).toBe("nzj1.secret");
    expect(prompts).toEqual(["Paste the one-time join token from Nearzero, then press Enter: "]);
    expect(await readTokenLine(lines("nzj1.piped"), () => prompts.push("x"), false)).toBe(
      "nzj1.piped",
    );
    expect(prompts).toHaveLength(1);
    expect(await readTokenLine(lines(), () => {}, false)).toBeNull();
  });

  test("join without an address prints usage", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run(["join"])).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toContain("Usage: nearzero-runner join <control-url>");
    } finally {
      err.mockRestore();
    }
  });
});
