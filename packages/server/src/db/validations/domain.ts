import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";

const unsafeTraefikRuleCharacter = /[`\u0000-\u001f\u007f]/;
const traefikNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const traefikMiddlewarePattern =
	/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:@[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;

export const isValidDomainHost = (value: string): boolean => {
	if (
		value !== value.trim() ||
		value.length === 0 ||
		value.includes("*") ||
		/[\s/:?#@[\]\\]/u.test(value) ||
		unsafeTraefikRuleCharacter.test(value)
	) {
		return false;
	}

	const ascii = domainToASCII(value).toLowerCase();
	if (!ascii || ascii.length > 253) return false;
	if (isIP(ascii) === 4) return true;
	// IPv6 literals contain ':' and cannot safely be used as a DNS hostname here.
	if (isIP(ascii) !== 0) return false;

	return ascii.split(".").every(
		(label) =>
			label.length > 0 &&
			label.length <= 63 &&
			/^[a-z0-9-]+$/.test(label) &&
			!label.startsWith("-") &&
			!label.endsWith("-"),
	);
};

export const isSafeTraefikRuleFragment = (value: string): boolean =>
	!unsafeTraefikRuleCharacter.test(value);

const hostSchema = z
	.string()
	.min(1, { message: "Add a hostname" })
	.refine((value) => value === value.trim(), {
		message: "Domain name cannot have leading or trailing spaces",
	})
	.refine(isValidDomainHost, {
		message: "Enter a valid hostname without a URL, port, wildcard, or spaces",
	})
	.transform((value) => value.toLowerCase());

const pathSchema = z
	.string()
	.min(1)
	.max(2048)
	.refine((value) => value.startsWith("/"), {
		message: "Path must start with '/'",
	})
	.refine(isSafeTraefikRuleFragment, {
		message: "Path contains characters that are unsafe in a routing rule",
	});

const optionalTraefikNameSchema = z
	.string()
	.max(128)
	.refine(
		(value) => value === "" || traefikNamePattern.test(value),
		"Use only letters, numbers, periods, underscores, and hyphens",
	);

const middlewareSchema = z
	.string()
	.max(256)
	.regex(
		traefikMiddlewarePattern,
		"Middleware names may only contain letters, numbers, periods, underscores, hyphens, and one provider separator",
	);

export const domain = z
	.object({
		host: hostSchema,
		path: pathSchema.optional(),
		internalPath: pathSchema.optional(),
		stripPath: z.boolean().optional(),
		port: z
			.number()
			.min(1, { message: "Port must be at least 1" })
			.max(65535, { message: "Port must be 65535 or below" })
			.optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customEntrypoint: optionalTraefikNameSchema.nullable().optional(),
		customCertResolver: optionalTraefikNameSchema,
		middlewares: z.array(middlewareSchema).max(64).optional(),
	})
	.superRefine((input, ctx) => {
		if (input.https && !input.certificateType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["certificateType"],
				message: "Required",
			});
		}

		if (input.certificateType === "custom" && !input.customCertResolver) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["customCertResolver"],
				message: "Required when certificate type is custom",
			});
		}

		// Validate stripPath requires a valid path
		if (input.stripPath && (!input.path || input.path === "/")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["stripPath"],
				message:
					"Strip path can only be enabled when a path other than '/' is specified",
			});
		}

		// Validate internalPath starts with /
		if (
			input.internalPath &&
			input.internalPath !== "/" &&
			!input.internalPath.startsWith("/")
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["internalPath"],
				message: "Internal path must start with '/'",
			});
		}
	});

export const domainCompose = z
	.object({
		host: hostSchema,
		path: pathSchema.optional(),
		internalPath: pathSchema.optional(),
		stripPath: z.boolean().optional(),
		port: z
			.number()
			.min(1, { message: "Port must be at least 1" })
			.max(65535, { message: "Port must be 65535 or below" })
			.optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customEntrypoint: optionalTraefikNameSchema.nullable().optional(),
		customCertResolver: optionalTraefikNameSchema,
		serviceName: z.string().min(1, { message: "Service name is required" }),
		middlewares: z.array(middlewareSchema).max(64).optional(),
	})
	.superRefine((input, ctx) => {
		if (input.https && !input.certificateType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["certificateType"],
				message: "Required",
			});
		}

		if (input.certificateType === "custom" && !input.customCertResolver) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["customCertResolver"],
				message: "Required when certificate type is custom",
			});
		}

		// Validate stripPath requires a valid path
		if (input.stripPath && (!input.path || input.path === "/")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["stripPath"],
				message:
					"Strip path can only be enabled when a path other than '/' is specified",
			});
		}

		// Validate internalPath starts with /
		if (
			input.internalPath &&
			input.internalPath !== "/" &&
			!input.internalPath.startsWith("/")
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["internalPath"],
				message: "Internal path must start with '/'",
			});
		}
	});
