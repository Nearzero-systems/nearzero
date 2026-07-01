import {
	getServerServiceInventoryTotal,
	type ServerServiceInventory,
	type ServerServiceInventoryLists,
} from "@nearzero/server/services/server";
import {
	assertServerRemoveAllowed,
	assertServerRemoveCleanupComplete,
	getServerAttachedServiceRefs,
	preflightServerAttachedServiceDeleteAccess,
} from "@/server/api/utils/server-delete";
import { describe, expect, it } from "vitest";

const inventory = (
	lists: Partial<ServerServiceInventoryLists> = {},
): ServerServiceInventory => {
	const complete: ServerServiceInventoryLists = {
		applications: [],
		compose: [],
		redis: [],
		mariadb: [],
		mongo: [],
		mysql: [],
		postgres: [],
		libsql: [],
		...lists,
	};
	return {
		...complete,
		total: getServerServiceInventoryTotal(complete),
	};
};

describe("server delete policy", () => {
	it("includes libsql in attached service totals and refs", () => {
		const current = inventory({
			libsql: [{ libsqlId: "libsql-1" }],
		});

		expect(current.total).toBe(1);
		expect(getServerAttachedServiceRefs(current)).toContainEqual({
			type: "libsql",
			id: "libsql-1",
		});
	});

	it("blocks active-service server delete unless the destructive flag is set", () => {
		const current = inventory({
			applications: [{ applicationId: "app-1" }],
		});

		expect(() => assertServerRemoveAllowed(current, false)).toThrow(
			"Server has active services, please delete them first",
		);
		expect(() => assertServerRemoveAllowed(current, true)).not.toThrow();
	});

	it("preflights delete access for every attached service", async () => {
		const current = inventory({
			applications: [{ applicationId: "app-1" }],
			compose: [{ composeId: "compose-1" }],
			redis: [{ redisId: "redis-1" }],
			mariadb: [{ mariadbId: "mariadb-1" }],
			mongo: [{ mongoId: "mongo-1" }],
			mysql: [{ mysqlId: "mysql-1" }],
			postgres: [{ postgresId: "postgres-1" }],
			libsql: [{ libsqlId: "libsql-1" }],
		});
		const checked: string[] = [];

		await preflightServerAttachedServiceDeleteAccess(current, async (service) => {
			checked.push(`${service.type}:${service.id}`);
		});

		expect(checked).toEqual([
			"application:app-1",
			"compose:compose-1",
			"redis:redis-1",
			"mariadb:mariadb-1",
			"mongo:mongo-1",
			"mysql:mysql-1",
			"postgres:postgres-1",
			"libsql:libsql-1",
		]);
	});

	it("blocks final server deletion if cleanup leaves attached services behind", () => {
		const current = inventory({
			postgres: [{ postgresId: "postgres-1" }],
		});

		expect(() => assertServerRemoveCleanupComplete(current)).toThrow(
			"Server still has attached services after cleanup. Refresh and try again.",
		);
		expect(() => assertServerRemoveCleanupComplete(inventory())).not.toThrow();
	});
});
