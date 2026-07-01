import { Resend } from "resend";
import {
	renderOtpSignInEmailHtml,
	renderOtpSignInEmailText,
} from "../emails/render-otp-sign-in-email";
import { NEARZERO_WORDMARK } from "../emails/transactional-layout";

const RESEND_API_KEY =
	process.env.RESEND_API_KEY || process.env.NEARZERO_RESEND_API_KEY || "";
const RESEND_FROM_EMAIL =
	process.env.NEARZERO_AUTH_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || "";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function parsePositiveInt(raw: string | undefined, fallback: number) {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getOtpExpiresInSeconds() {
	return parsePositiveInt(process.env.NEARZERO_AUTH_OTP_TTL_MS, 600_000) / 1000;
}

export function assertAuthOtpDeliveryReady() {
	const hasResend = Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);
	const debugOtp =
		process.env.NEARZERO_AUTH_DEBUG_OTP === "true" ||
		process.env.NEARZERO_AUTH_DEBUG_OTP === "1";
	const devFallback = process.env.NODE_ENV === "development";

	if (hasResend || debugOtp || devFallback) return;

	throw new Error(
		"Email delivery is not configured. Set RESEND_API_KEY and NEARZERO_AUTH_FROM_EMAIL, or enable NEARZERO_AUTH_DEBUG_OTP for local development.",
	);
}

function logDevOtp(email: string, code: string, note?: string) {
	if (process.env.NODE_ENV !== "development") return;
	const suffix = note ? ` (${note})` : "";
	console.log(`[auth] OTP for ${email}: ${code}${suffix}`);
}

function isValidFromEmail(value: string): boolean {
	const raw = String(value || "").trim();
	if (!raw) return false;
	if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw)) return true;
	if (/^[^<>]+<\s*[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>$/.test(raw)) return true;
	return false;
}

export async function sendAuthOtpEmail(input: {
	email: string;
	code: string;
}) {
	const expiresInMinutes = Math.max(
		1,
		Math.round(getOtpExpiresInSeconds() / 60),
	);
	const subject = `Your ${NEARZERO_WORDMARK} sign-in code`;
	const text = renderOtpSignInEmailText({
		code: input.code,
		expiresInMinutes,
	});
	const html = renderOtpSignInEmailHtml({
		code: input.code,
		expiresInMinutes,
	});

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
			to: input.email,
			subject,
			text,
			html,
		});

		if (result.error) {
			const message =
				result.error.message ||
				result.error.name ||
				"Resend returned an unknown delivery error.";
			logDevOtp(input.email, input.code, `Resend failed: ${message}`);
			if (process.env.NODE_ENV === "development") {
				return "console" as const;
			}
			throw new Error(`Resend delivery failed: ${message}`);
		}

		return "email" as const;
	}

	logDevOtp(
		input.email,
		input.code,
		RESEND_API_KEY ? "Resend not fully configured" : "No Resend API key",
	);

	return "console" as const;
}
