import { quote } from "shell-quote";
import { findServerById } from "../services/server";
import { execAsyncRemote } from "../utils/process/execAsync";
import {
	installPinnedBuildpacks,
	installPinnedNixpacks,
	installPinnedRailpack,
} from "./builder-versions";

export type RepairableServerCapability =
	| "buildpacks"
	| "docker-daemon"
	| "docker-group"
	| "main-directory"
	| "nearzero-network"
	| "nixpacks"
	| "railpack"
	| "swarm"
	| "swarm-manager";

const REPAIRABLE_CAPABILITIES = new Set<RepairableServerCapability>([
	"buildpacks",
	"docker-daemon",
	"docker-group",
	"main-directory",
	"nearzero-network",
	"nixpacks",
	"railpack",
	"swarm",
	"swarm-manager",
]);

export function getRepairableServerCapabilities(
	capabilities: string[],
): RepairableServerCapability[] {
	return [
		...new Set(
			capabilities.filter(
				(capability): capability is RepairableServerCapability =>
					REPAIRABLE_CAPABILITIES.has(
						capability as RepairableServerCapability,
					),
			),
		),
	];
}

export function buildServerCapabilityRepairScript(input: {
	capabilities: RepairableServerCapability[];
	advertiseAddress: string;
}) {
	const requested = new Set(input.capabilities);
	const lines = [
		"#!/usr/bin/env bash",
		"set -Eeuo pipefail",
		'CURRENT_USER="$(id -un)"',
		'SYS_ARCH="$(uname -m)"',
		'command_exists() { command -v "$1" >/dev/null 2>&1; }',
		'if [ "$(id -u)" -eq 0 ]; then',
		'  SUDO_CMD=""',
		"elif sudo -n true >/dev/null 2>&1; then",
		'  SUDO_CMD="sudo"',
		"else",
		'  echo "Passwordless sudo is required for server capability repair." >&2',
		"  exit 40",
		"fi",
		'docker_cmd() { if [ -n "$SUDO_CMD" ]; then sudo docker "$@"; else docker "$@"; fi; }',
	];

	if (
		requested.has("docker-daemon") ||
		requested.has("swarm") ||
		requested.has("swarm-manager") ||
		requested.has("nearzero-network")
	) {
		lines.push(
			"command -v docker >/dev/null 2>&1 || { echo \"Docker CLI is not installed; setup is required.\" >&2; exit 41; }",
			"if ! docker_cmd info >/dev/null 2>&1; then",
			"  if command -v systemctl >/dev/null 2>&1; then",
			'    if [ -n "$SUDO_CMD" ]; then sudo systemctl start docker; else systemctl start docker; fi',
			"  elif command -v service >/dev/null 2>&1; then",
			'    if [ -n "$SUDO_CMD" ]; then sudo service docker start; else service docker start; fi',
			"  else",
			'    echo "Docker daemon cannot be started automatically on this server." >&2',
			"    exit 42",
			"  fi",
			"fi",
			"docker_cmd info >/dev/null 2>&1",
		);
	}

	if (requested.has("docker-group")) {
		lines.push(
			'if [ "$(id -u)" -ne 0 ] && ! groups "$CURRENT_USER" | grep -qw docker; then',
			'  sudo usermod -aG docker "$CURRENT_USER"',
			"fi",
		);
	}

	if (requested.has("main-directory")) {
		lines.push(
			'if [ -n "$SUDO_CMD" ]; then',
			"  sudo mkdir -p /etc/nearzero/{applications,logs,monitoring,schedules,ssh,traefik/dynamic,traefik/dynamic/certificates,volume-backups}",
			'  sudo chown -R "$CURRENT_USER:$CURRENT_USER" /etc/nearzero',
			"else",
			"  mkdir -p /etc/nearzero/{applications,logs,monitoring,schedules,ssh,traefik/dynamic,traefik/dynamic/certificates,volume-backups}",
			"fi",
		);
	}

	if (requested.has("swarm") || requested.has("swarm-manager")) {
		lines.push(
			'swarm_state="$(docker_cmd info --format \'{{.Swarm.LocalNodeState}}\' 2>/dev/null || true)"',
			'swarm_manager="$(docker_cmd info --format \'{{.Swarm.ControlAvailable}}\' 2>/dev/null || true)"',
			'if [ "$swarm_state" != "active" ]; then',
			`  docker_cmd swarm init --advertise-addr ${quote([input.advertiseAddress])}`,
			'elif [ "$swarm_manager" != "true" ]; then',
			'  echo "The server is already an active Swarm worker. Nearzero will not leave or recreate that Swarm automatically." >&2',
			"  exit 43",
			"fi",
		);
	}

	if (requested.has("nearzero-network")) {
		lines.push(
			"if docker_cmd network inspect nearzero-network >/dev/null 2>&1; then",
			'  network_driver="$(docker_cmd network inspect nearzero-network --format \'{{.Driver}}\')"',
			'  if [ "$network_driver" != "overlay" ]; then',
			'    echo "nearzero-network exists with a non-overlay driver. Refusing to replace an active network automatically." >&2',
			"    exit 44",
			"  fi",
			"else",
			"  docker_cmd network create --driver overlay --attachable nearzero-network >/dev/null",
			"fi",
		);
	}

	if (requested.has("nixpacks")) {
		lines.push(installPinnedNixpacks());
	}

	if (requested.has("railpack")) {
		lines.push(installPinnedRailpack());
	}

	if (requested.has("buildpacks")) {
		lines.push(installPinnedBuildpacks());
	}

	lines.push('echo "Requested server capability repair completed."');
	return lines.join("\n");
}

export async function repairServerCapabilities(input: {
	serverId: string;
	capabilities: string[];
}) {
	const capabilities = getRepairableServerCapabilities(input.capabilities);
	if (capabilities.length === 0) {
		return { attempted: [] as RepairableServerCapability[] };
	}

	const server = await findServerById(input.serverId);
	const script = buildServerCapabilityRepairScript({
		capabilities,
		advertiseAddress: server.ipAddress,
	});
	await execAsyncRemote(input.serverId, script);
	return { attempted: capabilities };
}
