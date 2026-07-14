import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	getMariadbBackupCommand,
	getMongoBackupCommand,
	getMysqlBackupCommand,
	getPostgresBackupCommand,
	getS3Credentials,
	quoteShellArgument,
} from "@nearzero/server/utils/backups/utils";
import { getRestoreCommand } from "@nearzero/server/utils/restore/utils";
import { describe, expect, test } from "vitest";

const serverSource = (relativePath: string) =>
	readFileSync(
		path.resolve(process.cwd(), `../../packages/server/src/${relativePath}`),
		"utf8",
	);

const platformSource = (relativePath: string) =>
	readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("backup secret execution boundary", () => {
	test("quotes every persisted S3 value and rejects legacy shell fragments", () => {
		const accessKey = "access key'with quote";
		const secretAccessKey = "secret; $(touch should-not-run)";
		const flags = getS3Credentials({
			accessKey,
			secretAccessKey,
			region: "auto",
			endpoint: "https://objects.example.test/path?x=1&y=2",
			provider: "Other",
			additionalFlags: ["--s3-sign-accept-encoding=false"],
		});
		const probe = spawnSync(
			"/bin/bash",
			["-c", `set -- ${flags.join(" ")}; printf '%s\n' "$@"`],
			{ encoding: "utf8" },
		);
		expect(probe.status, probe.stderr).toBe(0);
		expect(probe.stdout).toContain(`--s3-access-key-id=${accessKey}`);
		expect(probe.stdout).toContain(`--s3-secret-access-key=${secretAccessKey}`);
		expect(probe.stdout).toContain("--s3-sign-accept-encoding=false");
		expect(() =>
			getS3Credentials({
				accessKey: "key",
				secretAccessKey: "secret",
				region: "auto",
				endpoint: "https://objects.example.test",
				provider: "Other",
				additionalFlags: ["--retries=1; touch /tmp/injected"],
			}),
		).toThrow("Invalid flag format");
		expect(quoteShellArgument("a'b")).toBe("'a'\\''b'");
	});

	test("routes every secret-bearing backup command through stdin", () => {
		const commandSources = [
			"utils/backups/compose.ts",
			"utils/backups/index.ts",
			"utils/backups/libsql.ts",
			"utils/backups/mariadb.ts",
			"utils/backups/mongo.ts",
			"utils/backups/mysql.ts",
			"utils/backups/postgres.ts",
			"utils/backups/web-server.ts",
			"utils/restore/compose.ts",
			"utils/restore/libsql.ts",
			"utils/restore/mariadb.ts",
			"utils/restore/mongo.ts",
			"utils/restore/mysql.ts",
			"utils/restore/postgres.ts",
			"utils/restore/web-server.ts",
			"utils/volume-backups/utils.ts",
		];
		for (const file of commandSources) {
			const source = serverSource(file);
			expect(source, file).toContain("executeSensitiveShellScript({");
			expect(source, file).toContain("sensitiveValues:");
			expect(source, file).not.toContain("Executing command: ${");
		}

		for (const file of [
			"server/api/routers/backup.ts",
			"server/api/routers/destination.ts",
			"server/api/routers/volume-backups.ts",
		]) {
			const source = platformSource(file);
			expect(source, file).toContain("executeSensitiveShellScript({");
			expect(source, file).toContain("sensitiveValues:");
		}
	});

	test("generates valid shell for quoted backup and restore credentials", () => {
		const commands = [
			getPostgresBackupCommand("db'name", "user'name"),
			getMariadbBackupCommand("db'name", "user'name", "pass'word"),
			getMysqlBackupCommand("db'name", "pass'word"),
			getMongoBackupCommand("db'name", "user'name", "pass'word"),
			getRestoreCommand({
				appName: "mysql-service",
				type: "mysql",
				restoreType: "database",
				credentials: {
					database: "db'name",
					databasePassword: "pass'word",
				},
				rcloneCommand: "printf backup-data",
			}),
			getRestoreCommand({
				appName: "mongo-service",
				type: "mongo",
				restoreType: "database",
				credentials: {
					database: "db'name",
					databaseUser: "user'name",
					databasePassword: "pass'word",
				},
				rcloneCommand: "printf backup-data",
				backupFile: "safe.bson.gz",
			}),
		];
		for (const command of commands) {
			const probe = spawnSync("/bin/bash", ["-n"], {
				input: `CONTAINER_ID=container\n${command}`,
				encoding: "utf8",
			});
			expect(probe.status, probe.stderr).toBe(0);
		}
	});

	test("does not serialize stored destination or backup credentials", () => {
		const destinationRouter = platformSource(
			"server/api/routers/destination.ts",
		);
		expect(destinationRouter).toContain("toPublicDestination(destination)");
		expect(destinationRouter).toContain("rows.map(toPublicDestination)");

		const backupRouter = platformSource("server/api/routers/backup.ts");
		expect(backupRouter).toContain("return toPublicBackup(backup)");
		expect(backupRouter).toContain('"secretAccessKey"');
		expect(backupRouter).toContain('"databaseRootPassword"');

		const volumeRouter = platformSource("server/api/routers/volume-backups.ts");
		expect(volumeRouter).toContain("rows.map(toPublicVolumeBackup)");
		expect(volumeRouter).toContain("return toPublicVolumeBackup(vb)");
	});
});
