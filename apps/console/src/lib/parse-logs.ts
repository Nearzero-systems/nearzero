export type LogType = "error" | "warning" | "success" | "info" | "debug";
export type LogVariant = "red" | "yellow" | "green" | "blue" | "orange";

export interface LogLine {
	rawTimestamp: string | null;
	timestamp: Date | null;
	message: string;
}

interface LogStyle {
	type: LogType;
	variant: LogVariant;
	color: string;
}

const LOG_STYLES: Record<LogType, LogStyle> = {
	error: { type: "error", variant: "red", color: "bg-red-500/40" },
	warning: { type: "warning", variant: "orange", color: "bg-orange-500/40" },
	debug: { type: "debug", variant: "yellow", color: "bg-yellow-500/40" },
	success: { type: "success", variant: "green", color: "bg-green-500/40" },
	info: { type: "info", variant: "blue", color: "bg-blue-600/40" },
};

export function parseLogs(logString: string): LogLine[] {
	const logRegex =
		/^(?:(?<lineNumber>\d+)\s+)?(?<timestamp>(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC))?\s*(?<message>[\s\S]*)$/;

	const lines: LogLine[] = [];
	for (const rawLine of logString.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(logRegex);
		if (!match) continue;
		const { timestamp, message } = match.groups ?? {};
		if (!message?.trim()) continue;
		lines.push({
			rawTimestamp: timestamp ?? null,
			timestamp: timestamp ? new Date(timestamp.replace(" UTC", "Z")) : null,
			message: message.trim(),
		});
	}
	return lines;
}

export function getLogType(message: string): LogStyle {
	const statusMatch = message.match(/"statusCode"\s*:\s*"?(\d{3})"?/);
	if (statusMatch) {
		const statusCode = Number(statusMatch[1]);
		if (statusCode >= 500) return LOG_STYLES.error;
		if (statusCode >= 400) return LOG_STYLES.warning;
		if (statusCode >= 200 && statusCode < 300) return LOG_STYLES.success;
		return LOG_STYLES.info;
	}

	const lowerMessage = message.toLowerCase();

	if (
		/(?:^|\s)(?:error|err):?\s/i.test(lowerMessage) ||
		/\b(?:exception|failed|failure)\b/i.test(lowerMessage) ||
		/\[(?:error|err|fatal)\]/i.test(lowerMessage)
	) {
		return LOG_STYLES.error;
	}

	if (
		/(?:^|\s)(?:warning|warn):?\s/i.test(lowerMessage) ||
		/\[(?:warn(?:ing)?|attention)\]/i.test(lowerMessage) ||
		/⚠|⚠️/i.test(lowerMessage)
	) {
		return LOG_STYLES.warning;
	}

	if (
		/(?:successfully|complete[d]?)\s+(?:initialized|started|completed|created|done|deployed)/i.test(
			lowerMessage,
		) ||
		/\[(?:success|ok|done)\]/i.test(lowerMessage) ||
		/✓|√|✅|\[ok\]|done!/i.test(lowerMessage)
	) {
		return LOG_STYLES.success;
	}

	return LOG_STYLES.info;
}

export function logLineClass(message: string): string {
	const { variant } = getLogType(message);
	switch (variant) {
		case "red":
			return "text-red-600 dark:text-red-400";
		case "orange":
			return "text-orange-600 dark:text-orange-400";
		case "green":
			return "text-green-600 dark:text-green-400";
		case "yellow":
			return "text-yellow-700 dark:text-yellow-400";
		default:
			return "text-[#374151] dark:text-[#d1d5db]";
	}
}
