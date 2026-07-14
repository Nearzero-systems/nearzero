import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createSshHostVerification,
	fingerprintSshHostKey,
} from "@nearzero/server/utils/servers/ssh-host-verification";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const endpoint = {
	ipAddress: "Remote.Example.COM",
	port: 2222,
};

describe("SSH host-key verification", () => {
	let temporaryDirectory: string;
	let storePath: string;
	let previousStorePath: string | undefined;
	let previousStrictMode: string | undefined;

	beforeEach(() => {
		temporaryDirectory = mkdtempSync(
			path.join(tmpdir(), "nearzero-ssh-host-keys-"),
		);
		storePath = path.join(temporaryDirectory, "keys", "hosts.json");
		previousStorePath = process.env.NEARZERO_SSH_HOST_KEYS_PATH;
		previousStrictMode = process.env.NEARZERO_SSH_STRICT_HOST_KEY_CHECKING;
		process.env.NEARZERO_SSH_HOST_KEYS_PATH = storePath;
		delete process.env.NEARZERO_SSH_STRICT_HOST_KEY_CHECKING;
	});

	afterEach(() => {
		if (previousStorePath === undefined) {
			delete process.env.NEARZERO_SSH_HOST_KEYS_PATH;
		} else {
			process.env.NEARZERO_SSH_HOST_KEYS_PATH = previousStorePath;
		}
		if (previousStrictMode === undefined) {
			delete process.env.NEARZERO_SSH_STRICT_HOST_KEY_CHECKING;
		} else {
			process.env.NEARZERO_SSH_STRICT_HOST_KEY_CHECKING = previousStrictMode;
		}
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("persists a key only after authentication succeeds", () => {
		const hostKey = Buffer.from("first-server-host-key");
		const verification = createSshHostVerification(endpoint);

		expect(verification.hostVerifier(hostKey)).toBe(true);
		expect(existsSync(storePath)).toBe(false);

		verification.commit();

		const stored = JSON.parse(readFileSync(storePath, "utf8"));
		expect(stored["remote.example.com:2222"].fingerprint).toBe(
			fingerprintSshHostKey(hostKey),
		);
		expect(statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
		expect(statSync(storePath).mode & 0o777).toBe(0o600);
	});

	it("accepts the pinned key and rejects a changed key", () => {
		const originalKey = Buffer.from("original-server-host-key");
		const firstConnection = createSshHostVerification(endpoint);
		expect(firstConnection.hostVerifier(originalKey)).toBe(true);
		firstConnection.commit();

		const laterConnection = createSshHostVerification(endpoint);
		expect(laterConnection.hostVerifier(originalKey)).toBe(true);
		expect(
			laterConnection.hostVerifier(Buffer.from("replacement-server-host-key")),
		).toBe(false);
	});

	it("rejects an unknown host in strict mode", () => {
		process.env.NEARZERO_SSH_STRICT_HOST_KEY_CHECKING = "true";
		const verification = createSshHostVerification(endpoint);

		expect(verification.hostVerifier(Buffer.from("unknown-host-key"))).toBe(
			false,
		);
		verification.commit();
		expect(existsSync(storePath)).toBe(false);
	});

	it("fails closed when another first connection pins a different key", () => {
		const firstConnection = createSshHostVerification(endpoint);
		const competingConnection = createSshHostVerification(endpoint);

		expect(firstConnection.hostVerifier(Buffer.from("first-key"))).toBe(true);
		expect(competingConnection.hostVerifier(Buffer.from("competing-key"))).toBe(
			true,
		);
		competingConnection.commit();

		expect(() => firstConnection.commit()).toThrow(/host key changed/i);
	});

	it("fails closed when the persisted trust store is corrupt", () => {
		mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
		writeFileSync(storePath, "not-json", { encoding: "utf8", mode: 0o600 });
		const verification = createSshHostVerification(endpoint);

		expect(() => verification.hostVerifier(Buffer.from("server-key"))).toThrow(
			/host-key store is invalid/i,
		);
	});
});
