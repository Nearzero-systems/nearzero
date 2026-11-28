import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { longestTime, parseTime, spanTransform } from "../src/lib/motion.ts";

const STYLES = resolve(import.meta.dir, "..", "src", "styles");
const motion = readFileSync(resolve(STYLES, "motion.css"), "utf8");

/** Each `transition` and `transition-property` value in a stylesheet, comments removed. */
function transitionValues(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return Array.from(text.matchAll(/transition(?:-property)?\s*:\s*([^;{}]+);/g), (m) =>
    (m[1] ?? "").replace(/\s+/g, " ").trim(),
  );
}

describe("motion helpers (spec 21.7)", () => {
  test("CSS times read in milliseconds", () => {
    expect(parseTime("0.18s")).toBe(180);
    expect(parseTime("120ms")).toBe(120);
    expect(parseTime("0s")).toBe(0);
    expect(parseTime("")).toBe(0);
  });

  test("the longest transition counts its delay, and short lists repeat", () => {
    expect(longestTime("0.1s, 0.2s", "0.1s, 0s")).toBe(200);
    expect(longestTime("0.1s", "0.1s")).toBe(200);
    expect(longestTime("0.1s, 0.14s", "0s")).toBe(140);
    expect(longestTime("0s, 0s", "0s, 0s")).toBe(0);
  });

  test("a tab's highlight is drawn from the old tab with a shift and a scale from its left edge", () => {
    expect(spanTransform({ left: 10, width: 50 }, { left: 80, width: 100 })).toBe(
      "translateX(-70px) scaleX(0.5)",
    );
    expect(spanTransform({ left: 80, width: 100 }, { left: 80, width: 100 })).toBe("none");
  });
});

describe("the motion stylesheet (spec 21.7)", () => {
  test("the spec's durations are the ones written", () => {
    for (const duration of ["200ms", "220ms", "180ms", "140ms", "100ms", "160ms", "120ms"]) {
      expect(motion).toContain(duration);
    }
    // Sidebar, sheet, menus, dialogs, toasts, expandable parts, tabs.
    expect(motion).toMatch(/\.nz-nav \{\s+transition: width 200ms ease-out;/);
    expect(motion).toMatch(/\.nz-sheet:not\(\.nz-sheet--right\)\[open\] \{[^}]*220ms/);
    expect(motion).toMatch(/\.nz-pop \{[^}]*opacity 140ms ease-out,\s+transform 140ms/);
    expect(motion).toMatch(/\.nz-dialog\[open\],\s+\.nz-sheet--right\[open\] \{[^}]*180ms/);
    expect(motion).toMatch(/\.nz-toast\[data-leaving\] \{[^}]*opacity 140ms/);
    expect(motion).toMatch(/\.nz-expand \{[^}]*height 180ms/);
    expect(motion).toMatch(/\.nz-tab-glider \{[^}]*transform 180ms/);
  });

  test("nothing animates a shadow, and only the sidebar, columns and expandable parts animate size", () => {
    const allowed = new Set([
      "opacity",
      "transform",
      "scale",
      "translate",
      "color",
      "background-color",
      "border-color",
      "display",
      "overlay",
      "content-visibility",
      "none",
      "width",
      "height",
    ]);
    for (const file of readdirSync(STYLES).filter((name) => name.endsWith(".css"))) {
      const css = readFileSync(resolve(STYLES, file), "utf8");
      for (const value of transitionValues(css)) {
        expect(`${file}: ${value}`).not.toMatch(/shadow|filter/);
        if (file !== "motion.css") continue;
        for (const part of value.split(",")) {
          const property = part.trim().split(" ")[0] ?? "";
          expect(`${file}: ${property}`).toBe(`${file}: ${allowed.has(property) ? property : "?"}`);
        }
      }
    }
    // Width only on the sidebar and the secondary columns; height only on expandable parts.
    const text = motion.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(/([^{}]+)\{[^{}]*transition[^:]*:[^;]*\bwidth\b[^;]*;/g)) {
      expect(match[1]?.trim()).toMatch(/^\.nz-(nav|secondary)$/);
    }
    for (const match of text.matchAll(/([^{}]+)\{[^{}]*transition[^:]*:[^;]*\bheight\b[^;]*;/g)) {
      expect(match[1]?.trim()).toMatch(/nz-expand|data-height-motion|details-content/);
    }
  });

  test("reduced motion sets every duration to 0, unlayered so it wins", () => {
    const reduced = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/transition-duration: 0s;/);
    expect(reduced).toMatch(/animation-duration: 0s;/);
    expect(reduced).not.toContain("@layer");
    // Every motion rule above it lives in the components layer.
    const beforeReduced = motion.slice(0, motion.indexOf("@media (prefers-reduced-motion"));
    const unlayered = beforeReduced
      .replace(/@layer components \{[\s\S]*?\n\}\n/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(unlayered).not.toMatch(/transition:(?!\s*none)/);
  });
});
