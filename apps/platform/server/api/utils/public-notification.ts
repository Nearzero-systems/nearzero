const PRIVATE_CONNECTION_FIELDS = {
	slack: ["webhookUrl"],
	telegram: ["botToken"],
	discord: ["webhookUrl"],
	email: ["password"],
	resend: ["apiKey"],
	gotify: ["appToken"],
	ntfy: ["accessToken", "topic"],
	mattermost: ["webhookUrl"],
	custom: ["endpoint", "headers"],
	lark: ["webhookUrl"],
	pushover: ["userKey", "apiToken"],
	teams: ["webhookUrl"],
} as const;

function hasConfiguredValue(value: unknown) {
	if (typeof value === "string") return value.length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return value !== null && value !== undefined;
}

/**
 * Notification delivery credentials remain available to internal workers, but
 * are never serialized back to the browser. Token-bearing webhook/topic URLs
 * and custom headers are credentials too, even when their field name does not
 * explicitly contain "token" or "secret".
 */
export function toPublicNotification<T extends object>(notification: T) {
	const publicNotification = { ...notification } as Record<string, unknown>;

	for (const [relation, privateFields] of Object.entries(
		PRIVATE_CONNECTION_FIELDS,
	)) {
		const value = publicNotification[relation];
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;

		const connection = { ...(value as Record<string, unknown>) };
		connection.hasCredentials = privateFields.some((field) =>
			hasConfiguredValue(connection[field]),
		);
		for (const field of privateFields) delete connection[field];
		publicNotification[relation] = connection;
	}

	return publicNotification;
}
