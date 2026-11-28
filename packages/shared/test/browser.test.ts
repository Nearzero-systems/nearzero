import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as browser from "../src/browser.ts";
import * as everything from "../src/index.ts";

const SOURCE = resolve(import.meta.dir, "..", "src");

/** Every module a file reaches through its static imports and re-exports. */
function importGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
      else bare.add(specifier);
    }
    for (const match of text.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g)) bare.add(match[1] ?? "");
  };
  visit(entry);
  return { files, bare };
}

describe('the browser entry, "@nearzero/shared/browser"', () => {
  test("reaches no package at all, so zod and the schemas stay out of browser bundles", () => {
    const graph = importGraph(resolve(SOURCE, "browser.ts"));
    expect([...graph.bare]).toEqual([]);
    const names = [...graph.files].map((file) => file.slice(SOURCE.length + 1)).sort();
    expect(names).toContain("project-rules.ts");
    expect(names).toContain("variables.ts");
    // The schema modules never come along.
    for (const heavy of ["projects.ts", "identity.ts", "errors.ts", "config.ts", "http.ts"]) {
      expect(names).not.toContain(heavy);
    }
  });

  test("exports the same rules as the main entry, not copies", () => {
    expect(browser.environmentNameHint).toBe(everything.environmentNameHint);
    expect(browser.parseEnv).toBe(everything.parseEnv);
    expect(browser.DATABASE_DEFAULTS).toBe(everything.DATABASE_DEFAULTS);
    expect(browser.CAPABILITIES).toBe(everything.CAPABILITIES);
    expect("createServiceRequestSchema" in browser).toBe(false);
    expect(browser.environmentNameHint("QA Team")).toEqual({
      name: "qa-team",
      ok: true,
      message: "It will be called qa-team.",
    });
  });
});
