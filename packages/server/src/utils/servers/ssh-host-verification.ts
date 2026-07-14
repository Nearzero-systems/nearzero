import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { paths } from "../../constants";

type SshEndpoint = {
	ipAddress: string;
	port: number;
};

type StoredHostKey = {
	fingerprint: string;
	firstSeenAt: string;
};

type StoredHostKeys = Record<string, StoredHostKey>;

const getStorePath = () =>
	process.env.NEARZERO_SSH_HOST_KEYS_PATH?.trim() ||
	path.join(paths().SSH_PATH, "remote-host-keys.json");

const endpointKey = (server: SshEndpoint) =>
	`${server.ipAddress.trim().toLowerCase()}:${server.port}`;

function readStore(): StoredHostKeys {
	const storePath = getStorePath();
	if (!existsSync(storePath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as StoredHostKeys)
			: {};
	} catch {
		throw new Error(
			`SSH host-key store is invalid and must be repaired: ${storePath}`,
		);
	}
}

function writeStore(store: StoredHostKeys) {
	const storePath = getStorePath();
	mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
	chmodSync(path.dirname(storePath), 0o700);
	const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(temporaryPath, storePath);
	chmodSync(storePath, 0o600);
}

function withStoreLock<T>(operation: () => T): T {
	const storePath = getStorePath();
	mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
	chmodSync(path.dirname(storePath), 0o700);
	const lockPath = `${storePath}.lock`;
	let descriptor: number | null = null;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			const stale =
				existsSync(lockPath) &&
				Date.now() - statSync(lockPath).mtimeMs > 120_000;
			if (!stale || attempt > 0) {
				throw new Error("SSH host-key store is busy; retry the connection", {
					cause: error,
				});
			}
			unlinkSync(lockPath);
		}
	}
	if (descriptor === null) {
		throw new Error("Could not lock the SSH host-key store");
	}
	try {
		writeFileSync(descriptor, `${process.pid}\n`, "utf8");
		return operation();
	} finally {
		closeSync(descriptor);
		try {
			unlinkSync(lockPath);
		} catch {
			// The store update already completed; a missing lock needs no recovery.
		}
	}
}

export function fingerprintSshHostKey(key: Buffer): string {
	return `SHA256:${createHash("sha256")
		.update(key)
		.digest("base64")
		.replace(/=+$/, "")}`;
}

function fingerprintsMatch(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

/**
 * Persisted trust-on-first-use verification for remote SSH hosts.
 *
 * A new key is accepted provisionally and is only stored after SSH
 * authentication succeeds (`commit`). Subsequent connections reject a changed
 * key. Operators that require pre-provisioned trust can set
 * NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=true and seed the store before the
 * first connection.
 */
export function createSshHostVerification(server: SshEndpoint) {
	const key = endpointKey(server);
	let candidateFingerprint: string | null = null;

	return {
		hostVerifier(hostKey: Buffer) {
			const fingerprint = fingerprintSshHostKey(hostKey);
			const expected = readStore()[key]?.fingerprint;
			if (expected) return fingerprintsMatch(expected, fingerprint);
			if (
				process.env.NEARZERO_SSH_STRICT_HOST_KEY_CHECKING?.toLowerCase() ===
				"true"
			) {
				return false;
			}
			candidateFingerprint = fingerprint;
			return true;
		},
		commit() {
			if (!candidateFingerprint) return;
			withStoreLock(() => {
				const store = readStore();
				const existing = store[key]?.fingerprint;
				if (existing && !fingerprintsMatch(existing, candidateFingerprint!)) {
					throw new Error(
						`SSH host key changed for ${key}; refusing the connection`,
					);
				}
				if (!existing) {
					store[key] = {
						fingerprint: candidateFingerprint!,
						firstSeenAt: new Date().toISOString(),
					};
					writeStore(store);
				}
			});
			candidateFingerprint = null;
		},
	};
}
