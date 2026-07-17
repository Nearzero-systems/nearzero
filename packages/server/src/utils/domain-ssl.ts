export type DomainCertificateType = "letsencrypt" | "none" | "custom";

/**
 * Domains always get automatic Let's Encrypt HTTPS unless a custom resolver
 * is explicitly requested. Callers should not offer HTTP-only / no-cert paths
 * for normal hostname registration or service assignment.
 */
export function resolveAutomaticDomainSsl(input: {
	https?: boolean | null;
	certificateType?: DomainCertificateType | null;
}): {
	https: boolean;
	certificateType: DomainCertificateType;
} {
	if (input.certificateType === "custom") {
		return {
			https: input.https ?? true,
			certificateType: "custom",
		};
	}
	return {
		https: true,
		certificateType: "letsencrypt",
	};
}
