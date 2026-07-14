import { Client, type ClientChannel } from "ssh2";
import { createSshHostVerification } from "../utils/servers/ssh-host-verification";
import { findServerById } from "./server";
import { getWebServerSettings } from "./web-server-settings";

const DEFAULT_MONITORING_PORT = 4500;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type MonitoringHttpResponse = {
	status: number;
	statusText: string;
	body: string;
};

type MonitoringEndpoint =
	| { kind: "server" }
	| { kind: "container"; appName: string };

const monitoringPort = (value: unknown) => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
		throw new Error("Monitoring port must be an integer from 1 to 65535");
	}
	return parsed;
};

export const normalizeMonitoringLimit = (value: string) => {
	if (value === "all") return value;
	if (!/^[1-9]\d{0,3}$/.test(value)) {
		throw new Error(
			"Monitoring data points must be 'all' or a number from 1 to 9999",
		);
	}
	return value;
};

const decodeChunkedBody = (body: Buffer) => {
	const chunks: Buffer[] = [];
	let offset = 0;

	while (offset < body.length) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd < 0) throw new Error("Invalid chunked monitoring response");
		const sizeText = body
			.subarray(offset, lineEnd)
			.toString("ascii")
			.split(";", 1)[0];
		const size = Number.parseInt(sizeText ?? "", 16);
		if (!Number.isFinite(size) || size < 0) {
			throw new Error("Invalid chunk size in monitoring response");
		}
		offset = lineEnd + 2;
		if (size === 0) return Buffer.concat(chunks);
		if (offset + size + 2 > body.length) {
			throw new Error("Truncated chunked monitoring response");
		}
		chunks.push(body.subarray(offset, offset + size));
		offset += size;
		if (body.toString("ascii", offset, offset + 2) !== "\r\n") {
			throw new Error("Invalid chunk terminator in monitoring response");
		}
		offset += 2;
	}

	throw new Error("Truncated chunked monitoring response");
};

export const parseMonitoringHttpResponse = (
	rawResponse: Buffer,
): MonitoringHttpResponse => {
	const headerEnd = rawResponse.indexOf("\r\n\r\n");
	if (headerEnd < 0) throw new Error("Invalid HTTP response from monitoring");

	const headerLines = rawResponse
		.subarray(0, headerEnd)
		.toString("latin1")
		.split("\r\n");
	const statusLine = headerLines.shift() ?? "";
	const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(
		statusLine,
	);
	if (!statusMatch) throw new Error("Invalid HTTP status from monitoring");

	const headers = new Map<string, string>();
	for (const line of headerLines) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const name = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		headers.set(name, value);
	}

	let body = rawResponse.subarray(headerEnd + 4);
	if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
		body = decodeChunkedBody(body);
	} else {
		const contentLength = headers.get("content-length");
		if (contentLength) {
			const length = Number.parseInt(contentLength, 10);
			if (!Number.isInteger(length) || length < 0 || body.length < length) {
				throw new Error("Truncated monitoring response");
			}
			body = body.subarray(0, length);
		}
	}

	return {
		status: Number(statusMatch[1]),
		statusText: statusMatch[2] ?? "",
		body: body.toString("utf8"),
	};
};

const requestRemoteLoopback = async (
	serverId: string,
	port: number,
	path: string,
	token: string,
): Promise<MonitoringHttpResponse> => {
	if (!path.startsWith("/") || /[\r\n]/.test(path)) {
		throw new Error("Invalid remote monitoring request path");
	}
	if (
		Array.from(token).some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 31 || codePoint >= 127;
		})
	) {
		throw new Error("Monitoring token contains unsupported characters");
	}

	const server = await findServerById(serverId);
	if (!server.sshKeyId || !server.sshKey?.privateKey) {
		throw new Error("No SSH key available for this server");
	}
	const privateKey = server.sshKey.privateKey;

	return await new Promise((resolve, reject) => {
		const conn = new Client();
		const hostVerification = createSshHostVerification(server);
		let stream: ClientChannel | null = null;
		let settled = false;
		const chunks: Buffer[] = [];
		let responseBytes = 0;

		const finish = (error?: unknown, response?: MonitoringHttpResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stream?.destroy();
			conn.end();
			if (error) {
				reject(error);
			} else if (response) {
				resolve(response);
			} else {
				reject(new Error("Remote monitoring request ended without a response"));
			}
		};

		const finishFromResponse = () => {
			if (settled) return;
			try {
				finish(undefined, parseMonitoringHttpResponse(Buffer.concat(chunks)));
			} catch (error) {
				finish(error);
			}
		};

		const timer = setTimeout(() => {
			finish(new Error("Remote monitoring request timed out"));
		}, DEFAULT_TIMEOUT_MS);
		timer.unref?.();

		conn
			.once("ready", () => {
				try {
					hostVerification.commit();
				} catch (error) {
					finish(error);
					return;
				}

				conn.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => {
					if (error) {
						finish(
							new Error(
								`Could not open the remote monitoring tunnel: ${error.message}`,
							),
						);
						return;
					}
					stream = channel;
					channel.on("data", (chunk: Buffer | string) => {
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						responseBytes += buffer.length;
						if (responseBytes > MAX_RESPONSE_BYTES) {
							finish(new Error("Remote monitoring response exceeded 5 MiB"));
							return;
						}
						chunks.push(buffer);
					});
					channel.once("error", (channelError: Error) => finish(channelError));
					channel.once("end", finishFromResponse);
					channel.once("close", finishFromResponse);

					channel.write(
						[
							`GET ${path} HTTP/1.1`,
							`Host: 127.0.0.1:${port}`,
							"Accept: application/json",
							`Authorization: Bearer ${token}`,
							"Connection: close",
							"",
							"",
						].join("\r\n"),
					);
				});
			})
			.once("error", (error) => finish(error))
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey,
				hostVerifier: hostVerification.hostVerifier,
				readyTimeout: DEFAULT_TIMEOUT_MS,
			});
	});
};

const getLocalMonitoringUrl = async (endpoint: MonitoringEndpoint) => {
	const settings = await getWebServerSettings();
	const port = monitoringPort(
		settings?.metricsConfig.server.port ?? DEFAULT_MONITORING_PORT,
	);
	const configuredUrl = process.env.NEARZERO_METRICS_URL?.trim();
	const url = configuredUrl
		? new URL(configuredUrl)
		: new URL(`http://127.0.0.1:${port}/metrics`);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("NEARZERO_METRICS_URL must use HTTP or HTTPS");
	}
	if (endpoint.kind === "container") {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/containers`;
	}
	return {
		url,
		token:
			process.env.NEARZERO_METRICS_TOKEN?.trim() ||
			settings?.metricsConfig.server.token?.trim() ||
			"",
	};
};

const readLocalResponseBody = async (response: Response) => {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("Monitoring response exceeded 5 MiB");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
};

export const requestMonitoring = async (input: {
	serverId?: string;
	endpoint: MonitoringEndpoint;
	limit: string;
}): Promise<MonitoringHttpResponse> => {
	const limit = normalizeMonitoringLimit(input.limit);
	const search = new URLSearchParams({ limit });
	if (input.endpoint.kind === "container") {
		search.set("appName", input.endpoint.appName);
	}
	const endpointPath =
		input.endpoint.kind === "container" ? "/metrics/containers" : "/metrics";

	if (input.serverId) {
		const server = await findServerById(input.serverId);
		const port = monitoringPort(server.metricsConfig.server.port);
		const token = server.metricsConfig.server.token?.trim();
		if (!token) throw new Error("Remote monitoring is not configured");
		return await requestRemoteLoopback(
			input.serverId,
			port,
			`${endpointPath}?${search.toString()}`,
			token,
		);
	}

	const local = await getLocalMonitoringUrl(input.endpoint);
	if (!local.token) throw new Error("Monitoring is not configured");
	local.url.search = search.toString();
	const response = await fetch(local.url, {
		headers: { Authorization: `Bearer ${local.token}` },
		signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
	});
	return {
		status: response.status,
		statusText: response.statusText,
		body: await readLocalResponseBody(response),
	};
};
