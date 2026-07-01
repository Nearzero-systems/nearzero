import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import {
	getNixpacksCommand,
	NIXPACKS_PLAN_NORMALIZATION_FILTER,
	NIXPACKS_VERSIONED_PACKAGE_MANAGER_NIX_PATTERN,
} from "@nearzero/server/utils/builders/nixpacks";
import { describe, expect, it } from "vitest";

const createApplication = (overrides = {}) =>
	({
		applicationId: "app-1",
		appName: "hypeframe-paper-8stkv8",
		sourceType: "github",
		buildType: "nixpacks",
		buildPath: "/apps/web",
		buildExecutionTarget: "deploy_server",
		serverId: "deploy-server-1",
		publishDirectory: null,
		cleanCache: false,
		env: "",
		environment: {
			env: "",
			project: {
				env: "",
			},
		},
		...overrides,
	}) as any;

const executeWithFakeNixpacks = ({
	packageJson,
	plan,
}: {
	packageJson: Record<string, unknown>;
	plan: Record<string, unknown>;
}) => {
	const tempDirectory = mkdtempSync(
		path.join(os.tmpdir(), "nearzero-nixpacks-test-"),
	);
	const appName = `nixpacks-pm-${path.basename(tempDirectory)}`;
	const applicationDirectory = path.join(
		paths(false).APPLICATIONS_PATH,
		appName,
	);
	const sourceDirectory = path.join(applicationDirectory, "code");
	const fakeBinDirectory = path.join(tempDirectory, "bin");
	const fakePlanPath = path.join(tempDirectory, "raw-plan.json");
	const capturedPlanPath = path.join(tempDirectory, "captured-plan.json");
	const fakeNixpacksPath = path.join(fakeBinDirectory, "nixpacks");

	mkdirSync(sourceDirectory, { recursive: true });
	mkdirSync(fakeBinDirectory, { recursive: true });
	writeFileSync(
		path.join(sourceDirectory, "package.json"),
		JSON.stringify(packageJson),
	);
	writeFileSync(fakePlanPath, JSON.stringify(plan));
	writeFileSync(
		fakeNixpacksPath,
		`#!/usr/bin/env bash
set -e
if [ "$1" = "plan" ]; then
	cat "$NZ_FAKE_PLAN"
	exit 0
fi
if [ "$1" = "build" ]; then
	while [ "$#" -gt 0 ]; do
		if [ "$1" = "--config" ]; then
			cp "$2" "$NZ_CAPTURED_PLAN"
			exit 0
		fi
		shift
	done
fi
echo "Unexpected fake nixpacks invocation: $*" >&2
exit 2
`,
	);
	chmodSync(fakeNixpacksPath, 0o755);

	try {
		const command = getNixpacksCommand(
			createApplication({
				appName,
				buildPath: "",
				buildExecutionTarget: "nearzero_host",
				serverId: null,
			}),
			null,
		);
		execFileSync("bash", ["-c", command], {
			env: {
				...process.env,
				PATH: `${fakeBinDirectory}:${process.env.PATH ?? ""}`,
				NZ_FAKE_PLAN: fakePlanPath,
				NZ_CAPTURED_PLAN: capturedPlanPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return JSON.parse(readFileSync(capturedPlanPath, "utf8"));
	} finally {
		rmSync(applicationDirectory, { recursive: true, force: true });
		rmSync(tempDirectory, { recursive: true, force: true });
	}
};

describe("getNixpacksCommand", () => {
	it("generates bash that is syntactically valid before deployment", () => {
		const command = getNixpacksCommand(createApplication());

		expect(() =>
			execFileSync("bash", ["-n"], {
				input: command,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		).not.toThrow();
	});

	it("normalizes an isolated staging copy instead of mutating the source checkout", () => {
		const command = getNixpacksCommand(createApplication());

		expect(command).toContain("NZ_NIXPACKS_ORIGINAL_SOURCE_DIR=");
		expect(command).toContain(
			'NZ_NIXPACKS_SOURCE_DIR="$(mktemp -d "$NZ_NIXPACKS_STAGE_PARENT/.nearzero-nixpacks-stage.XXXXXX")"',
		);
		expect(command).toContain(
			'cp -a "$NZ_NIXPACKS_ORIGINAL_SOURCE_DIR/." "$NZ_NIXPACKS_SOURCE_DIR/"',
		);
		expect(command).toContain("trap nz_cleanup_nixpacks_stage EXIT");
		expect(command).toContain(
			'NZ_NIXPACKS_REQUESTED_DIR="$NZ_NIXPACKS_SOURCE_DIR/$NZ_NIXPACKS_RELATIVE_BUILD_PATH"',
		);
		expect(command).not.toContain(
			`NZ_NIXPACKS_SOURCE_DIR=/etc/nearzero/applications/hypeframe-paper-8stkv8/code`,
		);
	});

	it("passes workspace install/start commands and uses Turbo when available", () => {
		const command = getNixpacksCommand(createApplication());

		expect(command).toContain(
			'NZ_WORKSPACE_INSTALL_CMD="bun install --frozen-lockfile"',
		);
		expect(command).toContain(
			'NZ_WORKSPACE_BUILD_CMD="cd $NZ_WORKSPACE_REL_DIR && bun run build"',
		);
		expect(command).toContain(
			'NZ_WORKSPACE_START_CMD="cd $NZ_WORKSPACE_REL_DIR && bun run start"',
		);
		expect(command).toContain('--install-cmd "$NZ_WORKSPACE_INSTALL_CMD"');
		expect(command).toContain('--build-cmd "$NZ_WORKSPACE_BUILD_CMD"');
		expect(command).toContain('--start-cmd "$NZ_WORKSPACE_START_CMD"');
		expect(command).toContain("turbo.json");
		expect(command).toContain(
			"bunx turbo run build --filter=$NZ_WORKSPACE_PACKAGE...",
		);
		expect(command).toContain("Detected Turbo workspace pipeline");
		expect(command).not.toContain("export NIXPACKS_START_CMD");
	});

	it("derives the Node.js major version from package.json engines.node", () => {
		const command = getNixpacksCommand(createApplication());

		expect(command).toContain("NIXPACKS_NODE_VERSION");
		expect(command).toContain("engines.node");
	});

	it("forwards the resolved Node version to nixpacks via --env (not just an ambient export)", () => {
		const command = getNixpacksCommand(createApplication());

		// Nixpacks only honors NIXPACKS_NODE_VERSION when passed through --env.
		expect(command).toContain('--env NIXPACKS_NODE_VERSION="$NZ_NODE_VERSION"');
		expect(command).not.toContain("export NIXPACKS_NODE_VERSION");
	});

	it("checks .nvmrc/.node-version and defaults to the current LTS when no version is declared", () => {
		const command = getNixpacksCommand(createApplication());

		expect(command).toContain(".nvmrc");
		expect(command).toContain(".node-version");
		// Defaults to Node 22 LTS; archive selection is retried separately.
		expect(command).toContain('NZ_DEFAULT_NODE_MAJOR="22"');
		expect(command).toContain('NZ_NODE_VERSION="$NZ_DEFAULT_NODE_MAJOR"');
	});

	it("selects the highest major from an engines range and bumps open-ended ranges to LTS", () => {
		const command = getNixpacksCommand(createApplication());

		// Highest major wins for multi-major ranges like "^20 || ^22 || >=24".
		expect(command).toContain("sort -rn");
		// Open-ended lower bounds (>=, >) prefer the current LTS default.
		expect(command).toContain('-lt "$NZ_DEFAULT_NODE_MAJOR"');
	});

	it("selects a compatible nixpkgs archive per build attempt", () => {
		const command = getNixpacksCommand(createApplication());

		// Nixpacks only accepts archive overrides via nixpacks.toml, so Nearzero
		// writes/removes its own generated file per attempt.
		expect(command).toContain("nixpkgsArchive");
		expect(command).toContain("nixpacks.toml");
		expect(command).toContain(
			"Nixpacks archive strategy: default Nixpacks archive.",
		);
		expect(command).toContain("Nixpacks archive strategy: modern archive");
		expect(command).toContain("Generated by Nearzero. Safe to rewrite.");
		expect(command).toContain("NIXPACKS_NIXPKGS_ARCHIVE");
		expect(command).toContain("leaving nixpacks.toml/json untouched");
	});

	it("self-heals nixpkgs provider drift by switching archives", () => {
		const command = getNixpacksCommand(createApplication());

		expect(command).toContain("undefined variable");
		expect(command).toContain("retrying with Nixpacks default archive");
		expect(command).toContain("retrying with modern nixpkgs archive");
		expect(command).toContain("No compatible nixpkgs archive was found");
	});

	it("self-heals by retrying with the Node version required by the engine error", () => {
		const command = getNixpacksCommand(createApplication());

		// Retries up to a fixed number of attempts.
		expect(command).toContain("NZ_MAX_ATTEMPTS");
		// Parses the required version out of the "Expected version ..." engine error.
		expect(command).toContain("Expected version");
		// Bumps NIXPACKS_NODE_VERSION and retries with the satisfying major.
		expect(command).toContain("retrying with Node.js v");
		expect(command).toContain('NZ_NODE_VERSION="$NZ_NEW_MAJOR"');
	});

	it("resolves mixed package-manager toolchains before Nixpacks plans the image", () => {
		const command = getNixpacksCommand(createApplication());

		// A repo can install with yarn/pnpm but run nested scripts that shell out to
		// bun. Scan packageManager, lockfiles, and scripts across the repo package graph.
		expect(command).toContain(
			"Resolve the complete package-manager toolchain",
		);
		expect(command).toContain("packageManager declares");
		expect(command).toContain("package script invokes bun/bunx");
		expect(command).toContain('find "$NZ_NIXPACKS_SOURCE_DIR" -maxdepth 5');
		expect(command).toContain("NZ_PACKAGE_JSON_LIST_FILE");
		expect(command).not.toContain("done <<NZ_PACKAGE_JSON_LIST");
		expect(command).toContain("nz_refresh_pm_bootstrap");
		expect(command).toContain(
			"npm install --global --force corepack@0.31.0",
		);
		expect(command).toContain(
			"corepack prepare $NZ_YARN_INSTALL_SPEC --activate",
		);
		expect(command).toContain(
			"corepack prepare $NZ_PNPM_INSTALL_SPEC --activate",
		);
		expect(command).toContain(
			"generated Nixpacks plan requires yarn",
		);
		expect(command).toContain(
			"generated Nixpacks plan requires pnpm",
		);
		expect(command).toContain(
			"generated Nixpacks plan requires bun",
		);
		expect(command).toContain("NZ_REMOVE_BUN_JSON=false");
		expect(command).toContain("NZ_REMOVE_BUN_JSON=true");
		expect(command).toContain(
			'--argjson removeBun "$NZ_REMOVE_BUN_JSON"',
		);
		expect(command).toContain(
			"npm install --global --prefix /usr/local $NZ_BUN_INSTALL_SPEC",
		);
		expect(command).toContain("ln -sf /usr/local/bin/bun /usr/bin/bun");
		expect(command).toContain("ln -sf /usr/local/bin/bunx /usr/bin/bunx");
		expect(command).toContain("hash -r && bun --version");
		expect(command).not.toContain("NZ_EXTRA_PKGS");
		expect(command).toContain("Build tool resolution:");
		expect(command).toContain("package script invokes yarn");
	});

	it("self-heals by retrying when a build script reports a missing package-manager binary", () => {
		const command = getNixpacksCommand(createApplication());

		expect(command).toContain("Detected missing build tool");
		expect(command).toContain('bunx) NZ_MISSING_TOOL="bun"');
		expect(command).toContain('pnpx) NZ_MISSING_TOOL="pnpm"');
		expect(command).toContain(
			"regenerating the frozen plan with a $NZ_MISSING_TOOL bootstrap",
		);
		expect(command).toContain("nz_refresh_pm_bootstrap");
		expect(command).not.toContain("nz_add_extra_pkg");
	});

	it("freezes and normalizes the generated plan before every build attempt", () => {
		const command = getNixpacksCommand(createApplication());

		expect(command).toContain("nixpacks plan");
		expect(command).toContain("--format json");
		expect(command).toContain("nz_generate_frozen_nixpacks_plan");
		expect(command).toContain(".nearzero-nixpacks-plan.raw.json");
		expect(command).toContain(".nearzero-nixpacks-plan.json");
		expect(command).toContain('--config ".nearzero-nixpacks-plan.json"');
		expect(command).toContain(".providers = []");
		expect(command).not.toContain("workspaceCommand");
	});

	it("removes arbitrary versioned npm, Yarn, and pnpm Nix aliases from frozen plans", () => {
		const plan = {
			providers: ["node"],
			phases: {
				setup: {
					nixPkgs: [
						"nodejs_22",
						"npm-9_x",
						"npm-19_x",
						"npm_27",
						"npm",
						"yarn-1_x",
						"yarn-99_x",
						"yarn_4",
						"yarn",
						"pnpm-10_x",
						"pnpm-42_x",
						"pnpm_11",
						"pnpm",
						"gcc",
						"bun",
					],
					cmds: ["npm i -g corepack@0.20.0", "echo setup"],
				},
				install: {
					dependsOn: ["setup"],
					cmds: [
						"npm i -g corepack@0.24.1 && corepack enable",
						"npm ci",
					],
				},
			},
		};
		const normalized = JSON.parse(
			execFileSync(
				"jq",
				[
					"--arg",
					"packageManagerPattern",
					NIXPACKS_VERSIONED_PACKAGE_MANAGER_NIX_PATTERN,
					"--arg",
					"bootstrap",
					"npm install --global corepack@0.31.0 && corepack enable",
					"--argjson",
					"removeBun",
					"true",
					"--argjson",
					"replaceCorepack",
					"true",
					NIXPACKS_PLAN_NORMALIZATION_FILTER,
				],
				{
					input: JSON.stringify(plan),
					encoding: "utf8",
				},
			),
		);

		expect(normalized.providers).toEqual([]);
		expect(normalized.phases.setup.nixPkgs).toEqual(["nodejs_22", "gcc"]);
		expect(normalized.phases.setup.cmds).toEqual(["echo setup"]);
		expect(normalized.phases.install.cmds).toEqual([
			"npm install --global corepack@0.31.0 && corepack enable",
			"npm ci",
		]);
	});

	it("keeps Bun in a frozen plan when the repository does not require a Bun bootstrap", () => {
		const plan = {
			providers: ["node"],
			phases: {
				setup: {
					nixPkgs: ["nodejs_22", "bun"],
				},
			},
		};
		const normalized = JSON.parse(
			execFileSync(
				"jq",
				[
					"--arg",
					"packageManagerPattern",
					NIXPACKS_VERSIONED_PACKAGE_MANAGER_NIX_PATTERN,
					"--arg",
					"bootstrap",
					"",
					"--argjson",
					"removeBun",
					"false",
					"--argjson",
					"replaceCorepack",
					"false",
					NIXPACKS_PLAN_NORMALIZATION_FILTER,
				],
				{
					input: JSON.stringify(plan),
					encoding: "utf8",
				},
			),
		);

		expect(normalized.phases.setup.nixPkgs).toEqual(["nodejs_22", "bun"]);
	});

	it.each([
		{
			manager: "npm",
			spec: "npm@9.9.4",
			nixPackage: "npm-19_x",
			expectedBootstrap: "npm install --global npm@9.9.4",
		},
		{
			manager: "yarn",
			spec: "yarn@4.6.0+sha512.deadbeef",
			nixPackage: "yarn-99_x",
			expectedBootstrap: "corepack prepare yarn@4.6.0 --activate",
		},
		{
			manager: "pnpm",
			spec: "pnpm@10.12.1+sha512.deadbeef",
			nixPackage: "pnpm_42",
			expectedBootstrap: "corepack prepare pnpm@10.12.1 --activate",
		},
		{
			manager: "bun",
			spec: "bun@1.2.15+sha512.deadbeef",
			nixPackage: "bun",
			expectedBootstrap:
				"npm install --global --prefix /usr/local bun@1.2.15",
		},
	])(
		"normalizes the real generated plan and bootstraps exact $manager versions",
		({ spec, nixPackage, expectedBootstrap }) => {
			const normalized = executeWithFakeNixpacks({
				packageJson: {
					name: "package-manager-fixture",
					version: "1.0.0",
					packageManager: spec,
					scripts: {
						build: "echo built",
						start: "node server.js",
					},
				},
				plan: {
					providers: ["node"],
					phases: {
						setup: {
							nixPkgs: ["nodejs_22", nixPackage, "gcc"],
							cmds: ["npm install --global corepack@0.20.0"],
						},
						install: {
							dependsOn: ["setup"],
							cmds: ["echo install"],
						},
					},
				},
			});

			expect(normalized.providers).toEqual([]);
			expect(normalized.phases.setup.nixPkgs).toEqual([
				"nodejs_22",
				"gcc",
			]);
			expect(normalized.phases.install.cmds[0]).toContain(
				expectedBootstrap,
			);
		},
	);

	it("discovers secondary package managers from the generated plan and bootstraps them once", () => {
		const normalized = executeWithFakeNixpacks({
			packageJson: {
				name: "mixed-package-manager-fixture",
				version: "1.0.0",
				packageManager: "npm@10.9.2",
				scripts: {
					build: "echo built",
					start: "node server.js",
				},
			},
			plan: {
				providers: ["node"],
				phases: {
					setup: {
						nixPkgs: [
							"nodejs_22",
							"npm-27_x",
							"yarn_99",
							"pnpm-42_x",
							"bun",
						],
					},
					install: {
						dependsOn: ["setup"],
						cmds: [
							"yarn install",
							"pnpm run prepare",
							"bun run generate",
						],
					},
				},
			},
		});

		expect(normalized.phases.setup.nixPkgs).toEqual(["nodejs_22"]);
		const bootstrap = normalized.phases.install.cmds[0];
		expect(bootstrap).toContain("npm install --global npm@10.9.2");
		expect(bootstrap).toContain(
			"npm install --global --force corepack@0.31.0",
		);
		expect(bootstrap).toContain("corepack prepare yarn@stable --activate");
		expect(bootstrap).toContain("corepack prepare pnpm@latest --activate");
		expect(bootstrap).toContain(
			"npm install --global --prefix /usr/local bun@latest",
		);
		expect(bootstrap).toContain("ln -sf /usr/local/bin/bun /usr/bin/bun");
		expect(bootstrap).toContain(
			"ln -sf /usr/local/bin/bunx /usr/bin/bunx",
		);
		expect(bootstrap).toContain("hash -r && bun --version");
		expect(bootstrap.match(/corepack enable/g)).toHaveLength(1);
	});
});
