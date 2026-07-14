import { readFileSync } from "node:fs";
import path from "node:path";
import type { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import {
	assertGitProviderUrlConfigurationAllowed,
	parseGitProviderBaseUrl,
} from "@/server/api/utils/git-provider-url-security";

describe("Git provider server-side URL policy", () => {
	it("allows members to use normalized standard SaaS URLs", () => {
		expect(
			assertGitProviderUrlConfigurationAllowed({
				providerType: "gitlab",
				userRole: "member",
				providerUrl: " https://gitlab.com/ ",
			}),
		).toEqual({ providerUrl: "https://gitlab.com", internalUrl: null });

		expect(
			assertGitProviderUrlConfigurationAllowed({
				providerType: "gitea",
				userRole: "member",
				providerUrl: "https://gitea.com/",
			}),
		).toEqual({ providerUrl: "https://gitea.com", internalUrl: null });
	});

	it("requires owner or admin for self-hosted and internal endpoints", () => {
		for (const configuration of [
			{
				providerType: "gitlab" as const,
				providerUrl: "https://gitlab.internal.example",
			},
			{
				providerType: "gitea" as const,
				providerUrl: "https://gitea.com",
				internalUrl: "http://gitea.service:3000",
			},
		]) {
			expect(() =>
				assertGitProviderUrlConfigurationAllowed({
					...configuration,
					userRole: "member",
				}),
			).toThrow();
			try {
				assertGitProviderUrlConfigurationAllowed({
					...configuration,
					userRole: "member",
				});
			} catch (error) {
				expect(error).toMatchObject({
					code: "FORBIDDEN",
				} satisfies Partial<TRPCError>);
			}
		}

		expect(
			assertGitProviderUrlConfigurationAllowed({
				providerType: "gitea",
				userRole: "admin",
				providerUrl: "https://git.example.test/gitea/",
				internalUrl: "http://gitea.service:3000/",
			}),
		).toEqual({
			providerUrl: "https://git.example.test/gitea",
			internalUrl: "http://gitea.service:3000",
		});
	});

	it("rejects non-HTTP schemes, embedded credentials, queries, and fragments", () => {
		for (const value of [
			"file:///etc/passwd",
			"ssh://git@gitlab.example/repository",
			"https://user:password@gitlab.example",
			"https://gitlab.example?target=http://metadata.internal",
			"https://gitea.example/#fragment",
			"not a URL",
			"",
		]) {
			expect(() => parseGitProviderBaseUrl(value)).toThrow();
		}
	});

	it("enforces the policy at create, update, and callback boundaries", () => {
		const routerDirectory = path.resolve(process.cwd(), "server/api/routers");
		for (const routerName of ["gitlab", "gitea"]) {
			const source = readFileSync(
				path.join(routerDirectory, `${routerName}.ts`),
				"utf8",
			);
			expect(
				source.match(/assertGitProviderUrlConfigurationAllowed/g)?.length,
			).toBeGreaterThanOrEqual(3);
		}

		const handlerDirectory = path.resolve(
			process.cwd(),
			"server/routes/handlers/providers",
		);
		for (const handlerPath of [
			"gitlab/callback.ts",
			"gitea/callback.ts",
			"gitea/authorize.ts",
		]) {
			const source = readFileSync(
				path.join(handlerDirectory, handlerPath),
				"utf8",
			);
			expect(source).toContain("parseGitProviderBaseUrl");
			expect(source).not.toMatch(/username.*password|password.*username/);
		}
	});
});
