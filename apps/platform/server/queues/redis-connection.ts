import type { ConnectionOptions } from "bullmq";
import "../load-env.js";

function redisConfigFromUrl(urlString: string): ConnectionOptions {
	const url = new URL(urlString);
	const isTls = url.protocol === "rediss:";
	return {
		host: url.hostname,
		port: url.port ? Number(url.port) : 6379,
		...(url.username ? { username: decodeURIComponent(url.username) } : {}),
		...(url.password ? { password: decodeURIComponent(url.password) } : {}),
		...(isTls ? { tls: {} } : {}),
		maxRetriesPerRequest: null,
	};
}

function requireRedisUrl(): string {
	const redisUrl = process.env.REDIS_URL?.trim();
	if (!redisUrl) {
		throw new Error(
			"REDIS_URL is required in apps/platform/.env (for example an Upstash rediss:// URL). Nearzero does not start local Redis in cloud control-plane mode.",
		);
	}
	return redisUrl;
}

export const redisConfig: ConnectionOptions = redisConfigFromUrl(
	requireRedisUrl(),
);
