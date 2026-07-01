import { execAsyncRemote } from "../process/execAsync";

export type PublishedPortSpec = {
	publishedPort: number;
	protocol: "tcp" | "udp";
};

type PublishedPortInput = {
	PublishedPort?: unknown;
	publishedPort?: unknown;
	Protocol?: unknown;
	protocol?: unknown;
};

const VALID_PROTOCOLS = new Set(["tcp", "udp"]);

function normalizeProtocol(
	value: unknown,
): PublishedPortSpec["protocol"] | null {
	const protocol = typeof value === "string" ? value.toLowerCase() : "tcp";
	return VALID_PROTOCOLS.has(protocol)
		? (protocol as PublishedPortSpec["protocol"])
		: null;
}

function normalizePort(value: unknown): number | null {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function normalizePublishedPortSpecs(
	ports: PublishedPortInput[] | null | undefined,
): PublishedPortSpec[] {
	const specs: PublishedPortSpec[] = [];
	const seen = new Set<string>();

	for (const port of ports ?? []) {
		const publishedPort = normalizePort(
			port.PublishedPort ?? port.publishedPort,
		);
		const protocol = normalizeProtocol(port.Protocol ?? port.protocol);
		if (!publishedPort || !protocol) continue;

		const key = `${publishedPort}/${protocol}`;
		if (seen.has(key)) continue;
		seen.add(key);
		specs.push({ publishedPort, protocol });
	}

	return specs;
}

export function formatPublishedPortSpecs(specs: PublishedPortSpec[]) {
	return specs
		.map((spec) => `${spec.publishedPort}/${spec.protocol}`)
		.join(", ");
}

export function buildPublishedPortFirewallScript(specs: PublishedPortSpec[]) {
	const portSpecs = specs
		.map((spec) => `${spec.publishedPort}/${spec.protocol}`)
		.join(" ");

	return `
set -u
command_exists() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then
	SUDO_CMD=""
elif command_exists sudo && sudo -n true >/dev/null 2>&1; then
	SUDO_CMD="sudo"
else
	echo "Passwordless sudo is unavailable; skipped host firewall configuration for Docker published ports."
	echo "Allow these ports in the host/cloud firewall: ${portSpecs}"
	exit 0
fi

PORT_SPECS="${portSpecs}"
FIREWALL_MANAGED=false

if command_exists ufw; then
	if $SUDO_CMD ufw status 2>/dev/null | head -n 1 | grep -qi "active"; then
		for SPEC in $PORT_SPECS; do
			$SUDO_CMD ufw allow "$SPEC" >/dev/null 2>&1 || true
		done
		FIREWALL_MANAGED=true
		echo "UFW allowed Docker published ports: $PORT_SPECS"
	fi
fi

if [ "$FIREWALL_MANAGED" = false ] && command_exists firewall-cmd; then
	if $SUDO_CMD firewall-cmd --state 2>/dev/null | grep -q "running"; then
		for SPEC in $PORT_SPECS; do
			$SUDO_CMD firewall-cmd --permanent --add-port="$SPEC" >/dev/null 2>&1 || true
		done
		$SUDO_CMD firewall-cmd --reload >/dev/null 2>&1 || true
		FIREWALL_MANAGED=true
		echo "firewalld allowed Docker published ports: $PORT_SPECS"
	fi
fi

if [ "$FIREWALL_MANAGED" = false ] && command_exists iptables; then
	for SPEC in $PORT_SPECS; do
		PORT="\${SPEC%/*}"
		PROTO="\${SPEC#*/}"
		if ! $SUDO_CMD iptables -C INPUT -p "$PROTO" --dport "$PORT" -j ACCEPT 2>/dev/null; then
			$SUDO_CMD iptables -I INPUT -p "$PROTO" --dport "$PORT" -j ACCEPT >/dev/null 2>&1 || true
		fi
	done
	FIREWALL_MANAGED=true
	echo "iptables allowed Docker published ports: $PORT_SPECS"
fi

if [ "$FIREWALL_MANAGED" = false ]; then
	echo "No active supported host firewall was detected. Docker published ports should be reachable if the cloud firewall allows them."
fi

echo "Ensure the cloud firewall/security group also permits: $PORT_SPECS"
`.trim();
}

export async function openPublishedPortsOnRemoteServer(input: {
	serverId: string;
	ports: PublishedPortInput[] | null | undefined;
}) {
	const specs = normalizePublishedPortSpecs(input.ports);
	if (specs.length === 0) {
		return { specs, stdout: "", stderr: "" };
	}

	const result = await execAsyncRemote(
		input.serverId,
		buildPublishedPortFirewallScript(specs),
	);
	return { specs, ...result };
}
