import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	COMPOSE_STACK_ENV_MARKER,
	getComposeEnvFilePath,
	getComposeEnvironmentFileContent,
	getCreateEnvFileCommand,
	getEnsureComposeEnvFileCommand,
	getLegacyComposeEnvFilePath,
	getStackComposeExecutionCommand,
} from "@nearzero/server/utils/builders/compose";
import { afterEach, describe, expect, it } from "vitest";

const composeFixture = (env: string, appName = "compose-env-lifecycle") =>
	({
		appName,
		composePath: "docker-compose.yml",
		sourceType: "github",
		composeType: "docker-compose",
		env,
		randomize: false,
		serverId: null,
		environment: {
			env: "ENVIRONMENT_REFERENCE=environment-value",
			project: {
				env: "PROJECT_REFERENCE=project-value",
			},
		},
	}) as never;

const readRepositoryFile = (filePath: string) =>
	readFileSync(path.resolve(process.cwd(), "../..", filePath), "utf8");

const cleanupPaths: string[] = [];

afterEach(() => {
	for (const cleanupPath of cleanupPaths.splice(0)) {
		rmSync(cleanupPath, { recursive: true, force: true });
	}
});

describe("Compose environment lifecycle security", () => {
	it("keeps generated environment material out of the source and build context", () => {
		const compose = composeFixture("SECRET=compose-env-secret-canary");
		const canonicalPath = path.resolve(getComposeEnvFilePath(compose));
		const sourceEnvPath = path.resolve(getLegacyComposeEnvFilePath(compose));
		const projectPath = path.resolve(
			process.cwd(),
			".docker/compose/compose-env-lifecycle/code",
		);

		expect(canonicalPath.startsWith(`${projectPath}${path.sep}`)).toBe(false);
		expect(sourceEnvPath.startsWith(`${projectPath}${path.sep}`)).toBe(true);

		const prepared = getCreateEnvFileCommand(compose);
		expect(prepared.input).toContain("compose-env-secret-canary");
		expect(prepared.command).not.toContain("compose-env-secret-canary");
		expect(prepared.command).toContain(canonicalPath);
		expect(prepared.command).toContain("legacy_env_tracked=true");
		expect(prepared.command).toContain("legacy_env_managed=true");
		expect(prepared.command).toContain(
			'if [ "$legacy_env_preserved" != true ]; then',
		);
	});

	it("promotes only a candidate and rolls back only after promotion", () => {
		const prepared = getCreateEnvFileCommand(
			composeFixture("SECRET=rollback-secret-canary"),
		);
		const command = prepared.command;

		expect(command).toContain("nearzero_env_promoted=false");
		expect(command).toContain('if [ "$nearzero_env_promoted" = true ]; then');
		expect(command).toContain("nearzero_env_had_original=true");
		expect(command).toContain("nearzero_env_promoted=true");
		expect(command.indexOf("nearzero_env_promoted=true")).toBeGreaterThan(
			command.indexOf('mv -f -- "$nearzero_env_candidate" "$env_file"'),
		);
		expect(command).toContain("commit_compose_env()");
		expect(command).toContain("trap rollback_compose_env EXIT");
	});

	it("leaves both canonical and legacy snapshots unchanged after a failed deployment", () => {
		const appName = `compose-env-rollback-${randomUUID()}`;
		const compose = composeFixture("SECRET=new-candidate-value", appName);
		const canonicalPath = getComposeEnvFilePath(compose);
		const legacyPath = getLegacyComposeEnvFilePath(compose);
		const projectDirectory = path.dirname(legacyPath);
		const appDirectory = path.resolve(projectDirectory, "..");
		cleanupPaths.push(appDirectory, canonicalPath);
		mkdirSync(projectDirectory, { recursive: true });
		mkdirSync(path.dirname(canonicalPath), { recursive: true });
		writeFileSync(canonicalPath, 'SECRET="last-successful"\n', { mode: 0o600 });
		writeFileSync(legacyPath, 'SECRET="legacy-last-successful"\n', {
			mode: 0o600,
		});

		const prepared = getCreateEnvFileCommand(compose);
		const result = spawnSync(
			"/bin/sh",
			["-c", `set -e\n${prepared.command}\nfalse`],
			{
				input: prepared.input,
				encoding: "utf8",
			},
		);

		expect(result.status).not.toBe(0);
		expect(readFileSync(canonicalPath, "utf8")).toBe(
			'SECRET="last-successful"\n',
		);
		expect(readFileSync(legacyPath, "utf8")).toBe(
			'SECRET="legacy-last-successful"\n',
		);
		expect(lstatSync(legacyPath).isSymbolicLink()).toBe(false);
	});

	it("never replaces a source-controlled .env file", () => {
		const appName = `compose-env-tracked-${randomUUID()}`;
		const compose = composeFixture("SECRET=runtime-candidate", appName);
		const canonicalPath = getComposeEnvFilePath(compose);
		const legacyPath = getLegacyComposeEnvFilePath(compose);
		const projectDirectory = path.dirname(legacyPath);
		const appDirectory = path.resolve(projectDirectory, "..");
		cleanupPaths.push(appDirectory, canonicalPath);
		mkdirSync(projectDirectory, { recursive: true });
		writeFileSync(legacyPath, 'SECRET="source-controlled"\n', {
			mode: 0o600,
		});
		expect(
			spawnSync("git", ["init", "--quiet"], { cwd: projectDirectory }).status,
		).toBe(0);
		expect(
			spawnSync("git", ["add", ".env"], { cwd: projectDirectory }).status,
		).toBe(0);

		const prepared = getCreateEnvFileCommand(compose);
		const result = spawnSync(
			"/bin/sh",
			["-c", `set -e\n${prepared.command}\ncommit_compose_env`],
			{
				input: prepared.input,
				encoding: "utf8",
			},
		);

		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(legacyPath, "utf8")).toBe(
			'SECRET="source-controlled"\n',
		);
		expect(lstatSync(legacyPath).isSymbolicLink()).toBe(false);
		expect(readFileSync(canonicalPath, "utf8")).toContain("runtime-candidate");
	});

	it("preserves an existing source .env even when it is not tracked", () => {
		const appName = `compose-env-source-${randomUUID()}`;
		const compose = composeFixture("SECRET=runtime-candidate", appName);
		const canonicalPath = getComposeEnvFilePath(compose);
		const legacyPath = getLegacyComposeEnvFilePath(compose);
		const projectDirectory = path.dirname(legacyPath);
		cleanupPaths.push(path.resolve(projectDirectory, ".."), canonicalPath);
		mkdirSync(projectDirectory, { recursive: true });
		writeFileSync(legacyPath, 'SECRET="source-file"\n', { mode: 0o600 });

		const prepared = getCreateEnvFileCommand(compose);
		const result = spawnSync(
			"/bin/sh",
			["-c", `set -e\n${prepared.command}\ncommit_compose_env`],
			{ input: prepared.input, encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(legacyPath, "utf8")).toBe('SECRET="source-file"\n');
		expect(lstatSync(legacyPath).isSymbolicLink()).toBe(false);
	});

	it("migrates only a recognizable legacy Nearzero-managed .env", () => {
		const appName = `compose-env-managed-${randomUUID()}`;
		const compose = composeFixture("SECRET=runtime-candidate", appName);
		const canonicalPath = getComposeEnvFilePath(compose);
		const legacyPath = getLegacyComposeEnvFilePath(compose);
		const projectDirectory = path.dirname(legacyPath);
		cleanupPaths.push(path.resolve(projectDirectory, ".."), canonicalPath);
		mkdirSync(projectDirectory, { recursive: true });
		writeFileSync(
			legacyPath,
			`APP_NAME=${appName}\nCOMPOSE_PROJECT_NAME=${appName}\nSECRET=legacy\n`,
			{ mode: 0o600 },
		);

		const prepared = getCreateEnvFileCommand(compose);
		const result = spawnSync(
			"/bin/sh",
			["-c", `set -e\n${prepared.command}\ncommit_compose_env`],
			{ input: prepared.input, encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(lstatSync(legacyPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(legacyPath, "utf8")).toContain("runtime-candidate");
	});

	it("reuses the last successful snapshot without reading current database env", () => {
		const compose = composeFixture("SECRET=uncommitted-database-secret");
		const prepared = getEnsureComposeEnvFileCommand(compose);

		expect(prepared.input).toBeUndefined();
		expect(prepared.command).not.toContain("uncommitted-database-secret");
		expect(prepared.command).toContain(
			"No successfully deployed Compose environment snapshot exists",
		);
		expect(prepared.command).toContain(
			"Legacy Compose environment is an unexpected symbolic link",
		);
		expect(prepared.command).toContain(
			'if [ "$legacy_env_preserved" = true ]; then',
		);
	});

	it("round-trips dotenv values used by Compose and stack execution", () => {
		const content = getComposeEnvironmentFileContent(
			composeFixture(
				[
					"SPACE=value with spaces",
					'HASH="value#with#hashes"',
					"SPECIAL='quote: \" and dollar: $value'",
					'APOSTROPHE="it\'s preserved"',
					"BACKSLASH='C:\\private\\file'",
					'MULTILINE="line one\\nline two"',
					"PROJECT_VALUE=${{project.PROJECT_REFERENCE}}",
					"ENVIRONMENT_VALUE=${{environment.ENVIRONMENT_REFERENCE}}",
				].join("\n"),
			),
		);
		const markerLine = content.split("\n", 1)[0] ?? "";
		expect(markerLine.startsWith(COMPOSE_STACK_ENV_MARKER)).toBe(true);
		const parsed = JSON.parse(
			Buffer.from(
				markerLine.slice(COMPOSE_STACK_ENV_MARKER.length),
				"base64",
			).toString("utf8"),
		) as Record<string, string>;

		expect(parsed.SPACE).toBe("value with spaces");
		expect(parsed.HASH).toBe("value#with#hashes");
		expect(parsed.SPECIAL).toBe('quote: " and dollar: $value');
		expect(parsed.APOSTROPHE).toBe("it's preserved");
		expect(parsed.BACKSLASH).toBe("C:\\private\\file");
		expect(parsed.MULTILINE).toBe("line one\nline two");
		expect(parsed.PROJECT_VALUE).toBe("project-value");
		expect(parsed.ENVIRONMENT_VALUE).toBe("environment-value");
		expect(content).toContain(`SPECIAL='quote: " and dollar: $value'`);
		expect(content).toContain("APOSTROPHE='it\\'s preserved'");

		const stackCommand = getStackComposeExecutionCommand(
			"stack deploy -c docker-compose.yml compose-env-lifecycle",
			"/etc/nearzero/secrets/compose-env/compose-env-lifecycle.env",
		);
		expect(stackCommand).toContain("NEARZERO_COMPOSE_ENV_FILE=");
		expect(stackCommand).toContain("nearzero-stack-env-v1");
		expect(stackCommand).not.toContain("--env-file=");
	});

	it("loads the protected stack metadata without dotenv expansion", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "nearzero-stack-env-"));
		cleanupPaths.push(directory);
		const binDirectory = path.join(directory, "bin");
		const envPath = path.join(directory, "runtime.env");
		const outputPath = path.join(directory, "observed.json");
		mkdirSync(binDirectory, { recursive: true });
		writeFileSync(
			path.join(binDirectory, "docker"),
			`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({
  special: process.env.SPECIAL,
  apostrophe: process.env.APOSTROPHE,
  multiline: process.env.MULTILINE,
}));
`,
			{ mode: 0o700 },
		);
		chmodSync(path.join(binDirectory, "docker"), 0o700);
		writeFileSync(
			envPath,
			getComposeEnvironmentFileContent(
				composeFixture(
					[
						`OUTPUT_FILE=${outputPath}`,
						"SPECIAL='literal $NOT_EXPANDED and a \"quote\"'",
						'APOSTROPHE="it\'s exact"',
						'MULTILINE="first\\nsecond"',
					].join("\n"),
				),
			),
			{ mode: 0o600 },
		);

		const stackCommand = getStackComposeExecutionCommand(
			"stack deploy -c stack.yml compose-env-lifecycle",
			envPath,
		);
		const result = spawnSync("/bin/sh", ["-c", stackCommand], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
			special: 'literal $NOT_EXPANDED and a "quote"',
			apostrophe: "it's exact",
			multiline: "first\nsecond",
		});
	});

	it("serializes deploy, start, stop, domain reconciliation, and delete", () => {
		const source = readRepositoryFile(
			"packages/server/src/services/compose.ts",
		);

		for (const lifecycleOperation of [
			"deployCompose",
			"rebuildCompose",
			"removeCompose",
			"startCompose",
			"stopCompose",
		]) {
			const operationIndex = source.indexOf(
				`export const ${lifecycleOperation}`,
			);
			expect(operationIndex).toBeGreaterThan(-1);
			expect(source.slice(operationIndex, operationIndex + 500)).toContain(
				"withComposeRoutingMutationLock",
			);
		}
	});
});
