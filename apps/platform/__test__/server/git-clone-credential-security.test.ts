import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prepareCredentialedGitClone } from "@nearzero/server/utils/providers/credentialed-git";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (filePath: string) =>
	readFileSync(path.resolve(process.cwd(), "../..", filePath), "utf8");

describe("credentialed Git clone execution", () => {
	it.each([
		{
			provider: "GitHub",
			url: "https://github.com/acme/private-repository.git",
			username: "x-access-token",
		},
		{
			provider: "GitLab",
			url: "https://gitlab.example.com/acme/private-repository.git",
			username: "oauth2",
		},
		{
			provider: "Gitea",
			url: "https://gitea.example.com/acme/private-repository.git",
			username: "oauth2",
		},
		{
			provider: "Bitbucket",
			url: "https://bitbucket.org/acme/private-repository.git",
			username: "x-token-auth",
		},
	])(
		"keeps $provider credentials out of argv, commands, origins, and submodule URLs",
		({ url, username }) => {
			const password = "credential-canary-:'\"$@-never-in-command";
			const prepared = prepareCredentialedGitClone({
				repositoryUrl: url,
				username,
				password,
				branch: "main",
				outputPath: "/tmp/nearzero-credential-test/repository",
				enableSubmodules: true,
				isRemote: false,
			});
			const encodedPassword = Buffer.from(password, "utf8").toString("base64");

			expect(prepared.input).toContain(encodedPassword);
			expect(prepared.command).not.toContain(password);
			expect(prepared.command).not.toContain(encodedPassword);
			expect(prepared.command.replaceAll("\\:", ":")).toContain(url);
			expect(prepared.command).toContain("credential.helper=");
			expect(prepared.command).toContain("credential.useHttpPath=true");
			expect(prepared.command).toContain("GIT_CONFIG_GLOBAL=/dev/null");
			expect(prepared.command).toContain("GIT_CONFIG_NOSYSTEM=1");
			expect(prepared.command).toContain("http.sslVerify=true");
			expect(prepared.command).toContain("http.followRedirects=false");
			expect(prepared.command).toContain("protocol.allow=never");
			expect(prepared.command).toContain("protocol.https.allow=always");
			expect(prepared.command).toContain(
				`NEARZERO_GIT_ALLOWED_AUTHORITY=${new URL(url).host}`,
			);
			expect(prepared.command).toContain("remote set-url origin");
			expect(prepared.command).toContain("submodule sync --recursive");
			expect(prepared.command).toContain("submodule update --init --recursive");
			expect(prepared.command).not.toContain("clone --recurse-submodules");
			expect(prepared.command).toContain("cleanup_git_auth");
			expect(prepared.command).toContain("trap cleanup_git_auth EXIT");
			const syntax = spawnSync("/bin/sh", ["-n", "-c", prepared.command], {
				encoding: "utf8",
			});
			expect(syntax.status, syntax.stderr).toBe(0);
		},
	);

	it.each([
		"http://git.example.com/acme/repository.git",
		"https://user:token@git.example.com/acme/repository.git",
		"https://git.example.com/acme/repository.git?token=secret",
		"https://git.example.com/acme/repository.git#secret",
		"https://git.example.com/acme/repository.git\nmalformed",
	])("rejects an unsafe credentialed repository URL: %s", (repositoryUrl) => {
		expect(() =>
			prepareCredentialedGitClone({
				repositoryUrl,
				username: "oauth2",
				password: "token",
				branch: "main",
				outputPath: "/tmp/repository",
				enableSubmodules: false,
				isRemote: false,
			}),
		).toThrow(/HTTPS|credentials|query parameters|fragments|control data/i);
	});

	it("rejects control data that could corrupt the credential helper protocol", () => {
		expect(() =>
			prepareCredentialedGitClone({
				repositoryUrl: "https://git.example.com/acme/repository.git",
				username: "oauth2",
				password: "token\npassword=attacker-controlled",
				branch: "main",
				outputPath: "/tmp/repository",
				enableSubmodules: false,
				isRemote: false,
			}),
		).toThrow(/control data/i);
	});

	it("routes every hosted provider and deployment caller through prepared stdin", () => {
		for (const provider of ["github", "gitlab", "gitea", "bitbucket"]) {
			const source = readRepositoryFile(
				`packages/server/src/utils/providers/${provider}.ts`,
			);
			expect(source).toContain("prepareCredentialedGitClone");
			expect(source).not.toMatch(/https:\/\/\$\{[^}]*token/i);
		}

		for (const caller of [
			"packages/server/src/services/application.ts",
			"packages/server/src/services/patch-repo.ts",
			"packages/server/src/utils/docker/domain.ts",
		]) {
			const source = readRepositoryFile(caller);
			expect(source).toContain(".input");
		}
	});
});
