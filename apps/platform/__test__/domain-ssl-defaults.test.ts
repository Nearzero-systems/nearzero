import { describe, expect, it } from "vitest";
import { resolveAutomaticDomainSsl } from "@nearzero/server/utils/domain-ssl";

describe("resolveAutomaticDomainSsl", () => {
	it("defaults to Let's Encrypt HTTPS", () => {
		expect(resolveAutomaticDomainSsl({})).toEqual({
			https: true,
			certificateType: "letsencrypt",
		});
	});

	it("upgrades HTTP-only and none certificate requests", () => {
		expect(
			resolveAutomaticDomainSsl({
				https: false,
				certificateType: "none",
			}),
		).toEqual({
			https: true,
			certificateType: "letsencrypt",
		});
	});

	it("preserves custom certificate resolvers", () => {
		expect(
			resolveAutomaticDomainSsl({
				https: true,
				certificateType: "custom",
			}),
		).toEqual({
			https: true,
			certificateType: "custom",
		});
	});
});
