import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	buildMariaDbPasswordChangeScript,
	buildMongoPasswordChangeScript,
	buildMySqlPasswordChangeScript,
	buildPostgresPasswordChangeScript,
	buildRedisPasswordChangeScript,
} from "@nearzero/server/utils/databases/change-password";
import {
	ExecError,
	executeSensitiveShellScript,
	SENSITIVE_SHELL_COMMAND,
} from "@nearzero/server/utils/process/execAsync";
import { describe, expect, test } from "vitest";

const oldPassword = "OLD_PASSWORD_CANARY_123";
const newPassword = "NEW_PASSWORD_CANARY_456";

const passwordChangeScripts = () => ({
	mariadb: buildMariaDbPasswordChangeScript({
		appName: "mariadb-example",
		rootPassword: oldPassword,
		targetUser: "application_user",
		newPassword,
	}),
	mysql: buildMySqlPasswordChangeScript({
		appName: "mysql-example",
		rootPassword: oldPassword,
		targetUser: "application_user",
		newPassword,
	}),
	mongo: buildMongoPasswordChangeScript({
		appName: "mongo-example",
		databaseUser: "application_user",
		oldPassword,
		newPassword,
	}),
	redis: buildRedisPasswordChangeScript({
		appName: "redis-example",
		oldPassword,
		newPassword,
	}),
	postgres: buildPostgresPasswordChangeScript({
		appName: "postgres-example",
		databaseUser: "application_user",
		newPassword,
	}),
});

describe("database password execution boundary", () => {
	test("keeps every secret-bearing script out of command metadata", () => {
		const processSource = readFileSync(
			path.resolve(
				process.cwd(),
				"../../packages/server/src/utils/process/execAsync.ts",
			),
			"utf8",
		);

		expect(SENSITIVE_SHELL_COMMAND).toBe("bash -se");
		expect(processSource).toContain(
			"execAsyncRemote(serverId, SENSITIVE_SHELL_COMMAND, undefined, {",
		);
		expect(processSource).toContain("input: script");
		expect(processSource).toContain(
			'execFileAsync("/bin/bash", ["-se"], { input: script })',
		);
		expect(processSource).not.toContain("execAsyncRemote(serverId, script");
	});

	test("wires all five routers through the sensitive stdin helper", () => {
		for (const router of ["mariadb", "mysql", "mongo", "redis", "postgres"]) {
			const source = readFileSync(
				path.resolve(process.cwd(), `server/api/routers/${router}.ts`),
				"utf8",
			);
			const passwordMutation = source.slice(
				source.indexOf("changePassword:"),
				source.indexOf("\n\tmove:", source.indexOf("changePassword:")),
			);

			expect(passwordMutation).toContain("executeSensitiveShellScript({");
			expect(passwordMutation).toContain("sensitiveValues:");
			expect(passwordMutation).not.toContain("execAsync(");
			expect(passwordMutation).not.toContain("execAsyncRemote(");
			expect(passwordMutation).not.toContain("const command =");
		}
	});

	test("never places old or new credentials in database client arguments", () => {
		for (const script of Object.values(passwordChangeScripts())) {
			const processLines = script
				.split("\n")
				.filter((line) =>
					/(?:docker exec|\bmysql\b|\bmariadb\b|\bmongosh\b|\bredis-cli\b|\bpsql\b)/.test(
						line,
					),
				)
				.join("\n");

			expect(processLines).not.toContain(oldPassword);
			expect(processLines).not.toContain(newPassword);
		}

		const scripts = passwordChangeScripts();
		expect(scripts.mariadb).not.toMatch(/mariadb[^\n]*(?:-p|--password)/);
		expect(scripts.mysql).not.toMatch(/mysql[^\n]*(?:-p|--password)/);
		expect(scripts.mongo).not.toMatch(/mongosh[^\n]*(?:-p|--password|--eval)/);
		expect(scripts.redis).not.toMatch(/redis-cli[^\n]*(?:\s-a\s|--pass)/);
		expect(scripts.redis).not.toContain("REDISCLI_AUTH");
		expect(scripts.redis).toContain("redis-cli --pipe --pipe-timeout 10");
		expect(scripts.postgres).not.toMatch(/psql[^\n]*\s-c\s/);
	});

	test("keeps the Redis startup password out of the service command spec", () => {
		const source = readFileSync(
			path.resolve(
				process.cwd(),
				"../../packages/server/src/utils/databases/redis.ts",
			),
			"utf8",
		);
		expect(source).toContain('redis-server --requirepass "$REDIS_PASSWORD"');
		expect(source).not.toContain(
			"redis-server --requirepass ${databasePassword}",
		);
	});

	test("generates syntactically valid Bash and quotes SQL identifiers and values", () => {
		for (const script of Object.values(passwordChangeScripts())) {
			const result = spawnSync("bash", ["-n"], {
				input: script,
				encoding: "utf8",
			});
			expect(result.status, result.stderr).toBe(0);
		}

		expect(
			buildPostgresPasswordChangeScript({
				appName: "postgres-example",
				databaseUser: 'user"name',
				newPassword: "new'password",
			}),
		).toContain(`ALTER USER "user""name" WITH PASSWORD 'new''password';`);
		expect(
			buildMySqlPasswordChangeScript({
				appName: "mysql-example",
				rootPassword: oldPassword,
				targetUser: "user'name",
				newPassword: "new'password",
			}),
		).toContain(`ALTER USER 'user''name'@'%' IDENTIFIED BY 'new''password';`);
	});

	test("passes scripts through stdin and redacts success and failure output", async () => {
		const successSecret = "SUCCESS_OUTPUT_CANARY";
		const success = await executeSensitiveShellScript({
			script: `printf '%s' '${successSecret}'`,
			sensitiveValues: [successSecret],
		});
		expect(success.stdout).toBe("[REDACTED]");

		const failureSecret = "FAILURE_OUTPUT_CANARY";
		const failureScriptMarker = "ALTER USER internal_script_marker";
		let thrown: unknown;
		try {
			await executeSensitiveShellScript({
				script: `printf '%s: %s' '${failureScriptMarker}' '${failureSecret}' >&2\nexit 9`,
				sensitiveValues: [failureSecret],
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ExecError);
		const execError = thrown as ExecError;
		expect(execError.command).toBe(SENSITIVE_SHELL_COMMAND);
		expect(execError.exitCode).toBeUndefined();
		expect(execError.message).toBe("Sensitive shell script failed");
		expect(execError.stdout).toBeUndefined();
		expect(execError.stderr).toBeUndefined();
		expect(execError.originalError).toBeUndefined();
		expect(JSON.stringify(execError)).not.toContain(failureSecret);
		expect(execError.getDetailedMessage()).not.toContain(failureScriptMarker);
	});
});
