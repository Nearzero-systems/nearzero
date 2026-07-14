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
	it("selects Railpack when automatic framework metadata conflicts with the Dockerfile package manager", () => {
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "nixpacks",
				hasDockerfile: true,
				hasManagedFramework: true,
				hasDockerfilePackageManagerMismatch: true,
				hasManagedPackageManagerAgreement: true,
				hasDockerfileOverrides: false,
			}),
		).toBe("railpack");
	});

	it("keeps an automatic Dockerfile when no managed framework conflict exists", () => {
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "nixpacks",
				hasDockerfile: true,
				hasManagedFramework: false,
				hasDockerfilePackageManagerMismatch: true,
			}),
		).toBe("dockerfile");
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "nixpacks",
				hasDockerfile: true,
				hasManagedFramework: true,
				hasDockerfilePackageManagerMismatch: false,
			}),
		).toBe("dockerfile");
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "nixpacks",
				hasDockerfile: true,
				hasManagedFramework: true,
				hasDockerfilePackageManagerMismatch: true,
				hasManagedPackageManagerAgreement: false,
			}),
		).toBe("dockerfile");
		expect(
			selectApplicationBuilder({
				selectionMode: "automatic",
				requestedBuilder: "nixpacks",
				hasDockerfile: true,
				hasManagedFramework: true,
				hasDockerfilePackageManagerMismatch: true,
				hasManagedPackageManagerAgreement: true,
				hasDockerfileOverrides: true,
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

	it("uses a managed framework build for automatic package-manager conflicts while preserving explicit Dockerfiles", async () => {
		const appName = `build-plan-dockerfile-${Date.now()}`;
		const dockerfileOnlyValue = "NZ_TEST_DOCKERFILE_LITERAL=do-not-return";
		const sourceDirectory = path.join(
			paths(false).APPLICATIONS_PATH,
			appName,
			"code",
		);
		try {
			mkdirSync(sourceDirectory, { recursive: true });
			writeFileSync(
				path.join(sourceDirectory, "Dockerfile"),
				`FROM node:20-slim\n# ${dockerfileOnlyValue}\nCOPY package*.json ./\nRUN npm ci\n`,
			);
			writeFileSync(path.join(sourceDirectory, "bun.lock"), "");
			writeFileSync(path.join(sourceDirectory, "yarn.lock"), "");
			writeFileSync(path.join(sourceDirectory, "package-lock.json"), "{}");
			writeFileSync(
				path.join(sourceDirectory, "package.json"),
				JSON.stringify({
					name: "dockerfile-app",
					scripts: {
						build: "node scripts/run-next.js build",
						start: "next start",
					},
					dependencies: {
						next: "16.1.7",
						"next-auth": "^4.24.11",
					},
				}),
			);

			const plan = await createApplicationBuildPlan({
				buildServerId: null,
				application: {
					appName,
					sourceType: "github",
					buildPath: "/",
					buildType: "railpack",
					buildSelectionMode: "automatic",
					dockerfile: null,
					buildArgs: "NEARZERO_DEPLOY_URL=preview.example.test",
					buildSecrets: "NEARZERO_DEPLOY_URL=preview.example.test",
				} as any,
			});

			expect(plan.selectedBuilder).toBe("railpack");
			expect(plan.packageManager).toBe("bun");
			expect(plan.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "managed_builder_preferred_over_dockerfile",
						dockerfile: "Dockerfile",
						repositoryPackageManager: "bun",
						dockerfilePackageManagers: ["npm"],
						preferredBuilder: "railpack",
					}),
					expect.objectContaining({
						code: "multiple_package_manager_lockfiles",
						lockfiles: ["bun.lock", "yarn.lock", "package-lock.json"],
					}),
				]),
			);
			expect(plan.diagnostics).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "dockerfile_authoritative" }),
				]),
			);

			const explicitPlan = await createApplicationBuildPlan({
				buildServerId: null,
				application: {
					appName,
					sourceType: "github",
					buildPath: "/",
					buildType: "dockerfile",
					buildSelectionMode: "explicit",
					dockerfile: null,
				} as any,
			});
			expect(explicitPlan.selectedBuilder).toBe("dockerfile");
			expect(explicitPlan.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "dockerfile_authoritative" }),
					expect.objectContaining({
						code: "dockerfile_package_manager_mismatch",
						repositoryPackageManager: "bun",
						dockerfilePackageManagers: ["npm"],
					}),
				]),
			);

			const configuredDockerPlan = await createApplicationBuildPlan({
				buildServerId: null,
				application: {
					appName,
					sourceType: "github",
					buildPath: "/",
					buildType: "railpack",
					buildSelectionMode: "automatic",
					dockerfile: null,
					buildArgs: "USER_CONFIGURED_ARG=value",
				} as any,
			});
			expect(configuredDockerPlan.selectedBuilder).toBe("dockerfile");
			expect(JSON.stringify(plan)).not.toContain(dockerfileOnlyValue);
		} finally {
			rmSync(path.join(paths(false).APPLICATIONS_PATH, appName), {
				recursive: true,
				force: true,
			});
		}
	});

	it("does not inspect an invalid Dockerfile path for an explicit managed build", async () => {
		const appName = `build-plan-managed-${Date.now()}`;
		const sourceDirectory = path.join(
			paths(false).APPLICATIONS_PATH,
			appName,
			"code",
		);
		try {
			mkdirSync(sourceDirectory, { recursive: true });
			writeFileSync(
				path.join(sourceDirectory, "package.json"),
				JSON.stringify({
					name: "managed-app",
					scripts: { build: "node build.js", start: "node server.js" },
				}),
			);

			const managedPlan = await createApplicationBuildPlan({
				buildServerId: null,
				application: {
					appName,
					sourceType: "github",
					buildPath: "/",
					buildType: "nixpacks",
					buildSelectionMode: "explicit",
					dockerfile: "../../outside/Dockerfile",
				} as any,
			});
			expect(managedPlan.selectedBuilder).toBe("nixpacks");

			await expect(
				createApplicationBuildPlan({
					buildServerId: null,
					application: {
						appName,
						sourceType: "github",
						buildPath: "/",
						buildType: "dockerfile",
						buildSelectionMode: "explicit",
						dockerfile: "../../outside/Dockerfile",
					} as any,
				}),
			).rejects.toThrow(
				"Dockerfile path must stay inside the checked-out source directory.",
			);
		} finally {
			rmSync(path.join(paths(false).APPLICATIONS_PATH, appName), {
				recursive: true,
				force: true,
			});
		}
	});

	it("resolves package managers from the selected build path instead of unrelated root lockfiles", async () => {
		const appName = `build-plan-nested-lockfile-${Date.now()}`;
		const sourceDirectory = path.join(
			paths(false).APPLICATIONS_PATH,
			appName,
			"code",
		);
		try {
			mkdirSync(path.join(sourceDirectory, "apps/web"), { recursive: true });
			writeFileSync(
				path.join(sourceDirectory, "package.json"),
				JSON.stringify({ name: "repository-root" }),
			);
			writeFileSync(path.join(sourceDirectory, "package-lock.json"), "{}");
			writeFileSync(
				path.join(sourceDirectory, "apps/web/package.json"),
				JSON.stringify({
					name: "nested-web",
					scripts: { build: "next build", start: "next start" },
					dependencies: { next: "16.1.7" },
				}),
			);
			writeFileSync(path.join(sourceDirectory, "apps/web/bun.lock"), "");
			writeFileSync(
				path.join(sourceDirectory, "apps/web/Dockerfile"),
				"FROM node:20-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\n",
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

			expect(plan.selectedAppPath).toBe("/apps/web");
			expect(plan.packageManager).toBe("bun");
			expect(plan.selectedBuilder).toBe("railpack");
			expect(plan.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "managed_builder_preferred_over_dockerfile",
						repositoryPackageManager: "bun",
					}),
				]),
			);
			expect(plan.diagnostics).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "multiple_package_manager_lockfiles",
					}),
				]),
			);
		} finally {
			rmSync(path.join(paths(false).APPLICATIONS_PATH, appName), {
				recursive: true,
				force: true,
			});
		}
	});

	it("falls back from Railpack to Nixpacks only before compilation", () => {
		const preferredPlan: ApplicationBuildPlan = {
			...automaticRailpackPlan,
			diagnostics: [
				{
					code: "managed_builder_preferred_over_dockerfile",
					severity: "info",
					message: "Automatic mode preferred Railpack.",
					dockerfile: "Dockerfile",
					framework: "next",
					repositoryPackageManager: "bun",
					dockerfilePackageManagers: ["npm"],
					preferredBuilder: "railpack",
				},
			],
		};
		const fallbackPlan = fallbackApplicationBuildPlanToNixpacks(
			preferredPlan,
			"Railpack planning failed.",
		);
		expect(fallbackPlan).toMatchObject({
			selectedBuilder: "nixpacks",
			fallbackReason: "Railpack planning failed.",
			requiredCapabilities: ["docker", "nixpacks"],
		});
		expect(fallbackPlan.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "managed_builder_preferred_over_dockerfile",
					preferredBuilder: "railpack",
				}),
			]),
		);
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
