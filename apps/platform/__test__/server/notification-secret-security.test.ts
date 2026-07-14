import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toPublicNotification } from "@/server/api/utils/public-notification";

describe("notification credential boundaries", () => {
	it("removes every delivery credential without mutating internal state", () => {
		const canaries = [
			"SLACK_WEBHOOK_CANARY",
			"TELEGRAM_BOT_CANARY",
			"DISCORD_WEBHOOK_CANARY",
			"SMTP_PASSWORD_CANARY",
			"RESEND_KEY_CANARY",
			"GOTIFY_TOKEN_CANARY",
			"NTFY_ACCESS_TOKEN_CANARY",
			"NTFY_TOPIC_CANARY",
			"MATTERMOST_WEBHOOK_CANARY",
			"CUSTOM_ENDPOINT_CANARY",
			"CUSTOM_HEADER_CANARY",
			"LARK_WEBHOOK_CANARY",
			"PUSHOVER_USER_CANARY",
			"PUSHOVER_TOKEN_CANARY",
			"TEAMS_WEBHOOK_CANARY",
		];
		const stored = {
			notificationId: "notification-a",
			slack: { slackId: "slack-a", webhookUrl: canaries[0] },
			telegram: { telegramId: "telegram-a", botToken: canaries[1] },
			discord: { discordId: "discord-a", webhookUrl: canaries[2] },
			email: { emailId: "email-a", password: canaries[3] },
			resend: { resendId: "resend-a", apiKey: canaries[4] },
			gotify: { gotifyId: "gotify-a", appToken: canaries[5] },
			ntfy: {
				ntfyId: "ntfy-a",
				accessToken: canaries[6],
				topic: canaries[7],
			},
			mattermost: {
				mattermostId: "mattermost-a",
				webhookUrl: canaries[8],
			},
			custom: {
				customId: "custom-a",
				endpoint: canaries[9],
				headers: { Authorization: canaries[10] },
			},
			lark: { larkId: "lark-a", webhookUrl: canaries[11] },
			pushover: {
				pushoverId: "pushover-a",
				userKey: canaries[12],
				apiToken: canaries[13],
			},
			teams: { teamsId: "teams-a", webhookUrl: canaries[14] },
		};

		const publicNotification = toPublicNotification(stored);
		const serialized = JSON.stringify(publicNotification);
		for (const canary of canaries) expect(serialized).not.toContain(canary);
		for (const relation of Object.keys(stored).filter(
			(key) => key !== "notificationId",
		)) {
			expect(publicNotification[relation]).toMatchObject({
				hasCredentials: true,
			});
		}

		expect(stored.slack.webhookUrl).toBe(canaries[0]);
		expect(stored.custom.headers.Authorization).toBe(canaries[10]);
	});

	it("wires notification reads through the public mapper and avoids raw errors", () => {
		const router = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/notification.ts"),
			"utf8",
		);
		const delivery = readFileSync(
			path.resolve(
				process.cwd(),
				"../../packages/server/src/utils/notifications/utils.ts",
			),
			"utf8",
		);

		expect(router).toContain("return toPublicNotification(notification)");
		expect(router.match(/results\.map\(toPublicNotification\)/g)).toHaveLength(
			2,
		);
		expect(delivery).not.toMatch(
			/console\.(?:log|error)\([^)]*,\s*(?:err|error)/,
		);
		expect(delivery).not.toMatch(/\$\{(?:err|error).*?\.message/);
	});
});
