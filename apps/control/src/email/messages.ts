import type { OutgoingEmail } from "./transport.ts";

/** The emails Nearzero sends for identity and access, as plain text and simple HTML. */

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(
  to: string,
  subject: string,
  paragraphs: string[],
  link?: { url: string; label: string },
  extra: { heading?: string; footer?: string } = {},
) {
  const text = [
    ...(extra.heading ? [extra.heading] : []),
    ...paragraphs,
    ...(link ? [`${link.label}: ${link.url}`] : []),
    ...(extra.footer ? [extra.footer] : []),
  ].join("\n\n");
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1c1b22">',
    ...(extra.heading
      ? [
          `<h1 style="font-size:20px;line-height:28px;margin:0 0 12px">${escapeHtml(extra.heading)}</h1>`,
        ]
      : []),
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(link
      ? [
          `<p><a href="${escapeHtml(link.url)}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#6d4aff;color:#ffffff;text-decoration:none">${escapeHtml(link.label)}</a></p>`,
          `<p style="font-size:13px;color:#5b5870">Or open this address: ${escapeHtml(link.url)}</p>`,
        ]
      : []),
    ...(extra.footer
      ? [`<p style="font-size:13px;color:#5b5870">${escapeHtml(extra.footer)}</p>`]
      : []),
    "</div>",
  ].join("");
  return { to, subject, text, html } satisfies OutgoingEmail;
}

const ROLE_WORDS = { admin: "an admin", member: "a member" } as const;

/** The longest inviter name an invitation email shows (the C1-22 decision in spec 31). */
export const INVITER_NAME_MAX = 60;

/**
 * The invitation email (spec 04 4.5, 31a G1-07, the C1-22 decision in spec 31). Its opening words
 * are fixed, so an inviter can't write the email's first line by naming themselves; who sent it
 * comes on a line of its own, with their address, and a name cut at 60 characters.
 */
export function invitationEmail(input: {
  to: string;
  workspaceName: string;
  inviter: { name: string | null; email: string } | null;
  role: "admin" | "member";
  link: string;
}): OutgoingEmail {
  const name = input.inviter?.name?.replace(/\s+/g, " ").trim() ?? "";
  const shortName =
    name.length > INVITER_NAME_MAX ? `${name.slice(0, INVITER_NAME_MAX - 1).trimEnd()}…` : name;
  const sentBy = input.inviter
    ? shortName
      ? `Sent by ${shortName} (${input.inviter.email})`
      : `Sent by ${input.inviter.email}`
    : null;
  return render(
    input.to,
    `You've been invited to join ${input.workspaceName} on Nearzero`,
    [
      `You've been invited to join ${input.workspaceName} on Nearzero.`,
      ...(sentBy ? [sentBy] : []),
      `You'll join as ${ROLE_WORDS[input.role]}. The link works only for ${input.to} and expires in 7 days.`,
    ],
    { url: input.link, label: "Accept invitation" },
    {
      heading: `You've been invited to join ${input.workspaceName}`,
      footer: `This invitation was intended for ${input.to}. If you were not expecting this invitation, you can safely ignore this email.`,
    },
  );
}

/** Sent on "Save and send a test" (31a G1-07). */
export function testEmail(input: { to: string; workspaceName: string }): OutgoingEmail {
  return render(input.to, "Nearzero invitation emails are working", [
    `Invitation emails for ${input.workspaceName} are set up. People you invite will get their invitation from this address.`,
  ]);
}

export function emailChangedNotice(input: { to: string; newEmail: string }): OutgoingEmail {
  return render(input.to, "Your Nearzero email address was changed", [
    `The email address of your Nearzero account was changed to ${input.newEmail}.`,
    "If you didn't make this change, ask your Nearzero administrator to reset your account's password right away.",
  ]);
}

/**
 * The welcome email (spec 04 4.3, 30a R1-05): to the owner when they finish onboarding, and to
 * an invited member after their name step (or when they join, if they already have a name).
 */
export function welcomeEmail(input: {
  to: string;
  firstName: string | null;
  workspaceName: string;
  /** The workspace's Agent, `<console>/<slug>/dashboard/agent`, or null without a console address. */
  agentUrl: string | null;
}): OutgoingEmail {
  const greeting = `Welcome to Nearzero, ${input.firstName?.trim() || "there"}`;
  return render(
    input.to,
    greeting,
    [
      `Your workspace ${input.workspaceName} is ready. Nearzero helps your team deploy apps, manage services, and run infrastructure from one place.`,
    ],
    input.agentUrl ? { url: input.agentUrl, label: "Open your dashboard" } : undefined,
    { heading: greeting, footer: `This message was sent to ${input.to}.` },
  );
}

/** How long a link that confirms an email address works (spec 04 4.6). */
export const EMAIL_CONFIRMATION_HOURS = 24;

/**
 * The link that proves an email address (spec 04 4.6, 30a R1-02): sent to a new address after a
 * change, or to the account's own unproven address when the person asks for it.
 */
export function emailConfirmationEmail(input: {
  to: string;
  /** The account's address now, when this link would replace it; null to confirm `to` itself. */
  replacing: string | null;
  link: string;
}): OutgoingEmail {
  const until = `The link works for ${EMAIL_CONFIRMATION_HOURS} hours, only while you're signed in to Nearzero as this account.`;
  if (input.replacing) {
    return render(
      input.to,
      "Confirm your new Nearzero email address",
      [
        `Open this link to make ${input.to} the email address of your Nearzero account. Until you do, ${input.replacing} stays in use.`,
        until,
        "If you didn't ask for this, ignore this email; nothing changes.",
      ],
      { url: input.link, label: "Confirm email address" },
    );
  }
  return render(
    input.to,
    "Confirm your Nearzero email address",
    [
      `Open this link to confirm that ${input.to} is the email address of your Nearzero account. Invitations sent to it then show up in your notifications.`,
      until,
    ],
    { url: input.link, label: "Confirm email address" },
  );
}
