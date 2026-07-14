import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import {
	type apiCreateCertificate,
	certificates,
	server,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { stringify } from "yaml";
import type { z } from "zod";
import { execAsyncRemote } from "../utils/process/execAsync";

export type Certificate = typeof certificates.$inferSelect;

const SAFE_CERTIFICATE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const encodeBase64 = (value: string) =>
	Buffer.from(value, "utf8").toString("base64");

const resolveCertificateDirectory = (certificate: Certificate) => {
	if (!SAFE_CERTIFICATE_PATH.test(certificate.certificatePath)) {
		throw new Error("Certificate storage path is invalid");
	}

	const { CERTIFICATES_PATH } = paths(!!certificate.serverId);
	const certificatesPath = path.resolve(CERTIFICATES_PATH);
	const certificateDirectory = path.resolve(
		certificatesPath,
		certificate.certificatePath,
	);
	if (!certificateDirectory.startsWith(`${certificatesPath}${path.sep}`)) {
		throw new Error("Certificate storage path escapes its managed directory");
	}

	return { certificatesPath, certificateDirectory };
};

export const toPublicCertificate = <T extends object>(
	certificate: T,
): Omit<T, "privateKey"> => {
	const publicCertificate = { ...certificate } as T & { privateKey?: unknown };
	delete publicCertificate.privateKey;
	return publicCertificate;
};

export const assertCertificateServerOwnership = async (
	serverId: string | null | undefined,
	organizationId: string,
) => {
	if (!serverId) return;

	const ownedServer = await db.query.server.findFirst({
		where: and(
			eq(server.serverId, serverId),
			eq(server.organizationId, organizationId),
		),
		columns: { serverId: true },
	});
	if (!ownedServer) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Server not found",
		});
	}
};

export const findCertificateById = async (certificateId: string) => {
	const certificate = await db.query.certificates.findFirst({
		where: eq(certificates.certificateId, certificateId),
	});

	if (!certificate) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Certificate not found",
		});
	}

	return certificate;
};

const buildCertificateConfig = (certificateDirectory: string) =>
	stringify({
		tls: {
			certificates: [
				{
					certFile: path.join(certificateDirectory, "chain.crt"),
					keyFile: path.join(certificateDirectory, "privkey.key"),
				},
			],
		},
	});

const removeLocalDirectoryBestEffort = (directory: string | undefined) => {
	if (!directory) return;
	try {
		fs.rmSync(directory, { recursive: true, force: true });
	} catch {
		// A stale backup is preferable to reporting a failed deployment after the
		// new, permission-restricted directory has already been committed.
	}
};

const installLocalCertificateFiles = (
	certificate: Certificate,
	certificatesPath: string,
	certificateDirectory: string,
	yamlConfig: string,
) => {
	if (!fs.existsSync(certificatesPath)) {
		fs.mkdirSync(certificatesPath, { recursive: true, mode: 0o700 });
	}
	const certificateRoot = fs.lstatSync(certificatesPath);
	if (!certificateRoot.isDirectory() || certificateRoot.isSymbolicLink()) {
		throw new Error("Certificate storage root is not a regular directory");
	}
	fs.chmodSync(certificatesPath, 0o700);

	const stagingDirectory = fs.mkdtempSync(
		path.join(certificatesPath, ".certificate-stage-"),
	);
	fs.chmodSync(stagingDirectory, 0o700);
	let backupDirectory: string | undefined;
	let committed = false;

	try {
		for (const [fileName, contents] of [
			["chain.crt", certificate.certificateData],
			["privkey.key", certificate.privateKey],
			["certificate.yml", yamlConfig],
		] as const) {
			const filePath = path.join(stagingDirectory, fileName);
			fs.writeFileSync(filePath, contents, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			fs.chmodSync(filePath, 0o600);
		}

		if (fs.existsSync(certificateDirectory)) {
			const existing = fs.lstatSync(certificateDirectory);
			if (!existing.isDirectory() || existing.isSymbolicLink()) {
				throw new Error(
					"Certificate storage target is not a regular directory",
				);
			}
			backupDirectory = path.join(
				certificatesPath,
				`.certificate-backup-${randomUUID()}`,
			);
			fs.renameSync(certificateDirectory, backupDirectory);
		}

		try {
			fs.renameSync(stagingDirectory, certificateDirectory);
			committed = true;
		} catch (error) {
			if (
				backupDirectory &&
				fs.existsSync(backupDirectory) &&
				!fs.existsSync(certificateDirectory)
			) {
				fs.renameSync(backupDirectory, certificateDirectory);
			}
			throw error;
		}
	} finally {
		if (!committed) removeLocalDirectoryBestEffort(stagingDirectory);
		if (committed) removeLocalDirectoryBestEffort(backupDirectory);
	}
};

const installRemoteCertificateFiles = async (
	certificate: Certificate,
	certificatesPath: string,
	certificateDirectory: string,
	yamlConfig: string,
) => {
	if (!certificate.serverId) return;

	// Secrets travel on the SSH channel's stdin. They are deliberately absent
	// from the command so ExecError metadata and deployment logs cannot expose
	// either the certificate or its private key.
	const input = `${[
		encodeBase64(certificate.certificateData),
		encodeBase64(certificate.privateKey),
		encodeBase64(yamlConfig),
	].join("\n")}\n`;
	const command = `
set -eu
umask 077
root=${shellQuote(certificatesPath)}
target=${shellQuote(certificateDirectory)}
stage=''
backup=''
swap_started=0
cleanup() {
	status=$?
	trap - 0 1 2 15
	if [ "$status" -ne 0 ] && [ "$swap_started" -eq 1 ]; then
		rm -rf -- "$target"
		if [ -n "$backup" ] && [ -e "$backup" ]; then
			mv -- "$backup" "$target" || :
		fi
	fi
	if [ -n "$stage" ]; then rm -rf -- "$stage"; fi
	if [ "$status" -eq 0 ] && [ -n "$backup" ]; then
		rm -rf -- "$backup" || :
	fi
	exit "$status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15
if [ -L "$root" ]; then
	echo 'Certificate storage root must not be a symbolic link' >&2
	exit 1
fi
mkdir -p -- "$root"
if [ ! -d "$root" ] || [ -L "$root" ]; then
	echo 'Certificate storage root is not a regular directory' >&2
	exit 1
fi
chmod 700 -- "$root"
stage=$(mktemp -d "$root/.certificate-stage.XXXXXX")
chmod 700 -- "$stage"
IFS= read -r certificate_data
IFS= read -r private_key
IFS= read -r dynamic_config
printf '%s' "$certificate_data" | base64 -d > "$stage/chain.crt"
printf '%s' "$private_key" | base64 -d > "$stage/privkey.key"
printf '%s' "$dynamic_config" | base64 -d > "$stage/certificate.yml"
chmod 600 -- "$stage/chain.crt" "$stage/privkey.key" "$stage/certificate.yml"
if [ -L "$target" ]; then
	echo 'Certificate storage target must not be a symbolic link' >&2
	exit 1
fi
swap_started=1
if [ -e "$target" ]; then
	backup=$(mktemp -d "$root/.certificate-backup.XXXXXX")
	rmdir -- "$backup"
	mv -- "$target" "$backup"
fi
mv -- "$stage" "$target"
stage=''
`;

	await execAsyncRemote(certificate.serverId, command, undefined, { input });
};

export const installCertificateFiles = async (certificate: Certificate) => {
	const { certificatesPath, certificateDirectory } =
		resolveCertificateDirectory(certificate);
	const yamlConfig = buildCertificateConfig(certificateDirectory);

	if (certificate.serverId) {
		await installRemoteCertificateFiles(
			certificate,
			certificatesPath,
			certificateDirectory,
			yamlConfig,
		);
		return;
	}

	installLocalCertificateFiles(
		certificate,
		certificatesPath,
		certificateDirectory,
		yamlConfig,
	);
};

export const removeCertificateFiles = async (certificate: Certificate) => {
	const { certificateDirectory } = resolveCertificateDirectory(certificate);
	if (certificate.serverId) {
		await execAsyncRemote(
			certificate.serverId,
			`rm -rf -- ${shellQuote(certificateDirectory)}`,
		);
		return;
	}
	fs.rmSync(certificateDirectory, { recursive: true, force: true });
};

export const createCertificate = async (
	certificateData: z.infer<typeof apiCreateCertificate>,
	organizationId: string,
) => {
	await assertCertificateServerOwnership(
		certificateData.serverId,
		organizationId,
	);

	// Only copy client-authorized fields. In particular, certificatePath and
	// certificateId must always be generated by the server.
	const certificate = await db
		.insert(certificates)
		.values({
			name: certificateData.name,
			certificateData: certificateData.certificateData,
			privateKey: certificateData.privateKey,
			autoRenew: certificateData.autoRenew,
			serverId: certificateData.serverId,
			organizationId,
		})
		.returning();

	if (!certificate || certificate[0] === undefined) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Failed to create the certificate",
		});
	}

	const createdCertificate = certificate[0];
	try {
		await installCertificateFiles(createdCertificate);
	} catch (error) {
		const cleanupResults = await Promise.allSettled([
			removeCertificateFiles(createdCertificate),
			db
				.delete(certificates)
				.where(
					eq(certificates.certificateId, createdCertificate.certificateId),
				),
		]);
		const cleanupErrors = cleanupResults.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[error, ...cleanupErrors],
				"Certificate installation failed and cleanup was incomplete",
			);
		}
		throw error;
	}

	return createdCertificate;
};

export const removeCertificateById = async (certificateId: string) => {
	const certificate = await findCertificateById(certificateId);
	await removeCertificateFiles(certificate);

	const result = await db
		.delete(certificates)
		.where(eq(certificates.certificateId, certificateId))
		.returning();

	if (!result[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Failed to delete the certificate",
		});
	}

	return result;
};

export const updateCertificate = async (
	certificateId: string,
	updates: {
		name?: string;
		certificateData?: string;
		privateKey?: string;
	},
) => {
	const previousCertificate = await findCertificateById(certificateId);
	const updated = await db
		.update(certificates)
		.set({
			...updates,
		})
		.where(eq(certificates.certificateId, certificateId))
		.returning();

	if (!updated || updated[0] === undefined) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Failed to update the certificate",
		});
	}

	const updatedCertificate = updated[0];

	if (updates.certificateData || updates.privateKey) {
		try {
			await installCertificateFiles(updatedCertificate);
		} catch (error) {
			const rollbackResults = await Promise.allSettled([
				installCertificateFiles(previousCertificate),
				db
					.update(certificates)
					.set({
						name: previousCertificate.name,
						certificateData: previousCertificate.certificateData,
						privateKey: previousCertificate.privateKey,
					})
					.where(eq(certificates.certificateId, certificateId)),
			]);
			const rollbackErrors = rollbackResults.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					"Certificate installation failed and rollback was incomplete",
				);
			}
			throw error;
		}
	}

	return updatedCertificate;
};
