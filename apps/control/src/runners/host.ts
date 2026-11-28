import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";
import { createJoinToken, HOST_JOIN_TOKEN_TTL_MS, pruneJoinTokens } from "./credentials.ts";

/**
 * Enrolling the Nearzero host's own runner, with nobody typing a join command (spec 25 D1: the
 * host runs the same runner). At every start the control plane writes a fresh one-time join
 * token into a folder only it and the host's runner share (a Docker volume in compose.yml). A
 * runner without a working credential trades it for one; a runner that has one ignores it.
 * Unused host tokens from earlier starts are dropped, so only the newest one works.
 */

export const HANDOFF_FILE = "host-join-token";

export async function prepareHostHandoff(db: Db, directory: string, log: Logger): Promise<void> {
  await pruneJoinTokens(db, { hostToo: true });
  const { token } = await createJoinToken(db, null, { ttlMs: HOST_JOIN_TOKEN_TTL_MS });
  await mkdir(directory, { recursive: true });
  const path = join(directory, HANDOFF_FILE);
  const temporary = `${path}.tmp`;
  // Group-readable: the host's runner runs with every capability dropped and reads it through
  // the control plane's group (compose.yml gives it that group), nobody else can.
  await writeFile(temporary, `${token}\n`, { mode: 0o640 });
  await rename(temporary, path);
  log.info("left a join token for the host's runner", { directory });
}
