import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContainerCreateOptions } from "dockerode";
import { paths } from "../constants";
import { getDocker } from "../constants";

const DNS_CONTAINER_NAME = "nearzero-dns";
const COREDNS_IMAGE = "coredns/coredns:1.11.1";
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
	const maybe = error as { statusCode?: number; reason?: string; message?: string };
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
	if (!existsSync(DNS_COREFILE_PATH)) {
		writeFileSync(
			DNS_COREFILE_PATH,
			`.:53 {
  auto {
    directory ${DNS_ZONES_PATH}
    reload 10s
  }
  log
  errors
}
`,
			"utf8",
		);
	}
	return { DNS_PATH, DNS_ZONES_PATH, DNS_COREFILE_PATH };
}

export async function reloadNearzeroDns() {
	ensureDnsDirectories();
	const { DNS_PATH, DNS_ZONES_PATH, DNS_COREFILE_PATH } = paths();

	try {
		const existing = getDocker().getContainer(DNS_CONTAINER_NAME);
		await existing.inspect();
		await existing.restart();
		return;
	} catch (error) {
		if (!isDockerNotFound(error)) {
			throw new ManagedDnsSetupError(error);
		}
		// container missing — create below
	}

	const settings: ContainerCreateOptions = {
		name: DNS_CONTAINER_NAME,
		Image: COREDNS_IMAGE,
		Cmd: ["-conf", "/etc/coredns/Corefile"],
		HostConfig: {
			Binds: [
				`${DNS_COREFILE_PATH}:/etc/coredns/Corefile:ro`,
				`${DNS_ZONES_PATH}:/etc/coredns/zones:ro`,
			],
			PortBindings: {
				"53/tcp": [{ HostPort: "53" }],
				"53/udp": [{ HostPort: "53" }],
			},
			RestartPolicy: { Name: "unless-stopped" },
		},
		ExposedPorts: {
			"53/tcp": {},
			"53/udp": {},
		},
		NetworkingConfig: {
			EndpointsConfig: {
				"nearzero-network": {},
			},
		},
	};

	try {
		await pullCoreDnsImage();
		const container = await getDocker().createContainer(settings);
		await container.start();
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
