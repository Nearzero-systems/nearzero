import fs, {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@nearzero/server/db";
import {
	assertCertificateServerOwnership,
	type Certificate,
	createCertificate,
	installCertificateFiles,
	toPublicCertificate,
	updateCertificate,
} from "@nearzero/server/services/certificate";
import {
	loginDockerRegistry,
	toPublicRegistry,
	toPublicRegistryRelations,
} from "@nearzero/server/services/registry";
import {
	toPublicServer,
	toPublicServerRelation,
} from "@nearzero/server/services/server";
import { toPublicSshKey } from "@nearzero/server/services/ssh-key";
import { sanitizePublicErrorMessage } from "@nearzero/server/services/operational-log";
import type { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toPublicService } from "@/server/api/utils/public-service";

const mocks = vi.hoisted(() => ({
	certificatesPath: "",
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	execFileAsync: vi.fn(),
}));

vi.mock("@nearzero/server/constants", () => ({
	paths: () => ({ CERTIFICATES_PATH: mocks.certificatesPath }),
}));

vi.mock("@nearzero/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	execFileAsync: mocks.execFileAsync,
}));

const certificate = (overrides: Partial<Certificate> = {}): Certificate => ({
	certificateId: "certificate-id",
	name: "example.com",
	certificateData: "CERTIFICATE_MATERIAL",
	privateKey: "PRIVATE_KEY_MATERIAL",
	certificatePath: "certificate-example-safe",
	autoRenew: null,
	organizationId: "organization-a",
	serverId: null,
	...overrides,
});

describe("private material response redaction", () => {
	it("removes stored certificate, SSH, nested server, and monitoring secrets", () => {
		const storedCertificate = certificate();
		const storedSshKey = {
			sshKeyId: "ssh-key-id",
			name: "production",
			privateKey: "SSH_PRIVATE_KEY",
			publicKey: "ssh-ed25519 PUBLIC_KEY",
		};
		const storedServer = {
			serverId: "server-id",
			sshKey: storedSshKey,
			metricsConfig: {
				server: { token: "MONITORING_BEARER_TOKEN", port: 4500 },
				containers: { refreshRate: 60 },
			},
		};
		const storedRegistry = {
			registryId: "registry-id",
			registryName: "production",
			imagePrefix: null,
			username: "nearzero",
			password: "REGISTRY_PASSWORD",
			registryUrl: "registry.example.com",
			createdAt: new Date().toISOString(),
			registryType: "cloud" as const,
			organizationId: "organization-a",
		};

		expect(toPublicCertificate(storedCertificate)).not.toHaveProperty(
			"privateKey",
		);
		expect(toPublicSshKey(storedSshKey)).not.toHaveProperty("privateKey");
		expect(toPublicRegistry(storedRegistry)).not.toHaveProperty("password");
		const publicApplication = toPublicRegistryRelations({
			applicationId: "application-id",
			registry: storedRegistry,
			rollbackRegistry: storedRegistry,
		});
		expect(publicApplication.registry).not.toHaveProperty("password");
		expect(publicApplication.rollbackRegistry).not.toHaveProperty("password");
		const publicServer = toPublicServer(storedServer);
		expect(publicServer.sshKey).not.toHaveProperty("privateKey");
		expect(publicServer.metricsConfig.server).not.toHaveProperty("token");
		const publicService = toPublicServerRelation({
			serviceId: "service-id",
			server: storedServer,
		});
		expect(publicService.server.sshKey).not.toHaveProperty("privateKey");
		expect(publicService.server.metricsConfig.server).not.toHaveProperty(
			"token",
		);

		// Redaction must never mutate the internal values used by SSH/monitoring.
		expect(storedCertificate.privateKey).toBe("PRIVATE_KEY_MATERIAL");
		expect(storedServer.sshKey.privateKey).toBe("SSH_PRIVATE_KEY");
		expect(storedServer.metricsConfig.server.token).toBe(
			"MONITORING_BEARER_TOKEN",
		);
	});

	it("removes every private service relation without mutating deployment state", () => {
		const canaries = [
			"DOCKER_PASSWORD_CANARY",
			"REFRESH_TOKEN_CANARY",
			"SERVICE_ENV_CANARY",
			"BUILD_ARGS_CANARY",
			"BUILD_SECRET_CANARY",
			"PREVIEW_ENV_CANARY",
			"PREVIEW_BUILD_ARGS_CANARY",
			"PREVIEW_BUILD_SECRET_CANARY",
			"GITHUB_TOKEN_CANARY",
			"GITLAB_TOKEN_CANARY",
			"BITBUCKET_TOKEN_CANARY",
			"GITEA_TOKEN_CANARY",
			"REGISTRY_PASSWORD_CANARY",
			"SSH_PRIVATE_KEY_CANARY",
			"MONITORING_TOKEN_CANARY",
			"ENVIRONMENT_ENV_CANARY",
			"PROJECT_ENV_CANARY",
			"MOUNT_CONTENT_CANARY",
			"BACKUP_DESTINATION_SECRET_CANARY",
		];
		const storedService = {
			applicationId: "application-id",
			password: canaries[0],
			refreshToken: canaries[1],
			env: canaries[2],
			buildArgs: canaries[3],
			buildSecrets: canaries[4],
			previewEnv: canaries[5],
			previewBuildArgs: canaries[6],
			previewBuildSecrets: canaries[7],
			github: {
				githubId: "github-id",
				gitProviderId: "provider-id",
				accessToken: canaries[8],
			},
			gitlab: {
				gitlabId: "gitlab-id",
				gitProviderId: "provider-id",
				token: canaries[9],
			},
			bitbucket: {
				bitbucketId: "bitbucket-id",
				gitProviderId: "provider-id",
				appPassword: canaries[10],
			},
			gitea: {
				giteaId: "gitea-id",
				gitProviderId: "provider-id",
				token: canaries[11],
			},
			registry: {
				registryId: "registry-id",
				password: canaries[12],
			},
			server: {
				serverId: "server-id",
				sshKey: { sshKeyId: "ssh-key-id", privateKey: canaries[13] },
				metricsConfig: { server: { token: canaries[14], port: 4500 } },
			},
			environment: {
				environmentId: "environment-id",
				env: canaries[15],
				project: { projectId: "project-id", env: canaries[16] },
			},
			mounts: [{ mountId: "mount-id", content: canaries[17] }],
			backups: [
				{
					backupId: "backup-id",
					destination: { secretAccessKey: canaries[18] },
				},
			],
		};

		const publicService = toPublicService(storedService);
		const serialized = JSON.stringify(publicService);
		for (const canary of canaries) expect(serialized).not.toContain(canary);

		expect(publicService).toMatchObject({
			hasDockerPassword: true,
			hasEnvironmentVariables: true,
			hasBuildSecrets: true,
			hasPreviewEnvironmentVariables: true,
			hasPreviewBuildSecrets: true,
			github: { githubId: "github-id", gitProviderId: "provider-id" },
			gitlab: { gitlabId: "gitlab-id", gitProviderId: "provider-id" },
			bitbucket: {
				bitbucketId: "bitbucket-id",
				gitProviderId: "provider-id",
			},
			gitea: { giteaId: "gitea-id", gitProviderId: "provider-id" },
			mounts: [{ mountId: "mount-id", hasContent: true }],
		});
		expect(publicService).not.toHaveProperty("backups");
		expect(storedService.github.accessToken).toBe("GITHUB_TOKEN_CANARY");
		expect(storedService.environment.project.env).toBe("PROJECT_ENV_CANARY");
		expect(storedService.mounts[0]?.content).toBe("MOUNT_CONTENT_CANARY");
	});

	it("replaces database/process metadata and redacts common credential formats", () => {
		const databaseError = new Error(
			"Failed query: insert into registry (password) values ($1)\nparams: UNLABELED_DATABASE_SECRET",
		);
		expect(
			sanitizePublicErrorMessage(databaseError, "Safe operation failure"),
		).toBe("Safe operation failure");

		const tokenError = sanitizePublicErrorMessage(
			"Provider rejected sk-proj-abcdefghijklmnopqrstuvwxyz012345",
		);
		expect(tokenError).not.toContain("sk-proj-");
		expect(tokenError).toContain("[redacted token]");
	});

	it("wires every secret-bearing router response through a redactor", () => {
		const certificateRouter = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/certificate.ts"),
			"utf8",
		);
		const sshKeyRouter = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/ssh-key.ts"),
			"utf8",
		);
		const serverRouter = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/server.ts"),
			"utf8",
		);
		const registryRouter = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/registry.ts"),
			"utf8",
		);
		const applicationRouter = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/application.ts"),
			"utf8",
		);
		const deploymentRouter = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/deployment.ts"),
			"utf8",
		);
		const rollbackRouter = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/rollbacks.ts"),
			"utf8",
		);

		expect(certificateRouter).toContain("columns: { privateKey: false }");
		expect(certificateRouter).toContain("toPublicCertificate(cert)");
		expect(certificateRouter).toContain(
			"toPublicCertificate(updatedCertificate)",
		);
		expect(sshKeyRouter).toContain("columns: { privateKey: false }");
		expect(sshKeyRouter).toContain("toPublicSshKey(sshKey)");
		expect(sshKeyRouter).toContain("toPublicSshKey(result)");
		expect(serverRouter).toContain("return toPublicServer(server)");
		expect(serverRouter).toContain(".map(toPublicServer)");
		expect(serverRouter.match(/toPublicServer\(currentServer\)/g)?.length).toBe(
			2,
		);
		expect(registryRouter).toContain("columns: { password: false }");
		expect(registryRouter).toContain("loginDockerRegistry({");
		expect(registryRouter).not.toMatch(/echo\s+.*password.*docker\s+login/i);
		expect(applicationRouter).toContain(
			"return toPublicService(newApplication)",
		);
		expect(applicationRouter).toContain("return toPublicService({");
		expect(applicationRouter).toContain(
			"return { success: true, applicationId: service.applicationId }",
		);
		expect(deploymentRouter).not.toContain("rollback: true");
		expect(deploymentRouter).not.toContain("failedReason");
		expect(deploymentRouter).toContain(".map(toPublicDeployment)");
		expect(rollbackRouter).toContain(
			"return { success: true, rollbackId: input.rollbackId }",
		);
	});

	it("redacts every API boundary that serializes a nested server relation", () => {
		const routerDirectory = path.resolve(process.cwd(), "server/api/routers");
		const databaseVariables = {
			redis: "redis|mongo",
			mariadb: "mariadb|service|mongo",
			mongo: "mongo|service",
			mysql: "mysql|service|mongo",
			postgres: "postgres|service",
			libsql: "libsql",
		};

		for (const [routerName, returnVariables] of Object.entries(
			databaseVariables,
		)) {
			const source = readFileSync(
				path.join(routerDirectory, `${routerName}.ts`),
				"utf8",
			);
			expect(source).toContain("toPublicServerRelation");
			expect(source).not.toMatch(new RegExp(`return (${returnVariables});`));
		}

		const applicationRouter = readFileSync(
			path.join(routerDirectory, "application.ts"),
			"utf8",
		);
		const composeRouter = readFileSync(
			path.join(routerDirectory, "compose.ts"),
			"utf8",
		);
		const scheduleRouter = readFileSync(
			path.join(routerDirectory, "schedule.ts"),
			"utf8",
		);
		expect(applicationRouter).toContain("toPublicService");
		expect(applicationRouter).toContain("return toPublicService({");
		expect(applicationRouter).not.toMatch(/return (application|service);/);
		expect(composeRouter).toContain("toPublicService");
		expect(composeRouter).toContain("return toPublicService(newService)");
		expect(composeRouter).toContain("return toPublicService({");
		expect(composeRouter).not.toMatch(/return (compose|composeResult);/);
		expect(scheduleRouter).toContain(
			"return scheduleRows.map(toPublicServerRelation)",
		);
		expect(scheduleRouter).toContain("return toPublicServerRelation(schedule)");
	});
});

describe("certificate ownership and file installation", () => {
	let temporaryDirectory: string;

	beforeEach(() => {
		vi.clearAllMocks();
		temporaryDirectory = mkdtempSync(
			path.join(tmpdir(), "nearzero-certificate-security-"),
		);
		mocks.certificatesPath = path.join(temporaryDirectory, "certificates");
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("rejects a certificate target server outside the active organization", async () => {
		vi.mocked(db.query.server.findFirst).mockResolvedValueOnce(undefined);

		await expect(
			assertCertificateServerOwnership("foreign-server", "organization-a"),
		).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<TRPCError>);
	});

	it("installs local files atomically with private permissions", async () => {
		const initialCertificate = certificate();
		await installCertificateFiles(initialCertificate);

		const target = path.join(
			mocks.certificatesPath,
			initialCertificate.certificatePath,
		);
		expect(statSync(target).mode & 0o777).toBe(0o700);
		for (const fileName of ["chain.crt", "privkey.key", "certificate.yml"]) {
			expect(statSync(path.join(target, fileName)).mode & 0o777).toBe(0o600);
		}
		expect(readFileSync(path.join(target, "privkey.key"), "utf8")).toBe(
			"PRIVATE_KEY_MATERIAL",
		);

		await installCertificateFiles(
			certificate({
				certificateData: "UPDATED_CERTIFICATE",
				privateKey: "UPDATED_PRIVATE_KEY",
			}),
		);
		expect(readFileSync(path.join(target, "chain.crt"), "utf8")).toBe(
			"UPDATED_CERTIFICATE",
		);
		expect(readFileSync(path.join(target, "privkey.key"), "utf8")).toBe(
			"UPDATED_PRIVATE_KEY",
		);
		expect(
			readdirSync(mocks.certificatesPath).filter((name) =>
				name.startsWith(".certificate-"),
			),
		).toEqual([]);
	});

	it("restores the previous local directory if the atomic swap fails", async () => {
		const initialCertificate = certificate();
		await installCertificateFiles(initialCertificate);
		const target = path.join(
			mocks.certificatesPath,
			initialCertificate.certificatePath,
		);
		const realRename = fs.renameSync.bind(fs);
		let renameCalls = 0;
		vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
			renameCalls += 1;
			if (renameCalls === 2) throw new Error("simulated atomic swap failure");
			return realRename(oldPath, newPath);
		});

		await expect(
			installCertificateFiles(
				certificate({ privateKey: "KEY_THAT_MUST_NOT_BE_COMMITTED" }),
			),
		).rejects.toThrow("simulated atomic swap failure");
		expect(readFileSync(path.join(target, "privkey.key"), "utf8")).toBe(
			"PRIVATE_KEY_MATERIAL",
		);
	});

	it("keeps remote secrets out of command/error metadata and sends them on stdin", async () => {
		const remoteCertificate = certificate({ serverId: "server-id" });
		await installCertificateFiles(remoteCertificate);

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		const call = mocks.execAsyncRemote.mock.calls[0];
		expect(call).toBeDefined();
		if (!call) throw new Error("Expected a remote certificate install call");
		const [serverId, command, onData, options] = call;
		expect(serverId).toBe("server-id");
		expect(onData).toBeUndefined();
		expect(command).not.toContain(remoteCertificate.certificateData);
		expect(command).not.toContain(remoteCertificate.privateKey);
		expect(command).toContain("chmod 600");
		expect(options.input).toContain(
			Buffer.from(remoteCertificate.privateKey).toString("base64"),
		);
	});

	it("keeps registry passwords out of remote commands and sends them on stdin", async () => {
		const password = "REGISTRY_PASSWORD_MUST_NOT_ENTER_COMMAND_METADATA";
		await loginDockerRegistry({
			registryUrl: "registry.example.com",
			username: "nearzero",
			password,
			serverId: "server-id",
		});

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		const call = mocks.execAsyncRemote.mock.calls[0];
		expect(call).toBeDefined();
		if (!call) throw new Error("Expected a remote registry login call");
		const [serverId, command, onData, options] = call;
		expect(serverId).toBe("server-id");
		expect(onData).toBeUndefined();
		expect(command).not.toContain(password);
		expect(command).toContain("--password-stdin");
		expect(options.input).toBe(`${password}\n`);
	});

	it("awaits installation failure and compensates the inserted DB record", async () => {
		const blockedPath = path.join(temporaryDirectory, "not-a-directory");
		writeFileSync(blockedPath, "blocked");
		mocks.certificatesPath = blockedPath;
		const insertedCertificate = certificate();
		vi.mocked(db.insert).mockReturnValueOnce({
			values: () => ({
				returning: async () => [insertedCertificate],
			}),
		} as never);

		await expect(
			createCertificate(
				{
					name: insertedCertificate.name,
					certificateData: insertedCertificate.certificateData,
					privateKey: insertedCertificate.privateKey,
				},
				"organization-a",
			),
		).rejects.toThrow();
		expect(db.delete).toHaveBeenCalledOnce();
	});

	it("rolls back the DB update when replacement files cannot be installed", async () => {
		const blockedPath = path.join(temporaryDirectory, "not-a-directory");
		writeFileSync(blockedPath, "blocked");
		mocks.certificatesPath = blockedPath;
		const previousCertificate = certificate();
		const updatedCertificate = certificate({
			certificateData: "UPDATED_CERTIFICATE",
			privateKey: "UPDATED_PRIVATE_KEY",
		});
		vi.mocked(db.query.certificates.findFirst).mockResolvedValueOnce(
			previousCertificate,
		);
		const updateChain: Record<string, ReturnType<typeof vi.fn>> = {};
		updateChain.set = vi.fn(() => updateChain);
		updateChain.where = vi.fn(() => updateChain);
		updateChain.returning = vi.fn(async () => [updatedCertificate]);
		const rollbackChain: Record<string, ReturnType<typeof vi.fn>> = {};
		rollbackChain.set = vi.fn(() => rollbackChain);
		rollbackChain.where = vi.fn(async () => []);
		vi.mocked(db.update)
			.mockReturnValueOnce(updateChain as never)
			.mockReturnValueOnce(rollbackChain as never);

		await expect(
			updateCertificate(previousCertificate.certificateId, {
				certificateData: updatedCertificate.certificateData,
				privateKey: updatedCertificate.privateKey,
			}),
		).rejects.toThrow();
		expect(db.update).toHaveBeenCalledTimes(2);
		expect(rollbackChain.set).toHaveBeenCalledWith({
			name: previousCertificate.name,
			certificateData: previousCertificate.certificateData,
			privateKey: previousCertificate.privateKey,
		});
	});
});
