import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findSSHKeyById: vi.fn(),
	updateSSHKeyById: vi.fn(),
}));

vi.mock("@nearzero/server/services/ssh-key", () => ({
	findSSHKeyById: mocks.findSSHKeyById,
	updateSSHKeyById: mocks.updateSSHKeyById,
}));

vi.mock("@nearzero/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import { getCreateEnvFileCommand } from "@nearzero/server/utils/builders/compose";
import { cloneGitRepository } from "@nearzero/server/utils/providers/git";

describe("remote deployment secret handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.updateSSHKeyById.mockResolvedValue(undefined);
	});

	it("delivers a custom Git private key over SSH stdin instead of the command", async () => {
		const privateKey = [
			"-----BEGIN OPENSSH PRIVATE KEY-----",
			"private-key-canary-never-in-a-command",
			"-----END OPENSSH PRIVATE KEY-----",
		].join("\n");
		mocks.findSSHKeyById.mockResolvedValue({ privateKey });

		const prepared = await cloneGitRepository({
			appName: "private-repository",
			customGitUrl: "git@example.com:acme/private-repository.git",
			customGitBranch: "main",
			customGitSSHKeyId: "ssh-key-1",
			enableSubmodules: false,
			serverId: "server-1",
		});

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(prepared.input).toBe(privateKey);
		expect(prepared.command).not.toContain(privateKey);
		expect(prepared.command).not.toContain("/tmp/id_rsa");
		expect(prepared.command).toContain(".git-deploy-key-");
		expect(prepared.command).toContain("cat >");
		expect(prepared.command).toContain("StrictHostKeyChecking\\=yes");
		expect(prepared.command).toContain("IdentitiesOnly\\=yes");
		expect(prepared.command).toContain("cleanup_git_key");
		expect(prepared.command).toContain("trap cleanup_git_key EXIT");
	});

	it.each([
		"http://git.example.com/acme/repository.git",
		"https://user:token@git.example.com/acme/repository.git",
		"https://git.example.com/acme/repository.git?token=secret",
	])(
		"rejects an unsafe custom Git transport before cloning: %s",
		async (url) => {
			await expect(
				cloneGitRepository({
					appName: "unsafe-repository",
					customGitUrl: url,
					customGitBranch: "main",
					customGitSSHKeyId: null,
					serverId: "server-1",
				}),
			).rejects.toThrow(/HTTPS or SSH|cannot contain credentials/i);
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		},
	);

	it("writes Compose environment material atomically with mode 0600", () => {
		const prepared = getCreateEnvFileCommand({
			appName: "compose-app",
			composePath: "docker-compose.yml",
			env: "DATABASE_PASSWORD=compose-secret-canary",
			randomize: false,
			serverId: "server-1",
			environment: {
				env: "",
				project: { env: "" },
			},
		} as never);

		expect(prepared.input).toContain("compose-secret-canary");
		expect(prepared.command).not.toContain("compose-secret-canary");
		expect(prepared.command).not.toContain(
			Buffer.from("DATABASE_PASSWORD=compose-secret-canary").toString("base64"),
		);
		expect(prepared.command).toContain("umask 077");
		expect(prepared.command).toContain("mktemp");
		expect(prepared.command).toContain("chmod 600");
		expect(prepared.command).toContain("readlink -f");
		expect(prepared.command).toContain("escapes its managed project");
	});
});
