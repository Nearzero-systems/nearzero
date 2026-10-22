import {
	resolveBackupServerId,
	resolveScheduleServerId,
	resolveVolumeBackupServerId,
	runsOnExternalJobsService,
} from "@nearzero/server/services/job-placement";
import { afterEach, describe, expect, it } from "vitest";

const originalJobsUrl = process.env.JOBS_URL;

afterEach(() => {
	if (originalJobsUrl === undefined) delete process.env.JOBS_URL;
	else process.env.JOBS_URL = originalJobsUrl;
});

describe("scheduled job placement", () => {
	it("runs everything in-process without a schedules service", () => {
		delete process.env.JOBS_URL;
		expect(runsOnExternalJobsService("srv_1")).toBe(false);
		expect(runsOnExternalJobsService(null)).toBe(false);
	});

	it("sends only remote-server jobs to the schedules service", () => {
		process.env.JOBS_URL = "http://schedules:4001";
		expect(runsOnExternalJobsService("srv_1")).toBe(true);
		// The schedules service has no access to the local Docker host.
		expect(runsOnExternalJobsService(null)).toBe(false);
		expect(runsOnExternalJobsService("")).toBe(false);
	});

	it("resolves the server of each job type", () => {
		expect(resolveBackupServerId({ postgres: { serverId: "srv_pg" } })).toBe(
			"srv_pg",
		);
		expect(resolveBackupServerId({ compose: { serverId: null } })).toBeNull();
		expect(
			resolveScheduleServerId({
				serverId: null,
				application: { serverId: "srv_app" },
			}),
		).toBe("srv_app");
		expect(resolveScheduleServerId({ serverId: null })).toBeNull();
		expect(
			resolveVolumeBackupServerId({ redis: { serverId: "srv_redis" } }),
		).toBe("srv_redis");
	});
});
