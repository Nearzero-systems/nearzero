import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_URL } from "@/lib/branding";
import {
	extractSetupToken,
	isPublicInstallSetupStatus,
	type PublicInstallSetupStatus,
} from "@/lib/install-setup";

export function resolveLoopbackInstallSetupToken(
	env: NodeJS.ProcessEnv = process.env,
	cwd = process.cwd(),
) {
	const fromEnv = env.NEARZERO_INSTALL_SETUP_TOKEN?.trim();
	if (fromEnv) return extractSetupToken(fromEnv) ?? fromEnv;

	const fromUrl = env.NEARZERO_INSTALL_SETUP_URL?.trim();
	if (fromUrl) {
		const token = extractSetupToken(fromUrl);
		if (token) return token;
	}

	const envLocalPaths = [
		resolve(cwd, ".env.local"),
		resolve(cwd, "apps/console/.env.local"),
		fileURLToPath(new URL("../../.env.local", import.meta.url)),
	];
	for (const envLocalPath of [...new Set(envLocalPaths)]) {
		try {
			const envLocal = readFileSync(envLocalPath, "utf8");
			for (const line of envLocal.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const separator = trimmed.indexOf("=");
				if (separator < 0) continue;
				if (trimmed.slice(0, separator) !== "NEARZERO_INSTALL_SETUP_TOKEN") {
					continue;
				}
				const value = trimmed
					.slice(separator + 1)
					.trim()
					.replace(/^["']|["']$/g, "");
				if (value) return extractSetupToken(value) ?? value;
			}
		} catch {
			// .env.local is optional and may not exist in production.
		}
	}

	return null;
}

export async function verifyInstallSetupSessionToken(token: string) {
	try {
		const backend = BACKEND_URL.replace(/\/$/, "");
		const response = await fetch(`${backend}/api/install/setup/session`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({ token }),
			cache: "no-store",
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function fetchInstallSetupStatusServer(
	request?: Request,
): Promise<PublicInstallSetupStatus | null> {
	try {
		const backend = BACKEND_URL.replace(/\/$/, "");
		const response = await fetch(`${backend}/api/install/setup-status`, {
			method: "GET",
			headers: {
				accept: "application/json",
				...(request?.headers.get("cookie")
					? { cookie: request.headers.get("cookie")! }
					: {}),
			},
			cache: "no-store",
		});
		if (!response.ok) return null;
		const value = (await response.json().catch(() => null)) as unknown;
		return isPublicInstallSetupStatus(value) ? value : null;
	} catch {
		return null;
	}
}
