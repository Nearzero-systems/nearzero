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
	getRailpackBuildCommand,
	getRailpackPackageManagerValidationCommand,
	getRailpackPrepareCommand,
} from "@nearzero/server/utils/builders/railpack";
import { describe, expect, it } from "vitest";

const createApplication = (appName: string) =>
	({
		applicationId: "app-1",
		appName,
		sourceType: "github",
		buildType: "railpack",
		buildPath: "/",
		buildExecutionTarget: "nearzero_host",
		serverId: null,
		cleanCache: false,
		env: "",
		environment: {
			env: "",
			project: { env: "" },
		},
	}) as any;

describe("Railpack managed-build contract", () => {
	it("preserves repository exclusions while re-including the selected lockfile", () => {
		const tempDirectory = mkdtempSync(
			path.join(os.tmpdir(), "nearzero-railpack-test-"),
		);
		const appName = `railpack-context-${path.basename(tempDirectory)}`;
		const sourceDirectory = path.join(
			paths(false).APPLICATIONS_PATH,
			appName,
			"code",
		);
		const fakeBinDirectory = path.join(tempDirectory, "bin");
		const fakeRailpack = path.join(fakeBinDirectory, "railpack");
		const fakeDocker = path.join(fakeBinDirectory, "docker");
		const application = createApplication(appName);

		mkdirSync(sourceDirectory, { recursive: true });
		mkdirSync(fakeBinDirectory, { recursive: true });
		writeFileSync(
			path.join(sourceDirectory, ".dockerignore"),
			"node_modules\n.env\nbun.lock\n",
		);
		writeFileSync(
			path.join(sourceDirectory, "package.json"),
			JSON.stringify({
				name: "managed-next-app",
				scripts: { build: "node scripts/build.js" },
			}),
		);
		writeFileSync(path.join(sourceDirectory, "bun.lock"), "");
		writeFileSync(
			fakeRailpack,
			`#!/usr/bin/env bash
set -e
PLAN=""
INFO=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--plan-out) PLAN="$2"; shift 2 ;;
		--info-out) INFO="$2"; shift 2 ;;
		*) shift ;;
	esac
done
printf '%s' '{"packages":{"bun":"latest","node":"22"},"steps":{"install":{"commands":["bun install --frozen-lockfile"]}}}' > "$PLAN"
printf '%s' '{"provider":"node"}' > "$INFO"
`,
		);
		writeFileSync(fakeDocker, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(fakeRailpack, 0o755);
		chmodSync(fakeDocker, 0o755);

		try {
			const prepareCommand = getRailpackPrepareCommand(
				application,
				null,
				"bun",
			);
			const buildCommand = getRailpackBuildCommand(application, null);
			execFileSync("bash", ["-n", "-c", prepareCommand]);
			execFileSync("bash", ["-n", "-c", buildCommand]);
			execFileSync("bash", ["-c", prepareCommand], {
				env: {
					...process.env,
					PATH: `${fakeBinDirectory}:${process.env.PATH ?? ""}`,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			const planIgnorePath = path.join(
				sourceDirectory,
				"railpack-plan.json.dockerignore",
			);
			const planIgnore = readFileSync(planIgnorePath, "utf8");
			const planIgnoreLines = planIgnore.split("\n");
			expect(planIgnore).toContain("node_modules");
			expect(planIgnore).toContain(".env");
			expect(planIgnore).toContain("railpack-plan.json");
			expect(planIgnore).toContain("!package.json");
			expect(planIgnoreLines.lastIndexOf("!bun.lock")).toBeGreaterThan(
				planIgnoreLines.lastIndexOf("bun.lock"),
			);
			expect(planIgnore).not.toContain("!package-lock.json");

			const bunValidation = getRailpackPackageManagerValidationCommand(
				application,
				null,
				"bun",
				true,
			);
			execFileSync("bash", ["-n", "-c", bunValidation]);
			execFileSync("bash", ["-c", bunValidation], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			writeFileSync(
				path.join(sourceDirectory, "railpack-plan.json"),
				JSON.stringify({
					packages: { bun: "latest" },
					steps: {
						install: { commands: ["bun install --frozen-lockfile"] },
					},
				}),
			);
			expect(() =>
				execFileSync("bash", ["-c", bunValidation], {
					stdio: ["ignore", "pipe", "pipe"],
				}),
			).toThrow();

			const npmValidation = getRailpackPackageManagerValidationCommand(
				application,
				null,
				"npm",
			);
			expect(() =>
				execFileSync("bash", ["-c", npmValidation], {
					stdio: ["ignore", "pipe", "pipe"],
				}),
			).toThrow();
			expect(buildCommand).toContain("trap nz_cleanup_railpack_context EXIT");
		} finally {
			rmSync(path.join(paths(false).APPLICATIONS_PATH, appName), {
				recursive: true,
				force: true,
			});
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});
});
