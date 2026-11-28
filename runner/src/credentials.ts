import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type EnrollResponse,
  enrollResponseSchema,
  RUNNER_ENROLL_PATH,
  RUNNER_PROTOCOL_MIN_SUPPORTED,
  RUNNER_PROTOCOL_VERSION,
  type SystemInfo,
  VERSION,
} from "@nearzero/shared";

/**
 * The runner's own credential (spec 25 D1): issued once by the control plane in exchange for a
 * one-time join token, kept in a file only root can read, and sent with every connection. Setup
 * run again issues a new one and the old one stops working.
 */

export const CREDENTIAL_FILE = "credential";
/** Where the control plane leaves the Nearzero host's join token (in a volume both share). */
export const HANDOFF_FILE = "host-join-token";

export class EnrollError extends Error {
  /** True when trying again with the same token can't work. */
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "EnrollError";
    this.permanent = permanent;
  }
}

export async function readCredential(stateDirectory: string): Promise<string | null> {
  const value = await readFile(join(stateDirectory, CREDENTIAL_FILE), "utf8").catch(() => null);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function saveCredential(stateDirectory: string, credential: string): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700).catch(() => {});
  const path = join(stateDirectory, CREDENTIAL_FILE);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${credential}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function readHandoffToken(handoffDirectory: string | null): Promise<string | null> {
  if (!handoffDirectory) return null;
  const value = await readFile(join(handoffDirectory, HANDOFF_FILE), "utf8").catch(() => null);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Trades a join token for this runner's credential. */
export async function enroll(
  controlUrl: string,
  joinToken: string,
  system: Partial<SystemInfo>,
  fetcher: typeof fetch = fetch,
): Promise<EnrollResponse> {
  let response: Response;
  try {
    response = await fetcher(`${controlUrl}${RUNNER_ENROLL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        joinToken,
        runnerVersion: VERSION,
        protocol: RUNNER_PROTOCOL_VERSION,
        minProtocol: RUNNER_PROTOCOL_MIN_SUPPORTED,
        system,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new EnrollError(
      `Couldn't reach Nearzero at ${controlUrl} (${(error as Error).message}). Check the address and that this server can reach it.`,
      false,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    const message = body?.error?.message ?? `Nearzero answered ${response.status}.`;
    throw new EnrollError(message, response.status >= 400 && response.status < 500);
  }
  const parsed = enrollResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new EnrollError("Nearzero's answer to joining wasn't understood.", false);
  return parsed.data;
}

export type CredentialCheck = "accepted" | "refused" | "unreachable";

/** Asks the control plane whether a credential is still good, before opening the WebSocket. */
export async function checkCredential(
  controlUrl: string,
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<{ result: CredentialCheck; message: string }> {
  try {
    const response = await fetcher(`${controlUrl}/api/v1/runner/check`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (response.ok) return { result: "accepted", message: "" };
    if (response.status === 401 || response.status === 403) {
      return { result: "refused", message: body?.error?.message ?? "The credential was refused." };
    }
    return {
      result: "unreachable",
      message: body?.error?.message ?? `Nearzero answered ${response.status}.`,
    };
  } catch (error) {
    return { result: "unreachable", message: (error as Error).message };
  }
}
