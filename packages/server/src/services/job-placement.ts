type WithServer = { serverId?: string | null } | null | undefined;

/**
 * Where a scheduled job runs. With JOBS_URL configured, the external schedules
 * service runs jobs for remote servers only: it has no access to the local
 * Docker host. Local-host jobs always run in the platform process, so every
 * job has exactly one scheduler.
 */
export function runsOnExternalJobsService(serverId: string | null | undefined) {
	return Boolean(process.env.JOBS_URL?.trim() && serverId);
}

export function resolveBackupServerId(backup: {
	postgres?: WithServer;
	mysql?: WithServer;
	mariadb?: WithServer;
	mongo?: WithServer;
	libsql?: WithServer;
	compose?: WithServer;
}): string | null {
	return (
		backup.postgres?.serverId ||
		backup.mysql?.serverId ||
		backup.mariadb?.serverId ||
		backup.mongo?.serverId ||
		backup.libsql?.serverId ||
		backup.compose?.serverId ||
		null
	);
}

export function resolveScheduleServerId(schedule: {
	serverId?: string | null;
	application?: WithServer;
	compose?: WithServer;
}): string | null {
	return (
		schedule.serverId ||
		schedule.application?.serverId ||
		schedule.compose?.serverId ||
		null
	);
}

export function resolveVolumeBackupServerId(volumeBackup: {
	application?: WithServer;
	postgres?: WithServer;
	mysql?: WithServer;
	mariadb?: WithServer;
	mongo?: WithServer;
	redis?: WithServer;
	libsql?: WithServer;
	compose?: WithServer;
}): string | null {
	return (
		volumeBackup.application?.serverId ||
		volumeBackup.postgres?.serverId ||
		volumeBackup.mysql?.serverId ||
		volumeBackup.mariadb?.serverId ||
		volumeBackup.mongo?.serverId ||
		volumeBackup.redis?.serverId ||
		volumeBackup.libsql?.serverId ||
		volumeBackup.compose?.serverId ||
		null
	);
}
