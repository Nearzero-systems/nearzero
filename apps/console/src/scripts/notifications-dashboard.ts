import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { closeDialog, openDialog, showToast } from "@/scripts/ui";

type ProviderType =
	| "slack"
	| "telegram"
	| "discord"
	| "email"
	| "resend"
	| "gotify"
	| "ntfy"
	| "mattermost"
	| "pushover"
	| "custom"
	| "lark"
	| "teams";

type EventFlags = {
	appDeploy: boolean;
	appBuildError: boolean;
	databaseBackup: boolean;
	nearzeroBackup: boolean;
	volumeBackup: boolean;
	nearzeroRestart: boolean;
	dockerCleanup: boolean;
	serverThreshold: boolean;
};

type ProviderIds = {
	slackId?: string;
	telegramId?: string;
	discordId?: string;
	emailId?: string;
	resendId?: string;
	gotifyId?: string;
	ntfyId?: string;
	mattermostId?: string;
	pushoverId?: string;
	customId?: string;
	larkId?: string;
	teamsId?: string;
};

const PROVIDERS: { type: ProviderType; label: string }[] = [
	{ type: "slack", label: "Slack" },
	{ type: "telegram", label: "Telegram" },
	{ type: "discord", label: "Discord" },
	{ type: "lark", label: "Lark" },
	{ type: "teams", label: "Microsoft Teams" },
	{ type: "email", label: "Email" },
	{ type: "resend", label: "Resend" },
	{ type: "gotify", label: "Gotify" },
	{ type: "ntfy", label: "ntfy" },
	{ type: "mattermost", label: "Mattermost" },
	{ type: "pushover", label: "Pushover" },
	{ type: "custom", label: "Custom" },
];

const CREDENTIAL_INPUT_IDS: Record<ProviderType, string[]> = {
	slack: ["nz-notif-slack-webhook"],
	telegram: ["nz-notif-telegram-token"],
	discord: ["nz-notif-discord-webhook"],
	email: ["nz-notif-email-password"],
	resend: ["nz-notif-resend-api-key"],
	gotify: ["nz-notif-gotify-token"],
	ntfy: ["nz-notif-ntfy-topic", "nz-notif-ntfy-token"],
	mattermost: ["nz-notif-mattermost-webhook"],
	pushover: ["nz-notif-pushover-user", "nz-notif-pushover-token"],
	custom: ["nz-notif-custom-endpoint"],
	lark: ["nz-notif-lark-webhook"],
	teams: ["nz-notif-teams-webhook"],
};

const inputClass = "nz-modal__input";

function val(id: string) {
	return (
		(document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ""
	);
}

function numVal(id: string, fallback?: number) {
	const raw = val(id);
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? fallback : n;
}

function checked(id: string) {
	return (
		(document.getElementById(id) as HTMLInputElement | null)?.checked ?? false
	);
}

function setVal(id: string, value: string | number | boolean | undefined) {
	const el = document.getElementById(id);
	if (!(el instanceof HTMLInputElement)) return;
	if (el.type === "checkbox") el.checked = Boolean(value);
	else el.value = value == null ? "" : String(value);
}

function setCredentialPlaceholders(
	type?: ProviderType,
	hasConfiguredCredentials = false,
) {
	for (const [providerType, ids] of Object.entries(CREDENTIAL_INPUT_IDS)) {
		for (const id of ids) {
			const input = document.getElementById(id);
			if (!(input instanceof HTMLInputElement)) continue;
			input.dataset.defaultPlaceholder ??= input.placeholder;
			input.placeholder =
				type === providerType && hasConfiguredCredentials
					? "Configured — leave blank to keep"
					: (input.dataset.defaultPlaceholder ?? "");
		}
	}
}

function collectEvents(): EventFlags {
	return {
		appDeploy: checked("nz-notif-app-deploy"),
		appBuildError: checked("nz-notif-app-build-error"),
		databaseBackup: checked("nz-notif-database-backup"),
		nearzeroBackup: checked("nz-notif-nearzero-backup"),
		volumeBackup: checked("nz-notif-volume-backup"),
		nearzeroRestart: checked("nz-notif-nearzero-restart"),
		dockerCleanup: checked("nz-notif-docker-cleanup"),
		serverThreshold: checked("nz-notif-server-threshold"),
	};
}

function collectToAddresses(): string[] {
	return Array.from(document.querySelectorAll("[data-notif-to-address]"))
		.map((el) => (el instanceof HTMLInputElement ? el.value.trim() : ""))
		.filter(Boolean);
}

function collectHeaders(): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	document.querySelectorAll("[data-notif-header-row]").forEach((row) => {
		const key = row.querySelector(
			"[data-notif-header-key]",
		) as HTMLInputElement | null;
		const value = row.querySelector(
			"[data-notif-header-value]",
		) as HTMLInputElement | null;
		const k = key?.value.trim() ?? "";
		if (k) headers[k] = value?.value ?? "";
	});
	return Object.keys(headers).length ? headers : undefined;
}

function getSelectedType(): ProviderType {
	const selected = document.querySelector(
		'input[name="nz-notif-type"]:checked',
	) as HTMLInputElement | null;
	return (selected?.value as ProviderType) ?? "slack";
}

function setSelectedType(type: ProviderType) {
	const radio = document.querySelector(
		`input[name="nz-notif-type"][value="${type}"]`,
	) as HTMLInputElement | null;
	if (radio) radio.checked = true;
	updateProviderPanels(type);
	updateProviderRadios(type);
}

function updateProviderRadios(_active: ProviderType) {
	/* Selection styling handled via .nz-notif-provider-card:has(:checked) in CSS */
}

function updateProviderPanels(type: ProviderType) {
	document.querySelectorAll("[data-notif-panel]").forEach((panel) => {
		const match = panel.getAttribute("data-notif-panel") === type;
		panel.classList.toggle("hidden", !match);
	});
	document.querySelectorAll("[data-notif-shared-panel]").forEach((panel) => {
		const types =
			panel.getAttribute("data-notif-shared-panel")?.split(" ") ?? [];
		panel.classList.toggle("hidden", !types.includes(type));
	});
	const pushoverExtra = document.getElementById("nz-notif-pushover-emergency");
	if (pushoverExtra) {
		pushoverExtra.classList.toggle(
			"hidden",
			type !== "pushover" || numVal("nz-notif-pushover-priority", 0) !== 2,
		);
	}
}

function renderToAddresses(values: string[]) {
	const container = document.getElementById("nz-notif-to-addresses");
	if (!container) return;
	container.innerHTML = "";
	for (const email of values.length ? values : [""]) addToAddressRow(email);
}

function addToAddressRow(value = "") {
	const container = document.getElementById("nz-notif-to-addresses");
	if (!container) return;
	const row = document.createElement("div");
	row.className = "flex flex-row gap-2 w-full items-end";
	row.innerHTML = `
		<label class="nz-modal__field flex-1 min-w-0">
			<span class="nz-modal__label">Email</span>
			<input type="email" data-notif-to-address value="${value.replace(/"/g, "&quot;")}" placeholder="email@example.com" class="${inputClass}" />
		</label>
		<button type="button" class="nz-modal__btn nz-modal__btn--ghost shrink-0" data-notif-remove-to>Remove</button>
	`;
	row.querySelector("[data-notif-remove-to]")?.addEventListener("click", () => {
		if (container.children.length > 1) row.remove();
	});
	container.appendChild(row);
}

function renderHeaders(entries: Array<{ key: string; value: string }>) {
	const container = document.getElementById("nz-notif-headers");
	if (!container) return;
	container.innerHTML = "";
	for (const entry of entries.length ? entries : [])
		addHeaderRow(entry.key, entry.value);
}

function addHeaderRow(key = "", value = "") {
	const container = document.getElementById("nz-notif-headers");
	if (!container) return;
	const row = document.createElement("div");
	row.className = "flex items-center gap-2";
	row.setAttribute("data-notif-header-row", "1");
	row.innerHTML = `
		<label class="nz-modal__field flex-1 min-w-0">
			<span class="nz-modal__label">Key</span>
			<input type="text" data-notif-header-key value="${key.replace(/"/g, "&quot;")}" placeholder="Key" class="${inputClass}" />
		</label>
		<label class="nz-modal__field flex-[2] min-w-0">
			<span class="nz-modal__label">Value</span>
			<input type="text" data-notif-header-value value="${value.replace(/"/g, "&quot;")}" placeholder="Value" class="${inputClass}" />
		</label>
		<button type="button" class="nz-modal__btn nz-modal__btn--ghost shrink-0" data-notif-remove-header aria-label="Remove header">✕</button>
	`;
	row
		.querySelector("[data-notif-remove-header]")
		?.addEventListener("click", () => row.remove());
	container.appendChild(row);
}

function validateForm(
	type: ProviderType,
	hasConfiguredCredentials = false,
): string | null {
	const name = val("nz-notif-name");
	if (!name) return "Name is required";
	const credentialMissing = (id: string) =>
		!val(id) && !hasConfiguredCredentials;

	if (type === "slack" && credentialMissing("nz-notif-slack-webhook"))
		return "Webhook URL is required";
	if (type === "telegram") {
		if (credentialMissing("nz-notif-telegram-token"))
			return "Bot Token is required";
		if (!val("nz-notif-telegram-chat")) return "Chat ID is required";
	}
	if (type === "discord" && credentialMissing("nz-notif-discord-webhook"))
		return "Webhook URL is required";
	if (type === "email") {
		if (!val("nz-notif-email-smtp-server")) return "SMTP Server is required";
		if (!numVal("nz-notif-email-smtp-port")) return "SMTP Port is required";
		if (!val("nz-notif-email-username")) return "Username is required";
		if (credentialMissing("nz-notif-email-password"))
			return "Password is required";
		if (!val("nz-notif-email-from")) return "From Address is required";
		const to = collectToAddresses();
		if (!to.length) return "At least one email is required";
		for (const e of to) {
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "Email is invalid";
		}
	}
	if (type === "resend") {
		if (credentialMissing("nz-notif-resend-api-key"))
			return "API Key is required";
		if (!val("nz-notif-resend-from")) return "From Address is required";
		const to = collectToAddresses();
		if (!to.length) return "At least one email is required";
	}
	if (type === "gotify") {
		if (!val("nz-notif-gotify-url")) return "Server URL is required";
		if (credentialMissing("nz-notif-gotify-token"))
			return "App Token is required";
	}
	if (type === "ntfy") {
		if (!val("nz-notif-ntfy-url")) return "Server URL is required";
		if (credentialMissing("nz-notif-ntfy-topic")) return "Topic is required";
	}
	if (type === "mattermost" && credentialMissing("nz-notif-mattermost-webhook"))
		return "Webhook URL is required";
	if (type === "lark" && credentialMissing("nz-notif-lark-webhook"))
		return "Webhook URL is required";
	if (type === "teams" && credentialMissing("nz-notif-teams-webhook"))
		return "Webhook URL is required";
	if (type === "custom" && credentialMissing("nz-notif-custom-endpoint"))
		return "Endpoint URL is required";
	if (type === "pushover") {
		if (credentialMissing("nz-notif-pushover-user"))
			return "User Key is required";
		if (credentialMissing("nz-notif-pushover-token"))
			return "API Token is required";
		const priority = numVal("nz-notif-pushover-priority", 0);
		if (priority === 2) {
			if (numVal("nz-notif-pushover-retry") == null)
				return "Retry is required for emergency priority (2)";
			if (numVal("nz-notif-pushover-expire") == null)
				return "Expire is required for emergency priority (2)";
		}
	}
	return null;
}

function credentialField(
	key: string,
	value: string,
	editingNotificationId: string,
) {
	return value || !editingNotificationId ? { [key]: value } : {};
}

function buildPayload(
	type: ProviderType,
	notificationId: string,
	providerIds: ProviderIds,
) {
	const events = collectEvents();
	const base = {
		...events,
		name: val("nz-notif-name"),
		notificationId,
	};

	switch (type) {
		case "slack":
			return {
				...base,
				...credentialField(
					"webhookUrl",
					val("nz-notif-slack-webhook"),
					notificationId,
				),
				channel: val("nz-notif-slack-channel"),
				slackId: providerIds.slackId ?? "",
			};
		case "telegram":
			return {
				...base,
				...credentialField(
					"botToken",
					val("nz-notif-telegram-token"),
					notificationId,
				),
				chatId: val("nz-notif-telegram-chat"),
				messageThreadId: val("nz-notif-telegram-thread"),
				telegramId: providerIds.telegramId ?? "",
			};
		case "discord":
			return {
				...base,
				...credentialField(
					"webhookUrl",
					val("nz-notif-discord-webhook"),
					notificationId,
				),
				decoration: checked("nz-notif-discord-decoration"),
				discordId: providerIds.discordId ?? "",
			};
		case "email":
			return {
				...base,
				smtpServer: val("nz-notif-email-smtp-server"),
				smtpPort: numVal("nz-notif-email-smtp-port") ?? 587,
				username: val("nz-notif-email-username"),
				...credentialField(
					"password",
					val("nz-notif-email-password"),
					notificationId,
				),
				fromAddress: val("nz-notif-email-from"),
				toAddresses: collectToAddresses(),
				emailId: providerIds.emailId ?? "",
			};
		case "resend":
			return {
				...base,
				...credentialField(
					"apiKey",
					val("nz-notif-resend-api-key"),
					notificationId,
				),
				fromAddress: val("nz-notif-resend-from"),
				toAddresses: collectToAddresses(),
				resendId: providerIds.resendId ?? "",
			};
		case "gotify":
			return {
				...base,
				serverUrl: val("nz-notif-gotify-url"),
				...credentialField(
					"appToken",
					val("nz-notif-gotify-token"),
					notificationId,
				),
				priority: numVal("nz-notif-gotify-priority", 5) ?? 5,
				decoration: checked("nz-notif-gotify-decoration"),
				gotifyId: providerIds.gotifyId ?? "",
			};
		case "ntfy":
			return {
				...base,
				serverUrl: val("nz-notif-ntfy-url"),
				...credentialField("topic", val("nz-notif-ntfy-topic"), notificationId),
				...credentialField(
					"accessToken",
					val("nz-notif-ntfy-token"),
					notificationId,
				),
				priority: numVal("nz-notif-ntfy-priority", 3) ?? 3,
				ntfyId: providerIds.ntfyId ?? "",
			};
		case "mattermost":
			return {
				...base,
				...credentialField(
					"webhookUrl",
					val("nz-notif-mattermost-webhook"),
					notificationId,
				),
				channel: val("nz-notif-mattermost-channel") || undefined,
				username: val("nz-notif-mattermost-username") || undefined,
				mattermostId: providerIds.mattermostId ?? "",
			};
		case "lark":
			return {
				...base,
				...credentialField(
					"webhookUrl",
					val("nz-notif-lark-webhook"),
					notificationId,
				),
				larkId: providerIds.larkId ?? "",
			};
		case "teams":
			return {
				...base,
				...credentialField(
					"webhookUrl",
					val("nz-notif-teams-webhook"),
					notificationId,
				),
				teamsId: providerIds.teamsId ?? "",
			};
		case "custom":
			return {
				...base,
				...credentialField(
					"endpoint",
					val("nz-notif-custom-endpoint"),
					notificationId,
				),
				...(collectHeaders() ? { headers: collectHeaders() } : {}),
				customId: providerIds.customId ?? "",
			};
		case "pushover": {
			const priority = numVal("nz-notif-pushover-priority", 0) ?? 0;
			return {
				...base,
				...credentialField(
					"userKey",
					val("nz-notif-pushover-user"),
					notificationId,
				),
				...credentialField(
					"apiToken",
					val("nz-notif-pushover-token"),
					notificationId,
				),
				priority,
				retry: priority === 2 ? numVal("nz-notif-pushover-retry") : undefined,
				expire: priority === 2 ? numVal("nz-notif-pushover-expire") : undefined,
				pushoverId: providerIds.pushoverId ?? "",
			};
		}
	}
}

function buildTestPayload(type: ProviderType) {
	switch (type) {
		case "slack":
			return {
				webhookUrl: val("nz-notif-slack-webhook"),
				channel: val("nz-notif-slack-channel"),
			};
		case "telegram":
			return {
				botToken: val("nz-notif-telegram-token"),
				chatId: val("nz-notif-telegram-chat"),
				messageThreadId: val("nz-notif-telegram-thread"),
			};
		case "discord":
			return {
				webhookUrl: val("nz-notif-discord-webhook"),
				decoration: checked("nz-notif-discord-decoration"),
			};
		case "email":
			return {
				smtpServer: val("nz-notif-email-smtp-server"),
				smtpPort: numVal("nz-notif-email-smtp-port") ?? 587,
				username: val("nz-notif-email-username"),
				password: val("nz-notif-email-password"),
				fromAddress: val("nz-notif-email-from"),
				toAddresses: collectToAddresses(),
			};
		case "resend":
			return {
				apiKey: val("nz-notif-resend-api-key"),
				fromAddress: val("nz-notif-resend-from"),
				toAddresses: collectToAddresses(),
			};
		case "gotify":
			return {
				serverUrl: val("nz-notif-gotify-url"),
				appToken: val("nz-notif-gotify-token"),
				priority: numVal("nz-notif-gotify-priority", 5) ?? 5,
				decoration: checked("nz-notif-gotify-decoration"),
			};
		case "ntfy":
			return {
				serverUrl: val("nz-notif-ntfy-url"),
				topic: val("nz-notif-ntfy-topic"),
				accessToken: val("nz-notif-ntfy-token"),
				priority: numVal("nz-notif-ntfy-priority", 3) ?? 3,
			};
		case "mattermost":
			return {
				webhookUrl: val("nz-notif-mattermost-webhook"),
				channel: val("nz-notif-mattermost-channel") || undefined,
				username: val("nz-notif-mattermost-username") || undefined,
			};
		case "lark":
			return { webhookUrl: val("nz-notif-lark-webhook") };
		case "teams":
			return { webhookUrl: val("nz-notif-teams-webhook") };
		case "custom":
			return {
				endpoint: val("nz-notif-custom-endpoint"),
				headers: collectHeaders(),
			};
		case "pushover": {
			const priority = numVal("nz-notif-pushover-priority", 0) ?? 0;
			return {
				userKey: val("nz-notif-pushover-user"),
				apiToken: val("nz-notif-pushover-token"),
				priority,
				retry: priority === 2 ? numVal("nz-notif-pushover-retry") : undefined,
				expire: priority === 2 ? numVal("nz-notif-pushover-expire") : undefined,
			};
		}
	}
}

const MUTATIONS: Record<
	ProviderType,
	{ create: string; update: string; test: string }
> = {
	slack: {
		create: "notification.createSlack",
		update: "notification.updateSlack",
		test: "notification.testSlackConnection",
	},
	telegram: {
		create: "notification.createTelegram",
		update: "notification.updateTelegram",
		test: "notification.testTelegramConnection",
	},
	discord: {
		create: "notification.createDiscord",
		update: "notification.updateDiscord",
		test: "notification.testDiscordConnection",
	},
	email: {
		create: "notification.createEmail",
		update: "notification.updateEmail",
		test: "notification.testEmailConnection",
	},
	resend: {
		create: "notification.createResend",
		update: "notification.updateResend",
		test: "notification.testResendConnection",
	},
	gotify: {
		create: "notification.createGotify",
		update: "notification.updateGotify",
		test: "notification.testGotifyConnection",
	},
	ntfy: {
		create: "notification.createNtfy",
		update: "notification.updateNtfy",
		test: "notification.testNtfyConnection",
	},
	mattermost: {
		create: "notification.createMattermost",
		update: "notification.updateMattermost",
		test: "notification.testMattermostConnection",
	},
	lark: {
		create: "notification.createLark",
		update: "notification.updateLark",
		test: "notification.testLarkConnection",
	},
	teams: {
		create: "notification.createTeams",
		update: "notification.updateTeams",
		test: "notification.testTeamsConnection",
	},
	custom: {
		create: "notification.createCustom",
		update: "notification.updateCustom",
		test: "notification.testCustomConnection",
	},
	pushover: {
		create: "notification.createPushover",
		update: "notification.updatePushover",
		test: "notification.testPushoverConnection",
	},
};

function resetForm() {
	setVal("nz-notif-name", "");
	setVal("nz-notif-slack-webhook", "");
	setVal("nz-notif-slack-channel", "");
	setVal("nz-notif-telegram-token", "");
	setVal("nz-notif-telegram-chat", "");
	setVal("nz-notif-telegram-thread", "");
	setVal("nz-notif-discord-webhook", "");
	setVal("nz-notif-discord-decoration", true);
	setVal("nz-notif-email-smtp-server", "");
	setVal("nz-notif-email-smtp-port", "");
	setVal("nz-notif-email-username", "");
	setVal("nz-notif-email-password", "");
	setVal("nz-notif-email-from", "");
	setVal("nz-notif-resend-api-key", "");
	setVal("nz-notif-resend-from", "");
	setVal("nz-notif-gotify-url", "");
	setVal("nz-notif-gotify-token", "");
	setVal("nz-notif-gotify-priority", 5);
	setVal("nz-notif-gotify-decoration", true);
	setVal("nz-notif-ntfy-url", "");
	setVal("nz-notif-ntfy-topic", "");
	setVal("nz-notif-ntfy-token", "");
	setVal("nz-notif-ntfy-priority", 3);
	setVal("nz-notif-mattermost-webhook", "");
	setVal("nz-notif-mattermost-channel", "");
	setVal("nz-notif-mattermost-username", "");
	setVal("nz-notif-lark-webhook", "");
	setVal("nz-notif-teams-webhook", "");
	setVal("nz-notif-custom-endpoint", "");
	setVal("nz-notif-pushover-user", "");
	setVal("nz-notif-pushover-token", "");
	setVal("nz-notif-pushover-priority", 0);
	setVal("nz-notif-pushover-retry", "");
	setVal("nz-notif-pushover-expire", "");
	renderToAddresses([""]);
	renderHeaders([]);
	setVal("nz-notif-app-deploy", false);
	setVal("nz-notif-app-build-error", false);
	setVal("nz-notif-database-backup", false);
	setVal("nz-notif-nearzero-backup", false);
	setVal("nz-notif-volume-backup", false);
	setVal("nz-notif-nearzero-restart", false);
	setVal("nz-notif-docker-cleanup", false);
	setVal("nz-notif-server-threshold", false);
	setSelectedType("slack");
	setCredentialPlaceholders();
	const err = document.getElementById("nz-notif-form-error");
	err?.classList.add("hidden");
}

function populateFromNotification(notification: any) {
	const type = notification.notificationType as ProviderType;
	setVal("nz-notif-name", notification.name ?? "");
	setVal("nz-notif-app-deploy", notification.appDeploy);
	setVal("nz-notif-app-build-error", notification.appBuildError);
	setVal("nz-notif-database-backup", notification.databaseBackup);
	setVal("nz-notif-nearzero-backup", notification.nearzeroBackup);
	setVal("nz-notif-volume-backup", notification.volumeBackup);
	setVal("nz-notif-nearzero-restart", notification.nearzeroRestart);
	setVal("nz-notif-docker-cleanup", notification.dockerCleanup);
	setVal("nz-notif-server-threshold", notification.serverThreshold);
	setSelectedType(type);

	if (type === "slack") {
		setVal("nz-notif-slack-webhook", notification.slack?.webhookUrl ?? "");
		setVal("nz-notif-slack-channel", notification.slack?.channel ?? "");
	} else if (type === "telegram") {
		setVal("nz-notif-telegram-token", notification.telegram?.botToken ?? "");
		setVal("nz-notif-telegram-chat", notification.telegram?.chatId ?? "");
		setVal(
			"nz-notif-telegram-thread",
			notification.telegram?.messageThreadId ?? "",
		);
	} else if (type === "discord") {
		setVal("nz-notif-discord-webhook", notification.discord?.webhookUrl ?? "");
		setVal(
			"nz-notif-discord-decoration",
			notification.discord?.decoration ?? true,
		);
	} else if (type === "email") {
		setVal("nz-notif-email-smtp-server", notification.email?.smtpServer ?? "");
		setVal("nz-notif-email-smtp-port", notification.email?.smtpPort ?? "");
		setVal("nz-notif-email-username", notification.email?.username ?? "");
		setVal("nz-notif-email-password", notification.email?.password ?? "");
		setVal("nz-notif-email-from", notification.email?.fromAddress ?? "");
		renderToAddresses(notification.email?.toAddresses ?? [""]);
	} else if (type === "resend") {
		setVal("nz-notif-resend-api-key", notification.resend?.apiKey ?? "");
		setVal("nz-notif-resend-from", notification.resend?.fromAddress ?? "");
		renderToAddresses(notification.resend?.toAddresses ?? [""]);
	} else if (type === "gotify") {
		setVal("nz-notif-gotify-url", notification.gotify?.serverUrl ?? "");
		setVal("nz-notif-gotify-token", notification.gotify?.appToken ?? "");
		setVal("nz-notif-gotify-priority", notification.gotify?.priority ?? 5);
		setVal(
			"nz-notif-gotify-decoration",
			notification.gotify?.decoration ?? true,
		);
	} else if (type === "ntfy") {
		setVal("nz-notif-ntfy-url", notification.ntfy?.serverUrl ?? "");
		setVal("nz-notif-ntfy-topic", notification.ntfy?.topic ?? "");
		setVal("nz-notif-ntfy-token", notification.ntfy?.accessToken ?? "");
		setVal("nz-notif-ntfy-priority", notification.ntfy?.priority ?? 3);
	} else if (type === "mattermost") {
		setVal(
			"nz-notif-mattermost-webhook",
			notification.mattermost?.webhookUrl ?? "",
		);
		setVal(
			"nz-notif-mattermost-channel",
			notification.mattermost?.channel ?? "",
		);
		setVal(
			"nz-notif-mattermost-username",
			notification.mattermost?.username ?? "",
		);
	} else if (type === "lark") {
		setVal("nz-notif-lark-webhook", notification.lark?.webhookUrl ?? "");
	} else if (type === "teams") {
		setVal("nz-notif-teams-webhook", notification.teams?.webhookUrl ?? "");
	} else if (type === "custom") {
		setVal("nz-notif-custom-endpoint", notification.custom?.endpoint ?? "");
		const headers = notification.custom?.headers
			? Object.entries(
					notification.custom.headers as Record<string, string>,
				).map(([key, value]) => ({ key, value }))
			: [];
		renderHeaders(headers);
	} else if (type === "pushover") {
		setVal("nz-notif-pushover-user", notification.pushover?.userKey ?? "");
		setVal("nz-notif-pushover-token", notification.pushover?.apiToken ?? "");
		setVal("nz-notif-pushover-priority", notification.pushover?.priority ?? 0);
		setVal("nz-notif-pushover-retry", notification.pushover?.retry ?? "");
		setVal("nz-notif-pushover-expire", notification.pushover?.expire ?? "");
		updateProviderPanels(type);
	}
}

export function mountNotificationsDashboard() {
	const root = document.getElementById("nz-notifications-root");
	if (!root || root.dataset.bound === "1") return;
	root.dataset.bound = "1";

	let editingNotificationId = "";
	let providerIds: ProviderIds = {};
	let pendingDeleteId = "";
	let hasConfiguredCredentials = false;

	const setFormMode = (notificationId?: string) => {
		const dialog = document.getElementById("nz-notifications-form-dialog");
		const title = document.getElementById("nz-notifications-form-dialog-title");
		const desc = dialog?.querySelector(".nz-modal__description");
		const submit = document.getElementById("nz-notif-form-submit");
		const isEdit = !!notificationId;
		if (title)
			title.textContent = isEdit ? "Update notification" : "Add notification";
		if (desc) {
			desc.textContent = isEdit
				? "Update your notification providers for multiple channels."
				: "Create new notification providers for multiple channels.";
		}
		if (submit) submit.textContent = isEdit ? "Update" : "Create";
	};

	const openForm = async (notificationId?: string) => {
		editingNotificationId = notificationId ?? "";
		providerIds = {};
		hasConfiguredCredentials = false;
		resetForm();
		setFormMode(notificationId);
		if (notificationId) {
			try {
				const notification = await trpcQuery<any>("notification.one", {
					notificationId,
				});
				providerIds = {
					slackId: notification.slackId,
					telegramId: notification.telegramId,
					discordId: notification.discordId,
					emailId: notification.emailId,
					resendId: notification.resendId,
					gotifyId: notification.gotifyId,
					ntfyId: notification.ntfyId,
					mattermostId: notification.mattermostId,
					pushoverId: notification.pushoverId,
					customId: notification.customId,
					larkId: notification.larkId,
					teamsId: notification.teamsId,
				};
				hasConfiguredCredentials = Boolean(
					notification[notification.notificationType]?.hasCredentials,
				);
				populateFromNotification(notification);
				setCredentialPlaceholders(
					notification.notificationType as ProviderType,
					hasConfiguredCredentials,
				);
			} catch {
				showToast("Failed to load notification", "error");
				return;
			}
		}
		openDialog("nz-notifications-form-dialog");
	};

	root.addEventListener("click", (e) => {
		const t =
			e.target instanceof Element
				? e.target.closest("[data-notif-action]")
				: null;
		if (!(t instanceof HTMLElement)) return;
		const action = t.dataset.notifAction;
		if (action === "add") void openForm();
		else if (action === "edit") void openForm(t.dataset.notificationId);
		else if (action === "delete") {
			pendingDeleteId = t.dataset.notificationId ?? "";
			openDialog("nz-notifications-delete-dialog");
		} else if (action === "close-form")
			closeDialog("nz-notifications-form-dialog");
		else if (action === "close-delete")
			closeDialog("nz-notifications-delete-dialog");
		else if (action === "add-to-address") addToAddressRow("");
		else if (action === "add-header") addHeaderRow("", "");
	});

	document.getElementById("nz-notif-form")?.addEventListener("change", (e) => {
		const t = e.target;
		if (!(t instanceof HTMLInputElement)) return;
		if (t.name === "nz-notif-type") updateProviderPanels(getSelectedType());
		if (t.id === "nz-notif-pushover-priority") updateProviderPanels("pushover");
	});

	document
		.getElementById("nz-notif-form")
		?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const type = getSelectedType();
			const errEl = document.getElementById("nz-notif-form-error");
			const validationError = validateForm(
				type,
				Boolean(editingNotificationId) && hasConfiguredCredentials,
			);
			if (validationError) {
				if (errEl) {
					errEl.textContent = validationError;
					errEl.classList.remove("hidden");
				}
				return;
			}
			errEl?.classList.add("hidden");
			const submit = document.getElementById(
				"nz-notif-form-submit",
			) as HTMLButtonElement | null;
			if (submit) submit.disabled = true;
			try {
				const payload = buildPayload(type, editingNotificationId, providerIds);
				const proc = editingNotificationId
					? MUTATIONS[type].update
					: MUTATIONS[type].create;
				await trpcMutate(proc, payload);
				showToast(
					editingNotificationId
						? "Notification Updated"
						: "Notification Created",
					"success",
				);
				closeDialog("nz-notifications-form-dialog");
				window.location.reload();
			} catch (err) {
				showToast(
					editingNotificationId
						? "Error updating a notification"
						: "Error creating a notification",
					"error",
				);
				if (errEl && err instanceof Error && err.message) {
					errEl.textContent = err.message;
					errEl.classList.remove("hidden");
				}
			} finally {
				if (submit) submit.disabled = false;
			}
		});

	document
		.getElementById("nz-notif-test")
		?.addEventListener("click", async () => {
			const type = getSelectedType();
			const validationError = validateForm(type);
			if (validationError) {
				showToast(validationError, "error");
				return;
			}
			const testBtn = document.getElementById(
				"nz-notif-test",
			) as HTMLButtonElement | null;
			if (testBtn) testBtn.disabled = true;
			try {
				await trpcMutate(MUTATIONS[type].test, buildTestPayload(type));
				showToast("Connection Success", "success");
			} catch (err) {
				showToast(
					`Error testing the provider: ${err instanceof Error ? err.message : "Unknown error"}`,
					"error",
				);
			} finally {
				if (testBtn) testBtn.disabled = false;
			}
		});

	document
		.getElementById("nz-notifications-delete-confirm")
		?.addEventListener("click", async () => {
			if (!pendingDeleteId) return;
			const btn = document.getElementById(
				"nz-notifications-delete-confirm",
			) as HTMLButtonElement | null;
			if (btn) btn.disabled = true;
			try {
				await trpcMutate("notification.remove", {
					notificationId: pendingDeleteId,
				});
				showToast("Notification deleted successfully", "success");
				closeDialog("nz-notifications-delete-dialog");
				window.location.reload();
			} catch {
				showToast("Error deleting notification", "error");
			} finally {
				if (btn) btn.disabled = false;
				pendingDeleteId = "";
			}
		});

	// Initialize provider radio labels styling
	for (const p of PROVIDERS) {
		const label = document.querySelector(`[data-notif-type-label="${p.type}"]`);
		const radio = document.querySelector(
			`input[name="nz-notif-type"][value="${p.type}"]`,
		);
		radio?.addEventListener("change", () => updateProviderRadios(p.type));
		label?.addEventListener("click", () => {
			if (radio instanceof HTMLInputElement) {
				radio.checked = true;
				updateProviderPanels(p.type);
				updateProviderRadios(p.type);
			}
		});
	}
	updateProviderPanels("slack");
}
