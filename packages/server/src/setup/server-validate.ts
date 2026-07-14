import { Client } from "ssh2";
import { findServerById } from "../services/server";
import { createSshHostVerification } from "../utils/servers/ssh-host-verification";
import {
	BUILDPACKS_VERSION,
	NIXPACKS_VERSION,
	RAILPACK_VERSION,
} from "./builder-versions";

export const validateDocker = () => `
  if command_exists docker; then
     version=$(docker --version | awk '{print $3}' | sed 's/,//')
     if $DOCKER_CMD info >/dev/null 2>&1; then
       echo "$version true"
     else
       echo "$version false"
     fi
  else
    echo "0.0.0 false"
  fi
`;

export const validateRClone = () => `
  if command_exists rclone; then
    echo "$(rclone --version | head -n 1 | awk '{print $2}' | sed 's/^v//') true"
  else
    echo "0.0.0 false"
  fi
`;

export const validateSwarm = () => `
  if $DOCKER_CMD info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null | grep -q 'active'; then
    echo true
  else
    echo false
  fi
`;

export const validateSwarmManager = () => `
  if [ "$($DOCKER_CMD info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)" = "true" ]; then
    echo true
  else
    echo false
  fi
`;

export const validateNixpacks = () => `
  if command_exists nixpacks; then
	version=$(nixpacks --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1 || true)
    if [ "$version" = "${NIXPACKS_VERSION}" ]; then
      echo "$version true"
    else
      echo "\${version:-0.0.0} false"
    fi
  else
    echo "0.0.0 false"
  fi
`;

export const validateRailpack = () => `
  if command_exists railpack; then
    version=$(railpack --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1 || true)
    if [ "$version" = "${RAILPACK_VERSION}" ]; then
      echo "$version true"
    else
      echo "\${version:-0.0.0} false"
    fi
  else
    echo "0.0.0 false"
  fi
`;
export const validateBuildpacks = () => `
  if command_exists pack; then
    version=$(pack --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1 || true)
    if [ "$version" = "${BUILDPACKS_VERSION}" ]; then
      echo "$version true"
    else
      echo "\${version:-0.0.0} false"
    fi
  else
    echo "0.0.0 false"
  fi
`;

export const validateMainDirectory = () => `
  if [ -d "/etc/nearzero" ]; then
	echo true
  else
	echo false
  fi
`;

export const validateNearzeroNetwork = () => `
  if $DOCKER_CMD network ls 2>/dev/null | grep -q 'nearzero-network'; then
	echo true
  else
	echo false
  fi
`;

export const validateSudoAccess = () => `
  if [ "$(id -u)" -eq 0 ]; then
    echo "root true"
  elif sudo -n true 2>/dev/null; then
    echo "sudo true"
  else
    echo "none false"
  fi
`;

export const validateDockerGroup = () => `
  if groups | grep -qw docker; then
    echo true
  else
    echo false
  fi
`;

export type ServerValidateResult = {
	docker: { version: string; enabled: boolean };
	rclone: { version: string; enabled: boolean };
	nixpacks: { version: string; enabled: boolean };
	buildpacks: { version: string; enabled: boolean };
	railpack: { version: string; enabled: boolean };
	isNearzeroNetworkInstalled: boolean;
	isSwarmInstalled: boolean;
	isSwarmManager: boolean;
	isMainDirectoryInstalled: boolean;
	privilegeMode: string;
	dockerGroupMember: boolean;
};

export const serverValidate = async (
	serverId: string,
): Promise<ServerValidateResult> => {
	const client = new Client();
	const server = await findServerById(serverId);
	if (!server.sshKeyId) {
		throw new Error("No SSH Key found");
	}

	return new Promise<ServerValidateResult>((resolve, reject) => {
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
				const bashCommand = `
          command_exists() {
            command -v "$@" > /dev/null 2>&1
          }

          if [ "$(id -u)" -eq 0 ]; then
            SUDO_CMD=""
          elif sudo -n true 2>/dev/null; then
            SUDO_CMD="sudo"
          else
            SUDO_CMD=""
          fi
          DOCKER_CMD="$SUDO_CMD docker"

          dockerVersionEnabled=$(${validateDocker()})
          rcloneVersionEnabled=$(${validateRClone()})
          nixpacksVersionEnabled=$(${validateNixpacks()})
          buildpacksVersionEnabled=$(${validateBuildpacks()})
          railpackVersionEnabled=$(${validateRailpack()})
          dockerVersion=$(echo $dockerVersionEnabled | awk '{print $1}')
          dockerEnabled=$(echo $dockerVersionEnabled | awk '{print $2}')

          rcloneVersion=$(echo $rcloneVersionEnabled | awk '{print $1}')
          rcloneEnabled=$(echo $rcloneVersionEnabled | awk '{print $2}')

          nixpacksVersion=$(echo $nixpacksVersionEnabled | awk '{print $1}')
          nixpacksEnabled=$(echo $nixpacksVersionEnabled | awk '{print $2}')

          railpackVersion=$(echo $railpackVersionEnabled | awk '{print $1}')
          railpackEnabled=$(echo $railpackVersionEnabled | awk '{print $2}')

          buildpacksVersion=$(echo $buildpacksVersionEnabled | awk '{print $1}')
          buildpacksEnabled=$(echo $buildpacksVersionEnabled | awk '{print $2}')

          isNearzeroNetworkInstalled=$(${validateNearzeroNetwork()})
          isSwarmInstalled=$(${validateSwarm()})
          isSwarmManager=$(${validateSwarmManager()})
          isMainDirectoryInstalled=$(${validateMainDirectory()})

          sudoAccessResult=$(${validateSudoAccess()})
          privilegeMode=$(echo $sudoAccessResult | awk '{print $1}')
          isDockerGroupMember=$(${validateDockerGroup()})

  echo "{\\"docker\\": {\\"version\\": \\"$dockerVersion\\", \\"enabled\\": $dockerEnabled}, \\"rclone\\": {\\"version\\": \\"$rcloneVersion\\", \\"enabled\\": $rcloneEnabled}, \\"nixpacks\\": {\\"version\\": \\"$nixpacksVersion\\", \\"enabled\\": $nixpacksEnabled}, \\"buildpacks\\": {\\"version\\": \\"$buildpacksVersion\\", \\"enabled\\": $buildpacksEnabled}, \\"railpack\\": {\\"version\\": \\"$railpackVersion\\", \\"enabled\\": $railpackEnabled}, \\"isNearzeroNetworkInstalled\\": $isNearzeroNetworkInstalled, \\"isSwarmInstalled\\": $isSwarmInstalled, \\"isSwarmManager\\": $isSwarmManager, \\"isMainDirectoryInstalled\\": $isMainDirectoryInstalled, \\"privilegeMode\\": \\"$privilegeMode\\", \\"dockerGroupMember\\": $isDockerGroupMember}"
        `;
				client.exec(bashCommand, (err, stream) => {
					if (err) {
						reject(err);
						return;
					}
					let output = "";
					stream
						.on("close", () => {
							client.end();
							try {
								const result = JSON.parse(output.trim());
								resolve(result);
							} catch (parseError) {
								reject(
									new Error(
										`Failed to parse output: ${parseError instanceof Error ? parseError.message : parseError}`,
									),
								);
							}
						})
						.on("data", (data: string) => {
							output += data;
						})
						.stderr.on("data", (_data) => {});
				});
			})
			.on("error", (err) => {
				client.end();
				if (err.level === "client-authentication") {
					reject(
						new Error(
							`Authentication failed: Invalid SSH private key. ❌ Error: ${err.message} ${err.level}`,
						),
					);
				} else {
					reject(new Error(`SSH connection error: ${err.message}`));
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
