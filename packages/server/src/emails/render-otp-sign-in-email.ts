import {
	NEARZERO_WORDMARK,
	transactionalEmailBrandHeaderHtml,
	transactionalEmailPageCloseHtml,
	transactionalEmailPageOpenHtml,
	TRANSACTIONAL_EMAIL_SANS,
} from "./transactional-layout";

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function renderOtpSignInEmailHtml(input: {
	code: string;
	expiresInMinutes: number;
}): string {
	const sans = TRANSACTIONAL_EMAIL_SANS;
	const code = escapeHtml(input.code);
	const inner = `${transactionalEmailBrandHeaderHtml()}
      <h1 style="margin:0 0 12px;font-family:${sans};font-size:18px;line-height:1.35;font-weight:700;color:#111827;">
        Your sign-in code
      </h1>
      <p style="margin:0 0 14px;font-family:${sans};font-size:12px;line-height:1.55;color:#4b5563;">
        Use this code to sign in to ${escapeHtml(NEARZERO_WORDMARK)}. If you did not request it, you can ignore this email.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
        <tr>
          <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 20px;">
            <span style="font-family:${sans};font-size:22px;font-weight:700;letter-spacing:0.12em;color:#111827;">${code}</span>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-family:${sans};font-size:12px;line-height:1.5;color:#6b7280;">
        This code expires in ${escapeHtml(String(input.expiresInMinutes))} minutes.
      </p>`;

	return `${transactionalEmailPageOpenHtml(`Sign in to ${NEARZERO_WORDMARK}`)}${inner}${transactionalEmailPageCloseHtml()}`;
}

export function renderOtpSignInEmailText(input: {
	code: string;
	expiresInMinutes: number;
}): string {
	return [
		`Your ${NEARZERO_WORDMARK} sign-in code is ${input.code}.`,
		"",
		`It expires in ${input.expiresInMinutes} minutes.`,
		"",
		"If you did not request this code, you can ignore this email.",
	].join("\n");
}
