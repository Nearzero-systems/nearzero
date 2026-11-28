import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DatabaseBackupKind } from "@nearzero/shared";
import {
  checkScript,
  type DatabaseTarget,
  dumpScript,
  libsqlExchangeScript,
  loadScript,
  POSTGRES_RESET,
  unpackFromBucketStep,
} from "../src/backups/database-steps.ts";
import { createTar } from "../src/docker/tar.ts";

/**
 * The scripts backup helpers run (spec 08 8.3, 23.1; R3-50, R3-45, R2-06), run here with a real
 * shell, gzip, sed and tar, and stand-ins for rclone and the database clients: a dump streams
 * through gzip into the bucket and fails with the right reason when any stage fails; a restore is
 * checked whole and its format told from its first bytes; a load commits only a whole file, goes
 * into the database it is told to, and drops the lines of a MySQL dump that would switch to
 * another database.
 */

let dir = "";
let bin = "";

const DESTINATION = {
  provider: "minio" as const,
  endpoint: "http://minio.internal:9000",
  bucket: "backups",
  region: "us-east-1",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
};

function target(kind: DatabaseBackupKind, database: string | null = "app"): DatabaseTarget {
  return {
    kind,
    image: "db",
    network: "nearzero-edge",
    host: "shop-db",
    port: 5432,
    database,
    user: "app",
    password: "pw",
    rootPassword: "root",
  };
}

/** A stand-in program that records its arguments and what it read, and can be told to fail. */
async function fake(name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\necho "$0 $*" >> "$NZ_CALLS"\n${body}\n`);
  await chmod(path, 0o755);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nz-backup-scripts-"));
  bin = join(dir, "bin");
  await mkdir(bin);
  // rclone: `rcat` stores standard input as the upload; `cat` prints the stored download.
  await fake(
    "rclone",
    `[ "$1" = "--ca-cert" ] && shift 2
cmd=$1; shift
case "$cmd" in
  rcat) [ -n "$NZ_FAIL_UPLOAD" ] && { cat >/dev/null; exit 5; }; cat > "$NZ_UPLOAD" ;;
  cat)
    [ -n "$NZ_FAIL_DOWNLOAD" ] && exit 6
    count=""; prev=""
    for a in "$@"; do [ "$prev" = "--count" ] && count=$a; prev=$a; done
    if [ -n "$count" ]; then head -c "$count" "$NZ_DOWNLOAD"; else cat "$NZ_DOWNLOAD"; fi ;;
esac`,
  );
  await fake(
    "pg_dump",
    `printf 'CREATE TABLE items (id int);\\nINSERT INTO items VALUES (1);\\n'
[ -n "$NZ_FAIL_DUMP" ] && exit 1
exit 0`,
  );
  await fake("psql", `case "$*" in *ensure.sql*) exit 0 ;; esac\ncat > "$NZ_LOADED"\nexit 0`);
  // pg_restore turns a 0.1.x archive into SQL on its standard output.
  await fake(
    "pg_restore",
    `cat >/dev/null\nprintf 'CREATE TABLE from_archive();\\n'\n[ -n "$NZ_FAIL_RESTORE" ] && exit 1\nexit 0`,
  );
  await fake("mysql", `case "$*" in *--execute=*) exit 0 ;; esac\ncat > "$NZ_LOADED"\nexit 0`);
  await fake("mongorestore", `cat > "$NZ_LOADED"\nexit 0`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  calls: string;
}

async function run(script: string, env: Record<string, string> = {}, stdin?: string): Promise<Run> {
  const work = await mkdtemp(join(dir, "run-"));
  const path = join(work, "steps.sh");
  await writeFile(path, script);
  const calls = join(work, "calls");
  await writeFile(calls, "");
  const child = Bun.spawn(["sh", path], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      NZ_RCLONE: join(bin, "rclone"),
      NZ_STATUS: join(work, "status"),
      NZ_CALLS: calls,
      NZ_UPLOAD: join(work, "upload"),
      NZ_LOADED: join(work, "loaded"),
      ...env,
    },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr, calls: await readFile(calls, "utf8") };
}

async function download(content: Uint8Array | string): Promise<string> {
  const path = join(await mkdtemp(join(dir, "file-")), "backup");
  await writeFile(path, content);
  return path;
}

describe("a dump streams into the bucket (R3-50)", () => {
  test("pg_dump's output goes through gzip into rclone rcat, with nothing on the disk", async () => {
    const script = dumpScript(target("postgres"), DESTINATION, "shop/daily/x.sql.gz");
    const result = await run(script);
    expect(result.code).toBe(0);
    expect(result.calls).toContain("rclone rcat nearzero:backups/shop/daily/x.sql.gz");
    expect(result.calls).toContain(
      "pg_dump --host=shop-db --port=5432 --username=app --dbname=app",
    );
    // Nothing is written to the scratch volume (it is mounted read-only for this step).
    expect(script).not.toMatch(/> ?'?\/backup/);
  });

  test("the uploaded file is the dump, compressed", async () => {
    const work = await mkdtemp(join(dir, "upload-"));
    const upload = join(work, "upload");
    const result = await run(dumpScript(target("postgres"), DESTINATION, "k"), {
      NZ_UPLOAD: upload,
    });
    expect(result.code).toBe(0);
    expect(gunzipSync(await readFile(upload)).toString()).toBe(
      "CREATE TABLE items (id int);\nINSERT INTO items VALUES (1);\n",
    );
  });

  test("a dump that stops part-way fails as the dump, an upload that fails fails as the upload", async () => {
    const dumpFailed = await run(dumpScript(target("postgres"), DESTINATION, "k"), {
      NZ_FAIL_DUMP: "1",
    });
    expect(dumpFailed.code).toBe(10);
    expect(dumpFailed.stderr).toContain("The dump stopped before it finished (exit code 1).");
    const uploadFailed = await run(dumpScript(target("postgres"), DESTINATION, "k"), {
      NZ_FAIL_UPLOAD: "1",
    });
    expect(uploadFailed.code).toBe(12);
    expect(uploadFailed.stderr).toContain("Uploading the dump failed (exit code 5).");
  });

  test("libSQL's /dump answer goes compressed into the bucket too", async () => {
    const work = await mkdtemp(join(dir, "libsql-"));
    const upload = join(work, "upload");
    const script = libsqlExchangeScript(null, { destination: DESTINATION, key: "k" }).replace(
      "/nearzero/libsql-request.http",
      "/dev/null",
    );
    const result = await run(
      script,
      { NZ_UPLOAD: upload },
      "HTTP/1.0 200 OK\r\ncontent-type: text/plain\r\n\r\nCREATE TABLE t(x);\n",
    );
    expect(result.code).toBe(0);
    expect(gunzipSync(await readFile(upload)).toString()).toBe("CREATE TABLE t(x);\n");
  });
});

describe("a restore is checked whole and its format told first (R2-06, R3-44)", () => {
  const tar = createTar([
    { path: "dbs", type: "directory", mode: 0o755, uid: 0, gid: 0 },
    {
      path: "dbs/default/data",
      type: "file",
      content: new TextEncoder().encode("sqlite"),
      mode: 0o644,
      uid: 0,
      gid: 0,
    },
  ]);

  test("a Postgres archive, a tar archive and an SQL dump", async () => {
    const cases: [Uint8Array, string][] = [
      [gzipSync(Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(2000, 1)])), "pgdump"],
      [gzipSync(tar), "tar"],
      [gzipSync("-- PostgreSQL database dump\nCREATE TABLE x();\n"), "sql"],
    ];
    for (const [content, format] of cases) {
      const result = await run(checkScript("postgres", DESTINATION, "k"), {
        NZ_DOWNLOAD: await download(content),
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(format);
    }
    const mongo = await run(checkScript("mongodb", DESTINATION, "k"), {
      NZ_DOWNLOAD: await download(gzipSync("archive")),
    });
    expect(mongo.stdout.trim()).toBe("mongodb");
  });

  test("a damaged or missing file fails before anything is touched", async () => {
    const whole = gzipSync("CREATE TABLE x();\n".repeat(2000));
    const cut = await run(checkScript("postgres", DESTINATION, "k"), {
      NZ_DOWNLOAD: await download(whole.subarray(0, whole.length - 30)),
    });
    expect(cut.code).toBe(11);
    expect(cut.stderr).toContain("The backup file is damaged: it doesn't decompress");
    const gone = await run(checkScript("postgres", DESTINATION, "k"), {
      NZ_DOWNLOAD: await download(whole),
      NZ_FAIL_DOWNLOAD: "1",
    });
    expect(gone.code).toBe(12);
    expect(gone.stderr).toContain("Reading the backup from the bucket failed");
  });
});

describe("loading into the database asked for (R3-45, B1-19)", () => {
  test("Postgres: an SQL dump goes into the named database inside one transaction", async () => {
    const work = await mkdtemp(join(dir, "load-"));
    const loaded = join(work, "loaded");
    const result = await run(
      loadScript(target("postgres", "analytics"), DESTINATION, "k", "sql", "analytics"),
      { NZ_DOWNLOAD: await download(gzipSync("CREATE TABLE x();\n")), NZ_LOADED: loaded },
    );
    expect(result.code).toBe(0);
    // Emptied first, in the same transaction (C2-03).
    expect(await readFile(loaded, "utf8")).toBe(
      `BEGIN;\n${POSTGRES_RESET}CREATE TABLE x();\n\nCOMMIT;\n`,
    );
    expect(result.calls).toContain("--dbname=analytics");
    expect(result.calls).toContain("--set=target=analytics");
  });

  test("Postgres: a file cut short never commits", async () => {
    const work = await mkdtemp(join(dir, "load-"));
    const loaded = join(work, "loaded");
    const whole = gzipSync("INSERT INTO x VALUES (1);\n".repeat(5000));
    const result = await run(loadScript(target("postgres"), DESTINATION, "k", "sql", null), {
      NZ_DOWNLOAD: await download(whole.subarray(0, whole.length / 2)),
      NZ_LOADED: loaded,
    });
    expect(result.code).toBe(11);
    expect(await readFile(loaded, "utf8")).not.toContain("COMMIT;");
  });

  test("Postgres: an archive (0.1.x) goes through pg_restore, clean, if exists, no owner", async () => {
    const work = await mkdtemp(join(dir, "load-"));
    const loaded = join(work, "loaded");
    const archive = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(100, 7)]);
    const result = await run(
      loadScript(target("postgres", "shop"), DESTINATION, "k", "pgdump", null),
      { NZ_DOWNLOAD: await download(gzipSync(archive)), NZ_LOADED: loaded },
    );
    expect(result.code).toBe(0);
    // pg_restore writes the archive's SQL, which runs in psql's one transaction after the reset.
    expect(await readFile(loaded, "utf8")).toBe(
      `BEGIN;\n${POSTGRES_RESET}CREATE TABLE from_archive();\n\nCOMMIT;\n`,
    );
    expect(result.calls).toMatch(/pg_restore --clean --if-exists --no-owner --file=-/);
    expect(result.calls).toMatch(/psql .*--dbname=shop/);
    // An archive pg_restore can't read never commits.
    const broken = await run(
      loadScript(target("postgres", "shop"), DESTINATION, "k", "pgdump", null),
      { NZ_DOWNLOAD: await download(gzipSync(archive)), NZ_LOADED: loaded, NZ_FAIL_RESTORE: "1" },
    );
    expect(broken.code).toBe(15);
    expect(broken.stderr).toContain("pg_restore couldn't read the archive, so nothing was changed");
    expect(await readFile(loaded, "utf8")).not.toContain("COMMIT;");
  });

  test("Postgres: a dump that makes the public schema itself still loads after the reset (C2-03)", async () => {
    const work = await mkdtemp(join(dir, "load-"));
    const loaded = join(work, "loaded");
    const dump = "DROP SCHEMA IF EXISTS public;\nCREATE SCHEMA public;\nCREATE TABLE public.x();\n";
    const result = await run(loadScript(target("postgres"), DESTINATION, "k", "sql", null), {
      NZ_DOWNLOAD: await download(gzipSync(dump)),
      NZ_LOADED: loaded,
    });
    expect(result.code).toBe(0);
    expect(await readFile(loaded, "utf8")).toContain(
      "DROP SCHEMA IF EXISTS public;\nCREATE SCHEMA IF NOT EXISTS public;\nCREATE TABLE public.x();\n",
    );
  });

  test("MySQL: the database is made when missing, and the dump's own switches are dropped", async () => {
    const work = await mkdtemp(join(dir, "load-"));
    const loaded = join(work, "loaded");
    const dump = [
      "-- MySQL dump",
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `old` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
      "",
      "USE `old`;",
      "INSERT INTO `items` VALUES (1,'USE `x`;');",
      "",
    ].join("\n");
    const result = await run(
      loadScript(target("mysql", "analytics"), DESTINATION, "k", "sql", null),
      { NZ_DOWNLOAD: await download(gzipSync(dump)), NZ_LOADED: loaded },
    );
    expect(result.code).toBe(0);
    expect(await readFile(loaded, "utf8")).toBe(
      "-- MySQL dump\n\nINSERT INTO `items` VALUES (1,'USE `x`;');\n",
    );
    expect(result.calls).toContain("--execute=CREATE DATABASE IF NOT EXISTS `analytics`");
    expect(result.calls).toContain("--database=analytics");
  });

  test("MongoDB: the archive goes to mongorestore with --drop and the renamed database", async () => {
    const work = await mkdtemp(join(dir, "load-"));
    const loaded = join(work, "loaded");
    const result = await run(
      loadScript(target("mongodb", "copy"), DESTINATION, "k", "mongodb", "shop"),
      { NZ_DOWNLOAD: await download("archive-bytes"), NZ_LOADED: loaded },
    );
    expect(result.code).toBe(0);
    expect(await readFile(loaded, "utf8")).toBe("archive-bytes");
    expect(result.calls).toContain(
      "--drop --archive --gzip --nsInclude=shop.* --nsFrom=shop.* --nsTo=copy.*",
    );
  });

  test("libSQL: an archive of the data folder unpacks into the data volume", async () => {
    const tar = createTar([
      {
        path: "dbs/default/data",
        type: "file",
        content: new TextEncoder().encode("sqlite-bytes"),
        mode: 0o644,
        uid: 0,
        gid: 0,
      },
    ]);
    const step = unpackFromBucketStep("tools", "lite-data", DESTINATION, "k");
    const out = await mkdtemp(join(dir, "volume-"));
    const script = (step.files?.find((file) => file.name === "steps.sh")?.content ?? "")
      .replace("-C /target", `-C ${out}`)
      .replace("--numeric-owner ", "");
    const result = await run(script, { NZ_DOWNLOAD: await download(gzipSync(tar)) });
    expect(result.code).toBe(0);
    expect(await readFile(join(out, "dbs/default/data"), "utf8")).toBe("sqlite-bytes");
    expect(step.mounts).toEqual([{ source: "lite-data", target: "/target" }]);
  });
});
