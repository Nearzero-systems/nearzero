import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ContainerCreateOptions } from "dockerode";
import { getDocker, paths } from "../constants";

const DNS_CONTAINER_NAME = "nearzero-dns";
export const COREDNS_IMAGE = "coredns/coredns:1.14.6";
export const COREDNS_CONTAINER_ZONES_PATH = "/etc/coredns/zones";
export const MANAGED_DNS_SETUP_ERROR_CODE = "managed_dns_not_installed";

export class ManagedDnsSetupError extends Error {
	public readonly code = MANAGED_DNS_SETUP_ERROR_CODE;
	public readonly detail?: string;

	constructor(error?: unknown) {
		const detail = error instanceof Error ? error.message : String(error ?? "");
		super(
			[
				"Managed DNS is not ready.",
				"Complete server and DNS setup first.",
				`Code: ${MANAGED_DNS_SETUP_ERROR_CODE}`,
			]
				.filter(Boolean)
				.join(" "),
		);
		this.name = "ManagedDnsSetupError";
		this.detail = detail || undefined;
	}
}

function isDockerNotFound(error: unknown) {
	const maybe = error as {
		statusCode?: number;
		reason?: string;
		message?: string;
	};
	return (
		maybe?.statusCode === 404 ||
		/no such container|container .* not found/i.test(maybe?.message ?? "") ||
		/no such container|container .* not found/i.test(maybe?.reason ?? "")
	);
}

async function pullCoreDnsImage() {
	try {
		const stream = await getDocker().pull(COREDNS_IMAGE);
		await new Promise<void>((resolve, reject) => {
			getDocker().modem.followProgress(stream, (error: unknown) => {
				if (error) reject(error);
				else resolve();
			});
		});
	} catch (error) {
		throw new ManagedDnsSetupError(error);
	}
}

export function ensureDnsDirectories() {
	const { DNS_PATH, DNS_ZONES_PATH, DNS_COREFILE_PATH } = paths();
	mkdirSync(DNS_ZONES_PATH, { recursive: true });
	const desiredCorefile = `# Managed by Nearzero. Authoritative zones only; this is not a recursive resolver.
.:53 {
  auto {
    directory ${COREDNS_CONTAINER_ZONES_PATH} (.*)\\.zone {1}
    reload 2s
  }
  reload 30s
  errors
}
`;
	let corefileChanged = false;
	if (!existsSync(DNS_COREFILE_PATH)) {
		writeFileSync(DNS_COREFILE_PATH, desiredCorefile, "utf8");
		corefileChanged = true;
	} else {
		const existingCorefile = readFileSync(DNS_COREFILE_PATH, "utf8");
		const isLegacyNearzeroCorefile =
			existingCorefile.includes("auto {") &&
			existingCorefile.includes("reload 10s") &&
			(existingCorefile.includes(`directory ${DNS_ZONES_PATH}`) ||
				existingCorefile.includes("directory /etc/nearzero/dns/zones") ||
				existingCorefile.includes("directory /etc/coredns/zones"));
		if (isLegacyNearzeroCorefile && existingCorefile !== desiredCorefile) {
			writeFileSync(DNS_COREFILE_PATH, desiredCorefile, "utf8");
			corefileChanged = true;
		}
	}
	return { DNS_PATH, DNS_ZONES_PATH, DNS_COREFILE_PATH, corefileChanged };
}

export function getDnsContainerSettings(): ContainerCreateOptions {
	const { DNS_ZONES_PATH, DNS_COREFILE_PATH } = paths();
	return {
		name: DNS_CONTAINER_NAME,
		Image: COREDNS_IMAGE,
		Cmd: ["-conf", "/etc/coredns/Corefile"],
		HostConfig: {
			Binds: [
				`${DNS_COREFILE_PATH}:/etc/coredns/Corefile:ro`,
				`${DNS_ZONES_PATH}:${COREDNS_CONTAINER_ZONES_PATH}:ro`,
			],
			PortBindings: {
				"53/tcp": [{ HostPort: "53" }],
				"53/udp": [{ HostPort: "53" }],
			},
			RestartPolicy: { Name: "unless-stopped" },
			ReadonlyRootfs: true,
			CapDrop: ["ALL"],
			CapAdd: ["NET_BIND_SERVICE"],
			SecurityOpt: ["no-new-privileges:true"],
			Memory: 128 * 1024 * 1024,
			PidsLimit: 128,
		},
		ExposedPorts: {
			"53/tcp": {},
			"53/udp": {},
		},
	};
}

function dnsContainerIsHardened(info: {
	Config?: { Image?: string };
	HostConfig?: {
		ReadonlyRootfs?: boolean;
		CapDrop?: string[];
		CapAdd?: string[];
		SecurityOpt?: string[];
	};
}) {
	return (
		info.Config?.Image === COREDNS_IMAGE &&
		info.HostConfig?.ReadonlyRootfs === true &&
		info.HostConfig?.CapDrop?.includes("ALL") === true &&
		info.HostConfig?.CapAdd?.includes("NET_BIND_SERVICE") === true &&
		info.HostConfig?.SecurityOpt?.includes("no-new-privileges:true") === true
	);
}

export async function reloadNearzeroDns() {
	const { corefileChanged } = ensureDnsDirectories();
	const docker = getDocker();
	const composeSetting = process.env.NEARZERO_ENABLE_MANAGED_DNS;
	const composeManaged = composeSetting !== undefined;
	const composeEnabled = composeSetting?.trim().toLowerCase() === "true";
	if (composeManaged && !composeEnabled) {
		throw new ManagedDnsSetupError(
			"Managed DNS is disabled by NEARZERO_ENABLE_MANAGED_DNS",
		);
	}

	try {
		const existing = docker.getContainer(DNS_CONTAINER_NAME);
		const info = await existing.inspect();
		if (composeManaged) {
			if (!info.State.Running) {
				throw new ManagedDnsSetupError(
					"The Compose-managed nearzero-dns container is not running",
				);
			}
			// A one-time restart is required when migrating an older Corefile that
			// did not yet contain the reload plugin. Normal zone publishes are picked
			// up gracefully by the auto plugin and never restart authoritative DNS.
			if (corefileChanged) await existing.restart();
			return;
		}
		if (dnsContainerIsHardened(info)) {
			if (!info.State.Running || corefileChanged) await existing.restart();
			return;
		}
		// Pull before removing the old container so a registry outage cannot take
		// authoritative DNS offline during a security migration.
		await pullCoreDnsImage();
		await existing.remove({ force: true });
	} catch (error) {
		if (!isDockerNotFound(error)) {
			throw new ManagedDnsSetupError(error);
		}
		if (composeManaged) {
			throw new ManagedDnsSetupError(
				"The Compose-managed nearzero-dns container is not running",
			);
		}
		// container missing — create below
	}

	try {
		await pullCoreDnsImage();
		const container = await docker.createContainer(getDnsContainerSettings());
		await container.start();
		const info = await container.inspect();
		if (!info.State.Running) {
			throw new Error(
				info.State.Error || "CoreDNS exited immediately after startup",
			);
		}
	} catch (error) {
		throw error instanceof ManagedDnsSetupError
			? error
			: new ManagedDnsSetupError(error);
	}
}

export async function initializeNearzeroDns() {
	ensureDnsDirectories();
	await reloadNearzeroDns();
}
