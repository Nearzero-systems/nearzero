import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { getWebServerSettings } from "@nearzero/server/services/web-server-settings";
import { findServerById } from "@nearzero/server/services/server";
import { TRPCError } from "@trpc/server";

function ipv4ToInteger(value: string) {
	return value
		.split(".")
		.map(Number)
		.reduce((result, octet) => result * 256 + octet, 0) >>> 0;
}

function isInIpv4Cidr(value: string, network: string, prefix: number) {
	const address = ipv4ToInteger(value);
	const base = ipv4ToInteger(network);
	const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
	return (address & mask) === (base & mask);
}

const NON_PUBLIC_IPV4_RANGES: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

export function isPublicIpv4(value: string) {
	if (isIP(value) !== 4) return false;
	return !NON_PUBLIC_IPV4_RANGES.some(([network, prefix]) =>
		isInIpv4Cidr(value, network, prefix),
	);
}

function normalizeTargetHostname(value: string) {
	if (
		!value ||
		/[\u0000-\u0020\u007f]/.test(value) ||
		value.includes("://") ||
		value.includes("/") ||
		value.includes(":")
	) {
		throw new Error("Remote server address must be a plain IPv4 address or hostname");
	}
	const ascii = domainToASCII(value.toLowerCase().replace(/\.$/, ""));
	if (
		!ascii ||
		ascii.length > 253 ||
		!ascii.includes(".") ||
		!ascii
			.split(".")
			.every(
				(label) =>
					label.length > 0 &&
					label.length <= 63 &&
					/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
			)
	) {
		throw new Error("Remote server hostname is not valid");
	}
	return ascii;
}

export async function resolvePublicIpv4Target(
	value: string,
	resolver: (hostname: string) => Promise<string[]> = resolve4,
) {
	const target = value.trim();
	if (isIP(target) === 6) {
		throw new Error(
			"IPv6-only managed DNS is not supported yet; configure a public IPv4 address",
		);
	}
	if (isIP(target) === 4) {
		if (!isPublicIpv4(target)) {
			throw new Error("Managed public DNS requires a publicly routable IPv4 address");
		}
		return target;
	}

	const hostname = normalizeTargetHostname(target);
	let answers: string[];
	try {
		answers = await resolver(hostname);
	} catch (error) {
		throw new Error(
			`Could not resolve remote server hostname ${hostname} to IPv4`,
			{ cause: error },
		);
	}
	const unique = Array.from(new Set(answers)).sort(
		(a, b) => ipv4ToInteger(a) - ipv4ToInteger(b),
	);
	if (unique.length === 0 || unique.some((answer) => !isPublicIpv4(answer))) {
		throw new Error(
			`Remote server hostname ${hostname} must resolve only to public IPv4 addresses`,
		);
	}
	if (unique.length !== 1) {
		throw new Error(
			`Remote server hostname ${hostname} must resolve to exactly one public IPv4 address`,
		);
	}
	return unique[0] as string;
}

export async function resolveDomainTargetIp(serverId?: string | null) {
	let configuredTarget: string | null | undefined;
	if (serverId) {
		const server = await findServerById(serverId);
		configuredTarget = server.ipAddress;
	} else {
		const settings = await getWebServerSettings();
		configuredTarget = settings?.serverIp;
	}

	if (!configuredTarget) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: serverId
				? "Remote server does not have an IP address configured"
				: "Web server IP is not configured for managed DNS",
		});
	}
	try {
		return await resolvePublicIpv4Target(configuredTarget);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error
					? error.message
					: "Managed DNS target is not a valid public IPv4 address",
			cause: error,
		});
	}
}
