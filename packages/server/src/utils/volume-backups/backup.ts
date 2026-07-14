import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { findComposeById } from "@nearzero/server/services/compose";
import type { findVolumeBackupById } from "@nearzero/server/services/volume-backups";
import {
	getBackupTimestamp,
	getS3Credentials,
	normalizeS3Path,
	quoteShellArgument,
} from "../backups/utils";

export const getVolumeServiceAppName = (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
): string => {
	if (volumeBackup.compose?.appName) {
		return volumeBackup.serviceName
			? `${volumeBackup.compose.appName}_${volumeBackup.serviceName}`
			: volumeBackup.compose.appName;
	}
	const serviceAppName =
		volumeBackup.application?.appName ||
		volumeBackup.postgres?.appName ||
		volumeBackup.mysql?.appName ||
		volumeBackup.mariadb?.appName ||
		volumeBackup.mongo?.appName ||
		volumeBackup.redis?.appName ||
		volumeBackup.libsql?.appName;
	return serviceAppName || volumeBackup.appName;
};

export const backupVolume = async (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
) => {
	const { serviceType, volumeName, turnOff, prefix } = volumeBackup;
	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
	const { VOLUME_BACKUPS_PATH, VOLUME_BACKUP_LOCK_PATH } = paths(!!serverId);
	const destination = volumeBackup.destination;
	const s3AppName = getVolumeServiceAppName(volumeBackup);
	const backupFileName = `${volumeName}-${getBackupTimestamp()}.tar`;
	const bucketDestination = `${s3AppName}/${normalizeS3Path(prefix || "")}${backupFileName}`;
	const rcloneFlags = getS3Credentials(volumeBackup.destination);
	const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
	const volumeBackupPath = path.join(VOLUME_BACKUPS_PATH, volumeBackup.appName);

	const backupFilePath = `${volumeBackupPath}/${backupFileName}`;
	const rcloneCommand = `rclone copyto ${rcloneFlags.join(" ")} ${quoteShellArgument(backupFilePath)} ${quoteShellArgument(rcloneDestination)}`;
	const archiveCommand = `cd /volume_data && tar cvf ${quoteShellArgument(`/backup/${backupFileName}`)} .`;

	const backupCommand = `
	set -e
	printf 'Volume name: %s\n' ${quoteShellArgument(volumeName)}
	printf 'Backup file name: %s\n' ${quoteShellArgument(backupFileName)}
	echo "Turning off volume backup: ${turnOff ? "Yes" : "No"}"
	echo "Starting volume backup" 
	printf 'Dir: %s\n' ${quoteShellArgument(volumeBackupPath)}
    docker run --rm \
  -v ${quoteShellArgument(`${volumeName}:/volume_data`)} \
  -v ${quoteShellArgument(`${volumeBackupPath}:/backup`)} \
  ubuntu \
  bash -c ${quoteShellArgument(archiveCommand)}
  echo "Volume backup done ✅"
  `;

	const uploadCommand = `
  echo "Starting upload to S3..."
  ${rcloneCommand}
  echo "Upload to S3 done ✅"
  echo "Cleaning up local backup file..."
  rm -f -- ${quoteShellArgument(backupFilePath)}
  echo "Local backup file cleaned up ✅"
  `;

	if (!turnOff) {
		return `
		${backupCommand}
		${uploadCommand}
		`;
	}

	const serviceLockId =
		serviceType === "application"
			? volumeBackup.application?.appName
			: `${volumeBackup.compose?.appName}_${volumeBackup.serviceName}`;

	const lockPath = `${VOLUME_BACKUP_LOCK_PATH}-${serviceLockId}`;

	const lockWrapper = (body: string) => `
		set -e

		LOCK_PATH=${quoteShellArgument(lockPath)}

		echo "Waiting for volume backup lock: $LOCK_PATH"

		if command -v flock >/dev/null 2>&1; then
			exec 9>"$LOCK_PATH"
			flock 9
		else
			LOCK_DIR="$LOCK_PATH.dir"
			while ! mkdir "$LOCK_DIR" 2>/dev/null; do
				echo "Waiting for volume backup lock: $LOCK_PATH"
				sleep 5
			done
			trap 'rm -rf "$LOCK_DIR"' EXIT
		fi

		echo "Volume backup lock acquired"

		${body}

		echo "Volume backup lock released"
	`;

	if (serviceType === "application") {
		const applicationService = volumeBackup.application?.appName ?? "";
		return lockWrapper(`
		echo "Stopping application to 0 replicas"
		ACTUAL_REPLICAS=$(docker service inspect ${quoteShellArgument(applicationService)} --format "{{.Spec.Mode.Replicated.Replicas}}")
		echo "Actual replicas: $ACTUAL_REPLICAS"
		docker service update --replicas=0 ${quoteShellArgument(applicationService)}
        ${backupCommand}
		echo "Starting application to $ACTUAL_REPLICAS replicas"
        docker service update --replicas=$ACTUAL_REPLICAS --with-registry-auth ${quoteShellArgument(applicationService)}
		${uploadCommand}
  `);
	}
	if (serviceType === "compose") {
		const compose = await findComposeById(
			volumeBackup.compose?.composeId || "",
		);
		let stopCommand = "";
		let startCommand = "";

		if (compose.composeType === "stack") {
			const composeService = `${compose.appName}_${volumeBackup.serviceName}`;
			stopCommand = `
			echo "Stopping compose to 0 replicas"
			printf 'Service name: %s\n' ${quoteShellArgument(composeService)}
            ACTUAL_REPLICAS=$(docker service inspect ${quoteShellArgument(composeService)} --format "{{.Spec.Mode.Replicated.Replicas}}")
            echo "Actual replicas: $ACTUAL_REPLICAS"
            docker service update --replicas=0 ${quoteShellArgument(composeService)}`;

			startCommand = `
			echo "Starting compose to $ACTUAL_REPLICAS replicas"
			docker service update --replicas=$ACTUAL_REPLICAS --with-registry-auth ${quoteShellArgument(composeService)}`;
		} else {
			stopCommand = `
			echo "Stopping compose container"
            ID=$(docker ps -q --filter ${quoteShellArgument(`label=com.docker.compose.project=${compose.appName}`)} --filter ${quoteShellArgument(`label=com.docker.compose.service=${volumeBackup.serviceName}`)})
			docker stop -- "$ID"`;

			startCommand = `
            echo "Starting compose container"
            docker start -- "$ID"
			echo "Compose container started"
			`;
		}
		return lockWrapper(`
        ${stopCommand}
        ${backupCommand}
        ${startCommand}
		${uploadCommand}
  `);
	}
};
