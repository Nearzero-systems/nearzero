import { Resend } from "resend";

const RESEND_API_KEY =
	process.env.RESEND_API_KEY || process.env.NEARZERO_RESEND_API_KEY || "";
const RESEND_FROM_EMAIL =
	process.env.NEARZERO_AUTH_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || "";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function isValidFromEmail(value: string): boolean {
	const raw = String(value || "").trim();
	if (!raw) return false;
	if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw)) return true;
	if (/^[^<>]+<\s*[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>$/.test(raw)) return true;
	return false;
}

export function isTransactionalEmailConfigured() {
	return Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);
}

export async function sendTransactionalEmail(input: {
	to: string;
	subject: string;
	html: string;
	text?: string;
}) {
	if (RESEND_API_KEY && !RESEND_FROM_EMAIL) {
		throw new Error(
			"Resend is configured without sender email. Set NEARZERO_AUTH_FROM_EMAIL (e.g. Nearzero <onboarding@resend.dev>).",
		);
	}

	if (!RESEND_API_KEY && RESEND_FROM_EMAIL) {
		throw new Error(
			"NEARZERO_AUTH_FROM_EMAIL is set but RESEND_API_KEY is missing.",
		);
	}

	if (resend && RESEND_FROM_EMAIL) {
		if (!isValidFromEmail(RESEND_FROM_EMAIL)) {
			throw new Error(
				"Invalid NEARZERO_AUTH_FROM_EMAIL format. Use sender@domain.com or Name <sender@domain.com>.",
			);
		}

		const result = await resend.emails.send({
			from: RESEND_FROM_EMAIL,
			to: input.to,
			subject: input.subject,
			html: input.html,
			text: input.text,
		});

		if (result.error) {
			const message =
				result.error.message ||
				result.error.name ||
				"Resend returned an unknown delivery error.";
			throw new Error(`Resend delivery failed: ${message}`);
		}

		return "email" as const;
	}

	if (process.env.NODE_ENV === "development") {
		console.log(
			`[email] Transactional email to ${input.to}: ${input.subject} (Resend not configured)`,
		);
		return "console" as const;
	}

	throw new Error(
		"Transactional email is not configured. Set RESEND_API_KEY and NEARZERO_AUTH_FROM_EMAIL.",
	);
}
