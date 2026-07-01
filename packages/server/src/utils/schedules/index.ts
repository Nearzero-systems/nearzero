import { schedules } from "@nearzero/server/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";
import { scheduleJob } from "./utils";

export const initSchedules = async () => {
	try {
		const schedulesResult = await db.query.schedules.findMany({
			where: eq(schedules.enabled, true),
			with: {
				server: true,
				// Scope columns: the application table has >100 columns and a bare
				// `application: true` makes Drizzle emit json_build_array over all of
				// them, exceeding Postgres's 100-argument limit. scheduleJob only needs
				// appName + serverId.
				application: {
					columns: {
						applicationId: true,
						name: true,
						appName: true,
						serverId: true,
						environmentId: true,
					},
				},
				compose: true,
				user: true,
			},
		});

		console.log(`Initializing ${schedulesResult.length} schedules`);
		for (const schedule of schedulesResult) {
			scheduleJob(schedule);
			console.log(
				`Initialized schedule: ${schedule.name} ${schedule.scheduleType} ✅`,
			);
		}
	} catch (error) {
		console.log(`Error initializing schedules: ${error}`);
	}
};
