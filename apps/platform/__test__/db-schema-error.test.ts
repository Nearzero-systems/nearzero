import {
	isMissingRelationOrColumnError,
	isPostgresArgumentLimitError,
	rethrowUnlessSchemaDrift,
} from "@nearzero/server/services/db-schema-error";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

describe("db schema error mapping", () => {
	it("detects missing relation/column postgres codes", () => {
		expect(
			isMissingRelationOrColumnError({
				cause: { code: "42703", message: 'column "isSystemAssigned" does not exist' },
			}),
		).toBe(true);
		expect(
			isMissingRelationOrColumnError({
				cause: { code: "42P01", message: 'relation "dns_zone" does not exist' },
			}),
		).toBe(true);
		expect(
			isMissingRelationOrColumnError({
				cause: { code: "28P01", message: "password authentication failed" },
			}),
		).toBe(false);
	});

	it("detects the postgres 100-argument function limit", () => {
		expect(
			isPostgresArgumentLimitError({
				cause: {
					code: "54023",
					message: "cannot pass more than 100 arguments to a function",
				},
			}),
		).toBe(true);
	});

	it("maps schema drift to PRECONDITION_FAILED", () => {
		expect(() =>
			rethrowUnlessSchemaDrift(
				{ cause: { code: "42703" } },
				"Domain hostnames",
			),
		).toThrow(TRPCError);

		try {
			rethrowUnlessSchemaDrift(
				{ cause: { code: "42703" } },
				"Domain hostnames",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
			expect((error as TRPCError).message).toContain("database migration");
		}
	});
});
