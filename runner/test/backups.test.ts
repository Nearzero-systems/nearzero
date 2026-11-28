import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseBackupKind } from "@nearzero/shared";
import {
  checkedFormat,
  checkStep,
  type DatabaseTarget,
  databaseSecrets,
  dumpProgram,
  dumpStep,
  libsqlDumpStep,
  libsqlExchangeScript,
  libsqlExchangeStep,
  libsqlRequestHead,
  loadScript,
  loadStep,
  mongoNamespaces,
  rcloneCopyStep,
  withScratch,
} from "../src/backups/database-steps.ts";
import { firstFileOfTar, type HelperStep, helperConfig } from "../src/backups/helpers.ts";
import {
  objectsFrom,
  pipelineErrors,
  quoteIdentifier,
  restoreSql,
  unwrapDump,
} from "../src/backups/libsql.ts";
import {
  listedFiles,
  rcloneConfig,
  statSize,
  testStep,
  uploadStep,
} from "../src/backups/rclone.ts";
import { runSteps, type Step } from "../src/backups/steps.ts";
import { offsetZone, serverTimeZone, zoneFromLink } from "../src/backups/time-zone.ts";
import {
  archiveStep,
  emptyVolumeStep,
  freeBytes,
  isPlainArchive,
  unpackStep,
  verifyArchiveStep,
} from "../src/backups/volume-steps.ts";
import { createTar } from "../src/docker/tar.ts";
import { runCommand } from "../src/exec/command.ts";

/**
 * The runner's backup steps (spec 08 8.3, 17, 23.1): every step is its own program with standard
 * input closed and its exit status checked, so a step that reads standard input can never swallow
 * the steps after it, and a failure stops the run with the step's name.
 */

/** Runs steps as local processes, the way helper containers run them: argv, stdin closed. */
async function local(step: Step) {
  const result = await runCommand({ argv: step.argv, timeoutMs: 10_000 });
  return { exitCode: result.exitCode, stdout: result.output };
}

describe("the stdin rule (spec 23.1)", () => {
  test("steps that read standard input don't swallow the steps after them", async () => {
    const out: string[] = [];
    const started = Date.now();
    const outcome = await runSteps(
      [
        // Each would wait for (or eat) input if it had any: they get end-of-file at once.
        { title: "Reading everything on stdin", argv: ["sh", "-c", "cat; echo first"] },
        {
          title: "Reading a line from stdin",
          argv: ["sh", "-c", 'read line; echo "second:$line"'],
        },
        { title: "The last step", argv: ["sh", "-c", "echo third"] },
      ],
      local,
      (text) => out.push(text),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.results.map((result) => result?.stdout.trim())).toEqual([
      "first",
      "second:",
      "third",
    ]);
    expect(out.join("")).toContain("✓ The last step");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("the failure this prevents: a script fed to a shell on stdin loses its later steps", async () => {
    // What the rule is about: here the first step reads the rest of the script as its input, so
    // "after" never runs and the shell still exits 0. Steps are therefore never run this way.
    const result = await runCommand({
      argv: ["sh", "-s"],
      stdin: "cat >/dev/null\necho after\n",
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("after");
  });

  test("a failing step stops the run, names the step, and only `always` steps still run", async () => {
    const out: string[] = [];
    const outcome = await runSteps(
      [
        { title: "Dumping the database", argv: ["sh", "-c", "echo dumped"] },
        { title: "Compressing the dump", argv: ["sh", "-c", "exit 3"] },
        { title: "Uploading", argv: ["sh", "-c", "echo uploaded"] },
        { title: "Starting the service again", argv: ["sh", "-c", "echo started"], always: true },
      ],
      local,
      (text) => out.push(text),
    );
    expect(outcome.failure?.message).toBe("Compressing the dump failed (exit code 3).");
    expect(outcome.results[2]).toBeNull();
    expect(outcome.results[3]?.stdout.trim()).toBe("started");
    expect(out.join("")).toContain("✗ Compressing the dump failed (exit code 3).");
  });

  test("a step that can't start counts as failed", async () => {
    const outcome = await runSteps(
      [{ title: "Missing tool", argv: ["nearzero-no-such-program"] }],
      async () => {
        throw new Error("No such image");
      },
      () => {},
    );
    expect(outcome.failure?.message).toBe("Missing tool failed: No such image");
  });

  test("helper containers never have standard input, and run their program without a shell", () => {
    const config = helperConfig(
      {
        title: "Dump",
        image: "postgres:18",
        argv: ["pg_dump", "--file=/backup/dump.sql.gz"],
        mounts: [{ source: "scratch", target: "/backup" }],
        network: "nearzero-edge",
      },
      "11111111-2222-4333-8444-555555555555",
    );
    expect(config).toMatchObject({
      AttachStdin: false,
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Entrypoint: ["pg_dump"],
      Cmd: ["--file=/backup/dump.sql.gz"],
      Labels: { "dev.nearzero.backup-run": "11111111-2222-4333-8444-555555555555" },
    });
    expect((config.HostConfig as { NetworkMode: string }).NetworkMode).toBe("nearzero-edge");
  });
});

const KINDS: DatabaseBackupKind[] = ["postgres", "mysql", "mariadb", "mongodb", "libsql"];

function target(kind: DatabaseBackupKind): DatabaseTarget {
  return {
    kind,
    image: "sha256:abc",
    network: "nearzero-edge",
    host: "shop-db-x1y2z3",
    port: 5432,
    database: kind === "mongodb" || kind === "libsql" ? null : "app",
    user: "app",
    password: "Pa55word-From-Generator",
    rootPassword: kind === "mysql" || kind === "mariadb" ? "R00t-Password-Value" : null,
  };
}

const DESTINATION = {
  provider: "minio" as const,
  endpoint: "http://minio.internal:9000",
  bucket: "backups",
  region: "us-east-1",
  accessKeyId: "AKID-Example",
  secretAccessKey: "SECRET-Example-Key",
};

describe("dump and load steps (spec 08 8.3, R3-50)", () => {
  test("no step puts a password or a key on its command line; scripts are files that never read stdin", () => {
    const token = Buffer.from("app:Pa55word-From-Generator").toString("base64");
    const all: HelperStep[] = [];
    for (const kind of KINDS) {
      all.push(checkStep("tools", kind, DESTINATION, "app/daily/x.sql.gz"));
      if (kind === "libsql") {
        all.push(libsqlDumpStep("tools", target(kind), DESTINATION, "app/daily/x.sql.gz"));
        continue;
      }
      all.push(dumpStep(target(kind), DESTINATION, "app/daily/x.sql.gz"));
      all.push(
        loadStep(
          target(kind),
          DESTINATION,
          "app/daily/x.sql.gz",
          kind === "mongodb" ? "mongodb" : "sql",
          null,
        ),
      );
    }
    all.push(loadStep(target("postgres"), DESTINATION, "k", "pgdump", null));
    for (const step of all) {
      const line = step.argv.join(" ");
      for (const secret of [
        "Pa55word-From-Generator",
        "R00t-Password-Value",
        token,
        "SECRET-Example-Key",
        "AKID-Example",
      ]) {
        expect(line).not.toContain(secret);
        expect(Object.values(step.env ?? {}).join(" ")).not.toContain(secret);
      }
      expect(line).not.toContain("Authorization");
      // A shell only ever runs a script written into the helper, never text on its command line.
      if (step.argv[0] === "sh") {
        expect(step.argv).toHaveLength(2);
        expect(step.argv[1]).toStartWith("/nearzero/");
        const script =
          step.files?.find((file) => `/nearzero/${file.name}` === step.argv[1])?.content ?? "";
        expect(script.split("\n")[0]).toBe("exec </dev/null");
        for (const secret of [
          "Pa55word-From-Generator",
          "R00t-Password-Value",
          "SECRET-Example-Key",
        ]) {
          expect(script).not.toContain(secret);
        }
      }
      expect(step.argv).not.toContain("-c");
    }
  });

  test("libSQL's credentials travel in a file written into the helper, like the others", () => {
    const dump = libsqlDumpStep("tools", target("libsql"), DESTINATION, "app/daily/x.sql.gz");
    expect(dump.argv).toEqual([
      "nc",
      "shop-db-x1y2z3",
      "5432",
      "-e",
      "sh",
      "/nearzero/libsql-exchange.sh",
    ]);
    const token = Buffer.from("app:Pa55word-From-Generator").toString("base64");
    const head = dump.files?.find((file) => file.name === "libsql-request.http")?.content;
    expect(head).toBe(
      `GET /dump HTTP/1.0\r\nHost: shop-db-x1y2z3:5432\r\nAuthorization: Basic ${token}\r\nConnection: close\r\n\r\n`,
    );
    const script = dump.files?.find((file) => file.name === "libsql-exchange.sh")?.content ?? "";
    expect(script).toContain("cat '/nearzero/libsql-request.http'\n");
    expect(script).toContain("'rcat' 'nearzero:backups/app/daily/x.sql.gz'");
    expect(script).not.toContain(token);
    expect(dump.files?.map((file) => file.name)).toContain("rclone.conf");
    // A restore request: its body comes from the scratch volume, sized in the head.
    const post = libsqlExchangeStep("tools", target("libsql"), {
      title: "Listing",
      method: "POST",
      path: "/v2/pipeline",
      body: { file: "/backup/request-1.json", bytes: 42 },
      answerFile: "/backup/answer-1.json",
    });
    const postHead = post.files?.find((file) => file.name === "libsql-request.http")?.content;
    expect(postHead).toContain("POST /v2/pipeline HTTP/1.0\r\n");
    expect(postHead).toContain("Content-Length: 42\r\n");
    expect(post.files?.find((file) => file.name === "libsql-exchange.sh")?.content).toContain(
      "cat '/nearzero/libsql-request.http' '/backup/request-1.json'",
    );
    expect(libsqlRequestHead(target("libsql"), { method: "GET", path: "/dump" })).not.toContain(
      "Content-Length",
    );
  });

  test("the libSQL exchange keeps only a 200 answer's body, and stops with the status otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nz-libsql-"));
    try {
      const answer = join(dir, "answer");
      const script = join(dir, "exchange.sh");
      // The script's standard input stands in for the server's answer; its output is the request.
      await writeFile(
        script,
        libsqlExchangeScript(null, answer).replace("/nearzero/libsql-request.http", "/dev/null"),
      );
      const ok = await runCommand({
        argv: ["sh", script],
        stdin:
          "HTTP/1.0 200 OK\r\ncontent-type: text/plain\r\n\r\nPRAGMA foreign_keys=OFF;\nCOMMIT;\n",
        timeoutMs: 10_000,
      });
      expect(ok.exitCode).toBe(0);
      expect(await readFile(answer, "utf8")).toBe("PRAGMA foreign_keys=OFF;\nCOMMIT;\n");
      const refused = await runCommand({
        argv: ["sh", script],
        stdin: "HTTP/1.0 401 Unauthorized\r\n\r\nnope",
        timeoutMs: 10_000,
      });
      expect(refused.exitCode).toBe(22);
      expect(refused.output).toContain("libSQL answered: HTTP/1.0 401 Unauthorized");
      const silent = await runCommand({ argv: ["sh", script], stdin: "", timeoutMs: 10_000 });
      expect(silent.exitCode).toBe(70);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("each kind dumps with its own client into one pipe, and loads with its own", () => {
    const pg = dumpStep(target("postgres"), DESTINATION, "k");
    const pgScript = pg.files?.find((file) => file.name === "steps.sh")?.content ?? "";
    expect(pgScript).toContain("'pg_dump'");
    expect(pgScript).toContain("gzip -n -6");
    expect(pgScript).toContain("'rcat' 'nearzero:backups/k'");
    expect(pg.files?.find((file) => file.name === "pgpass")?.content).toBe(
      "*:*:*:*:Pa55word-From-Generator\n",
    );
    expect(pg.env?.PGPASSFILE).toBe("/nearzero/pgpass");
    // The image is the database's own; rclone comes from the scratch volume.
    expect(pg.image).toBe("sha256:abc");
    expect(pg.mounts).toEqual([{ source: "", target: "/backup", readOnly: true }]);
    const my = dumpProgram(target("mysql")).argv;
    expect(my[0]).toBe("mysqldump");
    expect(my[1]).toBe("--defaults-extra-file=/nearzero/my.cnf");
    // The dump names no database, so it loads into whichever one a restore picks (R3-45).
    expect(my).not.toContain("--databases");
    expect(my.at(-1)).toBe("app");
    expect(dumpProgram(target("mariadb")).argv[0]).toBe("mariadb-dump");
    expect(dumpProgram(target("mongodb"))).toMatchObject({ compressed: true });
    expect(dumpProgram(target("mongodb")).argv).toContain("--gzip");
    const mongoLoad = loadScript(target("mongodb"), DESTINATION, "k", "mongodb", null);
    expect(mongoLoad).toContain("'--drop'");
    expect(databaseSecrets(target("libsql"))).toHaveLength(2);
    expect(rcloneCopyStep("tools").argv).toEqual([
      "cp",
      "/usr/local/bin/rclone",
      "/etc/ssl/certs/ca-certificates.crt",
      "/backup/",
    ]);
    const filled = withScratch([pg], "nearzero-backup-run");
    expect(filled[0]?.mounts?.[0]?.source).toBe("nearzero-backup-run");
  });

  test("MongoDB restores the database the file came from into the one asked for (R3-45)", () => {
    expect(mongoNamespaces(null, null)).toEqual([]);
    expect(mongoNamespaces("shop", "shop")).toEqual(["--nsInclude=shop.*"]);
    expect(mongoNamespaces(null, "shop")).toEqual(["--nsInclude=shop.*"]);
    expect(mongoNamespaces("analytics", "copy")).toEqual([
      "--nsInclude=analytics.*",
      "--nsFrom=analytics.*",
      "--nsTo=copy.*",
    ]);
    expect(checkedFormat("x\nsql\n")).toBe("sql");
    expect(checkedFormat("nothing")).toBeNull();
  });

  test("volume steps keep owners as numbers and never follow a name prefix; 0.1.x's plain archives unpack too", () => {
    expect(archiveStep("tools", "web-html", "scratch").argv).toContain("--numeric-owner");
    expect(archiveStep("tools", "web-html", "scratch").mounts?.[0]).toEqual({
      source: "web-html",
      target: "/source",
      readOnly: true,
    });
    expect(emptyVolumeStep("tools", "web-html").argv).toEqual([
      "find",
      "/target",
      "-mindepth",
      "1",
      "-delete",
    ]);
    expect(unpackStep("tools", "web-html", "scratch").argv.slice(0, 5)).toEqual([
      "tar",
      "-x",
      "-z",
      "-p",
      "--numeric-owner",
    ]);
    expect(unpackStep("tools", "web-html", "scratch", true).argv).not.toContain("-z");
    expect(unpackStep("tools", "web-html", "scratch", true).argv).toContain("/backup/volume.tar");
    expect(verifyArchiveStep("tools", "scratch", true).argv).toEqual([
      "tar",
      "-t",
      "-f",
      "/backup/volume.tar",
    ]);
    expect(isPlainArchive("app/nightly/data-2026-11-25T03-00-00-123Z.tar")).toBe(true);
    expect(isPlainArchive("app/nightly/2026-11-25T03-00-00.tar.gz")).toBe(false);
    expect(
      freeBytes(
        "Filesystem           1024-blocks    Used Available Capacity Mounted on\n/dev/vda1  41152736 30000000 11152736  73% /backup\n",
      ),
    ).toBe(11152736 * 1024);
    expect(freeBytes("")).toBeNull();
  });

  test("a destination test from the Nearzero host reaches only the address it was checked at (R3-49)", () => {
    const step = testStep("tools", DESTINATION, 10, [
      { host: "minio.internal", address: "203.0.113.7" },
    ]);
    expect(helperConfig(step, "11111111-2222-4333-8444-555555555555")).toMatchObject({
      HostConfig: { ExtraHosts: ["minio.internal:203.0.113.7"] },
    });
    expect(
      helperConfig(testStep("tools", DESTINATION, 10), "x").HostConfig as object,
    ).not.toHaveProperty("ExtraHosts");
  });
});

describe("rclone (spec 25 D5)", () => {
  const destination = {
    provider: "cloudflare-r2" as const,
    endpoint: "https://abc.r2.cloudflarestorage.com",
    bucket: "backups",
    region: "auto",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
  };

  test("keys go in the config file, not the command line", () => {
    const config = rcloneConfig(destination);
    expect(config).toContain("provider = Cloudflare");
    expect(config).toContain("secret_access_key = SECRET");
    expect(config).toContain("no_check_bucket = true");
    const step = uploadStep("tools", destination, "scratch", "dump.sql.gz", "app/daily/x.sql.gz");
    expect(step.argv.join(" ")).not.toContain("SECRET");
    expect(step.argv).toContain("nearzero:backups/app/daily/x.sql.gz");
    expect(step.files?.[0]?.name).toBe("rclone.conf");
  });

  test("its JSON answers", () => {
    expect(statSize('{"Path":"x","Size":120,"IsDir":false}')).toBe(120);
    expect(statSize('{"Path":"x","IsDir":true}')).toBeNull();
    expect(statSize("not json")).toBeNull();
    expect(
      listedFiles(
        '[{"Path":"2026-01-01T00-00-00.sql.gz","Size":9,"ModTime":"2026-01-01T00:00:00Z"},{"Path":"sub","IsDir":true}]',
        "app/daily/",
      ),
    ).toEqual([
      { key: "app/daily/2026-01-01T00-00-00.sql.gz", size: 9, modifiedAt: "2026-01-01T00:00:00Z" },
    ]);
  });
});

describe("libSQL restores (spec 08 8.3)", () => {
  test("drops what is there and runs the dump in one transaction", () => {
    const dump =
      "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE items (id INTEGER);\nINSERT INTO items VALUES(1);\nCOMMIT;\n";
    expect(unwrapDump(dump)).not.toContain("BEGIN TRANSACTION;");
    const sql = restoreSql(
      [
        { type: "table", name: "items" },
        { type: "view", name: 'odd"name' },
      ],
      dump,
    );
    expect(sql.indexOf('DROP VIEW IF EXISTS "odd""name";')).toBeLessThan(
      sql.indexOf('DROP TABLE IF EXISTS "items";'),
    );
    expect(sql.startsWith("PRAGMA foreign_keys=OFF;\nBEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(quoteIdentifier("a")).toBe('"a"');
  });

  test("a text value with a line reading COMMIT; or BEGIN; stays whole (B2-21)", () => {
    const dump = [
      "PRAGMA foreign_keys=OFF;",
      "BEGIN TRANSACTION;",
      'CREATE TABLE notes (body TEXT, "odd\nname" TEXT);',
      "INSERT INTO notes VALUES('steps:",
      "BEGIN;",
      "UPDATE x;",
      "COMMIT;",
      "done','it''s",
      "COMMIT;');",
      "/* a comment",
      "COMMIT;",
      "*/",
      "-- it's a comment with a quote",
      "COMMIT;",
    ].join("\n");
    expect(unwrapDump(dump)).toBe(
      [
        "PRAGMA foreign_keys=OFF;",
        'CREATE TABLE notes (body TEXT, "odd\nname" TEXT);',
        "INSERT INTO notes VALUES('steps:",
        "BEGIN;",
        "UPDATE x;",
        "COMMIT;",
        "done','it''s",
        "COMMIT;');",
        "/* a comment",
        "COMMIT;",
        "*/",
        "-- it's a comment with a quote",
      ].join("\n"),
    );
  });

  test("reads libSQL's answers", () => {
    const answer = JSON.stringify({
      results: [
        {
          type: "ok",
          response: {
            type: "execute",
            result: {
              rows: [
                [
                  { type: "text", value: "table" },
                  { type: "text", value: "items" },
                ],
              ],
            },
          },
        },
        { type: "ok", response: { type: "close" } },
      ],
    });
    expect(objectsFrom(answer)).toEqual([{ type: "table", name: "items" }]);
    expect(pipelineErrors(answer)).toBeNull();
    expect(
      pipelineErrors(
        JSON.stringify({ results: [{ type: "error", error: { message: "no such table" } }] }),
      ),
    ).toBe("no such table");
  });
});

describe("small pieces", () => {
  test("the first file of a tar archive", () => {
    const tar = createTar([
      { path: "dir", type: "directory", mode: 0o755, uid: 0, gid: 0 },
      {
        path: "dir/dump.sql",
        type: "file",
        content: new TextEncoder().encode("SELECT 1;"),
        mode: 0o600,
        uid: 0,
        gid: 0,
      },
    ]);
    expect(new TextDecoder().decode(firstFileOfTar(tar) ?? new Uint8Array())).toBe("SELECT 1;");
  });

  test("the server's time zone from the engine's clock or the localtime link", () => {
    expect(offsetZone("2026-11-25T08:30:00.123456789+05:30")).toBe("UTC+05:30");
    expect(offsetZone("2026-11-25T03:00:00Z")).toBe("UTC");
    expect(offsetZone("2026-11-25T03:00:00-03:00")).toBe("UTC-03:00");
    expect(zoneFromLink("/usr/share/zoneinfo/Europe/Berlin")).toBe("Europe/Berlin");
    expect(zoneFromLink("../usr/share/zoneinfo/posix/America/New_York")).toBe("America/New_York");
    expect(zoneFromLink("/etc/nothing")).toBeNull();
  });

  test("in a container, the host's zone name given as TZ wins over the clock's offset", async () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "Europe/Berlin";
      expect(await serverTimeZone("2026-07-01T10:00:00+02:00", true)).toBe("Europe/Berlin");
      // compose.yml passes an empty TZ when the installer found no zone name.
      process.env.TZ = "";
      expect(await serverTimeZone("2026-07-01T10:00:00+02:00", true)).toBe("UTC+02:00");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});
