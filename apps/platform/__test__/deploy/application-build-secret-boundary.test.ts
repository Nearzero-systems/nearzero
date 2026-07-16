import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBuildCommand } from "@nearzero/server/utils/builders";
import {
	getRailpackBuildCommand,
	getRailpackPrepareCommand,
} from "@nearzero/server/utils/builders/railpack";
import {
	prepareBuildInput,
	PROTECTED_BUILD_MATERIAL_JQ_FILTER,
	resolveImmutableBuilderImage,
	wrapBuildCommand,
} from "@nearzero/server/utils/builders/utils";
import { describe, expect, it } from "vitest";

const jqProtectedMaterialAbsent = (artifact: unknown, secret: string) => {
	const tempDirectory = mkdtempSync(
		path.join(os.tmpdir(), "nearzero-protected-material-"),
	);
	const artifactPath = path.join(tempDirectory, "artifact.json");
	const secretPath = path.join(tempDirectory, "secret");
	try {
		writeFileSync(artifactPath, JSON.stringify(artifact));
		writeFileSync(secretPath, secret);
		execFileSync(
			"jq",
			["-e", "--rawfile", "nearzeroSecret", secretPath, PROTECTED_BUILD_MATERIAL_JQ_FILTER, artifactPath],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
};

const runtimeSecret = "runtime-canary-'-$-7f0d3f41";
const dockerSecret = 'docker-canary-"-e2ab85d0';
const publicBuildArgument = "public-build-value-93b76a1e";

const createApplication = (buildType: string) =>
	({
		applicationId: "app-build-secret-test",
		appName: "build-secret-test",
		sourceType: "github",
		buildType,
		buildPath: "/",
		buildExecutionTarget: "nearzero_host",
		serverId: null,
		dockerfile: "Dockerfile",
		dockerContextPath: null,
		dockerBuildStage: null,
		publishDirectory: buildType === "static" ? "dist" : null,
		isStaticSpa: buildType === "static",
		cleanCache: false,
		createEnvFile: true,
		env: `RUNTIME_TOKEN=${runtimeSecret}`,
		buildSecrets: `DOCKER_TOKEN=${dockerSecret}`,
		buildArgs: `PUBLIC_VERSION=${publicBuildArgument}`,
		herokuVersion: "24",
		environment: {
			env: "",
			project: { env: "" },
		},
		registry: null,
		rollbackRegistry: null,
	}) as any;

describe("application build secret boundary", () => {
	for (const buildType of [
		"dockerfile",
		"nixpacks",
		"railpack",
		"heroku_buildpacks",
		"paketo_buildpacks",
		"static",
	]) {
		it(`${buildType} keeps values in phase stdin rather than generated commands`, async () => {
			const prepared = await getBuildCommand(createApplication(buildType), {
				buildServerId: null,
				buildType: buildType as any,
				railpackPrepared: buildType === "railpack",
			});

			expect(prepared.script).not.toContain(runtimeSecret);
			expect(prepared.script).not.toContain(dockerSecret);
			expect(prepared.script).not.toContain(publicBuildArgument);
			expect(prepared.script).not.toContain(
				Buffer.from(runtimeSecret).toString("base64"),
			);
			expect(prepared.script).not.toContain(
				Buffer.from(dockerSecret).toString("base64"),
			);
			expect(prepared.input).toContain(
				Buffer.from(runtimeSecret).toString("base64"),
			);
			expect(prepared.input).toContain(
				Buffer.from(dockerSecret).toString("base64"),
			);
			expect(prepared.sensitiveValues).toContain(runtimeSecret);
			expect(prepared.sensitiveValues).toContain(dockerSecret);
			expect(prepared.sensitiveValues).not.toContain(publicBuildArgument);
			expect(prepared.script).not.toMatch(/>\s*["']?[^\n]*\.env["']?/);
			expect(prepared.script).not.toMatch(/--env\s+[^\s=]+=runtime-canary/);
			expect(prepared.script).not.toMatch(/export\s+\w+=runtime-canary/);
		});
	}

	it("ignores short common env values in protected-material scans", () => {
		const artifact = {
			providers: ["node"],
			phases: {
				setup: { nixPkgs: ["nodejs_22", "bun"] },
				install: { cmds: ["bun install --frozen-lockfile"] },
			},
		};
		expect(jqProtectedMaterialAbsent(artifact, "node")).toBe(true);
		expect(jqProtectedMaterialAbsent(artifact, "production")).toBe(true);
		expect(jqProtectedMaterialAbsent(artifact, "development")).toBe(true);
		expect(jqProtectedMaterialAbsent(artifact, "localhost")).toBe(true);
		expect(jqProtectedMaterialAbsent(artifact, "true")).toBe(true);
		expect(
			jqProtectedMaterialAbsent(artifact, "super-secret-token-value"),
		).toBe(true);
		expect(
			jqProtectedMaterialAbsent(
				{ cmd: "echo super-secret-token-value" },
				"super-secret-token-value",
			),
		).toBe(false);
		expect(
			jqProtectedMaterialAbsent(
				{ cmd: "DATABASE_URL=postgres://u:embedded-credential-abc123@db/app" },
				"embedded-credential-abc123",
			),
		).toBe(false);
	});

	it("skips public framework env keys during protected-material scans", () => {
		const application = createApplication("railpack");
		application.env = [
			"NODE_ENV=development",
			"NEXT_PUBLIC_APP_URL=http://localhost:3000",
			"DATABASE_URL=postgres://u:super-secret-db-token@db/app",
		].join("\n");
		const buildInput = prepareBuildInput(application);
		const script = wrapBuildCommand(`
nz_should_scan_protected_build_material NODE_ENV && exit 11
nz_should_scan_protected_build_material NEXT_PUBLIC_APP_URL && exit 12
nz_should_scan_protected_build_material DATABASE_URL || exit 13
`);
		execFileSync("bash", ["-Eeuo", "pipefail", "-c", script], {
			input: buildInput.input,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("uses builder-native non-argv secret channels", async () => {
		const docker = await getBuildCommand(createApplication("dockerfile"), {
			buildServerId: null,
			buildType: "dockerfile",
		});
		expect(docker.script).toContain("type=file,id=$NZ_BUILD_KEY,src=");
		expect(docker.script).toContain(
			"type=file,id=nearzero-build-env,src=$NZ_BUILD_ENV_EXPORT_FILE",
		);
		expect(docker.script).toContain('--build-arg "$NZ_BUILD_KEY"');
		expect(docker.script).toContain(
			'if [ -s "$NZ_BUILD_SECRET_KEYS_FILE" ] || [ -s "$NZ_BUILD_ENV_KEYS_FILE" ]',
		);

		const railpack = await getBuildCommand(createApplication("railpack"), {
			buildServerId: null,
			buildType: "railpack",
			railpackPrepared: true,
		});
		const railpackPrepare = getRailpackPrepareCommand(
			createApplication("railpack"),
			null,
		);
		expect(railpackPrepare).toContain(".secrets =");
		expect(railpackPrepare).toContain("--rawfile nearzeroSecret");
		expect(railpackPrepare).toContain("**/.env.*");
		expect(railpack.script).toContain(
			"type=file,id=$NZ_BUILD_KEY,src=$NZ_BUILD_ENV_DIR/$NZ_BUILD_KEY",
		);
		expect(railpack.script).toContain("--rawfile nearzeroSecret");
		expect(railpack.script).toContain(
			'rm -f "$NZ_RAILPACK_PLAN" "$NZ_RAILPACK_INFO"',
		);

		const nixpacks = await getBuildCommand(createApplication("nixpacks"), {
			buildServerId: null,
			buildType: "nixpacks",
		});
		expect(nixpacks.script).toContain("nearzeroSecretKeys");
		expect(nixpacks.script).toContain("nixpacks-docker-used");
		expect(nixpacks.script).toContain(
			"--mount=type=secret,id=nearzero-build-env",
		);
		expect(nixpacks.script).toContain(
			'NZ_NIXPACKS_PRIVATE_DIR="$NZ_BUILD_MATERIAL_DIR"',
		);
		expect(nixpacks.script).toContain(
			'NZ_RAW_PLAN="$NZ_NIXPACKS_PRIVATE_DIR/nixpacks-plan.raw.json"',
		);
		expect(nixpacks.script).toContain("--rawfile nearzeroSecret");
		expect(nixpacks.script).toContain("**/.env.*");
		expect(nixpacks.script).toContain(
			'NZ_BUILD_LOG="$NZ_NIXPACKS_PRIVATE_DIR/nixpacks-build.log"',
		);

		for (const buildType of [
			"heroku_buildpacks",
			"paketo_buildpacks",
		] as const) {
			const pack = await getBuildCommand(createApplication(buildType), {
				buildServerId: null,
				buildType,
			});
			expect(pack.script).toContain(
				'NZ_PACK_ARGS+=(--env-file "$NZ_BUILD_ENV_KEYS_FILE")',
			);
			expect(pack.script).toContain("NZ_PACK_ARGS+=(--clear-cache)");
			expect(pack.script).not.toContain('--env "$NZ_BUILD_KEY=');
		}
	});

	it("accepts only digest-pinned Pack builder overrides", () => {
		const variable = "NEARZERO_TEST_PACK_BUILDER_IMAGE";
		const original = process.env[variable];
		const pinned = `registry.example.com/team/builder:24@sha256:${"a".repeat(64)}`;

		try {
			process.env[variable] = pinned;
			expect(resolveImmutableBuilderImage(variable, "fallback:latest")).toBe(
				pinned,
			);

			process.env[variable] = "registry.example.com/team/builder:latest";
			expect(() =>
				resolveImmutableBuilderImage(variable, "fallback:latest"),
			).toThrow(/pinned by sha256 digest/);

			process.env[variable] = `${pinned};touch-/tmp/nearzero-builder-injection`;
			expect(() =>
				resolveImmutableBuilderImage(variable, "fallback:latest"),
			).toThrow(/pinned by sha256 digest/);
		} finally {
			if (original === undefined) delete process.env[variable];
			else process.env[variable] = original;
		}
	});

	it("rejects a mutable Railpack frontend override", () => {
		const variable = "NEARZERO_RAILPACK_FRONTEND_IMAGE";
		const original = process.env[variable];
		const pinned = `ghcr.io/railwayapp/railpack-frontend:v0.15.4@sha256:${"e".repeat(64)}`;

		try {
			process.env[variable] = pinned;
			expect(
				getRailpackBuildCommand(createApplication("railpack"), null).replaceAll(
					"\\",
					"",
				),
			).toContain(`BUILDKIT_SYNTAX=${pinned}`);

			process.env[variable] = "ghcr.io/railwayapp/railpack-frontend:v0.15.4";
			expect(() =>
				getRailpackPrepareCommand(createApplication("railpack"), null),
			).toThrow(/pinned by sha256 digest/);
		} finally {
			if (original === undefined) delete process.env[variable];
			else process.env[variable] = original;
		}
	});

	it("materializes mode-0600 files and removes the retry-scoped directory", () => {
		const tempDirectory = mkdtempSync(
			path.join(os.tmpdir(), "nearzero-build-boundary-test-"),
		);
		const resultPath = path.join(tempDirectory, "result");
		const application = createApplication("dockerfile");
		const buildInput = prepareBuildInput(application);
		const script = wrapBuildCommand(`
nz_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
test "$(nz_mode "$NZ_BUILD_ENV_DIR/RUNTIME_TOKEN")" = "600"
test "$(nz_mode "$NZ_BUILD_SECRET_DIR/DOCKER_TOKEN")" = "600"
test "$(nz_mode "$NZ_BUILD_ARGUMENT_DIR/PUBLIC_VERSION")" = "600"
test "$(nz_mode "$NZ_BUILD_MATERIAL_DIR")" = "700"
printf '%s' "$NZ_BUILD_MATERIAL_DIR" > ${JSON.stringify(resultPath)}
`);

		try {
			execFileSync("bash", ["-Eeuo", "pipefail", "-c", script], {
				input: buildInput.input,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const materialDirectory = readFileSync(resultPath, "utf8");
			expect(materialDirectory).toContain("nearzero-build-material.");
			expect(existsSync(materialDirectory)).toBe(false);
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("emits a POSIX-safe export file without changing quotes, dollars, or newlines", () => {
		const tempDirectory = mkdtempSync(
			path.join(os.tmpdir(), "nearzero-build-posix-export-test-"),
		);
		const loadedPath = path.join(tempDirectory, "loaded");
		const sourcedPath = path.join(tempDirectory, "sourced");
		const complexValue = "single-'-$HOME-first\nsecond line\n";
		const application = createApplication("dockerfile");
		application.env = `RUNTIME_TOKEN="${complexValue}"`;
		const buildInput = prepareBuildInput(application);
		const script = wrapBuildCommand(`
nz_load_runtime_environment
printf '%s' "$RUNTIME_TOKEN" > ${JSON.stringify(loadedPath)}
/bin/sh -c '. "$1"; printf "%s" "$RUNTIME_TOKEN" > "$2"' sh "$NZ_BUILD_ENV_EXPORT_FILE" ${JSON.stringify(sourcedPath)}
`);

		try {
			execFileSync("bash", ["-Eeuo", "pipefail", "-c", script], {
				input: buildInput.input,
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(readFileSync(loadedPath, "utf8")).toBe(complexValue);
			expect(readFileSync(sourcedPath, "utf8")).toBe(complexValue);
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});
});
