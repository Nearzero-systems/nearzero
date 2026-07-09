function parsePositiveInt(raw: string | undefined, fallback: number) {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getOtpExpiresInSeconds() {
	return parsePositiveInt(process.env.NEARZERO_AUTH_OTP_TTL_MS, 600_000) / 1000;
}

/** OTP auth works out of the box — codes are written to server logs (docker logs). */
export function assertAuthOtpDeliveryReady() {
	return;
}

export async function sendAuthOtpEmail(input: {
	email: string;
	code: string;
	type?: string;
}) {
	const label = input.type ? `${input.type} ` : "";
	console.log(
		`[nearzero auth] ${label}code for ${input.email}: ${input.code}`,
	);
	return "console" as const;
}
