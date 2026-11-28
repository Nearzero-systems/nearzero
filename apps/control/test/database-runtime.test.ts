import { describe, expect, test } from "bun:test";
import {
  databaseContainer,
  dataPath,
  imageMajor,
  MONGO_KEY_FILE_PATH,
  mongoKeyFile,
  mongoReplicaSetInit,
  readDatabaseSettings,
  readinessCheck,
  redisStartScript,
} from "../src/service-runtime/databases.ts";

/** How the six databases run (spec 8.1, 8.2), without a server. */

describe("database containers", () => {
  test("Postgres 18 keeps its data one level up; older majors in /data", () => {
    expect(imageMajor("postgres:18")).toBe(18);
    expect(imageMajor("pgvector/pgvector:pg17")).toBe(17);
    expect(imageMajor("registry:5000/postgres")).toBeNull();
    expect(dataPath("postgres", "postgres:18")).toBe("/var/lib/postgresql");
    expect(dataPath("postgres", "postgres:16-alpine")).toBe("/var/lib/postgresql/data");
    expect(dataPath("mariadb", "mariadb:11")).toBe("/var/lib/mysql");
  });

  test("each type gets its credentials, and a replica set its key file", () => {
    const settings = readDatabaseSettings("mongodb", { replicaSet: true }, "docs-abc123");
    const mongo = databaseContainer("mongodb", settings, { password: "pw12345678" });
    expect(mongo.env).toEqual({
      MONGO_INITDB_ROOT_USERNAME: "mongo",
      MONGO_INITDB_ROOT_PASSWORD: "pw12345678",
    });
    expect(mongo.command).toEqual([
      "mongod",
      "--replSet",
      "rs0",
      "--keyFile",
      MONGO_KEY_FILE_PATH,
      "--bind_ip_all",
    ]);
    expect(mongo.files[0]).toMatchObject({ path: MONGO_KEY_FILE_PATH, mode: 0o400, uid: 999 });
    const key = mongoKeyFile("pw12345678");
    expect(key).toBe(mongoKeyFile("pw12345678"));
    expect(key).not.toBe(mongoKeyFile("other-password"));
    expect(key).toMatch(/^[A-Za-z0-9+/=]{6,1024}$/);
    expect(mongo.secrets).toContain(key);
    const init = mongoReplicaSetInit(settings, { password: "pw12345678" }, "docs-abc123");
    expect(init.command.join(" ")).toContain('"host":"docs-abc123:27017"');
    expect(init.command.join(" ")).not.toContain("pw12345678");

    const mysql = databaseContainer("mysql", readDatabaseSettings("mysql", {}, "m"), {
      password: "a",
      rootPassword: "b",
    });
    expect(mysql.env).toMatchObject({
      MYSQL_ROOT_PASSWORD: "b",
      MYSQL_PASSWORD: "a",
      MYSQL_USER: "mysql",
    });
    const redis = databaseContainer("redis", readDatabaseSettings("redis", {}, "r"), {
      password: "c",
    });
    expect(redis.command).toEqual(["sh", "-c", redisStartScript("/data")]);
    expect(redis.env).toEqual({ NEARZERO_REDIS_PASSWORD: "c" });
    expect(redis.command?.join(" ")).not.toContain(" c ");
    const libsql = databaseContainer("libsql", readDatabaseSettings("libsql", {}, "l"), {
      password: "d",
    });
    expect(libsql.env.SQLD_HTTP_AUTH).toBe(`basic:${Buffer.from("libsql:d").toString("base64")}`);
  });

  test("readiness checks ask the real server, never with the password on the command line", () => {
    const postgres = readinessCheck("postgres", readDatabaseSettings("postgres", {}, "p"), {
      password: "x1",
    });
    expect(postgres?.command).toContain("127.0.0.1");
    const mysql = readinessCheck("mysql", readDatabaseSettings("mysql", {}, "m"), {
      password: "x",
      rootPassword: "root-pw",
    });
    expect(mysql?.command.join(" ")).not.toContain("root-pw");
    expect(mysql?.env.MYSQL_PWD).toBe("root-pw");
    expect(
      readinessCheck("libsql", readDatabaseSettings("libsql", {}, "l"), { password: "x" }),
    ).toBeNull();
  });
});

describe("a moved Redis loads its snapshot (spec 29.5)", () => {
  /**
   * Runs the start script against a folder standing in for the volume, with stand-ins for the
   * image's entrypoint, redis-server and redis-cli that say how they were called.
   */
  async function start(files: string[]): Promise<string[]> {
    const { mkdtemp, mkdir, rm, writeFile, chmod, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "nz1-redis-"));
    const data = join(root, "data");
    const bin = join(root, "bin");
    const calls = join(root, "calls");
    await mkdir(data);
    await mkdir(bin);
    for (const file of files) {
      if (file.endsWith("/")) await mkdir(join(data, file));
      else await writeFile(join(data, file), "x");
    }
    const stub = (body: string) => `#!/bin/sh\n${body}\n`;
    await writeFile(join(bin, "docker-entrypoint.sh"), stub(`echo "entrypoint $*" >> "${calls}"`));
    await writeFile(join(bin, "redis-server"), stub(`echo "server $*" >> "${calls}"`));
    await writeFile(
      join(bin, "redis-cli"),
      stub(`echo "cli $*" >> "${calls}"; [ "$4" = ping ] && echo PONG; exit 0`),
    );
    for (const name of ["docker-entrypoint.sh", "redis-server", "redis-cli"]) {
      await chmod(join(bin, name), 0o755);
    }
    const child = Bun.spawn(["sh", "-c", redisStartScript(data)], {
      env: { PATH: `${bin}:/usr/bin:/bin`, NEARZERO_REDIS_PASSWORD: "s3cret" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    // The background step that turns append-only on runs after the server starts.
    for (let i = 0; i < 50; i++) {
      const text = await readFile(calls, "utf8").catch(() => "");
      if (files.join() !== "dump.rdb" || text.includes("config set")) break;
      await Bun.sleep(100);
    }
    const lines = (await readFile(calls, "utf8").catch(() => "")).trim().split("\n");
    await rm(root, { recursive: true, force: true });
    return lines.sort();
  }

  test("a snapshot alone is loaded first, then append-only is turned on from it", async () => {
    expect(await start(["dump.rdb"])).toEqual([
      "cli -a s3cret --no-auth-warning config set appendonly yes",
      "cli -a s3cret --no-auth-warning ping",
      "entrypoint redis-server --requirepass s3cret --appendonly no",
    ]);
  });

  test("append-only files (or an empty volume) start with append-only, through the entrypoint", async () => {
    const aof = ["entrypoint redis-server --requirepass s3cret --appendonly yes"];
    expect(await start(["dump.rdb", "appendonlydir/"])).toEqual(aof);
    expect(await start(["appendonly.aof"])).toEqual(aof);
    expect(await start([])).toEqual(aof);
  });
});
