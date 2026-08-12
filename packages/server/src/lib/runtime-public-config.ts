import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import {
	normalizeDnsHostname,
	normalizeDnsZoneName,
} from "../utils/dns/zone-file";
import { normalizeAuthEmail } from "./auth-email-policy";

const RUNTIME_PUBLIC_CONFIG_VERSION = 1 as const;
const RUNTIME_PUBLIC_CONFIG_FILENAME = "runtime-public.json";
const MAX_RUNTIME_PUBLIC_CONFIG_BYTES = 4_096;
const emailSchema = z.string().email();

function ipv4ToInteger(value: string) {
	return (
		value
			.split(".")
			.map(Number)
			.reduce((result, octet) => result * 256 + octet, 0) >>> 0
	);
}

function isInIpv4Cidr(value: string, network: string, prefix: number) {
	const address = ipv4ToInteger(value);
	const base = ipv4ToInteger(network);
	const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
	return (address & mask) === (base & mask);
}

const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
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

function isPublicIpv4(value: string) {
	return (
		isIP(value) === 4 &&
		!NON_PUBLIC_IPV4_RANGES.some(([network, prefix]) =>
			isInIpv4Cidr(value, network, prefix),
		)
	);
}

type RuntimePublicConfigEnvironment = Record<string, string | undefined> & {
	NODE_ENV?: string;
	NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH?: string;
};

export type RuntimePublicConfig = {
	version: typeof RUNTIME_PUBLIC_CONFIG_VERSION;
	managementHostname: string;
	consoleUrl: string;
	adminEmail: string;
	publicIp: string;
	managedDnsZone: string | null;
	managedDnsSoaEmail: string | null;
};

export type RuntimePublicConfigInput = {
	managementHostname: string;
	adminEmail: string;
	publicIp: string;
	managedDnsZone?: string | null;
	managedDnsSoaEmail?: string | null;
};

export type RuntimePublicConfigPathOptions = {
	/** Exact file path. Intended for isolated tests and controlled tooling. */
	path?: string | null;
	env?: RuntimePublicConfigEnvironment;
};

function validateRuntimePublicConfig(value: unknown): RuntimePublicConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Runtime public configuration must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const expectedKeys = [
		"adminEmail",
		"consoleUrl",
		"managedDnsSoaEmail",
		"managedDnsZone",
		"managementHostname",
		"publicIp",
		"version",
	];
	if (
		keys.length !== expectedKeys.length ||
		keys.some((key, index) => key !== expectedKeys[index])
	) {
		throw new Error("Runtime public configuration contains unexpected fields");
	}
	if (record.version !== RUNTIME_PUBLIC_CONFIG_VERSION) {
		throw new Error("Unsupported runtime public configuration version");
	}
	if (typeof record.managementHostname !== "string") {
		throw new Error("Runtime management hostname must be a string");
	}
	const managementHostname = normalizeDnsHostname(record.managementHostname, {
		requireFqdn: true,
	});
	const consoleUrl = `https://${managementHostname}`;
	if (record.consoleUrl !== consoleUrl) {
		throw new Error(
			"Runtime console URL must be the HTTPS origin for the management hostname",
		);
	}
	if (typeof record.adminEmail !== "string") {
		throw new Error("Runtime administrator email must be a string");
	}
	const adminEmail = normalizeAuthEmail(record.adminEmail);
	if (!emailSchema.safeParse(adminEmail).success) {
		throw new Error(
			"Runtime administrator email must be a valid email address",
		);
	}
	if (typeof record.publicIp !== "string" || !isPublicIpv4(record.publicIp)) {
		throw new Error(
			"Runtime public IP must be a publicly routable IPv4 address",
		);
	}
	if (
		record.managedDnsZone !== null &&
		typeof record.managedDnsZone !== "string"
	) {
		throw new Error("Runtime managed DNS zone must be a string or null");
	}
	const managedDnsZone = record.managedDnsZone
		? normalizeDnsZoneName(record.managedDnsZone)
		: null;
	if (
		record.managedDnsSoaEmail !== null &&
		typeof record.managedDnsSoaEmail !== "string"
	) {
		throw new Error("Runtime managed DNS SOA email must be a string or null");
	}
	const managedDnsSoaEmail = record.managedDnsSoaEmail
		? normalizeAuthEmail(record.managedDnsSoaEmail)
		: null;
	if (
		managedDnsSoaEmail &&
		!emailSchema.safeParse(managedDnsSoaEmail).success
	) {
		throw new Error(
			"Runtime managed DNS SOA email must be a valid email address",
		);
	}
	return {
		version: RUNTIME_PUBLIC_CONFIG_VERSION,
		managementHostname,
		consoleUrl,
		adminEmail,
		publicIp: record.publicIp,
		managedDnsZone,
		managedDnsSoaEmail,
	};
}

export function resolveRuntimePublicConfigPath(
	options: RuntimePublicConfigPathOptions = {},
) {
	if (options.path !== undefined) {
		return options.path ? path.resolve(options.path) : null;
	}
	const env = options.env ?? process.env;
	const configuredPath = env.NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH?.trim();
	if (configuredPath) return path.resolve(configuredPath);
	if (env.NODE_ENV !== "production") return null;
	return path.join("/etc/nearzero", RUNTIME_PUBLIC_CONFIG_FILENAME);
}

function assertSafeFileStat(stat: Stats) {
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("Runtime public configuration must be a regular file");
	}
	if (stat.size > MAX_RUNTIME_PUBLIC_CONFIG_BYTES) {
		throw new Error("Runtime public configuration is too large");
	}
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(
			"Runtime public configuration must not be group/world accessible",
		);
	}
	if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
		throw new Error(
			"Runtime public configuration must be owned by this process user",
		);
	}
}

function assertSafeExistingFile(filePath: string) {
	assertSafeFileStat(lstatSync(filePath));
}

function assertSafeDirectory(directory: string) {
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("Runtime public configuration directory is unsafe");
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new Error(
			"Runtime public configuration directory must not be group/world writable",
		);
	}
	if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
		throw new Error(
			"Runtime public configuration directory must be owned by this process user",
		);
	}
}

/**
 * Read the durable public origin selected during first-run setup.
 * Missing configuration is expected before the browser wizard completes.
 * Invalid or unsafe files fail closed instead of falling back silently.
 */
export function readRuntimePublicConfig(
	options: RuntimePublicConfigPathOptions = {},
): RuntimePublicConfig | null {
	const filePath = resolveRuntimePublicConfigPath(options);
	if (!filePath) return null;
	let descriptor: number;
	try {
		descriptor = openSync(
			filePath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: string }).code === "ENOENT"
		) {
			return null;
		}
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: string }).code === "ELOOP"
		) {
			throw new Error("Runtime public configuration must be a regular file");
		}
		throw error;
	}
	let raw: string;
	try {
		assertSafeFileStat(fstatSync(descriptor));
		raw = readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_RUNTIME_PUBLIC_CONFIG_BYTES) {
		throw new Error("Runtime public configuration is too large");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Runtime public configuration is not valid JSON");
	}
	return validateRuntimePublicConfig(parsed);
}

/** Atomically persist a strict HTTPS management origin with mode 0600. */
export function persistRuntimePublicConfig(
	input: RuntimePublicConfigInput,
	options: RuntimePublicConfigPathOptions = {},
): RuntimePublicConfig {
	const filePath = resolveRuntimePublicConfigPath(options);
	if (!filePath) {
		throw new Error(
			"Runtime public configuration path is unavailable outside production",
		);
	}
	const managementHostname = normalizeDnsHostname(input.managementHostname, {
		requireFqdn: true,
	});
	const config = validateRuntimePublicConfig({
		version: RUNTIME_PUBLIC_CONFIG_VERSION,
		managementHostname,
		consoleUrl: `https://${managementHostname}`,
		adminEmail: input.adminEmail,
		publicIp: input.publicIp.trim(),
		managedDnsZone: input.managedDnsZone?.trim() || null,
		managedDnsSoaEmail: input.managedDnsSoaEmail?.trim() || null,
	});
	const directory = path.dirname(filePath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	assertSafeDirectory(directory);
	const temporaryPath = path.join(
		directory,
		`.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let descriptor: number | null = null;
	try {
		descriptor = openSync(
			temporaryPath,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				(constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeFileSync(descriptor, `${JSON.stringify(config)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		renameSync(temporaryPath, filePath);
		chmodSync(filePath, 0o600);
		assertSafeExistingFile(filePath);
		return config;
	} catch (error) {
		if (descriptor !== null) closeSync(descriptor);
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The rename may already have completed or creation may have failed.
		}
		throw error;
	}
}
