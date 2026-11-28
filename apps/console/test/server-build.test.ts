import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * The console's built server (astro.config.ts, selfContainedServer): the production image has no
 * node_modules, so dist/server must import nothing but Node's built-in modules, and every file
 * starts with Bun's `// @bun` marker so Bun runs it as built. Without the marker, Bun 1.3's
 * load-time transpiler mishandles labeled statements in React's production server renderer.
 */

const DIST = resolve(import.meta.dir, "..", "dist", "server");
const ARTIFACTS = resolve(import.meta.dir, "..", "test-artifacts");

/** Runs `code` as a module in Bun and returns what it prints. */
async function runInBun(code: string): Promise<{ out: string; code: number }> {
  const file = join(ARTIFACTS, `server-build-${crypto.randomUUID()}.mjs`);
  await Bun.write(file, code);
  try {
    const child = Bun.spawn(["bun", file], { stdout: "pipe", stderr: "pipe" });
    const out =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    return { out: out.trim(), code: await child.exited };
  } finally {
    await Bun.file(file).delete();
  }
}

// The shape in React's production renderer (performWork): a labeled block left from a catch
// through `finally`, in the first branch of an if … else. Correct output: "B1,B2".
const LABELED_BREAK = `const log = [];
function f(i, n) {
  if (i === 0) {
    a: {
      if (n) {
        try { throw 1; } catch (x) { break a; } finally { log.push("A"); }
      }
    }
  } else log.push("B" + i);
}
f(1, 1); f(2, 1);
console.log(log.join(","));
`;

describe("the console's server build", () => {
  test("Bun's load-time transpiler is skipped for files marked // @bun, which run correctly", async () => {
    // Marked files are read as Latin-1, so text beyond ASCII must be written as escapes.
    expect((await runInBun('// @bun\nconsole.log("\\u2192 \\u2026")\n')).out).toBe("→ …");
    const marked = await runInBun(`// @bun\n${LABELED_BREAK}`);
    expect(marked).toEqual({ out: "B1,B2", code: 0 });
    // Unmarked, Bun 1.3 drops the else branch. If a later Bun gets it right, the marker is
    // merely harmless; this records why it is there.
    const unmarked = await runInBun(LABELED_BREAK);
    expect(["", "B1,B2"]).toContain(unmarked.out);
  });

  test.skipIf(!existsSync(DIST))(
    "every server file is marked and imports only Node's built-in modules",
    async () => {
      const files = (await readdir(DIST, { recursive: true })).filter((name) =>
        name.endsWith(".mjs"),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const name of files) {
        const bytes = await Bun.file(join(DIST, name)).bytes();
        // Bun reads `// @bun` files as Latin-1: anything beyond ASCII would turn into mojibake.
        expect({ name, ascii: bytes.every((byte) => byte < 128) }).toEqual({ name, ascii: true });
        const text = new TextDecoder().decode(bytes);
        expect(text.startsWith("// @bun\n")).toBe(true);
        const bare = [...text.matchAll(/^import [^"'\n]*?from\s*["']([^"'.][^"']*)["']/gm)]
          .map((match) => match[1] as string)
          .filter((specifier) => !specifier.startsWith("node:"));
        expect({ name, bare }).toEqual({ name, bare: [] });
      }
    },
  );
});
