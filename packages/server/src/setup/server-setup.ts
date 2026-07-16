import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { getNearzeroUrl } from "@nearzero/server/services/admin";
import {
	createServerDeployment,
	updateDeploymentStatus,
} from "@nearzero/server/services/deployment";
import {
	sanitizeOperationalLogLine,
	sanitizePublicErrorMessage,
} from "@nearzero/server/services/operational-log";
import {
	findServerById,
	updateServerById,
} from "@nearzero/server/services/server";
import { getWebServerSettings } from "@nearzero/server/services/web-server-settings";
import {
	getDefaultMiddlewares,
	getDefaultServerTraefikConfig,
	TRAEFIK_CONTROL_NETWORK,
	TRAEFIK_HTTP3_PORT,
	TRAEFIK_IMAGE,
	TRAEFIK_PORT,
	TRAEFIK_SOCKET_PROXY_IMAGE,
	TRAEFIK_SSL_PORT,
	TRAEFIK_VERSION,
} from "@nearzero/server/setup/traefik-setup";
import slug from "slugify";
import { Client } from "ssh2";
import { recreateDirectory } from "../utils/filesystem/directory";
import { createSshHostVerification } from "../utils/servers/ssh-host-verification";
import {
	installPinnedBuildpacks,
	installPinnedNixpacks,
	installPinnedRailpack,
} from "./builder-versions";
import { setupMonitoring } from "./monitoring-setup";
import { type ServerValidateResult, serverValidate } from "./server-validate";

export const RCLONE_BOOTSTRAP_VERSION = "1.74.2";
export const DOCKER_COMPOSE_BOOTSTRAP_VERSION = "5.1.4";
export const BUN_BOOTSTRAP_VERSION = "1.3.10";
export const PNPM_BOOTSTRAP_VERSION = "10.34.0";
export const MONITORING_BOOTSTRAP_IMAGE =
	"ghcr.io/nearzero-systems/monitoring:0.1.32";

const generateToken = () => {
	const array = new Uint8Array(64);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

export const slugify = (text: string | undefined) => {
	if (!text) {
		return "";
	}

	const cleanedText = text.trim().replace(/[^a-zA-Z0-9\s]/g, "");

	return slug(cleanedText, {
		lower: true,
		trim: true,
		strict: true,
	});
};

export const serverSetup = async (
	serverId: string,
	onData?: (data: any) => void,
) => {
	const server = await findServerById(serverId);
	const { LOGS_PATH } = paths();

	const slugifyName = slugify(`server ${server.name}`);

	const fullPath = path.join(LOGS_PATH, slugifyName);

	await recreateDirectory(fullPath);

	const deployment = await createServerDeployment({
		serverId: server.serverId,
		title: "Setup Server",
		description: "Setup Server",
	});
	const emitLog = (value: unknown) => {
		const safeLine = sanitizeOperationalLogLine(value);
		if (!safeLine) return;
		onData?.(safeLine);
		if (deployment.logPath) {
			void fsPromises.appendFile(deployment.logPath, safeLine).catch(() => {});
		}
	};

	try {
		await updateServerById(serverId, {
			setupStatus: "running",
			setupError: null,
			setupStartedAt: new Date().toISOString(),
			setupFinishedAt: null,
		});
		emitLog(
			sanitizeOperationalLogLine("\nInstalling Server Dependencies: ✅\n"),
		);
		await installRequirements(serverId, emitLog);

		const validation = await serverValidate(serverId);
		const missingChecks = getMissingSetupChecks(validation);
		if (missingChecks.length > 0) {
			const message = `Server setup did not complete. Missing: ${missingChecks.join(", ")}.`;
			emitLog(`\n${message}\n`);
			throw new Error(message);
		}

		emitLog("\nConfiguring Monitoring: 🔄\n");

		const baseUrl = await getNearzeroUrl();
		const token = generateToken();
		const urlCallback = `${baseUrl}/api/trpc/notification.receiveNotification`;
		// The monitoring container crashes (and restarts forever) if cronJob is
		// empty, because the cron scheduler rejects an empty expression. The
		// server default for cronJob is "", so we must guarantee a valid value
		// here before (re)creating the monitoring container.
		const cronJob = server.metricsConfig.server.cronJob || "0 0 * * *";
		const retentionDays = server.metricsConfig.server.retentionDays || 2;

		await updateServerById(serverId, {
			metricsConfig: {
				server: {
					...server.metricsConfig.server,
					token: token,
					urlCallback: urlCallback,
					cronJob: cronJob,
					retentionDays: retentionDays,
				},
				containers: server.metricsConfig.containers,
			},
		});

		try {
			await setupMonitoring(serverId);
			emitLog("\nMonitoring Configured: ✅\n");
		} catch (monitoringError) {
			const message = sanitizePublicErrorMessage(
				monitoringError,
				"Monitoring setup failed",
			);
			console.warn(
				"[server-setup] monitoring setup skipped",
				sanitizePublicErrorMessage(monitoringError, "Monitoring setup failed"),
			);
			emitLog(
				`\nMonitoring setup skipped: ${message}\nServer setup can continue; publish/configure NEARZERO_MONITORING_IMAGE to enable monitoring.\n`,
			);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateServerById(serverId, {
			setupStatus: "ready",
			setupError: null,
			setupFinishedAt: new Date().toISOString(),
		});

		emitLog("\nSetup Server: ✅\n");
	} catch (err) {
		const message = sanitizeOperationalLogLine(
			err instanceof Error ? err.message : String(err),
		);
		console.error("[server-setup]", message);

		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateServerById(serverId, {
			setupStatus: "failed",
			setupError: message,
			setupFinishedAt: new Date().toISOString(),
		});
		emitLog(`${message} ❌\n`);
		throw err;
	}
};

export function getMissingSetupChecks(validation: ServerValidateResult) {
	const missing: string[] = [];
	if (!validation.docker?.enabled) missing.push("Docker");
	if (!validation.isMainDirectoryInstalled) missing.push("/etc/nearzero");
	if (!validation.nixpacks?.enabled) missing.push("Nixpacks");
	if (!validation.buildpacks?.enabled) missing.push("Buildpacks");
	if (!validation.railpack?.enabled) missing.push("Railpack");
	if (!validation.rclone?.enabled) missing.push("Rclone");
	if (!validation.isSwarmInstalled) missing.push("Docker Swarm");
	if (validation.isSwarmInstalled && !validation.isSwarmManager) {
		missing.push("Docker Swarm manager");
	}
	if (validation.privilegeMode === "none") {
		missing.push("passwordless sudo");
	}
	if (validation.privilegeMode !== "root" && !validation.dockerGroupMember) {
		missing.push("Docker group membership");
	}
	if (!validation.isNearzeroNetworkInstalled) missing.push("nearzero-network");
	return missing;
}

const preSetupCleanup = () => `
	# Re-runs must preserve running workloads and ingress. Each later setup step
	# reconciles only the Nearzero-owned resource it manages and rolls back
	# Traefik if replacement fails.
	if $SUDO_CMD docker inspect nearzero-traefik >/dev/null 2>&1; then
		echo "Existing Nearzero Traefik container detected; it will be reconciled in place ✅"
	else
		echo "No existing Nearzero Traefik container detected ✅"
	fi
`;

export const defaultCommand = (acmeEmail?: string | null, sshPort = 22) => {
	const bashCommand = `
set -Eeuo pipefail;
# nearzero-bootstrap-supply-chain-v2
DOCKER_VERSION="\${DOCKER_VERSION:-}"
OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
SYS_ARCH=$(uname -m)
CURRENT_USER=$USER

echo "Installing requirements for: OS: $OS_TYPE"

# Auto-detect sudo requirement
if [ "$EUID" -eq 0 ]; then
	SUDO_CMD=""
	echo "Running as root"
else
	if sudo -n true 2>/dev/null; then
		SUDO_CMD="sudo"
		echo "Running as $CURRENT_USER with sudo privileges"
	else
		echo "Error: Non-root user requires passwordless sudo access. ❌"
		echo "Configure with: echo '$CURRENT_USER ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/$CURRENT_USER"
		exit 1
	fi
fi

# Check if the OS is manjaro, if so, change it to arch
if [ "$OS_TYPE" = "manjaro" ] || [ "$OS_TYPE" = "manjaro-arm" ]; then
	OS_TYPE="arch"
fi

# Check if the OS is Asahi Linux, if so, change it to fedora
if [ "$OS_TYPE" = "fedora-asahi-remix" ]; then
	OS_TYPE="fedora"
fi

# Check if the OS is popOS, if so, change it to ubuntu
if [ "$OS_TYPE" = "pop" ]; then
	OS_TYPE="ubuntu"
fi

# Check if the OS is linuxmint, if so, change it to ubuntu
if [ "$OS_TYPE" = "linuxmint" ]; then
	OS_TYPE="ubuntu"
fi

#Check if the OS is zorin, if so, change it to ubuntu
if [ "$OS_TYPE" = "zorin" ]; then
	OS_TYPE="ubuntu"
fi

if [ "$OS_TYPE" = "arch" ] || [ "$OS_TYPE" = "archarm" ]; then
	OS_VERSION="rolling"
else
	OS_VERSION=$(grep -w "VERSION_ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
fi

if [ "$OS_TYPE" = 'amzn' ]; then
    $SUDO_CMD dnf install -y findutils >/dev/null
fi

case "$OS_TYPE" in
arch | ubuntu | debian | raspbian | centos | fedora | rhel | ol | rocky | sles | opensuse-leap | opensuse-tumbleweed | almalinux | opencloudos | amzn | alpine) ;;
*)
	echo "This script only supports Debian, Redhat, Arch Linux, Alpine Linux, or SLES based operating systems for now."
	exit
	;;
esac

echo -e "---------------------------------------------"
echo "| CPU Architecture  | $SYS_ARCH"
echo "| Operating System  | $OS_TYPE $OS_VERSION"
echo "| Docker            | \${DOCKER_VERSION:-latest stable}"
echo -e "---------------------------------------------\n"

echo -e "0. Pre-setup cleanup (if re-running setup)"
${preSetupCleanup()}

echo -e "1. Installing required packages (curl, wget, git, jq, openssl). "

command_exists() {
	command -v "$@" > /dev/null 2>&1
}

${installUtilities()}

echo -e "2. Validating ports. "
${validatePorts()}



echo -e "3. Installing RClone. "
${installRClone()}

echo -e "4. Installing Docker. "
${installDocker()}

echo -e "5. Setting up Docker Swarm"
${setupSwarm()}

echo -e "6. Setting up Network"
${setupNetwork()}

echo -e "7. Configuring swap memory"
${setupSwap()}

echo -e "8. Setting up Directories"
${setupMainDirectory()}
${setupDirectories()}

echo -e "9. Setting up Traefik"
${createTraefikConfig(acmeEmail)}

echo -e "10. Setting up Middlewares"
${createDefaultMiddlewares()}

echo -e "11. Setting up Traefik Instance"
${createTraefikInstance()}

echo -e "12. Configuring web ingress firewall"
${configureWebIngressFirewall()}

echo -e "13. Installing Nixpacks"
${installNixpacks()}

echo -e "14. Installing Buildpacks"
${installBuildpacks()}

echo -e "15. Installing Railpack"
${installRailpack()}

echo -e "16. Installing package managers (bun, pnpm)"
${installPackageManagers()}

echo -e "17. Validating monitoring image"
${validateMonitoringImage()}

echo -e "18. Keeping monitoring on a private transport"
echo "Remote monitoring is not opened in the public host firewall ✅"

echo -e "19. Configuring permissions"
${setupPermissions()}

echo -e "20. Hardening SSH authentication"
${hardenRemoteSsh(sshPort)}
				`;

	return bashCommand;
};

const isGeneratedNearzeroSetupCommand = (
	command: string | null | undefined,
) => {
	const value = command?.trim();
	if (!value) return false;
	return (
		value.includes("Installing requirements for: OS:") &&
		value.includes("command_exists()") &&
		value.includes("Installing Nixpacks") &&
		value.includes("/etc/nearzero")
	);
};

export const isLatestGeneratedCommand = (
	command: string | null | undefined,
) => {
	const value = command?.trim();
	if (!value) return false;
	// Bump this marker whenever the generated setup script changes in a way that
	// should force servers with a stored command to regenerate. Latest change:
	// harden remote ingress, ACME storage, Docker API access, and re-run safety.
	return (
		value.includes("nearzero-traefik-control") &&
		value.includes("Remote monitoring is not opened") &&
		value.includes("nearzero-bootstrap-supply-chain-v2") &&
		value.includes("nearzero-container-hardening-v1") &&
		value.includes("nearzero-managed-ssh-v1") &&
		value.includes(`TRAEFIK_VERSION=${TRAEFIK_VERSION}`) &&
		value.includes(`TRAEFIK_IMAGE=${TRAEFIK_IMAGE}`)
	);
};

const installRequirements = async (
	serverId: string,
	onData?: (data: any) => void,
) => {
	const client = new Client();
	const server = await findServerById(serverId);
	const webServerSettings = await getWebServerSettings();
	if (!server.sshKeyId) {
		onData?.("❌ No SSH Key found, please assign one to this server");
		throw new Error("No SSH Key found");
	}

	return new Promise<void>((resolve, reject) => {
		const hostVerification = createSshHostVerification(server);
		client
			.once("ready", () => {
				try {
					hostVerification.commit();
				} catch (error) {
					client.end();
					reject(error);
					return;
				}
				const storedCommand = server.command?.trim();

				// Always use the latest generated command if:
				// 1. No stored command exists, OR
				// 2. Stored command is Nearzero-generated but not the latest version
				const shouldUseLatest =
					!storedCommand ||
					(isGeneratedNearzeroSetupCommand(storedCommand) &&
						!isLatestGeneratedCommand(storedCommand));

				const command = shouldUseLatest
					? defaultCommand(webServerSettings?.letsEncryptEmail, server.port)
					: storedCommand;

				if (storedCommand && shouldUseLatest) {
					onData?.(
						"Using the latest Nearzero-generated setup script with improved re-run handling.\n",
					);
				}

				client.exec(command, (err, stream) => {
					if (err) {
						onData?.(err.message);
						reject(err);
						return;
					}
					stream
						.on("close", (code: number) => {
							client.end();
							if (code && code !== 0) {
								reject(
									new Error(
										`Server setup command failed with exit code ${code}`,
									),
								);
								return;
							}
							resolve();
						})
						.on("data", (data: string) => {
							onData?.(sanitizeOperationalLogLine(data.toString()));
						})
						.stderr.on("data", (data) => {
							onData?.(sanitizeOperationalLogLine(data.toString()));
						});
				});
			})
			.on("error", (err) => {
				client.end();
				if (err.level === "client-authentication") {
					const technicalDetail = `Error: ${err.message} ${err.level}`;
					const friendlyMessage = [
						"",
						"❌ Couldn't connect to your server — the SSH key was not accepted.",
						"",
						"This usually means the key doesn't match what's on the server, or the key format is invalid.",
						"",
						`Technical details: ${technicalDetail}`,
						"",
						"💡 Hints:",
						"  • Check that the SSH key you added in Nearzero is the same one installed on the server (e.g. in ~/.ssh/authorized_keys).",
						"  • Try generating a new SSH key in Nearzero and add only the public key to the server, then try again.",
						"  • Make sure to follow the instructions on the Setup Server Button on the SSH Keys tab",
					].join("\n");
					onData?.(sanitizeOperationalLogLine(friendlyMessage));
					reject(
						new Error(
							`Authentication failed: Invalid SSH private key. ${technicalDetail}`,
						),
					);
				} else {
					const technicalDetail = `${err.message} ${err.level ?? ""}`.trim();
					const friendlyMessage = [
						"",
						"❌ Couldn't connect to your server.",
						"",
						"The connection failed before setup could run. Common causes: wrong IP or port, firewall blocking access, or the server is offline.",
						"",
						`Technical details: ${technicalDetail}`,
						"",
						"💡 Hints:",
						"  • Check that the server IP address and SSH port are correct and the server is powered on.",
						"  • If the server is in a private network, ensure Nearzero can reach it (VPN, firewall rules, or correct security groups).",
						"  • Make sure the SSH port (usually 22) is open and the SSH service is running on the server.",
					].join("\n");
					onData?.(sanitizeOperationalLogLine(friendlyMessage));
					reject(new Error(`SSH connection error: ${technicalDetail}`));
				}
			})
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				hostVerifier: hostVerification.hostVerifier,
				readyTimeout: 30_000,
			});
	});
};

const setupDirectories = () => {
	const {
		APPLICATIONS_PATH,
		BASE_PATH,
		CERTIFICATES_PATH,
		COMPOSE_ENV_PATH,
		COMPOSE_PATH,
		DNS_COREFILE_PATH,
		DNS_PATH,
		DNS_ZONES_PATH,
		DYNAMIC_TRAEFIK_PATH,
		LOGS_PATH,
		MAIN_TRAEFIK_PATH,
		MONITORING_PATH,
		PATCH_REPOS_PATH,
		REGISTRY_PATH,
		SCHEDULES_PATH,
		SSH_PATH,
		VOLUME_BACKUPS_PATH,
	} = paths(true);
	// Keep file paths and lock-file prefixes out of this allowlist. In
	// particular, DNS_COREFILE_PATH must remain creatable as a regular file.
	const directories = [
		BASE_PATH,
		MAIN_TRAEFIK_PATH,
		DYNAMIC_TRAEFIK_PATH,
		LOGS_PATH,
		APPLICATIONS_PATH,
		COMPOSE_PATH,
		COMPOSE_ENV_PATH,
		SSH_PATH,
		CERTIFICATES_PATH,
		MONITORING_PATH,
		REGISTRY_PATH,
		SCHEDULES_PATH,
		VOLUME_BACKUPS_PATH,
		PATCH_REPOS_PATH,
		DNS_PATH,
		DNS_ZONES_PATH,
	];

	const createDirsCommand = directories
		.map((dir) => `install -d -m 0700 "${dir}"`)
		.join(" && ");
	const repairCorefilePathCommand = `if [ -d "${DNS_COREFILE_PATH}" ]; then rmdir -- "${DNS_COREFILE_PATH}" || { echo "CoreDNS Corefile path is a non-empty directory" >&2; exit 66; }; fi`;
	const chmodCommand = `chmod 700 "${SSH_PATH}"`;

	const command = `
	${createDirsCommand}
	${repairCorefilePathCommand}
	${chmodCommand}
	`;

	return command;
};

const setupMainDirectory = () => `
	# Check if the /etc/nearzero directory exists
	if [ -d /etc/nearzero ]; then
		echo "/etc/nearzero already exists ✅"
	else
		# Create the /etc/nearzero directory
		$SUDO_CMD mkdir -p /etc/nearzero
		echo "Directory /etc/nearzero created ✅"
	fi
	# Ensure the current user owns the directory
	if [ -n "$SUDO_CMD" ]; then
		$SUDO_CMD chown -R "$CURRENT_USER:$CURRENT_USER" /etc/nearzero
	fi
	chmod 700 /etc/nearzero
`;

export const setupSwarm = () => `
	get_advertise_address() {
		if [ -n "\${ADVERTISE_ADDR:-}" ]; then
			echo "$ADVERTISE_ADDR"
			return
		fi
		if command -v ip >/dev/null 2>&1; then
			local route_ip
			route_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')
			if [ -n "$route_ip" ]; then
				echo "$route_ip"
				return
			fi
		fi
		hostname -I 2>/dev/null | awk '{print $1}'
	}

	SWARM_STATE=$($SUDO_CMD docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)
	IS_MANAGER=$($SUDO_CMD docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || true)
	if [ "$SWARM_STATE" = "active" ]; then
		if [ "$IS_MANAGER" != "true" ]; then
			echo "This server is already a worker in another Docker Swarm. Nearzero will not leave or replace that Swarm automatically." >&2
			exit 43
		fi
		echo "This node is already a Swarm manager ✅"
	else
		advertise_addr=$(get_advertise_address)
		if [ -z "$advertise_addr" ]; then
			echo "Could not determine a local Swarm advertise address. Set ADVERTISE_ADDR explicitly." >&2
			exit 1
		fi
		echo "Initializing Swarm manager with local advertise address: $advertise_addr"
		$SUDO_CMD docker swarm init --advertise-addr "$advertise_addr"
		echo "Swarm initialized ✅"
	fi
	`;

const setupNetwork = () => `
	# Check if the nearzero-network already exists
	if $SUDO_CMD docker network inspect nearzero-network >/dev/null 2>&1; then
		echo "Network nearzero-network already exists"

		# Verify it's an overlay network
		NETWORK_DRIVER=$($SUDO_CMD docker network inspect nearzero-network --format '{{.Driver}}' 2>/dev/null || echo "")

		if [ "$NETWORK_DRIVER" = "overlay" ]; then
			echo "Network is correctly configured as overlay ✅"
		else
			echo "nearzero-network exists with driver '$NETWORK_DRIVER'. Refusing to remove or replace an existing network automatically." >&2
			exit 44
		fi
	else
		# Create the nearzero-network if it doesn't exist
		if $SUDO_CMD docker network create --driver overlay --attachable nearzero-network; then
			echo "Network created ✅"
		else
			echo "Failed to create nearzero-network ❌" >&2
			exit 1
		fi
	fi
`;

// Memory-hungry builds (e.g. Next.js production builds) can exhaust RAM on
// small servers and get OOM-killed (exit code 137). Provisioning a swap file
// gives the kernel headroom to absorb those spikes instead of killing the
// build. Idempotent: skips if swap already exists or the host doesn't allow it.
const setupSwap = () => `
	# Skip if any swap is already active
	if [ "$($SUDO_CMD swapon --show 2>/dev/null | wc -l)" -gt 0 ]; then
		echo "Swap already active ✅"
	elif [ -f /swapfile ]; then
		echo "Swap file already exists, enabling it..."
		$SUDO_CMD swapon /swapfile 2>/dev/null || echo "Could not enable existing swap file (continuing)"
	else
		# Size the swap to ~2x RAM, capped at 8G, with a 2G minimum. This gives
		# low-RAM servers enough headroom for heavy builds.
		MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
		if [ -z "$MEM_KB" ]; then MEM_KB=1048576; fi
		MEM_MB=$((MEM_KB / 1024))
		SWAP_MB=$((MEM_MB * 2))
		if [ "$SWAP_MB" -lt 2048 ]; then SWAP_MB=2048; fi
		if [ "$SWAP_MB" -gt 8192 ]; then SWAP_MB=8192; fi

		# Ensure there is enough free disk before creating the swap file (need
		# the swap size plus a 2G buffer). Skip gracefully if not.
		FREE_MB=$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}')
		if [ -z "$FREE_MB" ]; then FREE_MB=0; fi
		if [ "$FREE_MB" -lt $((SWAP_MB + 2048)) ]; then
			echo "Not enough free disk for a $SWAP_MB MB swap file (free: $FREE_MB MB); skipping swap setup."
		else
			echo "Creating $SWAP_MB MB swap file at /swapfile..."
			if $SUDO_CMD fallocate -l \${SWAP_MB}M /swapfile 2>/dev/null || $SUDO_CMD dd if=/dev/zero of=/swapfile bs=1M count=$SWAP_MB 2>/dev/null; then
				$SUDO_CMD chmod 600 /swapfile
				if $SUDO_CMD mkswap /swapfile >/dev/null 2>&1 && $SUDO_CMD swapon /swapfile 2>/dev/null; then
					# Persist across reboots if not already present in fstab
					if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
						echo '/swapfile none swap sw 0 0' | $SUDO_CMD tee -a /etc/fstab >/dev/null 2>&1 || true
					fi
					echo "Swap file enabled ($SWAP_MB MB) ✅"
				else
					echo "Could not enable swap (host may disallow it, e.g. some containers); continuing without swap."
					$SUDO_CMD rm -f /swapfile 2>/dev/null || true
				fi
			else
				echo "Could not allocate swap file; continuing without swap."
			fi
		fi
	fi
`;

const validatePorts = () => `
	# check if something is running on port 80
	if ss -tulnp | grep ':80 ' >/dev/null 2>&1; then
		# Check if it's Traefik
		if $SUDO_CMD docker ps --format '{{.Names}}' | grep -q 'nearzero-traefik'; then
			echo "Port 80 is used by nearzero-traefik (expected) ✅"
		else
			echo "Port 80 is already owned by another process; refusing to continue with a partially configured ingress." >&2
			exit 45
		fi
	else
		echo "Port 80 is available ✅"
	fi

	# check if something is running on port 443
	if ss -tulnp | grep ':443 ' >/dev/null 2>&1; then
		# Check if it's Traefik
		if $SUDO_CMD docker ps --format '{{.Names}}' | grep -q 'nearzero-traefik'; then
			echo "Port 443 is used by nearzero-traefik (expected) ✅"
		else
			echo "Port 443 is already owned by another process; refusing to continue with a partially configured ingress." >&2
			exit 46
		fi
	else
		echo "Port 443 is available ✅"
	fi
`;

const installUtilities = () => `

	# Wait for any other apt/dpkg process to release the package manager lock
	# before we try to install. Freshly provisioned cloud servers commonly run
	# unattended-upgrades or cloud-init on first boot, which holds the lock and
	# would otherwise make our install fail immediately (exit code 100):
	#   "Could not get lock /var/lib/dpkg/lock-frontend ... is another process using it?"
	wait_for_apt_lock() {
		# fuser isn't guaranteed to be present on minimal images; if it's missing
		# we skip the polling and rely on DPkg::Lock::Timeout below instead.
		if ! command_exists fuser; then
			return 0
		fi
		local max_wait=300
		local waited=0
		while $SUDO_CMD fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
			|| $SUDO_CMD fuser /var/lib/dpkg/lock >/dev/null 2>&1 \
			|| $SUDO_CMD fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
			if [ "$waited" -ge "$max_wait" ]; then
				echo "⚠️  Another process is still holding the apt lock after \${max_wait}s; proceeding anyway." >&2
				break
			fi
			if [ "$waited" -eq 0 ]; then
				echo "Waiting for another package manager process to finish (apt/dpkg lock is held)..." >&2
			fi
			sleep 5
			waited=$((waited + 5))
		done
	}

	# Run an apt-get command defensively. DPkg::Lock::Timeout makes apt itself
	# wait for the lock instead of erroring out, and the retry loop handles
	# transient failures such as lock contention or a flaky package mirror.
	run_apt() {
		local action="$1"
		local attempt=1
		local max_attempts=3
		while [ "$attempt" -le "$max_attempts" ]; do
			wait_for_apt_lock
			if $SUDO_CMD apt-get -o DPkg::Lock::Timeout=300 "$@" >/dev/null 2>&1; then
				return 0
			fi
			echo "apt-get $action failed (attempt $attempt/$max_attempts); retrying in 10s..." >&2
			sleep 10
			attempt=$((attempt + 1))
		done
		echo "apt-get $action failed after $max_attempts attempts ❌" >&2
		return 1
	}

	case "$OS_TYPE" in
	arch)
		$SUDO_CMD pacman -Sy --noconfirm --needed ca-certificates curl wget git git-lfs jq openssl unzip >/dev/null
		;;
	alpine)
		$SUDO_CMD sed -i '/^#.*\/community/s/^#//' /etc/apk/repositories
		$SUDO_CMD apk update >/dev/null
		$SUDO_CMD apk add ca-certificates curl wget git git-lfs jq openssl sudo unzip tar >/dev/null
		;;
	ubuntu | debian | raspbian)
		export DEBIAN_FRONTEND=noninteractive
		run_apt update -y
		run_apt install -y ca-certificates unzip curl wget git git-lfs jq openssl
		;;
	centos | fedora | rhel | ol | rocky | almalinux | opencloudos | amzn)
		if [ "$OS_TYPE" = "amzn" ]; then
			$SUDO_CMD dnf install -y ca-certificates curl wget git git-lfs jq openssl unzip >/dev/null
		else
			if ! command -v dnf >/dev/null; then
				$SUDO_CMD yum install -y dnf >/dev/null
			fi
			if ! command -v curl >/dev/null; then
				$SUDO_CMD dnf install -y curl >/dev/null
			fi
			$SUDO_CMD dnf install -y ca-certificates wget git git-lfs jq openssl unzip >/dev/null
		fi
		;;
	sles | opensuse-leap | opensuse-tumbleweed)
		$SUDO_CMD zypper refresh >/dev/null
		$SUDO_CMD zypper install -y ca-certificates curl wget git git-lfs jq openssl unzip >/dev/null
		;;
	*)
		echo "This script only supports Debian, Redhat, Arch Linux, or SLES based operating systems for now."
		exit
		;;
		esac

	# Download only immutable HTTPS artifacts and compare them with a digest
	# embedded in this generated setup command. A failed or partial download is
	# deleted and is never executed or installed.
	download_verified_artifact() {
		local url="$1"
		local expected_sha256="$2"
		local target="$3"

		case "$expected_sha256" in
			"" | *[!0-9a-f]*)
				echo "Invalid pinned SHA-256 digest for $url" >&2
				return 1
				;;
		esac
		if [ "\${#expected_sha256}" -ne 64 ]; then
			echo "Invalid pinned SHA-256 digest length for $url" >&2
			return 1
		fi

		rm -f "$target"
		if ! curl --fail --location --show-error --silent \
			--proto '=https' --proto-redir '=https' \
			--tlsv1.2 --retry 3 --connect-timeout 20 --max-time 300 \
			--output "$target" "$url"; then
			rm -f "$target"
			return 1
		fi
		if ! printf '%s  %s\\n' "$expected_sha256" "$target" | sha256sum -c - >/dev/null; then
			echo "Checksum verification failed for $url" >&2
			rm -f "$target"
			return 1
		fi
	}
`;

const installDocker = () => `

install_verified_compose_plugin() {
	COMPOSE_VERSION=${DOCKER_COMPOSE_BOOTSTRAP_VERSION}
	case "$SYS_ARCH" in
		x86_64 | amd64)
			COMPOSE_ARCH=x86_64
			COMPOSE_SHA256=33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4
			;;
		aarch64 | arm64)
			COMPOSE_ARCH=aarch64
			COMPOSE_SHA256=d4fb48b72857810314d3ee77123c89954101844efa4788031221f4c370495946
			;;
		armv6l | armv6)
			COMPOSE_ARCH=armv6
			COMPOSE_SHA256=38c8b500e75de30707024db9d135af979f4fdf6b9bae82b7a854b17eddad1205
			;;
		armv7l | armv7)
			COMPOSE_ARCH=armv7
			COMPOSE_SHA256=5cce4229012b8b18067fba078c9ec4e2a5dd47cb4cb3a0cc3d431f6fc429060f
			;;
		ppc64le)
			COMPOSE_ARCH=ppc64le
			COMPOSE_SHA256=044a5a6eac8ba3b686e5ad74d529293372eb6d8553685738fe93ae6a6fd92790
			;;
		riscv64)
			COMPOSE_ARCH=riscv64
			COMPOSE_SHA256=03565cf8e16b3afa6fd6555d697b3237ea2d4dbd5547ab6835bc90fa7e5e00bb
			;;
		s390x)
			COMPOSE_ARCH=s390x
			COMPOSE_SHA256=5bd0db672b07bb86272e84bbddd286f42fe9b84080e4d47ad3a91a84bd8c2c3d
			;;
		*)
			echo "No checksum-pinned Docker Compose artifact is available for architecture $SYS_ARCH." >&2
			return 1
			;;
	 esac

	COMPOSE_ASSET="docker-compose-linux-$COMPOSE_ARCH"
	COMPOSE_TMP=$(mktemp)
	if ! download_verified_artifact \
		"https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/$COMPOSE_ASSET" \
		"$COMPOSE_SHA256" "$COMPOSE_TMP"; then
		rm -f "$COMPOSE_TMP"
		return 1
	fi
	if ! $SUDO_CMD install -d -m 0755 /usr/local/lib/docker/cli-plugins || \
		! $SUDO_CMD install -m 0755 "$COMPOSE_TMP" /usr/local/lib/docker/cli-plugins/docker-compose; then
		rm -f "$COMPOSE_TMP"
		return 1
	fi
	rm -f "$COMPOSE_TMP"
	$SUDO_CMD docker compose version >/dev/null 2>&1
}

# Detect if docker is installed via snap
if [ -x "$(command -v snap)" ]; then
    SNAP_DOCKER_INSTALLED=$(snap list docker >/dev/null 2>&1 && echo "true" || echo "false")
    if [ "$SNAP_DOCKER_INSTALLED" = "true" ]; then
        echo " - Docker is installed via snap."
        echo "   Please note that Nearzero does not support Docker installed via snap."
        echo "   Please remove Docker with snap (snap remove docker) and reexecute this script."
        exit 1
    fi
fi

echo -e "3. Check Docker Installation. "
if ! [ -x "$(command -v docker)" ]; then
    echo " - Docker is not installed. Installing Docker. It may take a while."
	if [ -n "$DOCKER_VERSION" ]; then
		echo "Nearzero will not pass an unverified version argument to a downloaded installer." >&2
		echo "Preinstall Docker $DOCKER_VERSION from a signed package repository, then rerun setup." >&2
		exit 1
	fi
    case "$OS_TYPE" in
        "almalinux" | "rocky" | "centos" | "rhel" | "ol")
			$SUDO_CMD dnf install -y dnf-plugins-core >/dev/null 2>&1
            $SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1
            $SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
            ;;
		"opencloudos")
            # Special handling for OpenCloud OS
            echo " - Installing Docker for OpenCloud OS..."
            $SUDO_CMD dnf install -y docker >/dev/null 2>&1

            # Remove --live-restore parameter from Docker configuration if it exists
            if [ -f "/etc/sysconfig/docker" ]; then
                echo " - Removing --live-restore parameter from Docker configuration..."
                $SUDO_CMD sed -i 's/--live-restore[^[:space:]]*//' /etc/sysconfig/docker >/dev/null 2>&1
                $SUDO_CMD sed -i 's/--live-restore//' /etc/sysconfig/docker >/dev/null 2>&1
                # Clean up any double spaces that might be left
                $SUDO_CMD sed -i 's/  */ /g' /etc/sysconfig/docker >/dev/null 2>&1
            fi
            echo " - Docker configured for OpenCloud OS"
            ;;
        "alpine")
            $SUDO_CMD apk add docker docker-cli-compose >/dev/null 2>&1
            $SUDO_CMD rc-update add docker default >/dev/null 2>&1
            $SUDO_CMD service docker start >/dev/null 2>&1
            ;;
        "arch")
            $SUDO_CMD pacman -Sy docker docker-compose --noconfirm >/dev/null 2>&1
            ;;
        "amzn")
            $SUDO_CMD dnf install docker -y >/dev/null 2>&1
            ;;
        "fedora")
            if [ -x "$(command -v dnf5)" ]; then
				$SUDO_CMD dnf install -y dnf5-plugins >/dev/null 2>&1
                $SUDO_CMD dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo --overwrite >/dev/null 2>&1
            else
				$SUDO_CMD dnf install -y dnf-plugins-core >/dev/null 2>&1
                $SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/fedora/docker-ce.repo >/dev/null 2>&1
            fi
            $SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
            ;;
		"ubuntu" | "debian" | "raspbian")
			if ! run_apt install -y docker.io docker-compose-plugin; then
				run_apt install -y docker.io
			fi
			;;
		"sles" | "opensuse-leap" | "opensuse-tumbleweed")
			$SUDO_CMD zypper install -y docker >/dev/null
			;;
		*)
			echo "No signed package-repository Docker installation is defined for $OS_TYPE." >&2
			exit 1
			;;
	esac

	if ! [ -x "$(command -v docker)" ]; then
		echo " - Docker installation from the signed package repository failed." >&2
		echo " - Install Docker from https://docs.docker.com/engine/install/ and rerun setup." >&2
		exit 1
	fi
	if command -v systemctl >/dev/null 2>&1; then
		$SUDO_CMD systemctl enable docker >/dev/null 2>&1 || true
		$SUDO_CMD systemctl start docker >/dev/null 2>&1 || true
	fi
	echo " - Docker installed successfully."
else
    echo " - Docker is installed."
fi

if ! $SUDO_CMD docker info >/dev/null 2>&1; then
	echo " - Docker is installed but the Docker daemon is not reachable. Start Docker and make sure $CURRENT_USER can access it." >&2
	exit 1
fi
if ! $SUDO_CMD docker compose version >/dev/null 2>&1; then
	echo " - Docker Compose plugin is missing; installing pinned version ${DOCKER_COMPOSE_BOOTSTRAP_VERSION}."
	if ! install_verified_compose_plugin; then
		echo " - Docker Compose could not be installed from a verified release artifact." >&2
		exit 1
	fi
fi
if ! $SUDO_CMD docker compose version >/dev/null 2>&1; then
	echo " - Docker Compose plugin is not usable after installation." >&2
	exit 1
fi
`;

const createTraefikConfig = (acmeEmail?: string | null) => {
	const config = `# nearzero-managed-traefik-v2\n${getDefaultServerTraefikConfig(acmeEmail)}`;
	const encodedConfig = Buffer.from(config, "utf8").toString("base64");

	const command = `
		umask 077
		mkdir -p /etc/nearzero/traefik/dynamic
		chmod 700 /etc/nearzero/traefik /etc/nearzero/traefik/dynamic
	if [ ! -f "/etc/nearzero/traefik/dynamic/acme.json" ]; then
		touch "/etc/nearzero/traefik/dynamic/acme.json"
	fi
	chmod 600 "/etc/nearzero/traefik/dynamic/acme.json"

		TRAEFIK_CONFIG=/etc/nearzero/traefik/traefik.yml
		TRAEFIK_CONFIG_TMP="$TRAEFIK_CONFIG.nearzero-new"
		TRAEFIK_CONFIG_ROLLBACK="$TRAEFIK_CONFIG.nearzero-rollback"
		TRAEFIK_CONFIG_HAD_OLD=false
		TRAEFIK_CONFIG_PENDING=true
		rm -f "$TRAEFIK_CONFIG_ROLLBACK"
		if [ -f "$TRAEFIK_CONFIG" ]; then
			cp -p "$TRAEFIK_CONFIG" "$TRAEFIK_CONFIG_ROLLBACK"
			chmod 600 "$TRAEFIK_CONFIG_ROLLBACK"
			TRAEFIK_CONFIG_HAD_OLD=true
		fi
		restore_traefik_static_config() {
			if [ "\${TRAEFIK_CONFIG_PENDING:-false}" != true ]; then
				return 0
			fi
			if [ "\${TRAEFIK_CONFIG_HAD_OLD:-false}" = true ] && [ -f "$TRAEFIK_CONFIG_ROLLBACK" ]; then
				mv -f "$TRAEFIK_CONFIG_ROLLBACK" "$TRAEFIK_CONFIG"
				chmod 600 "$TRAEFIK_CONFIG"
			else
				rm -f "$TRAEFIK_CONFIG"
			fi
			TRAEFIK_CONFIG_PENDING=false
		}
		trap restore_traefik_static_config ERR
		printf '%s' '${encodedConfig}' | base64 -d > "$TRAEFIK_CONFIG_TMP"
	chmod 600 "$TRAEFIK_CONFIG_TMP"
	if [ -f "$TRAEFIK_CONFIG" ] && ! grep -q 'nearzero-docker-proxy:2375' "$TRAEFIK_CONFIG"; then
		cp -p "$TRAEFIK_CONFIG" "$TRAEFIK_CONFIG.pre-socket-proxy.bak"
		echo "Backed up legacy Traefik config before Docker socket hardening."
	fi
	if [ ! -f "$TRAEFIK_CONFIG" ] || ! grep -q 'nearzero-docker-proxy:2375' "$TRAEFIK_CONFIG"; then
		mv -f "$TRAEFIK_CONFIG_TMP" "$TRAEFIK_CONFIG"
		echo "Traefik static config reconciled ✅"
	elif grep -q '^# nearzero-managed-traefik-v2$' "$TRAEFIK_CONFIG" && ! cmp -s "$TRAEFIK_CONFIG_TMP" "$TRAEFIK_CONFIG"; then
		mv -f "$TRAEFIK_CONFIG_TMP" "$TRAEFIK_CONFIG"
		echo "Nearzero-managed Traefik config updated ✅"
	else
		rm -f "$TRAEFIK_CONFIG_TMP"
		chmod 600 "$TRAEFIK_CONFIG"
		echo "Existing hardened/custom Traefik config preserved ✅"
	fi
	`;

	return command;
};

const createDefaultMiddlewares = () => {
	const config = getDefaultMiddlewares();
	const encodedConfig = Buffer.from(config, "utf8").toString("base64");
	const command = `
	umask 077
	MIDDLEWARE_CONFIG=/etc/nearzero/traefik/dynamic/middlewares.yml
	MIDDLEWARE_CONFIG_TMP="$MIDDLEWARE_CONFIG.nearzero-new"
	printf '%s' '${encodedConfig}' | base64 -d > "$MIDDLEWARE_CONFIG_TMP"
	chmod 600 "$MIDDLEWARE_CONFIG_TMP"
	if [ ! -f "$MIDDLEWARE_CONFIG" ] || ! cmp -s "$MIDDLEWARE_CONFIG_TMP" "$MIDDLEWARE_CONFIG"; then
		mv -f "$MIDDLEWARE_CONFIG_TMP" "$MIDDLEWARE_CONFIG"
	else
		rm -f "$MIDDLEWARE_CONFIG_TMP"
	fi
	`;
	return command;
};

export const installRClone = () => `
    if command_exists rclone; then
		echo "RClone already installed ✅"
	else
		RCLONE_VERSION=${RCLONE_BOOTSTRAP_VERSION}
		case "$SYS_ARCH" in
			x86_64 | amd64)
				RCLONE_ARCH=amd64
				RCLONE_SHA256=72a806370072015ccbe4d81bcd348cc5eaf3beca6c65ba693fd43fb31fcca5b1
				;;
			aarch64 | arm64)
				RCLONE_ARCH=arm64
				RCLONE_SHA256=bc2b2eb8269b743ed7bcea869f3782cfb4931e41efa53fc8befc6dc8308b7a50
				;;
			armv7l | armv7)
				RCLONE_ARCH=arm-v7
				RCLONE_SHA256=0d016e245543995dd5828ab0decd06d4044f87db0ed7f0fceb467f505744a216
				;;
			armv6l | armv6)
				RCLONE_ARCH=arm-v6
				RCLONE_SHA256=debf3db517b4e9de5405f49e76e16ad0fcd38bdaf60e288d0a64a9369faec72f
				;;
			i386 | i686)
				RCLONE_ARCH=386
				RCLONE_SHA256=a74e8b3f31ae32cd888767cf518ec922b0478dd933c297701dd56c8cd389e657
				;;
			*)
				echo "No checksum-pinned rclone artifact is available for architecture $SYS_ARCH." >&2
				exit 1
				;;
		esac

		RCLONE_ARCHIVE="rclone-v$RCLONE_VERSION-linux-$RCLONE_ARCH.zip"
		RCLONE_TMP_DIR=$(mktemp -d)
		if ! download_verified_artifact \
			"https://github.com/rclone/rclone/releases/download/v$RCLONE_VERSION/$RCLONE_ARCHIVE" \
			"$RCLONE_SHA256" "$RCLONE_TMP_DIR/$RCLONE_ARCHIVE"; then
			rm -rf "$RCLONE_TMP_DIR"
			echo "Unable to download and verify rclone $RCLONE_VERSION." >&2
			exit 1
		fi
		if ! unzip -q "$RCLONE_TMP_DIR/$RCLONE_ARCHIVE" -d "$RCLONE_TMP_DIR"; then
			rm -rf "$RCLONE_TMP_DIR"
			echo "Unable to extract the verified rclone archive." >&2
			exit 1
		fi
		if ! $SUDO_CMD install -m 0755 \
			"$RCLONE_TMP_DIR/rclone-v$RCLONE_VERSION-linux-$RCLONE_ARCH/rclone" \
			/usr/local/bin/rclone; then
			rm -rf "$RCLONE_TMP_DIR"
			echo "Unable to install the verified rclone binary." >&2
			exit 1
		fi
		rm -rf "$RCLONE_TMP_DIR"
		INSTALLED_RCLONE_VERSION=$(rclone --version | head -n 1 | awk '{print $2}' | sed 's/^v//')
		if [ "$INSTALLED_RCLONE_VERSION" != "$RCLONE_VERSION" ]; then
			echo "Installed rclone version $INSTALLED_RCLONE_VERSION does not match pinned version $RCLONE_VERSION." >&2
			exit 1
		fi
		echo "RClone version $RCLONE_VERSION installed from a verified release artifact ✅"
	fi
`;

export const createTraefikInstance = () => {
	const command = `
		# nearzero-container-hardening-v1
		TRAEFIK_VERSION=${TRAEFIK_VERSION}
		TRAEFIK_IMAGE=${TRAEFIK_IMAGE}
		SOCKET_PROXY_IMAGE=${TRAEFIK_SOCKET_PROXY_IMAGE}
		CONTROL_NETWORK=${TRAEFIK_CONTROL_NETWORK}

		# Pull both pinned images before touching the active ingress.
		$SUDO_CMD docker pull "$TRAEFIK_IMAGE" >/dev/null
		$SUDO_CMD docker pull "$SOCKET_PROXY_IMAGE" >/dev/null

		if $SUDO_CMD docker network inspect "$CONTROL_NETWORK" >/dev/null 2>&1; then
			CONTROL_DRIVER=$($SUDO_CMD docker network inspect "$CONTROL_NETWORK" --format '{{.Driver}}')
			CONTROL_INTERNAL=$($SUDO_CMD docker network inspect "$CONTROL_NETWORK" --format '{{.Internal}}')
			if [ "$CONTROL_DRIVER" != "bridge" ] || [ "$CONTROL_INTERNAL" != "true" ]; then
				restore_traefik_static_config
				echo "$CONTROL_NETWORK must be an internal bridge network; refusing to expose the Docker API on a shared network." >&2
				exit 47
			fi
		else
			$SUDO_CMD docker network create --driver bridge --internal "$CONTROL_NETWORK" >/dev/null
		fi

		# Only the socket proxy sees the Docker socket. It allows Traefik's read-only
		# discovery endpoints and denies all POST/write operations.
		create_socket_proxy() {
			PROXY_NAME="$1"
			$SUDO_CMD docker create \
			--name "$PROXY_NAME" \
			--restart always \
			--network "$CONTROL_NETWORK" \
			--read-only \
			--tmpfs /run:rw,noexec,nosuid,size=16m \
			--tmpfs /tmp:rw,noexec,nosuid,size=16m \
			--tmpfs /var/lib/haproxy:rw,noexec,nosuid,size=16m \
			--security-opt no-new-privileges:true \
			--cap-drop ALL \
			-v /var/run/docker.sock:/var/run/docker.sock:ro \
			-e ALLOW_START=0 -e ALLOW_STOP=0 -e ALLOW_RESTARTS=0 \
			-e AUTH=0 -e BUILD=0 -e COMMIT=0 -e CONFIGS=0 \
			-e CONTAINERS=1 -e EVENTS=1 -e EXEC=0 -e IMAGES=0 \
			-e INFO=1 -e NETWORKS=1 -e NODES=1 -e PING=1 \
			-e PLUGINS=0 -e POST=0 -e SECRETS=0 -e SERVICES=1 \
			-e SESSION=0 -e SWARM=0 -e SYSTEM=0 -e TASKS=1 \
			-e VERSION=1 -e VOLUMES=0 \
			"$SOCKET_PROXY_IMAGE" >/dev/null
		}

		# Validate the image and security options before replacing the active proxy.
		$SUDO_CMD docker rm -f nearzero-docker-proxy-check >/dev/null 2>&1 || true
		if ! create_socket_proxy nearzero-docker-proxy-check || \
			! $SUDO_CMD docker start nearzero-docker-proxy-check >/dev/null; then
			$SUDO_CMD docker rm -f nearzero-docker-proxy-check >/dev/null 2>&1 || true
			restore_traefik_static_config
			echo "Docker socket proxy validation failed; the active proxy was left untouched." >&2
			exit 48
		fi
		sleep 1
		if [ "$($SUDO_CMD docker inspect nearzero-docker-proxy-check --format '{{.State.Running}}' 2>/dev/null || echo false)" != "true" ]; then
			$SUDO_CMD docker rm -f nearzero-docker-proxy-check >/dev/null 2>&1 || true
			restore_traefik_static_config
			echo "Docker socket proxy validation exited; the active proxy was left untouched." >&2
			exit 48
		fi
		$SUDO_CMD docker rm -f nearzero-docker-proxy-check >/dev/null

		$SUDO_CMD docker rm -f nearzero-docker-proxy-rollback >/dev/null 2>&1 || true
		HAD_OLD_PROXY=false
		if $SUDO_CMD docker inspect nearzero-docker-proxy >/dev/null 2>&1; then
			HAD_OLD_PROXY=true
			$SUDO_CMD docker stop nearzero-docker-proxy >/dev/null 2>&1 || true
			$SUDO_CMD docker rename nearzero-docker-proxy nearzero-docker-proxy-rollback
		fi
		PROXY_CREATED=false
		if create_socket_proxy nearzero-docker-proxy && \
			$SUDO_CMD docker start nearzero-docker-proxy >/dev/null; then
			PROXY_CREATED=true
			sleep 1
		fi
		if [ "$PROXY_CREATED" != true ] || [ "$($SUDO_CMD docker inspect nearzero-docker-proxy --format '{{.State.Running}}' 2>/dev/null || echo false)" != "true" ]; then
			$SUDO_CMD docker rm -f nearzero-docker-proxy >/dev/null 2>&1 || true
			if [ "$HAD_OLD_PROXY" = true ]; then
				$SUDO_CMD docker rename nearzero-docker-proxy-rollback nearzero-docker-proxy
				$SUDO_CMD docker start nearzero-docker-proxy >/dev/null 2>&1 || true
			fi
			restore_traefik_static_config
			echo "Docker socket proxy replacement failed; the previous proxy was restored." >&2
			exit 48
		fi
		$SUDO_CMD docker rm -f nearzero-docker-proxy-rollback >/dev/null 2>&1 || true
		if ! $SUDO_CMD docker run --rm \
			--network "$CONTROL_NETWORK" \
			-v /etc/nearzero/traefik/traefik.yml:/etc/traefik/traefik.yml:ro \
			"$TRAEFIK_IMAGE" \
			check-config --configFile=/etc/traefik/traefik.yml >/dev/null; then
			restore_traefik_static_config
			echo "Traefik rejected the generated static configuration; active ingress was left untouched." >&2
			exit 50
		fi

		# Preserve the old ingress until the replacement is ready. A legacy Swarm
		# service is scaled to zero and restored if standalone startup fails.
		LEGACY_SERVICE=false
		if $SUDO_CMD docker service inspect nearzero-traefik >/dev/null 2>&1; then
			LEGACY_SERVICE=true
			$SUDO_CMD docker service scale nearzero-traefik=0 >/dev/null
			sleep 3
		fi
		$SUDO_CMD docker rm -f nearzero-traefik-rollback >/dev/null 2>&1 || true
		HAD_OLD_CONTAINER=false
		if $SUDO_CMD docker inspect nearzero-traefik >/dev/null 2>&1; then
			HAD_OLD_CONTAINER=true
			$SUDO_CMD docker stop nearzero-traefik >/dev/null 2>&1 || true
			$SUDO_CMD docker rename nearzero-traefik nearzero-traefik-rollback
		fi

		TRAEFIK_CREATED=false
		if $SUDO_CMD docker create \
			--name nearzero-traefik \
			--restart always \
			--network "$CONTROL_NETWORK" \
			--read-only \
			--tmpfs /tmp:rw,noexec,nosuid,size=16m \
			--security-opt no-new-privileges:true \
			--cap-drop ALL \
			--cap-add NET_BIND_SERVICE \
			-v /etc/nearzero/traefik/traefik.yml:/etc/traefik/traefik.yml:ro \
			-v /etc/nearzero/traefik/dynamic:/etc/nearzero/traefik/dynamic \
			-p ${TRAEFIK_SSL_PORT}:${TRAEFIK_SSL_PORT}/tcp \
			-p ${TRAEFIK_PORT}:${TRAEFIK_PORT}/tcp \
			-p ${TRAEFIK_HTTP3_PORT}:${TRAEFIK_SSL_PORT}/udp \
			"$TRAEFIK_IMAGE" >/dev/null; then
			if $SUDO_CMD docker network connect nearzero-network nearzero-traefik >/dev/null && \
				$SUDO_CMD docker start nearzero-traefik >/dev/null; then
				TRAEFIK_CREATED=true
				sleep 2
			fi
		fi

		if [ "$TRAEFIK_CREATED" != "true" ] || [ "$($SUDO_CMD docker inspect nearzero-traefik --format '{{.State.Running}}' 2>/dev/null || echo false)" != "true" ]; then
			echo "Hardened Traefik failed to start; restoring the previous ingress." >&2
			$SUDO_CMD docker rm -f nearzero-traefik >/dev/null 2>&1 || true
			restore_traefik_static_config
			if [ "$HAD_OLD_CONTAINER" = "true" ]; then
				$SUDO_CMD docker rename nearzero-traefik-rollback nearzero-traefik
				$SUDO_CMD docker start nearzero-traefik >/dev/null 2>&1 || true
			fi
			if [ "$LEGACY_SERVICE" = "true" ]; then
				$SUDO_CMD docker service scale nearzero-traefik=1 >/dev/null 2>&1 || true
			fi
			exit 49
		fi

		$SUDO_CMD docker rm -f nearzero-traefik-rollback >/dev/null 2>&1 || true
		if [ "$LEGACY_SERVICE" = "true" ]; then
			$SUDO_CMD docker service rm nearzero-traefik >/dev/null
		fi
		TRAEFIK_CONFIG_PENDING=false
		rm -f "$TRAEFIK_CONFIG_ROLLBACK"
		trap - ERR
		echo "Traefik $TRAEFIK_VERSION is running with isolated read-only Docker API access ✅"
	`;

	return command;
};

const installNixpacks = installPinnedNixpacks;

const installRailpack = installPinnedRailpack;

// Install checksum-pinned standalone binaries for host-side convenience. Most
// builds provision their package managers inside Nixpacks containers, so an
// unsupported architecture or unavailable artifact remains non-fatal.
const installPackageManagers = () => `
	install_verified_bun() {
		BUN_VERSION=${BUN_BOOTSTRAP_VERSION}
		case "$SYS_ARCH" in
			x86_64 | amd64)
			BUN_ARCH=x64
			if grep -qiw avx2 /proc/cpuinfo 2>/dev/null; then
				BUN_BASELINE=""
			else
				BUN_BASELINE=-baseline
			fi
			;;
			aarch64 | arm64)
			BUN_ARCH=aarch64
			BUN_BASELINE=""
			;;
			*)
				return 2
				;;
		esac

		if [ "$OS_TYPE" = "alpine" ]; then
			BUN_LIBC=-musl
		else
			BUN_LIBC=""
		fi
		BUN_ASSET="bun-linux-$BUN_ARCH$BUN_LIBC$BUN_BASELINE.zip"
		case "$BUN_ASSET" in
			bun-linux-x64.zip)
				BUN_SHA256=f57bc0187e39623de716ba3a389fda5486b2d7be7131a980ba54dc7b733d2e08
				;;
			bun-linux-x64-baseline.zip)
				BUN_SHA256=41201a8c5ee74a9dcbb1ce25a1104f1f929838b57a845aa78d98379b0ce7cde2
				;;
			bun-linux-x64-musl.zip)
				BUN_SHA256=48a6c32277d343db0148ce066336472ffd380358a4d26bb1329714742492d824
				;;
			bun-linux-x64-musl-baseline.zip)
				BUN_SHA256=a7bc4cdea1ef255a83adbf39c7aafcd30e09f2b8f74deec4b10ee318bc024d1f
				;;
			bun-linux-aarch64.zip)
				BUN_SHA256=fa5ecb25cafa8e8f5c87a0f833719d46dd0af0a86c7837d806531212d55636d3
				;;
			bun-linux-aarch64-musl.zip)
				BUN_SHA256=d2c81365a2e529b78a42330d3a0056e8dbd7896b4a6782c8e392b6532141e34d
				;;
			*)
				return 2
				;;
		esac

		BUN_TMP_DIR=$(mktemp -d)
		if ! download_verified_artifact \
			"https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_ASSET" \
			"$BUN_SHA256" "$BUN_TMP_DIR/$BUN_ASSET"; then
			rm -rf "$BUN_TMP_DIR"
			return 1
		fi
		if ! unzip -q "$BUN_TMP_DIR/$BUN_ASSET" -d "$BUN_TMP_DIR"; then
			rm -rf "$BUN_TMP_DIR"
			return 1
		fi
		BUN_EXTRACT_DIR=$(basename "$BUN_ASSET" .zip)
		if ! $SUDO_CMD install -m 0755 "$BUN_TMP_DIR/$BUN_EXTRACT_DIR/bun" /usr/local/bin/bun || \
			! $SUDO_CMD ln -sf /usr/local/bin/bun /usr/local/bin/bunx; then
			rm -rf "$BUN_TMP_DIR"
			return 1
		fi
		rm -rf "$BUN_TMP_DIR"
		[ "$(bun --version 2>/dev/null)" = "$BUN_VERSION" ]
	}

	install_verified_pnpm() {
		PNPM_VERSION=${PNPM_BOOTSTRAP_VERSION}
		case "$SYS_ARCH" in
			x86_64 | amd64)
				PNPM_ARCH=x64
				PNPM_SHA256=a4a661a496ea0c02cbca38d372c304873ebe38c0e5f120b65a30bfda50d00fb4
				;;
			aarch64 | arm64)
				PNPM_ARCH=arm64
				PNPM_SHA256=2604884f4a7ecdf6877682e8fb34cd10a6beaebe7909f5cfe1e9fdc1961dc7f0
				;;
			*)
				return 2
				;;
		esac

		PNPM_ASSET="pnpm-linuxstatic-$PNPM_ARCH"
		PNPM_TMP=$(mktemp)
		if ! download_verified_artifact \
			"https://github.com/pnpm/pnpm/releases/download/v$PNPM_VERSION/$PNPM_ASSET" \
			"$PNPM_SHA256" "$PNPM_TMP"; then
			rm -f "$PNPM_TMP"
			return 1
		fi
		if ! $SUDO_CMD install -m 0755 "$PNPM_TMP" /usr/local/bin/pnpm; then
			rm -f "$PNPM_TMP"
			return 1
		fi
		rm -f "$PNPM_TMP"
		[ "$(pnpm --version 2>/dev/null)" = "$PNPM_VERSION" ]
	}

	# Bun
	if command_exists bun; then
		echo "Bun already installed ✅"
	elif install_verified_bun; then
		echo "Bun ${BUN_BOOTSTRAP_VERSION} installed from a verified release artifact ✅"
	else
		echo "⚠️  Bun was not installed (non-critical; container builds provision it via Nixpacks)."
	fi

	# pnpm standalone binary (does not require a system Node.js)
	if command_exists pnpm; then
		echo "pnpm already installed ✅"
	elif install_verified_pnpm; then
		echo "pnpm ${PNPM_BOOTSTRAP_VERSION} installed from a verified release artifact ✅"
	else
		echo "⚠️  pnpm was not installed (non-critical; container builds provision it via Nixpacks)."
	fi
`;

const validateMonitoringImage = () => `
	# Validate monitoring image availability
	echo "Checking monitoring image availability..."

	# Try to inspect the manifest of the monitoring image
	MONITORING_IMAGE="${MONITORING_BOOTSTRAP_IMAGE}"

	if $SUDO_CMD docker manifest inspect $MONITORING_IMAGE > /dev/null 2>&1; then
		echo "Monitoring image $MONITORING_IMAGE is accessible ✅"
	else
		echo "⚠️  Warning: Could not verify monitoring image $MONITORING_IMAGE"
		echo "   Monitoring setup may fail later. This is not critical for server setup."
		echo "   You can configure monitoring after setup completes."
	fi
`;

const hardenRemoteSsh = (sshPort: number) => {
	const expectedSshPort =
		Number.isSafeInteger(sshPort) && sshPort > 0 && sshPort <= 65_535
			? sshPort
			: 22;

	return `
	# nearzero-managed-ssh-v1
	# Keep the active external port unchanged: it may be translated by a cloud
	# firewall or provider NAT. Nearzero hardens authentication and forwarding
	# without risking a mid-install port migration.
	echo "Hardening OpenSSH authentication (configured Nearzero port: ${expectedSshPort})..."
	SSHD_CONFIG=/etc/ssh/sshd_config
	SSHD_BACKUP=/etc/ssh/sshd_config.nearzero-backup
	SSHD_CANDIDATE=$(mktemp)
	SSHD_EXISTING=$(mktemp)
	trap 'rm -f "$SSHD_CANDIDATE" "$SSHD_EXISTING"' EXIT

	if command_exists sshd; then
		SSHD_BIN=$(command -v sshd)
	elif [ -x /usr/sbin/sshd ]; then
		SSHD_BIN=/usr/sbin/sshd
	elif [ -x /usr/local/sbin/sshd ]; then
		SSHD_BIN=/usr/local/sbin/sshd
	else
		echo "Error: OpenSSH server binary was not found; refusing to report a hardened server. ❌"
		rm -f "$SSHD_CANDIDATE" "$SSHD_EXISTING"
		exit 1
	fi

	if [ ! -f "$SSHD_CONFIG" ]; then
		echo "Error: $SSHD_CONFIG was not found; refusing to report a hardened server. ❌"
		rm -f "$SSHD_CANDIDATE" "$SSHD_EXISTING"
		exit 1
	fi

	nearzero_reload_sshd() {
		if command_exists systemctl; then
			if $SUDO_CMD systemctl reload sshd >/dev/null 2>&1; then
				return 0
			fi
			if $SUDO_CMD systemctl reload ssh >/dev/null 2>&1; then
				return 0
			fi
		fi
		if command_exists rc-service && $SUDO_CMD rc-service sshd reload >/dev/null 2>&1; then
			return 0
		fi
		if command_exists service; then
			if $SUDO_CMD service sshd reload >/dev/null 2>&1; then
				return 0
			fi
			if $SUDO_CMD service ssh reload >/dev/null 2>&1; then
				return 0
			fi
		fi
		return 1
	}

	nearzero_restore_sshd() {
		if [ -f "$SSHD_BACKUP" ]; then
			$SUDO_CMD install -m 0600 "$SSHD_BACKUP" "$SSHD_CONFIG" || return 1
			$SUDO_CMD "$SSHD_BIN" -t -f "$SSHD_CONFIG" || return 1
			nearzero_reload_sshd || return 1
		fi
	}

	# Remove only the block owned by Nearzero, preserving every administrator
	# directive and Include outside it. Prepending the managed block makes these
	# first-value OpenSSH directives authoritative, including before Match blocks.
	$SUDO_CMD awk '
		$0 == "# BEGIN nearzero-managed-ssh-v1" { managed = 1; next }
		$0 == "# END nearzero-managed-ssh-v1" { managed = 0; next }
		!managed { print }
	' "$SSHD_CONFIG" > "$SSHD_EXISTING"

	{
		printf '%s\n' \
			'# BEGIN nearzero-managed-ssh-v1' \
			'PubkeyAuthentication yes' \
			'AuthenticationMethods publickey' \
			'PasswordAuthentication no' \
			'KbdInteractiveAuthentication no' \
			'ChallengeResponseAuthentication no' \
			'PermitRootLogin prohibit-password' \
			'MaxAuthTries 3' \
			'LoginGraceTime 30' \
			'AllowAgentForwarding no' \
			'X11Forwarding no' \
			'AllowTcpForwarding local' \
			'GatewayPorts no' \
			'PermitTunnel no' \
			'PermitUserEnvironment no' \
			'# END nearzero-managed-ssh-v1'
		cat "$SSHD_EXISTING"
	} > "$SSHD_CANDIDATE"
	chmod 0600 "$SSHD_CANDIDATE"

	# Validate both syntax and the effective authentication policy before touching
	# the live configuration. The active session uses a key, so root key access is
	# retained while password and keyboard-interactive logins are disabled.
	if ! $SUDO_CMD "$SSHD_BIN" -t -f "$SSHD_CANDIDATE"; then
		echo "Error: generated OpenSSH policy failed syntax validation. ❌"
		rm -f "$SSHD_CANDIDATE" "$SSHD_EXISTING"
		exit 1
	fi

	if ! SSHD_EFFECTIVE=$($SUDO_CMD "$SSHD_BIN" -T -f "$SSHD_CANDIDATE" -C "user=$CURRENT_USER,host=nearzero,addr=127.0.0.1"); then
		echo "Error: generated OpenSSH policy failed effective-policy validation. ❌"
		exit 1
	fi
	if ! printf '%s\n' "$SSHD_EFFECTIVE" | grep -qx 'pubkeyauthentication yes' || \
		! printf '%s\n' "$SSHD_EFFECTIVE" | grep -qx 'authenticationmethods publickey' || \
		! printf '%s\n' "$SSHD_EFFECTIVE" | grep -qx 'passwordauthentication no' || \
		! printf '%s\n' "$SSHD_EFFECTIVE" | grep -qx 'kbdinteractiveauthentication no' || \
		printf '%s\n' "$SSHD_EFFECTIVE" | grep -qx 'permitrootlogin yes'; then
		echo "Error: effective OpenSSH policy is not key-only; leaving the live configuration unchanged. ❌"
		rm -f "$SSHD_CANDIDATE" "$SSHD_EXISTING"
		exit 1
	fi

	if ! $SUDO_CMD install -m 0600 "$SSHD_CONFIG" "$SSHD_BACKUP"; then
		echo "Error: could not create a protected OpenSSH backup; leaving the live configuration unchanged. ❌"
		exit 1
	fi
	if ! $SUDO_CMD install -m 0600 "$SSHD_CANDIDATE" "$SSHD_CONFIG" || \
		! $SUDO_CMD "$SSHD_BIN" -t -f "$SSHD_CONFIG" || \
		! nearzero_reload_sshd; then
		echo "OpenSSH hardening could not be activated; restoring the prior configuration..."
		if nearzero_restore_sshd; then
			echo "Prior OpenSSH configuration restored ✅"
		else
			echo "Error: automatic OpenSSH restore failed. Keep this session open and restore $SSHD_BACKUP manually. ❌"
		fi
		rm -f "$SSHD_CANDIDATE" "$SSHD_EXISTING"
		exit 1
	fi

	rm -f "$SSHD_CANDIDATE" "$SSHD_EXISTING"
	trap - EXIT
	echo "OpenSSH key-only authentication policy active ✅"
	echo "  - Keep the cloud firewall restricted to trusted sources on SSH port ${expectedSshPort}."
	`;
};

const configureWebIngressFirewall = () => `
	# Applications are exposed through the shared Traefik ingress. Individual
	# application ports stay private on the Docker overlay network.
	echo "Configuring shared web ingress (${TRAEFIK_PORT}/tcp, ${TRAEFIK_SSL_PORT}/tcp, ${TRAEFIK_HTTP3_PORT}/udp)..."
	WEB_FIREWALL_MANAGED=false

	if command_exists ufw; then
		if $SUDO_CMD ufw status 2>/dev/null | head -n 1 | grep -qi "active"; then
			$SUDO_CMD ufw allow ${TRAEFIK_PORT}/tcp >/dev/null
			$SUDO_CMD ufw allow ${TRAEFIK_SSL_PORT}/tcp >/dev/null
			$SUDO_CMD ufw allow ${TRAEFIK_HTTP3_PORT}/udp >/dev/null
			WEB_FIREWALL_MANAGED=true
			echo "  - UFW web ingress configured ✅"
		fi
	fi

	if [ "$WEB_FIREWALL_MANAGED" = false ] && command_exists firewall-cmd; then
		if $SUDO_CMD firewall-cmd --state 2>/dev/null | grep -q "running"; then
			$SUDO_CMD firewall-cmd --permanent --add-port=${TRAEFIK_PORT}/tcp >/dev/null
			$SUDO_CMD firewall-cmd --permanent --add-port=${TRAEFIK_SSL_PORT}/tcp >/dev/null
			$SUDO_CMD firewall-cmd --permanent --add-port=${TRAEFIK_HTTP3_PORT}/udp >/dev/null
			$SUDO_CMD firewall-cmd --reload >/dev/null
			WEB_FIREWALL_MANAGED=true
			echo "  - firewalld web ingress configured ✅"
		fi
	fi

	if [ "$WEB_FIREWALL_MANAGED" = false ] && command_exists iptables; then
		for PORT in ${TRAEFIK_PORT} ${TRAEFIK_SSL_PORT}; do
			if ! $SUDO_CMD iptables -C INPUT -p tcp --dport $PORT -j ACCEPT 2>/dev/null; then
				$SUDO_CMD iptables -I INPUT -p tcp --dport $PORT -j ACCEPT >/dev/null
			fi
		done
		if ! $SUDO_CMD iptables -C INPUT -p udp --dport ${TRAEFIK_HTTP3_PORT} -j ACCEPT 2>/dev/null; then
			$SUDO_CMD iptables -I INPUT -p udp --dport ${TRAEFIK_HTTP3_PORT} -j ACCEPT >/dev/null
		fi
		echo "  - iptables web ingress configured ✅"
	fi

	echo "  - Ensure the cloud firewall/security group also permits TCP ${TRAEFIK_PORT}/${TRAEFIK_SSL_PORT} and UDP ${TRAEFIK_HTTP3_PORT}."
	`;

const setupPermissions = () => `
	# Add user to docker group if not root
	if [ -n "$SUDO_CMD" ]; then
		if ! groups "$CURRENT_USER" | grep -qw docker; then
			$SUDO_CMD usermod -aG docker "$CURRENT_USER"
			echo "User $CURRENT_USER added to docker group ✅"
		else
			echo "User $CURRENT_USER already in docker group ✅"
		fi
		# Ensure the user owns the nearzero directory
		$SUDO_CMD chown -R "$CURRENT_USER:$CURRENT_USER" /etc/nearzero
		echo "Permissions configured for $CURRENT_USER ✅"
	else
		echo "Running as root, no extra permissions needed ✅"
	fi
`;

const installBuildpacks = installPinnedBuildpacks;
