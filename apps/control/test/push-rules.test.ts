import { describe, expect, test } from "bun:test";
import {
  matchesWatchPath,
  readPushBody,
  shouldDeployPush,
  watchPathsMatch,
} from "../src/webhooks/push-rules.ts";
import { serviceOfToken } from "../src/webhooks/tokens.ts";

/** Push triggers and watch paths (spec 6.6), as the Git provider milestone will reuse them. */

const files = (added: string[], modified: string[] = [], removed: string[] = []) => ({
  added,
  modified,
  removed,
});

describe("watch paths", () => {
  test("globs and folders", () => {
    expect(matchesWatchPath("src/a/b.ts", "src/**")).toBe(true);
    expect(matchesWatchPath("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesWatchPath("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(matchesWatchPath("docs/readme.md", "src/**")).toBe(false);
    expect(matchesWatchPath("docs/guide/a.md", "docs")).toBe(true);
    expect(matchesWatchPath("docsite/a.md", "docs")).toBe(false);
    expect(matchesWatchPath("a/package.json", "**/package.json")).toBe(true);
    expect(matchesWatchPath("package.json", "**/package.json")).toBe(true);
  });

  test("negation, braces and character classes, as 0.1.x read them (G2-03)", () => {
    const deploys = (watchPaths: string[], changed: string) =>
      shouldDeployPush(
        { trigger: "push", branch: "main", watchPaths },
        { ref: "refs/heads/main", files: files([], [changed]) },
      ).deploy;
    // The acceptance lines.
    expect(deploys(["!docs/**"], "src/index.ts")).toBe(true);
    expect(deploys(["!docs/**"], "docs/a.md")).toBe(false);
    expect(deploys(["{apps/web,packages/ui}/**"], "packages/ui/button.tsx")).toBe(true);
    expect(deploys(["{apps/web,packages/ui}/**"], "apps/api/index.ts")).toBe(false);
    expect(deploys(["src/*.[jt]s"], "src/a.ts")).toBe(true);
    expect(deploys(["src/*.[jt]s"], "src/a.cs")).toBe(false);
    // Positive and ! paths together: what is under the positive ones, minus the excluded.
    const mixed = ["src/**", "!src/**/*.test.ts", "!src/fixtures"];
    expect(watchPathsMatch("src/a.ts", mixed)).toBe(true);
    expect(watchPathsMatch("src/a/b.test.ts", mixed)).toBe(false);
    expect(watchPathsMatch("src/fixtures/x.json", mixed)).toBe(false);
    expect(watchPathsMatch("README.md", mixed)).toBe(false);
    // More of the syntax.
    expect(matchesWatchPath("a.js", "[!t]*.js")).toBe(true);
    expect(matchesWatchPath("t.js", "[^t]*.js")).toBe(false);
    expect(matchesWatchPath("v2/a", "v[0-9]/*")).toBe(true);
    expect(matchesWatchPath("a/b", "a[/]b")).toBe(false);
    expect(matchesWatchPath("apps/web/src/a.ts", "apps/{web,{api,admin}}/**")).toBe(true);
    expect(matchesWatchPath("apps/admin/a.ts", "apps/{web,{api,admin}}/**")).toBe(true);
    expect(matchesWatchPath("literal{x}.txt", "literal{x}.txt")).toBe(true);
    expect(matchesWatchPath("a*b", "a\\*b")).toBe(true);
    expect(matchesWatchPath("axb", "a\\*b")).toBe(false);
    expect(matchesWatchPath("file(1).txt", "file(1).*")).toBe(true);
    // A folder named alone still matches everything under it, negated too.
    expect(watchPathsMatch("docs/guide/a.md", ["!docs"])).toBe(false);
    expect(watchPathsMatch("docsite/a.md", ["!docs"])).toBe(true);
  });

  test("20,000 changed files are checked quickly", () => {
    const changed = Array.from({ length: 20_000 }, (_, i) => `vendor/lib-${i}/index.js`);
    const started = performance.now();
    const decision = shouldDeployPush(
      { trigger: "push", branch: "main", watchPaths: ["{apps,packages}/**", "!**/*.md"] },
      { ref: "refs/heads/main", files: files([], changed) },
    );
    expect(decision.deploy).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a push touching only docs/ doesn't deploy an app watching src/** (acceptance)", () => {
    const rules = { trigger: "push" as const, branch: "main", watchPaths: ["src/**"] };
    expect(
      shouldDeployPush(rules, { ref: "refs/heads/main", files: files([], ["docs/a.md"]) }).deploy,
    ).toBe(false);
    expect(
      shouldDeployPush(rules, { ref: "refs/heads/main", files: files([], [], ["src/old.ts"]) })
        .deploy,
    ).toBe(true);
    // A host that doesn't list files deploys rather than guess.
    expect(shouldDeployPush(rules, { ref: "refs/heads/main", files: null }).deploy).toBe(true);
  });
});

describe("triggers", () => {
  test("On push deploys the branch only; On tag deploys tags only", () => {
    const push = { trigger: "push" as const, branch: "main", watchPaths: [] };
    expect(shouldDeployPush(push, { ref: "refs/heads/main", commit: "abc1234" })).toEqual({
      deploy: true,
      branch: "main",
      tag: null,
      commit: "abc1234",
    });
    expect(shouldDeployPush(push, { ref: "refs/heads/dev" }).deploy).toBe(false);
    expect(shouldDeployPush(push, { ref: "refs/tags/v1" }).deploy).toBe(false);
    const tag = { ...push, trigger: "tag" as const };
    expect(shouldDeployPush(tag, { ref: "refs/tags/v1.2.0" })).toMatchObject({
      deploy: true,
      tag: "v1.2.0",
    });
    expect(shouldDeployPush(tag, { ref: "refs/heads/main" }).deploy).toBe(false);
    expect(shouldDeployPush(push, { ref: "refs/heads/main", deleted: true }).deploy).toBe(false);
  });

  test("push bodies of the common hosts are read", () => {
    const body = readPushBody({
      ref: "refs/heads/main",
      after: "0123456789abcdef0123456789abcdef01234567",
      commits: [{ added: ["a"], modified: ["b"], removed: ["c"] }],
      head_commit: { message: "Subject\n\nBody" },
    });
    expect(body).toMatchObject({
      ref: "refs/heads/main",
      files: files(["a"], ["b"], ["c"]),
      subject: "Subject",
    });
    expect(
      readPushBody({ ref: "refs/heads/x", after: "0000000000000000000000000000000000000000" })
        ?.deleted,
    ).toBe(true);
    expect(readPushBody({ hello: 1 })).toBeNull();
    expect(readPushBody("text")).toBeNull();
  });
});

test("a malformed webhook token is refused without a database answer", async () => {
  const db = {
    selectFrom() {
      throw new Error("should not be asked");
    },
  } as never;
  expect(await serviceOfToken(db, "nope")).toBeNull();
  expect(await serviceOfToken(db, "nzw1.not-an-id.secret")).toBeNull();
});
