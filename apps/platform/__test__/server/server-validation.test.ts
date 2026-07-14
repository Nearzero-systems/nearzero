import {
	apiCreateServer,
	apiUpdateServer,
	isValidServerAddress,
} from "@nearzero/server/db/schema/server";
import { describe, expect, it } from "vitest";

const validServer = {
	name: "Production server",
	description: "",
	ipAddress: "203.0.113.10",
	port: 22,
	username: "deploy",
	sshKeyId: "key-1",
};

describe("remote server input validation", () => {
	it.each([
		"203.0.113.10",
		"2001:db8::10",
		"server.example.com",
		"node-1.internal",
	])("accepts a valid server address: %s", (address) => {
		expect(isValidServerAddress(address)).toBe(true);
	});

	it.each([
		"https://server.example.com",
		"server.example.com:22",
		"server.example.com/path",
		"user@server.example.com",
		"server..example.com",
		"server.example.com\nProxyCommand=evil",
		"-server.example.com",
	])("rejects an unsafe server address: %s", (address) => {
		expect(isValidServerAddress(address)).toBe(false);
	});

	it("enforces SSH port bounds and a non-injectable username", () => {
		expect(apiCreateServer.safeParse(validServer).success).toBe(true);
		expect(
			apiCreateServer.safeParse({ ...validServer, port: 70000 }).success,
		).toBe(false);
		expect(
			apiCreateServer.safeParse({
				...validServer,
				username: "root; curl attacker.example",
			}).success,
		).toBe(false);
	});

	it("applies the same validation when a server is updated", () => {
		expect(
			apiUpdateServer.safeParse({
				...validServer,
				serverId: "server-1",
				ipAddress: "server.example.com`whoami`",
			}).success,
		).toBe(false);
	});
});
