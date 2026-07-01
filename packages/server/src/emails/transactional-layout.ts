import { loginGridEmailBackgroundDataUri } from "./login-grid-email-background";

export const NEARZERO_WORDMARK = "Nearzero";

export const TRANSACTIONAL_EMAIL_SANS =
	"ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function transactionalEmailBrandHeaderHtml(): string {
	const sans = TRANSACTIONAL_EMAIL_SANS;
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse;">
  <tr>
    <td style="padding:0 10px 0 0;vertical-align:middle;">
      ${transactionalEmailBrandMarkOnlyHtml()}
    </td>
    <td style="padding:0;vertical-align:middle;font-family:${sans};font-size:12px;font-weight:600;letter-spacing:0.02em;color:#111827;">
      ${escapeHtml(NEARZERO_WORDMARK)}
    </td>
  </tr>
</table>`;
}

function transactionalEmailBrandMarkOnlyHtml(): string {
	const cell = 10;
	const gap = 2;
	return `<table role="presentation" cellpadding="0" cellspacing="${gap}" style="border-collapse:separate;border-spacing:${gap}px;">
    <tr>
      <td style="width:${cell}px;height:${cell}px;background:#111827;border-radius:2px;line-height:0;font-size:0;">&#8203;</td>
      <td style="width:${cell}px;height:${cell}px;background:#111827;border-radius:2px;line-height:0;font-size:0;">&#8203;</td>
    </tr>
    <tr>
      <td style="width:${cell}px;height:${cell}px;background:#111827;border-radius:2px;line-height:0;font-size:0;">&#8203;</td>
      <td style="width:${cell}px;height:${cell}px;background:#d1d5db;border-radius:2px;line-height:0;font-size:0;">&#8203;</td>
    </tr>
  </table>`;
}

export function transactionalEmailPageOpenHtml(title: string): string {
	const gridBg = loginGridEmailBackgroundDataUri();
	const sans = TRANSACTIONAL_EMAIL_SANS;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#eceef3;background-image:url('${gridBg}');font-family:${sans};">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px 40px;">
    <div style="background:#ffffff;border:1px solid #eceef3;border-radius:6px;padding:24px 24px 28px;box-shadow:0 1px 2px rgba(0,0,0,0.04);">`;
}

export function transactionalEmailPageCloseHtml(): string {
	return `    </div>
  </div>
</body>
</html>`;
}
