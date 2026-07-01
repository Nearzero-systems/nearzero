import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { getAgentConfig } from "./config";

export type StoredAttachment = {
	id: string;
	name: string;
	path: string;
	contentType: string;
	size: number;
};

export async function storeAttachment(file: {
	name: string;
	contentType?: string;
	buffer: Buffer;
}): Promise<StoredAttachment> {
	const config = getAgentConfig();
	const id = nanoid();
	const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
	await mkdir(config.attachmentsPath, { recursive: true });
	const target = path.join(config.attachmentsPath, `${id}-${safeName}`);
	await writeFile(target, file.buffer);
	return {
		id,
		name: safeName,
		path: target,
		contentType: file.contentType || "application/octet-stream",
		size: file.buffer.byteLength,
	};
}
