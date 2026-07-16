import { TRPCError } from "@trpc/server";

function postgresErrorCode(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current; depth += 1) {
		if (typeof current === "object" && current !== null) {
			const code = Reflect.get(current, "code");
			if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
				return code;
			}
			current = Reflect.get(current, "cause");
			continue;
		}
		break;
	}
	return null;
}

export function isMissingRelationOrColumnError(error: unknown): boolean {
	const code = postgresErrorCode(error);
	return code === "42P01" || code === "42703";
}

export function isPostgresArgumentLimitError(error: unknown): boolean {
	return postgresErrorCode(error) === "54023";
}

/** Map known DB failure modes to clear client-facing TRPC errors. */
export function rethrowUnlessSchemaDrift(
	error: unknown,
	feature = "This feature",
): never {
	if (isMissingRelationOrColumnError(error)) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `${feature} needs a database migration. Restart the Nearzero platform container so migrations can apply, then reload.`,
			cause: error,
		});
	}
	if (isPostgresArgumentLimitError(error)) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `${feature} query is too wide for Postgres. Update Nearzero and retry.`,
			cause: error,
		});
	}
	throw error;
}
