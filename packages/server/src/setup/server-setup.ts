import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { paths } from "@nearzero/server/constants";
import { getNearzeroUrl } from "@nearzero/server/services/admin";
import {
	createServerDeployment,
	updateDeploymentStatus,
} from "@nearzero/server/services/deployment";
import {
	findServerById,
	updateServerById,
} from "@nearzero/server/services/server";
import { sanitizeOperationalLogLine } from "@nearzero/server/services/operational-log";
import {
	getDefaultMiddlewares,
	getDefaultServerTraefikConfig,
	TRAEFIK_HTTP3_PORT,
	TRAEFIK_PORT,
	TRAEFIK_SSL_PORT,
	TRAEFIK_VERSION,
} from "@nearzero/server/setup/traefik-setup";
import slug from "slugify";
import { Client } from "ssh2";
import { recreateDirectory } from "../utils/filesystem/directory";
import {
	installPinnedBuildpacks,
	installPinnedNixpacks,
	installPinnedRailpack,
} from "./builder-versions";
import { setupMonitoring } from "./monitoring-setup";
import { serverValidate, type ServerValidateResult } from "./server-validate";

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
		emitLog(sanitizeOperationalLogLine("\nInstalling Server Dependencies: ✅\n"));
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
			const message =
				monitoringError instanceof Error
					? monitoringError.message
					: String(monitoringError);
			console.warn("[server-setup] monitoring setup skipped", monitoringError);
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
	if (
		validation.privilegeMode !== "root" &&
		!validation.dockerGroupMember
	) {
		missing.push("Docker group membership");
	}
	if (!validation.isNearzeroNetworkInstalled) missing.push("nearzero-network");
	return missing;
}

const preSetupCleanup = () => `
	# Pre-setup cleanup for re-runs
	# This ensures a clean state when retrying server setup

	# Check if this is a re-run (Traefik or Swarm already exists)
	NEEDS_CLEANUP=false

	if $SUDO_CMD docker inspect nearzero-traefik > /dev/null 2>&1; then
		NEEDS_CLEANUP=true
	fi

	if $SUDO_CMD docker info | grep -q 'Swarm: active'; then
		NEEDS_CLEANUP=true
	fi

	if [ "$NEEDS_CLEANUP" = "true" ]; then
		echo "Detected existing Nearzero installation. Cleaning up for fresh setup..."

		# Stop and remove Traefik container if it exists
		if $SUDO_CMD docker inspect nearzero-traefik > /dev/null 2>&1; then
			echo "  - Stopping and removing existing Traefik container..."
			$SUDO_CMD docker stop nearzero-traefik 2>/dev/null || true
			$SUDO_CMD docker rm -f nearzero-traefik 2>/dev/null || true
			sleep 2
		fi

		# Remove Traefik service if it exists (legacy)
		if $SUDO_CMD docker service inspect nearzero-traefik > /dev/null 2>&1; then
			echo "  - Removing existing Traefik service..."
			$SUDO_CMD docker service rm nearzero-traefik 2>/dev/null || true
			sleep 3
		fi

		echo "Cleanup completed ✅"
	else
		echo "Fresh installation detected, no cleanup needed ✅"
	fi
`;

export const defaultCommand = () => {
	const bashCommand = `
set -Eeuo pipefail;
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
${createTraefikConfig()}

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

echo -e "18. Configuring monitoring firewall"
${configureMonitoringPort()}

echo -e "19. Configuring permissions"
${setupPermissions()}
				`;

	return bashCommand;
};

const isGeneratedNearzeroSetupCommand = (command: string | null | undefined) => {
	const value = command?.trim();
	if (!value) return false;
	return (
		value.includes("Installing requirements for: OS:") &&
		value.includes("command_exists()") &&
		value.includes("Installing Nixpacks") &&
		value.includes("/etc/nearzero")
	);
};

const isLatestGeneratedCommand = (command: string | null | undefined) => {
	const value = command?.trim();
	if (!value) return false;
	// Bump this marker whenever the generated setup script changes in a way that
	// should force servers with a stored command to regenerate. Latest change:
	// configure the shared Traefik ingress ports during setup.
	return value.includes("Configuring web ingress firewall");
};

const installRequirements = async (
	serverId: string,
	onData?: (data: any) => void,
) => {
	const client = new Client();
	const server = await findServerById(serverId);
	if (!server.sshKeyId) {
		onData?.("❌ No SSH Key found, please assign one to this server");
		throw new Error("No SSH Key found");
	}

	return new Promise<void>((resolve, reject) => {
		client
			.once("ready", () => {
				const storedCommand = server.command?.trim();

				// Always use the latest generated command if:
				// 1. No stored command exists, OR
				// 2. Stored command is Nearzero-generated but not the latest version
				const shouldUseLatest =
					!storedCommand ||
					(isGeneratedNearzeroSetupCommand(storedCommand) && !isLatestGeneratedCommand(storedCommand));

				const command = shouldUseLatest ? defaultCommand() : storedCommand;

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
			});
	});
};

const setupDirectories = () => {
	const { SSH_PATH } = paths(true);
	const directories = Object.values(paths(true));

	const createDirsCommand = directories
		.map((dir) => `mkdir -p "${dir}"`)
		.join(" && ");
	const chmodCommand = `chmod 700 "${SSH_PATH}"`;

	const command = `
	${createDirsCommand}
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
		$SUDO_CMD chown -R $CURRENT_USER:$CURRENT_USER /etc/nearzero
	fi
`;

export const setupSwarm = () => `
		# Check if the node is already part of a Docker Swarm
		if $SUDO_CMD docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null | grep -q 'active'; then
			echo "Docker Swarm is already active"

			# Check if this is a manager node
			IS_MANAGER=$($SUDO_CMD docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)

			if [ "$IS_MANAGER" = "true" ]; then
				echo "This node is a Swarm manager ✅"
			else
				echo "Warning: This node is a Swarm worker, not a manager"
				echo "Nearzero requires a manager node. Leaving swarm and reinitializing..."

				# Leave the swarm
				if $SUDO_CMD docker swarm leave --force 2>/dev/null; then
					echo "Left existing swarm"
				else
					echo "Failed to leave swarm, but continuing..."
				fi

				# Get IP address and reinitialize
				get_ip() {
					local ip=""
					ip=\$(curl -4s --connect-timeout 5 https://ifconfig.io 2>/dev/null)
					if [ -z "\$ip" ]; then
						ip=\$(curl -4s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
					fi
					if [ -z "\$ip" ]; then
						ip=\$(curl -4s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
					fi
					if [ -z "\$ip" ]; then
						ip=\$(curl -6s --connect-timeout 5 https://ifconfig.io 2>/dev/null)
					fi
					if [ -z "\$ip" ]; then
						ip=\$(curl -6s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
					fi
					if [ -z "\$ip" ]; then
						ip=\$(curl -6s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
					fi
					if [ -z "\$ip" ]; then
						echo "Error: Could not determine server IP address automatically." >&2
						exit 1
					fi
					echo "\$ip"
				}
				advertise_addr=\$(get_ip)
				echo "Advertise address: \$advertise_addr"
				$SUDO_CMD docker swarm init --advertise-addr \$advertise_addr
				echo "Swarm reinitialized as manager ✅"
			fi
		else
			# Get IP address
			get_ip() {
				local ip=""

				# Try IPv4 with multiple services
				# First attempt: ifconfig.io
				ip=\$(curl -4s --connect-timeout 5 https://ifconfig.io 2>/dev/null)

				# Second attempt: icanhazip.com
				if [ -z "\$ip" ]; then
					ip=\$(curl -4s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
				fi

				# Third attempt: ipecho.net
				if [ -z "\$ip" ]; then
					ip=\$(curl -4s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
				fi

				# If no IPv4, try IPv6 with multiple services
				if [ -z "\$ip" ]; then
					# Try IPv6 with ifconfig.io
					ip=\$(curl -6s --connect-timeout 5 https://ifconfig.io 2>/dev/null)

					# Try IPv6 with icanhazip.com
					if [ -z "\$ip" ]; then
						ip=\$(curl -6s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
					fi

					# Try IPv6 with ipecho.net
					if [ -z "\$ip" ]; then
						ip=\$(curl -6s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
					fi
				fi

				if [ -z "\$ip" ]; then
					echo "Error: Could not determine server IP address automatically (neither IPv4 nor IPv6)." >&2
					echo "Please set the ADVERTISE_ADDR environment variable manually." >&2
					echo "Example: export ADVERTISE_ADDR=<your-server-ip>" >&2
					exit 1
				fi

				echo "\$ip"
			}
			advertise_addr=\$(get_ip)
			echo "Advertise address: \$advertise_addr"

			# Initialize Docker Swarm
			$SUDO_CMD docker swarm init --advertise-addr \$advertise_addr
			echo "Swarm initialized ✅"
		fi
	`;

const setupNetwork = () => `
	# Check if the nearzero-network already exists
	if $SUDO_CMD docker network ls | grep -q 'nearzero-network'; then
		echo "Network nearzero-network already exists"

		# Verify it's an overlay network
		NETWORK_DRIVER=$($SUDO_CMD docker network inspect nearzero-network --format '{{.Driver}}' 2>/dev/null || echo "")

		if [ "$NETWORK_DRIVER" = "overlay" ]; then
			echo "Network is correctly configured as overlay ✅"
		else
			echo "Warning: nearzero-network exists but is not an overlay network (driver: $NETWORK_DRIVER)"
			echo "Recreating network as overlay..."

			# Remove the old network
			$SUDO_CMD docker network rm nearzero-network 2>/dev/null || true
			sleep 2

			# Create the overlay network
			if $SUDO_CMD docker network create --driver overlay --attachable nearzero-network; then
				echo "Network recreated as overlay ✅"
			else
				echo "Failed to recreate nearzero-network ❌" >&2
				exit 1
			fi
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
			echo "⚠️  Warning: Something is already running on port 80"
			echo "   This may prevent Traefik from binding to port 80"
			echo "   You may need to stop the service using port 80 or reconfigure it"
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
			echo "⚠️  Warning: Something is already running on port 443"
			echo "   This may prevent Traefik from binding to port 443"
			echo "   You may need to stop the service using port 443 or reconfigure it"
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
		$SUDO_CMD pacman -Sy --noconfirm --needed curl wget git git-lfs jq openssl >/dev/null || true
		;;
	alpine)
		$SUDO_CMD sed -i '/^#.*\/community/s/^#//' /etc/apk/repositories
		$SUDO_CMD apk update >/dev/null
		$SUDO_CMD apk add curl wget git git-lfs jq openssl sudo unzip tar >/dev/null
		;;
	ubuntu | debian | raspbian)
		export DEBIAN_FRONTEND=noninteractive
		run_apt update -y
		run_apt install -y unzip curl wget git git-lfs jq openssl
		;;
	centos | fedora | rhel | ol | rocky | almalinux | opencloudos | amzn)
		if [ "$OS_TYPE" = "amzn" ]; then
			$SUDO_CMD dnf install -y wget git git-lfs jq openssl >/dev/null
		else
			if ! command -v dnf >/dev/null; then
				$SUDO_CMD yum install -y dnf >/dev/null
			fi
			if ! command -v curl >/dev/null; then
				$SUDO_CMD dnf install -y curl >/dev/null
			fi
			$SUDO_CMD dnf install -y wget git git-lfs jq openssl unzip >/dev/null
		fi
		;;
	sles | opensuse-leap | opensuse-tumbleweed)
		$SUDO_CMD zypper refresh >/dev/null
		$SUDO_CMD zypper install -y curl wget git git-lfs jq openssl >/dev/null
		;;
	*)
		echo "This script only supports Debian, Redhat, Arch Linux, or SLES based operating systems for now."
		exit
		;;
	esac
`;

const installDocker = () => `

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
    case "$OS_TYPE" in
        "almalinux" | "rocky" | "centos" | "rhel" | "ol")
            $SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1
            $SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Docker could not be installed automatically. Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                exit 1
            fi
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            ;;
	"opencloudos")
            # Special handling for OpenCloud OS
            echo " - Installing Docker for OpenCloud OS..."
            $SUDO_CMD dnf install -y docker >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Docker could not be installed automatically. Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                exit 1
            fi

            # Remove --live-restore parameter from Docker configuration if it exists
            if [ -f "/etc/sysconfig/docker" ]; then
                echo " - Removing --live-restore parameter from Docker configuration..."
                $SUDO_CMD sed -i 's/--live-restore[^[:space:]]*//' /etc/sysconfig/docker >/dev/null 2>&1
                $SUDO_CMD sed -i 's/--live-restore//' /etc/sysconfig/docker >/dev/null 2>&1
                # Clean up any double spaces that might be left
                $SUDO_CMD sed -i 's/  */ /g' /etc/sysconfig/docker >/dev/null 2>&1
            fi

            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            echo " - Docker configured for OpenCloud OS"
            ;;
        "alpine")
            $SUDO_CMD apk add docker docker-cli-compose >/dev/null 2>&1
            $SUDO_CMD rc-update add docker default >/dev/null 2>&1
            $SUDO_CMD service docker start >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Failed to install Docker with apk. Try to install it manually."
                echo "   Please visit https://wiki.alpinelinux.org/wiki/Docker for more information."
                exit 1
            fi
            ;;
        "arch")
            $SUDO_CMD pacman -Sy docker docker-compose --noconfirm >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker.service >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Failed to install Docker with pacman. Try to install it manually."
                echo "   Please visit https://wiki.archlinux.org/title/docker for more information."
                exit 1
            fi
            ;;
        "amzn")
            $SUDO_CMD dnf install docker -y >/dev/null 2>&1
            DOCKER_CONFIG=/usr/local/lib/docker
            $SUDO_CMD mkdir -p $DOCKER_CONFIG/cli-plugins >/dev/null 2>&1
            $SUDO_CMD curl -sL https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) -o $DOCKER_CONFIG/cli-plugins/docker-compose >/dev/null 2>&1
            $SUDO_CMD chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose >/dev/null 2>&1
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Failed to install Docker with dnf. Try to install it manually."
                echo "   Please visit https://www.cyberciti.biz/faq/how-to-install-docker-on-amazon-linux-2/ for more information."
                exit 1
            fi
            ;;
        "fedora")
            if [ -x "$(command -v dnf5)" ]; then
                # dnf5 is available
                $SUDO_CMD dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo --overwrite >/dev/null 2>&1
            else
                # dnf5 is not available, use dnf
                $SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/fedora/docker-ce.repo >/dev/null 2>&1
            fi
            $SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Docker could not be installed automatically. Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                exit 1
            fi
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            ;;
        *)
            if [ "$OS_TYPE" = "ubuntu" ] && [ "$OS_VERSION" = "24.10" ]; then
                echo "Docker automated installation is not supported on Ubuntu 24.10 (non-LTS release)."
                    echo "Please install Docker manually."
                exit 1
            fi

            if ! [ -x "$(command -v docker)" ]; then
                if [ -n "$DOCKER_VERSION" ]; then
                    if ! curl -fsSL https://get.docker.com | $SUDO_CMD sh -s -- --version "$DOCKER_VERSION" 2>&1; then
                        echo " - Docker version $DOCKER_VERSION was not available from Docker's repository. Retrying latest stable Docker."
                        if ! curl -fsSL https://get.docker.com | $SUDO_CMD sh 2>&1; then
                            echo " - Docker official installer failed."
                        fi
                    fi
                elif ! curl -fsSL https://get.docker.com | $SUDO_CMD sh 2>&1; then
                    echo " - Docker official installer failed."
                fi
                if ! [ -x "$(command -v docker)" ] && { [ "$OS_TYPE" = "ubuntu" ] || [ "$OS_TYPE" = "debian" ] || [ "$OS_TYPE" = "raspbian" ]; }; then
                    echo " - Docker official installer did not install Docker. Trying OS packages."
                    $SUDO_CMD rm -f /etc/apt/sources.list.d/docker.list
                    $SUDO_CMD apt-get -qq update >/dev/null
                    if ! $SUDO_CMD env DEBIAN_FRONTEND=noninteractive apt-get -y -qq install docker.io docker-compose-plugin >/dev/null 2>&1; then
                        $SUDO_CMD env DEBIAN_FRONTEND=noninteractive apt-get -y -qq install docker.io >/dev/null 2>&1
                    fi
                fi
                if ! [ -x "$(command -v docker)" ]; then
                    echo " - Docker installation failed."
                    echo "   Maybe your OS is not supported?"
                    echo " - Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                    exit 1
                fi
            fi
            if command -v systemctl >/dev/null 2>&1; then
                $SUDO_CMD systemctl enable docker >/dev/null 2>&1 || true
                $SUDO_CMD systemctl start docker >/dev/null 2>&1 || true
            fi

    esac
    if ! $SUDO_CMD docker info >/dev/null 2>&1; then
        echo " - Docker is installed but the Docker daemon is not reachable. Start Docker and make sure $CURRENT_USER can access it." >&2
        exit 1
    fi
    echo " - Docker installed successfully."
else
    echo " - Docker is installed."
    if ! $SUDO_CMD docker info >/dev/null 2>&1; then
        echo " - Docker is installed but the Docker daemon is not reachable. Start Docker and make sure $CURRENT_USER can access it." >&2
        exit 1
    fi
fi
`;

const createTraefikConfig = () => {
	const config = getDefaultServerTraefikConfig();

	const command = `
	if [ -f "/etc/nearzero/traefik/dynamic/acme.json" ]; then
		chmod 600 "/etc/nearzero/traefik/dynamic/acme.json"
	fi
	if [ -f "/etc/nearzero/traefik/traefik.yml" ]; then
		echo "Traefik config already exists ✅"
	else
		echo "${config}" > /etc/nearzero/traefik/traefik.yml
	fi
	`;

	return command;
};

const createDefaultMiddlewares = () => {
	const config = getDefaultMiddlewares();
	const command = `
	if [ -f "/etc/nearzero/traefik/dynamic/middlewares.yml" ]; then
		echo "Middlewares config already exists ✅"
	else
		echo "${config}" > /etc/nearzero/traefik/dynamic/middlewares.yml
	fi
	`;
	return command;
};

export const installRClone = () => `
    if command_exists rclone; then
		echo "RClone already installed ✅"
	else
		curl https://rclone.org/install.sh | $SUDO_CMD bash
		RCLONE_VERSION=$(rclone --version | head -n 1 | awk '{print $2}' | sed 's/^v//')
		echo "RClone version $RCLONE_VERSION installed ✅"
	fi
`;

export const createTraefikInstance = () => {
	const command = `
	    # Remove the older Swarm service before running Traefik as a standalone container.
		if $SUDO_CMD docker service inspect nearzero-traefik > /dev/null 2>&1; then
			echo "Migrating Traefik from Swarm service to Standalone container..."
			$SUDO_CMD docker service rm nearzero-traefik
			sleep 8
			echo "Traefik migrated to Standalone ✅"
		fi

		# Check if nearzero-traefik container exists
		if $SUDO_CMD docker inspect nearzero-traefik > /dev/null 2>&1; then
			# Check if it's running
			if $SUDO_CMD docker ps --filter "name=nearzero-traefik" --format '{{.Names}}' | grep -q 'nearzero-traefik'; then
				echo "Traefik container is already running ✅"
			else
				echo "Traefik container exists but is not running. Removing and recreating..."
				$SUDO_CMD docker rm -f nearzero-traefik 2>/dev/null || true
				sleep 2

				# Create the nearzero-traefik container
				TRAEFIK_VERSION=${TRAEFIK_VERSION}
				$SUDO_CMD docker run -d \
					--name nearzero-traefik \
					--restart always \
					-v /etc/nearzero/traefik/traefik.yml:/etc/traefik/traefik.yml \
					-v /etc/nearzero/traefik/dynamic:/etc/nearzero/traefik/dynamic \
					-v /var/run/docker.sock:/var/run/docker.sock \
					-p ${TRAEFIK_SSL_PORT}:${TRAEFIK_SSL_PORT} \
					-p ${TRAEFIK_PORT}:${TRAEFIK_PORT} \
					-p ${TRAEFIK_HTTP3_PORT}:${TRAEFIK_HTTP3_PORT}/udp \
					traefik:v$TRAEFIK_VERSION

				$SUDO_CMD docker network connect nearzero-network nearzero-traefik 2>/dev/null || true
				echo "Traefik version $TRAEFIK_VERSION recreated ✅"
			fi
		else
			# Create the nearzero-traefik container
			TRAEFIK_VERSION=${TRAEFIK_VERSION}

			# Try to create the container
			if $SUDO_CMD docker run -d \
				--name nearzero-traefik \
				--restart always \
				-v /etc/nearzero/traefik/traefik.yml:/etc/traefik/traefik.yml \
				-v /etc/nearzero/traefik/dynamic:/etc/nearzero/traefik/dynamic \
				-v /var/run/docker.sock:/var/run/docker.sock \
				-p ${TRAEFIK_SSL_PORT}:${TRAEFIK_SSL_PORT} \
				-p ${TRAEFIK_PORT}:${TRAEFIK_PORT} \
				-p ${TRAEFIK_HTTP3_PORT}:${TRAEFIK_HTTP3_PORT}/udp \
				traefik:v$TRAEFIK_VERSION 2>&1; then

				$SUDO_CMD docker network connect nearzero-network nearzero-traefik 2>/dev/null || true
				echo "Traefik version $TRAEFIK_VERSION installed ✅"
			else
				echo "⚠️  Failed to start Traefik container"
				echo "   This is likely because ports 80 or 443 are already in use"
				echo "   Please stop any services using these ports and retry setup"
				exit 1
			fi
		fi
	`;

	return command;
};

const installNixpacks = installPinnedNixpacks;

const installRailpack = installPinnedRailpack;

// Install bun and pnpm on the host so application build/start scripts that shell
// out to them work in any context (e.g. workspace builds run on the host).
// Note: most builds run inside Nixpacks-built containers, where these tools are
// provisioned separately (see the Nixpacks builder), so host installation is a
// best-effort convenience and must never fail the overall setup.
const installPackageManagers = () => `
	# Bun
	if command_exists bun; then
		echo "Bun already installed ✅"
	else
		$SUDO_CMD env BUN_INSTALL=/usr/local bash -c "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
		if command_exists bun; then
			echo "Bun installed ✅"
		else
			echo "⚠️  Bun was not installed (non-critical; container builds provision it via Nixpacks)."
		fi
	fi

	# pnpm (standalone install; does not require a system Node.js)
	if command_exists pnpm; then
		echo "pnpm already installed ✅"
	else
		$SUDO_CMD env PNPM_HOME=/usr/local/bin SHELL=bash bash -c "curl -fsSL https://get.pnpm.io/install.sh | sh -" >/dev/null 2>&1 || true
		if command_exists pnpm; then
			echo "pnpm installed ✅"
		else
			echo "⚠️  pnpm was not installed (non-critical; container builds provision it via Nixpacks)."
		fi
	fi
`;

const validateMonitoringImage = () => `
	# Validate monitoring image availability
	echo "Checking monitoring image availability..."

	# Try to inspect the manifest of the monitoring image
	MONITORING_IMAGE="ghcr.io/nearzero-systems/monitoring:latest"

	if $SUDO_CMD docker manifest inspect $MONITORING_IMAGE > /dev/null 2>&1; then
		echo "Monitoring image $MONITORING_IMAGE is accessible ✅"
	else
		echo "⚠️  Warning: Could not verify monitoring image $MONITORING_IMAGE"
		echo "   Monitoring setup may fail later. This is not critical for server setup."
		echo "   You can configure monitoring after setup completes."
	fi
`;

const configureWebIngressFirewall = () => `
	# Applications are exposed through the shared Traefik ingress. Individual
	# application ports stay private on the Docker overlay network.
	echo "Configuring shared web ingress (80/tcp, 443/tcp, 443/udp)..."
	WEB_FIREWALL_MANAGED=false

	if command_exists ufw; then
		if $SUDO_CMD ufw status 2>/dev/null | head -n 1 | grep -qi "active"; then
			$SUDO_CMD ufw allow 80/tcp >/dev/null 2>&1 || true
			$SUDO_CMD ufw allow 443/tcp >/dev/null 2>&1 || true
			$SUDO_CMD ufw allow 443/udp >/dev/null 2>&1 || true
			WEB_FIREWALL_MANAGED=true
			echo "  - UFW web ingress configured ✅"
		fi
	fi

	if [ "$WEB_FIREWALL_MANAGED" = false ] && command_exists firewall-cmd; then
		if $SUDO_CMD firewall-cmd --state 2>/dev/null | grep -q "running"; then
			$SUDO_CMD firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
			$SUDO_CMD firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
			$SUDO_CMD firewall-cmd --permanent --add-port=443/udp >/dev/null 2>&1 || true
			$SUDO_CMD firewall-cmd --reload >/dev/null 2>&1 || true
			WEB_FIREWALL_MANAGED=true
			echo "  - firewalld web ingress configured ✅"
		fi
	fi

	if [ "$WEB_FIREWALL_MANAGED" = false ] && command_exists iptables; then
		for PORT in 80 443; do
			if ! $SUDO_CMD iptables -C INPUT -p tcp --dport $PORT -j ACCEPT 2>/dev/null; then
				$SUDO_CMD iptables -I INPUT -p tcp --dport $PORT -j ACCEPT 2>/dev/null || true
			fi
		done
		if ! $SUDO_CMD iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null; then
			$SUDO_CMD iptables -I INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || true
		fi
		echo "  - iptables web ingress configured ✅"
	fi

	echo "  - Ensure the cloud firewall/security group also permits TCP 80/443 and UDP 443."
`;

const configureMonitoringPort = () => `
	# Configure firewall for monitoring port (4500)
	MONITORING_PORT=4500

	echo "Configuring firewall for monitoring port $MONITORING_PORT..."

	# Check if UFW is installed and active
	if command_exists ufw; then
		UFW_STATUS=$($SUDO_CMD ufw status 2>/dev/null | head -n 1 | grep -i "active" || echo "inactive")
		if [ "$UFW_STATUS" != "inactive" ]; then
			echo "  - Configuring UFW firewall..."
			$SUDO_CMD ufw allow $MONITORING_PORT/tcp >/dev/null 2>&1 || true
			echo "  - UFW: Port $MONITORING_PORT opened ✅"
		else
			echo "  - UFW is installed but not active, skipping"
		fi
	fi

	# Check if firewalld is active (CentOS/RHEL/Fedora)
	if command_exists firewall-cmd; then
		if $SUDO_CMD firewall-cmd --state 2>/dev/null | grep -q "running"; then
			echo "  - Configuring firewalld..."
			$SUDO_CMD firewall-cmd --permanent --add-port=$MONITORING_PORT/tcp >/dev/null 2>&1 || true
			$SUDO_CMD firewall-cmd --reload >/dev/null 2>&1 || true
			echo "  - firewalld: Port $MONITORING_PORT opened ✅"
		fi
	fi

	# For iptables (if no firewall manager is active)
	if ! command_exists ufw && ! command_exists firewall-cmd; then
		if command_exists iptables; then
			echo "  - Configuring iptables..."
			# Check if rule already exists
			if ! $SUDO_CMD iptables -C INPUT -p tcp --dport $MONITORING_PORT -j ACCEPT 2>/dev/null; then
				$SUDO_CMD iptables -A INPUT -p tcp --dport $MONITORING_PORT -j ACCEPT 2>/dev/null || true

				# Try to save iptables rules (method varies by distro)
				if command_exists netfilter-persistent; then
					$SUDO_CMD netfilter-persistent save >/dev/null 2>&1 || true
				elif command_exists iptables-save; then
					$SUDO_CMD sh -c "iptables-save > /etc/iptables/rules.v4" 2>/dev/null || true
				fi
				echo "  - iptables: Port $MONITORING_PORT opened ✅"
			else
				echo "  - iptables: Port $MONITORING_PORT already open ✅"
			fi
		fi
	fi

	echo ""
	echo "📝 Note: Firewall configured for monitoring port $MONITORING_PORT"
	echo "   If using cloud provider (AWS/GCP/Azure), you must also:"
	echo "   - Open port $MONITORING_PORT in Security Group/Firewall Rules"
	echo "   - Allow inbound traffic from your Nearzero platform IP"
`;

const setupPermissions = () => `
	# Add user to docker group if not root
	if [ -n "$SUDO_CMD" ]; then
		if ! groups $CURRENT_USER | grep -qw docker; then
			$SUDO_CMD usermod -aG docker $CURRENT_USER
			echo "User $CURRENT_USER added to docker group ✅"
		else
			echo "User $CURRENT_USER already in docker group ✅"
		fi
		# Ensure the user owns the nearzero directory
		$SUDO_CMD chown -R $CURRENT_USER:$CURRENT_USER /etc/nearzero
		echo "Permissions configured for $CURRENT_USER ✅"
	else
		echo "Running as root, no extra permissions needed ✅"
	fi
`;

const installBuildpacks = installPinnedBuildpacks;
