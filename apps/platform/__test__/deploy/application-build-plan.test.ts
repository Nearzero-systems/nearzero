import {
	createApplicationBuildPlan,
	fallbackApplicationBuildPlanToNixpacks,
	selectApplicationBuilder,
} from "@nearzero/server/services/application-build-plan";
import { paths } from "@nearzero/server/constants";
import type { ApplicationBuildPlan } from "@nearzero/server/types/application-build-plan";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const automaticRailpackPlan: ApplicationBuildPlan = {
	version: 1,
	selectionMode: "automatic",
	requestedBuilder: "nixpacks",
	selectedBuilder: "railpack",
	fallbackReason: null,
	sourceRevision: "abc123",
	buildPath: "/apps/web",
	workspaceRoot: null,
	selectedAppPath: "/apps/web",
	appCount: 1,
	detectedApps: [],
	packageManager: "bun",
	framework: "next",
	commands: {
		install: "bun install --frozen-lockfile",
		build: "next build",
		start: "next start",
	},
	healingHints: [],
	requiredCapabilities: ["docker", "railpack"],
	generatedAt: "2026-06-13T00:00:00.000Z",
};

describe("application build plan selection", () => {
	it("selects a detected Dockerfile before automatic builders", () => {
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "nixpacks",
				hasDockerfile: true,
			}),
		).toBe("dockerfile");
	});

	it("selects Railpack when automatic detection has no Dockerfile", () => {
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "nixpacks",
				hasDockerfile: false,
			}),
		).toBe("railpack");
	});

	it("selects Nixpacks for automatic workspace dependency builds", () => {
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "railpack",
				hasDockerfile: false,
				hasWorkspaceDependencies: true,
			}),
		).toBe("nixpacks");
	});

	it("selects Nixpacks for automatic custom command builds", () => {
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "railpack",
				hasDockerfile: false,
				hasCustomCommands: true,
			}),
		).toBe("nixpacks");
	});

	it("preserves an explicitly configured builder", () => {
		expect(
			selectApplicationBuilder({
				selectionMode: "explicit",
				requestedBuilder: "paketo_buildpacks",
				hasDockerfile: true,
			}),
		).toBe("paketo_buildpacks");
	});

	it("falls back from Railpack to Nixpacks only before compilation", () => {
		expect(
			fallbackApplicationBuildPlanToNixpacks(
				automaticRailpackPlan,
				"Railpack planning failed.",
			),
		).toMatchObject({
			selectedBuilder: "nixpacks",
			fallbackReason: "Railpack planning failed.",
			requiredCapabilities: ["docker", "nixpacks"],
		});
	});

	it("uses Turbo to build selected workspace apps with dependencies first", async () => {
		const appName = `build-plan-turbo-${Date.now()}`;
		const sourceDirectory = path.join(
			paths(false).APPLICATIONS_PATH,
			appName,
			"code",
		);
		try {
			mkdirSync(path.join(sourceDirectory, "apps/web"), { recursive: true });
			mkdirSync(path.join(sourceDirectory, "packages/shared"), {
				recursive: true,
			});
			writeFileSync(path.join(sourceDirectory, "bun.lock"), "");
			writeFileSync(
				path.join(sourceDirectory, "turbo.json"),
				JSON.stringify({ tasks: { build: { dependsOn: ["^build"] } } }),
			);
			writeFileSync(
				path.join(sourceDirectory, "package.json"),
				JSON.stringify({
					name: "paper",
					workspaces: ["apps/*", "packages/*"],
					packageManager: "bun@1.3.5",
					devDependencies: { turbo: "^2.3.3" },
				}),
			);
			writeFileSync(
				path.join(sourceDirectory, "apps/web/package.json"),
				JSON.stringify({
					name: "@paper/web",
					scripts: { build: "next build", start: "next start" },
					dependencies: {
						"@paper/shared": "workspace:*",
						next: "^16.2.4",
					},
				}),
			);
			writeFileSync(
				path.join(sourceDirectory, "packages/shared/package.json"),
				JSON.stringify({
					name: "@paper/shared",
					scripts: { build: "tsup src/index.ts" },
				}),
			);

			const plan = await createApplicationBuildPlan({
				buildServerId: null,
				application: {
					appName,
					sourceType: "github",
					buildPath: "/apps/web",
					buildType: "railpack",
					buildSelectionMode: "automatic",
					dockerfile: null,
				} as any,
			});

			expect(plan.selectedBuilder).toBe("nixpacks");
			expect(plan.commands.install).toBe("bun install --frozen-lockfile");
			expect(plan.commands.build).toBe(
				"bunx turbo run build --filter=@paper/web...",
			);
			expect(plan.commands.start).toBe("cd apps/web && bun run start");
			expect(plan.healingHints.join("\n")).toContain(
				"build the selected app through Turbo",
			);
		} finally {
			rmSync(path.join(paths(false).APPLICATIONS_PATH, appName), {
				recursive: true,
				force: true,
			});
		}
	});

	it("does not fall back for explicit or already-fallback plans", () => {
		expect(() =>
			fallbackApplicationBuildPlanToNixpacks(
				{ ...automaticRailpackPlan, selectionMode: "explicit" },
				"failure",
			),
		).toThrow("Builder fallback is not allowed");
		expect(() =>
			fallbackApplicationBuildPlanToNixpacks(
				{ ...automaticRailpackPlan, selectedBuilder: "nixpacks" },
				"failure",
			),
		).toThrow("Builder fallback is not allowed");
	});
});
