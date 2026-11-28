import { describe, expect, test } from "bun:test";
import {
  appSourceRequestSchema,
  branchProblem,
  buildSettingsRequestSchema,
  CRASH_OUTPUT_MAX_CHARS,
  CRASH_OUTPUT_MAX_LINES,
  cleanContainerOutput,
  databaseConnectionUrl,
  firstFailureLine,
  GIT_URL_CREDENTIALS,
  GIT_URL_INVALID,
  maskedConnectionUrl,
  mountsRequestSchema,
  normalizeBuildPath,
  parseGitUrl,
  portsRequestSchema,
  splitWatchPaths,
} from "../src/deploys.ts";

describe("connection URLs (spec 8.2)", () => {
  const base = { password: "pass", host: "db-abc123", port: 5432, from: "internal" as const };

  test("each type has its format", () => {
    expect(
      databaseConnectionUrl({ ...base, kind: "postgres", user: "postgres", database: "postgres" }),
    ).toBe("postgresql://postgres:pass@db-abc123:5432/postgres");
    expect(
      databaseConnectionUrl({ ...base, kind: "mysql", user: "mysql", port: 3306, database: "app" }),
    ).toBe("mysql://mysql:pass@db-abc123:3306/app");
    expect(
      databaseConnectionUrl({
        ...base,
        kind: "mariadb",
        user: "mariadb",
        port: 3306,
        database: "m",
      }),
    ).toBe("mysql://mariadb:pass@db-abc123:3306/m");
    expect(databaseConnectionUrl({ ...base, kind: "mongodb", user: "mongo", port: 27017 })).toBe(
      "mongodb://mongo:pass@db-abc123:27017/?authSource=admin",
    );
    expect(databaseConnectionUrl({ ...base, kind: "redis", user: null, port: 6379 })).toBe(
      "redis://default:pass@db-abc123:6379",
    );
    expect(databaseConnectionUrl({ ...base, kind: "libsql", user: "libsql", port: 8080 })).toBe(
      "http://libsql:pass@db-abc123:8080",
    );
  });

  test("a replica set names itself inside and connects directly from outside", () => {
    const input = {
      ...base,
      kind: "mongodb" as const,
      user: "mongo",
      port: 27017,
      replicaSet: true,
    };
    expect(databaseConnectionUrl(input)).toBe(
      "mongodb://mongo:pass@db-abc123:27017/?authSource=admin&replicaSet=rs0",
    );
    expect(
      databaseConnectionUrl({ ...input, host: "203.0.113.7", port: 20001, from: "public" }),
    ).toBe("mongodb://mongo:pass@203.0.113.7:20001/?authSource=admin&directConnection=true");
  });

  test("credentials are percent-encoded, IPv6 hosts bracketed", () => {
    const url = databaseConnectionUrl({
      kind: "postgres",
      user: "app user",
      password: "p@ss:w/rd#?!'()*%",
      host: "2001:db8::1",
      port: 20000,
      database: "shop",
      from: "public",
    });
    expect(url).toBe(
      "postgresql://app%20user:p%40ss%3Aw%2Frd%23%3F%21%27%28%29%2A%25@[2001:db8::1]:20000/shop",
    );
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w/rd#?!'()*%");
  });

  test("masked URLs hide only the password", () => {
    expect(maskedConnectionUrl({ ...base, kind: "redis", user: null, port: 6379 })).toBe(
      "redis://default:••••••••@db-abc123:6379",
    );
  });
});

describe("Git URLs (spec 6.1, 6.3)", () => {
  test("HTTPS, scp-like and ssh:// URLs are read", () => {
    expect(parseGitUrl("https://github.com/acme/web.git")).toMatchObject({
      transport: "https",
      host: "github.com",
      path: "acme/web",
    });
    expect(parseGitUrl("git@gitlab.com:acme/group/web.git")).toMatchObject({
      transport: "ssh",
      host: "gitlab.com",
      path: "acme/group/web",
    });
    expect(parseGitUrl("ssh://git@git.example.com:2222/acme/web.git")).toMatchObject({
      transport: "ssh",
      path: "acme/web",
    });
  });

  test("credentials in the URL and other schemes are refused", () => {
    expect(parseGitUrl("https://user:secret@github.com/acme/web")).toEqual({
      problem: GIT_URL_CREDENTIALS,
    });
    expect(parseGitUrl("https://token@github.com/acme/web")).toEqual({
      problem: GIT_URL_CREDENTIALS,
    });
    expect(parseGitUrl("http://github.com/acme/web")).toEqual({ problem: GIT_URL_INVALID });
    expect(parseGitUrl("file:///etc/passwd")).toEqual({ problem: GIT_URL_INVALID });
    expect(parseGitUrl("https://github.com/acme")).toEqual({ problem: GIT_URL_INVALID });
    expect(parseGitUrl("https://github.com/acme/../web")).toEqual({ problem: GIT_URL_INVALID });
    expect(parseGitUrl("--upload-pack=x@host:a/b")).toEqual({ problem: GIT_URL_INVALID });
  });

  test("branches and build paths stay safe", () => {
    expect(branchProblem("release/2.0")).toBeNull();
    expect(branchProblem("-x")).not.toBeNull();
    expect(branchProblem("a..b")).not.toBeNull();
    expect(normalizeBuildPath("/apps/web/")).toBe("apps/web");
    expect(normalizeBuildPath("")).toBe("");
    expect(typeof normalizeBuildPath("apps/../../etc")).toBe("object");
    const parsed = appSourceRequestSchema.safeParse({
      type: "git",
      url: "https://github.com/acme/web",
    });
    expect(parsed.success && parsed.data).toMatchObject({
      branch: "main",
      buildPath: "",
      trigger: "push",
    });
  });
});

describe("ports and mounts (spec 6.8)", () => {
  test("a port published twice is refused, TCP and UDP are separate", () => {
    expect(
      portsRequestSchema.safeParse({
        ports: [
          { containerPort: 53, publishedPort: 53 },
          { containerPort: 53, publishedPort: 53, protocol: "udp" },
        ],
      }).success,
    ).toBe(true);
    const twice = portsRequestSchema.safeParse({
      ports: [
        { containerPort: 80, publishedPort: 8080 },
        { containerPort: 81, publishedPort: 8080 },
      ],
    });
    expect(twice.success).toBe(false);
  });

  test("mount paths are absolute, without .., and used once", () => {
    expect(
      mountsRequestSchema.safeParse({
        mounts: [{ type: "bind", hostPath: "data", containerPath: "/d" }],
      }).success,
    ).toBe(false);
    expect(
      mountsRequestSchema.safeParse({
        mounts: [{ type: "volume", name: "x", containerPath: "/a/../b" }],
      }).success,
    ).toBe(false);
    expect(
      mountsRequestSchema.safeParse({
        mounts: [
          { type: "volume", name: "a", containerPath: "/data" },
          { type: "volume", name: "b", containerPath: "/data" },
        ],
      }).success,
    ).toBe(false);
  });
});

test("the first failing line of a log is found (spec 11.2)", () => {
  const log =
    "Initializing deployment (Nearzero 1.0.0)\n#1 load\n#5 ERROR: failed to solve\nmore\n";
  expect(firstFailureLine(log)).toEqual({ line: 3, text: "#5 ERROR: failed to solve" });
  expect(firstFailureLine("all good\n")).toBeNull();
});

describe("build commands are one line (B2-01, spec 6.4)", () => {
  test("line breaks and control characters are refused, tabs and ordinary text are fine", () => {
    const commands = (start: string) =>
      buildSettingsRequestSchema.safeParse({ builder: { type: "heroku" }, commands: { start } });
    expect(commands("npm run start -- --port $PORT\t# ok").success).toBe(true);
    for (const bad of ["node x\rhttp:", "a\nb", "a\u0000b", "a\u0085b", "a\u2028b", "a\u001bb"]) {
      const parsed = commands(bad);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(
        "Keep the command on one line, without line breaks or other control characters.",
      );
    }
  });
});

describe("a crashed container's last output (31b G2-01)", () => {
  test("values, logins in URLs, escape codes and control characters are removed", () => {
    const out = cleanContainerOutput(
      "\u001b[1;31mFATAL\u001b[0m db=postgres://app:s3cret@db:5432/app key=abcd1234 port=80\r\n" +
        "mongodb://root:pw@m1,m2/x?authSource=admin redis://:only-pass@cache:6379 \u0000\u0008end\n",
      ["abcd1234", "80", ""],
    );
    expect(out).toBe(
      "FATAL db=postgres://[credentials-redacted]@db:5432/app key=[redacted] port=80\n" +
        "mongodb://[credentials-redacted]@m1,m2/x?authSource=admin redis://[credentials-redacted]@cache:6379 end",
    );
  });

  test("a value that is a whole URL is redacted as a value, longest first", () => {
    expect(cleanContainerOutput("url=https://u:p@h/x and p=u:p", ["https://u:p@h/x", "u:p@"])).toBe(
      "url=[redacted] and p=u:p",
    );
  });

  test("keeps the last 60 lines and 6,000 characters", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const lines = cleanContainerOutput(many, []).split("\n");
    expect(lines.length).toBe(CRASH_OUTPUT_MAX_LINES);
    expect(lines[0]).toBe("line 40");
    const wide = Array.from({ length: 50 }, (_, i) => `${i}:${"x".repeat(300)}`).join("\n");
    const kept = cleanContainerOutput(wide, []);
    expect(kept.length).toBeLessThanOrEqual(CRASH_OUTPUT_MAX_CHARS);
    expect(kept.endsWith(`49:${"x".repeat(300)}`)).toBe(true);
    // It starts at a whole line.
    expect(kept.split("\n")[0]).toMatch(/^\d+:x{300}$/);
  });
});

describe("watch paths typed in one box (31b G2-03)", () => {
  test("commas inside braces stay with their pattern", () => {
    expect(splitWatchPaths("src/**, {apps/web,packages/ui}/**\n!docs/**,,")).toEqual([
      "src/**",
      "{apps/web,packages/ui}/**",
      "!docs/**",
    ]);
    expect(splitWatchPaths("")).toEqual([]);
  });
});
