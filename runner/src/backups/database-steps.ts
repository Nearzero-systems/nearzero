// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are the shell's own ${NAME} syntax.
import type { DatabaseBackupKind, RunnerDestination } from "@nearzero/shared";
import { HELPER_FILES_DIR, type HelperStep, SCRATCH_PATH } from "./helpers.ts";
import { rcloneConfig, remote } from "./rclone.ts";

/**
 * How each database is dumped and loaded (spec 08 8.3, 23.1; R3-50), as helper steps.
 *
 * Dumps stream straight to the bucket and restores stream straight from it, so a database bigger
 * than the server's free disk still backs up and restores. The helper runs in the database's own
 * image (so the client matches the server), on the database's network, reaching it by name, with
 * rclone (a static program, copied from the backup tools image into the run's scratch volume
 * with the tools image's certificate list) at the other end of a pipe. Passwords and keys go in
 * files written into the helper, never on a command line. A helper's script is a file written
 * into it as well; its first line cuts standard input off for good, so nothing in it reads the
 * helper's standard input, and every program's exit status is written down and checked before
 * the script ends.
 *
 * A restore first reads the whole file from the bucket once, to check it arrives whole and
 * decompresses, and to tell its format; then it loads it: a plain SQL dump, a Postgres archive
 * (pg_restore), a MongoDB archive, or an archive of a libSQL data folder. That reads the backups
 * 0.1.x wrote as well as 1.0's (R2-06, R3-44).
 */

export interface DatabaseTarget {
  kind: DatabaseBackupKind;
  /** The database container's own image id, so the tools match the server. */
  image: string;
  network: string;
  host: string;
  port: number;
  database: string | null;
  user: string | null;
  password: string;
  rootPassword: string | null;
}

/** What a restore's file turned out to hold, from its first bytes. */
export type BackupFormat = "sql" | "pgdump" | "tar" | "mongodb";

/** rclone and the certificate list, copied into the scratch volume for a database image. */
export const RCLONE_IN_SCRATCH = `${SCRATCH_PATH}/rclone`;
export const CERTIFICATES_IN_SCRATCH = `${SCRATCH_PATH}/ca-certificates.crt`;
const CONFIG = `${HELPER_FILES_DIR}/rclone.conf`;
const SCRIPT = "steps.sh";

/** A shell word: the text between single quotes, with any single quote spelled '\''. */
export function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function command(argv: readonly string[]): string {
  return argv.map(shellWord).join(" ");
}

function scratchMount(readOnly = false) {
  return [{ source: "", target: SCRATCH_PATH, readOnly }];
}

/** pgpass needs ":" and "\" escaped. */
function pgpass(password: string): string {
  return `*:*:*:*:${password.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`;
}

/** An option file for the MySQL and MariaDB clients. */
function myCnf(user: string, password: string): string {
  const quoted = password.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[client]\nuser=${user}\npassword="${quoted}"\n`;
}

function mongoConfig(password: string): string {
  return `password: ${JSON.stringify(password)}\n`;
}

function libsqlAuth(target: DatabaseTarget): string {
  return `Authorization: Basic ${Buffer.from(`${target.user ?? "libsql"}:${target.password}`).toString("base64")}`;
}

/**
 * The top of every helper script: standard input is gone for good, rclone is found (the scratch
 * copy in a database image, the tools image's own otherwise) with the certificate list next to
 * it, and `code <name>` reads an exit status a pipeline stage wrote down (a stage that never ran
 * counts as failed).
 */
function preamble(): string[] {
  return [
    "exec </dev/null",
    `RC="\${NZ_RCLONE:-${RCLONE_IN_SCRATCH}}"`,
    '[ -x "$RC" ] || RC=rclone',
    'CA=""',
    `[ -f ${CERTIFICATES_IN_SCRATCH} ] && CA=${CERTIFICATES_IN_SCRATCH}`,
    'S="${NZ_STATUS:-/tmp/nz-status}"',
    'rm -rf "$S"; mkdir -p "$S"',
    'code() { cat "$S/$1" 2>/dev/null || echo 1; }',
  ];
}

/** `<stage>; echo $? > status`, as one stage of a pipeline. */
function stage(text: string, status: string): string {
  return `{ ${text}; echo $? > "$S/${status}"; }`;
}

/** Stops the script with a message unless the stage's status is 0. */
function needs(status: string, message: string, exitCode: number): string {
  return `[ "$(code ${status})" = 0 ] || { echo "${message} (exit code $(code ${status}))." >&2; exit ${exitCode}; }`;
}

const TRANSFER = ["--retries", "3", "--low-level-retries", "5"];
const PROGRESS = ["--stats", "30s", "--stats-one-line", "--stats-log-level", "NOTICE"];

function rclone(args: readonly string[]): string {
  return `"$RC" \${CA:+--ca-cert "$CA"} ${command(args)}`;
}

/**
 * rclone's upload of a stream of unknown size: in parts of 32 MB, two at a time (64 MB of memory,
 * and up to 10,000 parts: about 300 GB per file).
 */
function rcat(destination: RunnerDestination, key: string): string {
  return rclone([
    "rcat",
    remote(destination, key),
    "--config",
    CONFIG,
    ...TRANSFER,
    "--s3-chunk-size",
    "32M",
    "--s3-upload-concurrency",
    "2",
    ...PROGRESS,
  ]);
}

function rcloneCat(destination: RunnerDestination, key: string, extra: string[] = []): string {
  return rclone(["cat", remote(destination, key), "--config", CONFIG, ...TRANSFER, ...extra]);
}

function rcloneFile(destination: RunnerDestination) {
  return { name: "rclone.conf", content: rcloneConfig(destination) };
}

/** Copies rclone and its certificate list from the tools image into the scratch volume. */
export function rcloneCopyStep(toolsImage: string): HelperStep {
  return {
    title: "Preparing the transfer tool",
    image: toolsImage,
    argv: ["cp", "/usr/local/bin/rclone", "/etc/ssl/certs/ca-certificates.crt", `${SCRATCH_PATH}/`],
    mounts: scratchMount(),
  };
}

// ---- Dumps

/** The program that writes the dump to its standard output, and whether that is compressed. */
export function dumpProgram(target: DatabaseTarget): { argv: string[]; compressed: boolean } {
  switch (target.kind) {
    case "postgres":
      return {
        argv: [
          "pg_dump",
          `--host=${target.host}`,
          `--port=${target.port}`,
          `--username=${target.user ?? "postgres"}`,
          `--dbname=${target.database ?? "postgres"}`,
          "--no-password",
          "--clean",
          "--if-exists",
        ],
        compressed: false,
      };
    case "mysql":
    case "mariadb": {
      const maria = target.kind === "mariadb";
      return {
        argv: [
          maria ? "mariadb-dump" : "mysqldump",
          `--defaults-extra-file=${HELPER_FILES_DIR}/my.cnf`,
          `--host=${target.host}`,
          `--port=${target.port}`,
          "--protocol=TCP",
          "--single-transaction",
          "--routines",
          "--triggers",
          "--events",
          ...(maria ? [] : ["--set-gtid-purged=OFF"]),
          // Tables are dropped and created again on restore. The dump names no database, so a
          // restore loads it into whichever database it is told to (R3-45).
          "--add-drop-table",
          target.database ?? target.kind,
        ],
        compressed: false,
      };
    }
    case "mongodb":
      return {
        argv: [
          "mongodump",
          `--host=${target.host}`,
          `--port=${target.port}`,
          `--username=${target.user ?? "mongo"}`,
          "--authenticationDatabase=admin",
          `--config=${HELPER_FILES_DIR}/mongo.yaml`,
          ...(target.database ? [`--db=${target.database}`] : []),
          "--archive",
          "--gzip",
        ],
        compressed: true,
      };
    case "libsql":
      throw new Error("libSQL is dumped over its HTTP interface (libsqlDumpStep).");
  }
}

function credentialFiles(target: DatabaseTarget): { name: string; content: string }[] {
  switch (target.kind) {
    case "postgres":
      return [{ name: "pgpass", content: pgpass(target.password) }];
    case "mysql":
    case "mariadb":
      return [{ name: "my.cnf", content: myCnf("root", target.rootPassword ?? target.password) }];
    case "mongodb":
      return [{ name: "mongo.yaml", content: mongoConfig(target.password) }];
    case "libsql":
      return [];
  }
}

function credentialEnv(target: DatabaseTarget): Record<string, string> {
  return {
    HOME: "/tmp",
    ...(target.kind === "postgres" ? { PGPASSFILE: `${HELPER_FILES_DIR}/pgpass` } : {}),
  };
}

/** The script that dumps, compresses and uploads in one pipe. */
export function dumpScript(
  target: DatabaseTarget,
  destination: RunnerDestination,
  key: string,
): string {
  const program = dumpProgram(target);
  const pipeline = [
    stage(command(program.argv), "dump"),
    ...(program.compressed ? [] : [stage("gzip -n -6", "gzip")]),
    stage(`${rcat(destination, key)} >/dev/null`, "upload"),
  ].join(" | ");
  return [
    ...preamble(),
    pipeline,
    // The upload's failure is named first: a dump cut off by a failed upload fails too.
    needs("upload", "Uploading the dump failed", 12),
    needs("dump", "The dump stopped before it finished", 10),
    ...(program.compressed ? [] : [needs("gzip", "Compressing the dump failed", 11)]),
    "",
  ].join("\n");
}

/** Dumps the database straight into the bucket (Postgres, MySQL, MariaDB, MongoDB). */
export function dumpStep(
  target: DatabaseTarget,
  destination: RunnerDestination,
  key: string,
): HelperStep {
  return {
    title: `Dumping the database into the bucket (${dumpProgram(target).argv[0]})`,
    image: target.image,
    network: target.network,
    argv: ["sh", `${HELPER_FILES_DIR}/${SCRIPT}`],
    env: credentialEnv(target),
    mounts: scratchMount(true),
    files: [
      ...credentialFiles(target),
      rcloneFile(destination),
      { name: SCRIPT, content: dumpScript(target, destination, key) },
    ],
  };
}

// ---- libSQL over HTTP, with the credentials in a file

/** Where a libSQL helper finds the request's head (the credentials) and its script. */
export const LIBSQL_REQUEST_FILE = "libsql-request.http";
export const LIBSQL_SCRIPT_FILE = "libsql-exchange.sh";

/**
 * The head of one HTTP/1.0 request to libSQL, with its Authorization header. HTTP/1.0 keeps the
 * answer plain: no chunks, and the server closes the connection when the body ends.
 */
export function libsqlRequestHead(
  target: DatabaseTarget,
  request: { method: "GET" | "POST"; path: string; bodyBytes?: number },
): string {
  const lines = [
    `${request.method} ${request.path} HTTP/1.0`,
    `Host: ${target.host}:${target.port}`,
    libsqlAuth(target),
    ...(request.bodyBytes === undefined
      ? []
      : ["Content-Type: application/json", `Content-Length: ${request.bodyBytes}`]),
    "Connection: close",
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** Where a libSQL answer goes: a file in the scratch volume, or compressed into the bucket. */
export type LibsqlAnswer = string | { destination: RunnerDestination; key: string };

/**
 * The script a libSQL helper runs (spec 08 8.3). busybox nc starts it with its standard input and
 * output connected to libSQL, so it reads only the server's answer, never anyone's input. It
 * sends the request's head (the only place the credentials are, a file written into the helper)
 * and the body from the scratch volume, then keeps the answer's body when libSQL says 200 and
 * stops with libSQL's status line otherwise. A dump's body goes compressed into the bucket.
 */
export function libsqlExchangeScript(bodyFile: string | null, answer: LibsqlAnswer): string {
  const send = [`${HELPER_FILES_DIR}/${LIBSQL_REQUEST_FILE}`, ...(bodyFile ? [bodyFile] : [])];
  const body =
    typeof answer === "string"
      ? [`cat > '${answer}'`]
      : [
          'RC="${NZ_RCLONE:-rclone}"',
          'CA=""',
          'S="${NZ_STATUS:-/tmp/nz-status}"; rm -rf "$S"; mkdir -p "$S"',
          'code() { cat "$S/$1" 2>/dev/null || echo 1; }',
          `${stage("cat", "dump")} | ${stage("gzip -n -6", "gzip")} | ${stage(`${rcat(answer.destination, answer.key)} >/dev/null`, "upload")}`,
          needs("upload", "Uploading the dump failed", 12),
          needs("dump", "Reading libSQL's dump failed", 10),
          needs("gzip", "Compressing the dump failed", 11),
        ];
  return [
    `cr=$(printf '\\r')`,
    `cat ${send.map((file) => `'${file}'`).join(" ")}`,
    `IFS= read -r status || { echo "libSQL closed the connection without answering." >&2; exit 70; }`,
    `status=\${status%"$cr"}`,
    `case "$status" in`,
    `  "HTTP/1."?" 200"*) ;;`,
    `  *) echo "libSQL answered: $status" >&2; exit 22 ;;`,
    "esac",
    `while IFS= read -r line; do [ "\${line%"$cr"}" = "" ] && break; done`,
    ...body,
    "",
  ].join("\n");
}

/**
 * A helper step that sends one request to libSQL from the backup tools image: busybox nc, on the
 * database's network, runs the exchange script. Nothing secret is on its command line.
 */
export function libsqlExchangeStep(
  toolsImage: string,
  target: DatabaseTarget,
  options: {
    title: string;
    method: "GET" | "POST";
    path: string;
    /** The body in the scratch volume, and its size in bytes. */
    body?: { file: string; bytes: number };
    answerFile: LibsqlAnswer;
  },
): HelperStep {
  return {
    title: options.title,
    image: toolsImage,
    network: target.network,
    argv: [
      "nc",
      target.host,
      String(target.port),
      "-e",
      "sh",
      `${HELPER_FILES_DIR}/${LIBSQL_SCRIPT_FILE}`,
    ],
    mounts: scratchMount(),
    env: { HOME: "/tmp" },
    files: [
      {
        name: LIBSQL_REQUEST_FILE,
        content: libsqlRequestHead(target, {
          method: options.method,
          path: options.path,
          ...(options.body ? { bodyBytes: options.body.bytes } : {}),
        }),
      },
      {
        name: LIBSQL_SCRIPT_FILE,
        content: libsqlExchangeScript(options.body?.file ?? null, options.answerFile),
      },
      ...(typeof options.answerFile === "string"
        ? []
        : [rcloneFile(options.answerFile.destination)]),
    ],
  };
}

/** libSQL's /dump, compressed and streamed into the bucket. */
export function libsqlDumpStep(
  toolsImage: string,
  target: DatabaseTarget,
  destination: RunnerDestination,
  key: string,
): HelperStep {
  return libsqlExchangeStep(toolsImage, target, {
    title: "Dumping the database into the bucket (libSQL /dump)",
    method: "GET",
    path: "/dump",
    answerFile: { destination, key },
  });
}

// ---- Restores

/**
 * The script that reads the whole file once (it must arrive whole and decompress) and prints its
 * format: a Postgres archive starts with PGDMP, a tar archive has "ustar" at byte 257, anything
 * else is SQL. MongoDB's archives are only checked.
 */
export function checkScript(
  kind: DatabaseBackupKind,
  destination: RunnerDestination,
  key: string,
): string {
  const classify =
    kind === "mongodb"
      ? ["format=mongodb"]
      : [
          `${rcloneCat(destination, key, ["--count", "65536"])} 2>/dev/null | gzip -dc 2>/dev/null | head -c 512 > "$S/peek"`,
          "format=sql",
          'if [ "$(head -c 5 "$S/peek")" = PGDMP ]; then format=pgdump',
          'elif [ "$(dd if="$S/peek" bs=1 skip=257 count=5 2>/dev/null)" = ustar ]; then format=tar',
          "fi",
        ];
  return [
    ...preamble(),
    ...classify,
    'if [ "$format" = tar ]; then',
    `  ${stage(rcloneCat(destination, key), "download")} | ${stage("gzip -dc", "gzip")} | ${stage("tar -t -f - >/dev/null", "archive")}`,
    "else",
    `  ${stage(rcloneCat(destination, key), "download")} | ${stage("gzip -dc >/dev/null", "gzip")}`,
    '  echo 0 > "$S/archive"',
    "fi",
    needs("download", "Reading the backup from the bucket failed", 12),
    needs("gzip", "The backup file is damaged: it doesn't decompress", 11),
    needs("archive", "The backup file is damaged: its archive can't be read", 11),
    'echo "$format"',
    "",
  ].join("\n");
}

/** Reads the backup from the bucket once, whole, and answers its format (on standard output). */
export function checkStep(
  toolsImage: string,
  kind: DatabaseBackupKind,
  destination: RunnerDestination,
  key: string,
): HelperStep {
  return {
    title: "Checking the backup file is whole",
    image: toolsImage,
    argv: ["sh", `${HELPER_FILES_DIR}/${SCRIPT}`],
    env: { HOME: "/tmp" },
    captureStdout: true,
    files: [
      rcloneFile(destination),
      { name: SCRIPT, content: checkScript(kind, destination, key) },
    ],
  };
}

/** The format a check printed, or null. */
export function checkedFormat(stdout: string): BackupFormat | null {
  const word = stdout.trim().split("\n").at(-1)?.trim();
  return word === "sql" || word === "pgdump" || word === "tar" || word === "mongodb" ? word : null;
}

/** MongoDB's namespace options: the source database renamed into the target, or one database. */
export function mongoNamespaces(source: string | null, target: string | null): string[] {
  if (!target) return [];
  if (source && source !== target) {
    return [`--nsInclude=${source}.*`, `--nsFrom=${source}.*`, `--nsTo=${target}.*`];
  }
  return [`--nsInclude=${target}.*`];
}

function clientArgs(target: DatabaseTarget, program: string): string[] {
  return [
    program,
    `--defaults-extra-file=${HELPER_FILES_DIR}/my.cnf`,
    `--host=${target.host}`,
    `--port=${target.port}`,
    "--protocol=TCP",
    "--batch",
  ];
}

/**
 * The lines of a dump made with --databases that would load it into the database it came from
 * instead of the one asked for (1.0's earlier dumps). mysqldump writes every statement on lines
 * of its own and escapes line breaks inside values, and USE isn't allowed in stored programs.
 */
export const MYSQL_SWITCHES = [
  "/^CREATE DATABASE \\/\\*!32312 IF NOT EXISTS\\*\\/ `/d",
  "/^USE `[^`]*`;$/d",
];

const POSTGRES_ENSURE =
  "SELECT format('CREATE DATABASE %I', :'target') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'target')\\gexec\n";

/**
 * Run first inside a Postgres restore's transaction (C2-03): every schema of the database is
 * dropped with what is in it, and public is made again as Postgres makes it, so tables, views,
 * foreign keys and triggers added since the backup can't stop the dump's own DROP statements.
 * The restore brings back the database the backup holds (spec 8.3); a failed load rolls back.
 */
export const POSTGRES_RESET = `SET LOCAL client_min_messages = warning;
DO $nz$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT nspname FROM pg_catalog.pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
  LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', item.nspname);
  END LOOP;
  CREATE SCHEMA public;
  COMMENT ON SCHEMA public IS 'standard public schema';
  IF current_setting('server_version_num')::int >= 150000 THEN
    ALTER SCHEMA public OWNER TO pg_database_owner;
    GRANT USAGE ON SCHEMA public TO PUBLIC;
  ELSE
    GRANT ALL ON SCHEMA public TO PUBLIC;
  END IF;
END
$nz$;
`;

/** A dump that makes public itself finds it made already. */
const PUBLIC_SCHEMA_IF_MISSING = "s/^CREATE SCHEMA public;$/CREATE SCHEMA IF NOT EXISTS public;/";

function clientName(target: DatabaseTarget, format: BackupFormat): string {
  if (target.kind === "postgres") return format === "pgdump" ? "pg_restore" : "psql";
  if (target.kind === "mongodb") return "mongorestore";
  return target.kind === "mariadb" ? "mariadb" : "mysql";
}

/** The script that streams the backup from the bucket into the database. */
export function loadScript(
  target: DatabaseTarget,
  destination: RunnerDestination,
  key: string,
  format: Exclude<BackupFormat, "tar">,
  source: string | null,
): string {
  if (format === "pgdump" && target.kind !== "postgres") {
    throw new Error("Only Postgres reads a Postgres archive.");
  }
  const download = stage(rcloneCat(destination, key), "download");
  const gunzip = stage("gzip -dc", "gzip");
  const lines = [...preamble()];
  switch (target.kind) {
    case "postgres": {
      const database = target.database ?? "postgres";
      const connection = [
        `--host=${target.host}`,
        `--port=${target.port}`,
        `--username=${target.user ?? "postgres"}`,
        "--no-password",
      ];
      // The database it goes into is made when it isn't there (it may have been dropped).
      lines.push(
        `${command(["psql", ...connection, "--dbname=postgres", "--no-psqlrc", "--quiet", "--set=ON_ERROR_STOP=1", `--set=target=${database}`, `--file=${HELPER_FILES_DIR}/ensure.sql`])} >/dev/null || echo "Couldn't check that the database ${database} exists; loading into it anyway." >&2`,
      );
      // One transaction: the database is emptied first (C2-03), then the dump runs; COMMIT is
      // sent only when the whole file arrived (and, for an archive, was read whole), so anything
      // less is rolled back and nothing changes.
      const psql = stage(
        command([
          "psql",
          ...connection,
          `--dbname=${database}`,
          "--no-psqlrc",
          "--quiet",
          "--set=ON_ERROR_STOP=1",
          "--output=/dev/null",
        ]),
        "load",
      );
      const sql =
        format === "pgdump"
          ? // A 0.1.x archive: pg_restore turns it into the same SQL a dump holds.
            `${download} | ${gunzip} | ${stage(command(["pg_restore", "--clean", "--if-exists", "--no-owner", "--file=-"]), "convert")}`
          : `${download} | ${gunzip}`;
      const arrived =
        format === "pgdump"
          ? '[ "$(code download)" = 0 ] && [ "$(code gzip)" = 0 ] && [ "$(code convert)" = 0 ]'
          : '[ "$(code download)" = 0 ] && [ "$(code gzip)" = 0 ]';
      lines.push(
        `{ printf 'BEGIN;\\n'; cat <<'NZ_RESET'`,
        POSTGRES_RESET.replace(/\n$/, ""),
        "NZ_RESET",
        `${sql} | sed -e ${shellWord(PUBLIC_SCHEMA_IF_MISSING)}; if ${arrived}; then printf '\\nCOMMIT;\\n'; fi; } | ${psql}`,
      );
      break;
    }
    case "mysql":
    case "mariadb": {
      const program = clientName(target, format);
      const database = target.database ?? target.kind;
      lines.push(
        `NZ_DATABASE=${shellWord(database)}`,
        "bt='`'",
        `${command(clientArgs(target, program))} --execute="CREATE DATABASE IF NOT EXISTS \${bt}\${NZ_DATABASE}\${bt}" || { echo "The database ${database} couldn't be created." >&2; exit 13; }`,
        `${download} | ${gunzip} | sed ${MYSQL_SWITCHES.map((rule) => `-e ${shellWord(rule)}`).join(" ")} | ${stage(`${command(clientArgs(target, program))} --database="$NZ_DATABASE"`, "load")}`,
      );
      break;
    }
    case "mongodb":
      lines.push(
        `${download} | ${stage(command(["mongorestore", `--host=${target.host}`, `--port=${target.port}`, `--username=${target.user ?? "mongo"}`, "--authenticationDatabase=admin", `--config=${HELPER_FILES_DIR}/mongo.yaml`, "--drop", "--archive", "--gzip", ...mongoNamespaces(source, target.database)]), "load")}`,
      );
      break;
    case "libsql":
      throw new Error("libSQL dumps are loaded over its HTTP interface (libsql.ts).");
  }
  const stopped =
    target.kind === "postgres"
      ? "psql stopped, so nothing was changed"
      : `${clientName(target, format)} stopped`;
  lines.push(
    needs("download", "Reading the backup from the bucket failed", 12),
    ...(target.kind === "mongodb" ? [] : [needs("gzip", "The backup file doesn't decompress", 11)]),
    ...(target.kind === "postgres" && format === "pgdump"
      ? [needs("convert", "pg_restore couldn't read the archive, so nothing was changed", 15)]
      : []),
    needs("load", stopped, 14),
    "",
  );
  return lines.join("\n");
}

/** Streams the backup from the bucket into the database with its own client. */
export function loadStep(
  target: DatabaseTarget,
  destination: RunnerDestination,
  key: string,
  format: Exclude<BackupFormat, "tar">,
  source: string | null,
): HelperStep {
  const into = target.database ?? (target.kind === "mongodb" ? "the server" : "the database");
  return {
    title: `Loading the backup into ${into} (${clientName(target, format)})`,
    image: target.image,
    network: target.network,
    argv: ["sh", `${HELPER_FILES_DIR}/${SCRIPT}`],
    env: credentialEnv(target),
    mounts: scratchMount(true),
    files: [
      ...credentialFiles(target),
      ...(target.kind === "postgres" ? [{ name: "ensure.sql", content: POSTGRES_ENSURE }] : []),
      rcloneFile(destination),
      { name: SCRIPT, content: loadScript(target, destination, key, format, source) },
    ],
  };
}

/**
 * Unpacks a data-folder archive (libSQL) from the bucket into the data volume, which the caller
 * emptied with the database stopped.
 */
export function unpackFromBucketStep(
  toolsImage: string,
  volume: string,
  destination: RunnerDestination,
  key: string,
): HelperStep {
  const script = [
    ...preamble(),
    `${stage(rcloneCat(destination, key), "download")} | ${stage("gzip -dc", "gzip")} | ${stage("tar -x -p --numeric-owner -f - -C /target", "archive")}`,
    needs("download", "Reading the backup from the bucket failed", 12),
    needs("gzip", "The backup file doesn't decompress", 11),
    needs("archive", "Unpacking the archive failed", 14),
    "",
  ].join("\n");
  return {
    title: `Unpacking the archive into ${volume}`,
    image: toolsImage,
    argv: ["sh", `${HELPER_FILES_DIR}/${SCRIPT}`],
    env: { HOME: "/tmp" },
    mounts: [{ source: volume, target: "/target" }],
    files: [rcloneFile(destination), { name: SCRIPT, content: script }],
  };
}

/** The values to cut out of everything the steps print. */
export function databaseSecrets(target: DatabaseTarget): string[] {
  const secrets = [target.password];
  if (target.rootPassword) secrets.push(target.rootPassword);
  if (target.kind === "libsql")
    secrets.push(libsqlAuth(target).slice("Authorization: Basic ".length));
  return secrets;
}

/** Fills in the scratch volume's name in the steps' mounts. */
export function withScratch(steps: HelperStep[], scratch: string): HelperStep[] {
  return steps.map((step) => ({
    ...step,
    mounts: (step.mounts ?? []).map((mount) =>
      mount.source === "" ? { ...mount, source: scratch } : mount,
    ),
  }));
}
