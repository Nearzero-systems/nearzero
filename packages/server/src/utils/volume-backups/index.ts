export * from "./backup";
export * from "./restore";
export * from "./utils";

import { volumeBackups } from "@nearzero/server/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";
import {
	resolveVolumeBackupServerId,
	runsOnExternalJobsService,
} from "../../services/job-placement";
import { scheduleVolumeBackup } from "./utils";

export const initVolumeBackupsCronJobs = async () => {
	console.log("Setting up volume backups cron jobs....");
	try {
		const volumeBackupsResult = await db.query.volumeBackups.findMany({
			where: eq(volumeBackups.enabled, true),
			with: {
				// Scope columns: the application table has >100 columns; a bare
				// `application: true` exceeds Postgres's 100-argument json_build_array
				// limit and throws.
				application: {
					columns: {
						applicationId: true,
						name: true,
						appName: true,
						serverId: true,
					},
				},
				compose: true,
				postgres: { columns: { serverId: true } },
				mysql: { columns: { serverId: true } },
				mariadb: { columns: { serverId: true } },
				mongo: { columns: { serverId: true } },
				redis: { columns: { serverId: true } },
				libsql: { columns: { serverId: true } },
			},
		});

		console.log(`Initializing ${volumeBackupsResult.length} volume backups`);
		for (const volumeBackup of volumeBackupsResult) {
			if (
				runsOnExternalJobsService(resolveVolumeBackupServerId(volumeBackup))
			) {
				continue;
			}
			scheduleVolumeBackup(volumeBackup.volumeBackupId);
			console.log(
				`Initialized volume backup: ${volumeBackup.name} ${volumeBackup.serviceType} ✅`,
			);
		}
	} catch (error) {
		console.log(`Error initializing volume backups: ${error}`);
	}
};
