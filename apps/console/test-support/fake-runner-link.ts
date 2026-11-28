import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RUNNER_PROTOCOL_MIN_SUPPORTED, RUNNER_PROTOCOL_VERSION } from "@nearzero/shared";
import { FakeRunner } from "../../control/test/support/fake-runner.ts";

/**
 * A pretend Nearzero host runner for the console's browser checks (the sweep and the end-to-end
 * flows): it enrolls with the one-time join token the control plane leaves in its handoff
 * folder, connects over the real runner WebSocket, and answers every command with the control
 * plane's own test runner (apps/control/test/support/fake-runner.ts), which speaks the real
 * protocol against a small pretend Docker. Deploys then run end to end without Docker.
 */

const ROOT = resolve(import.meta.dir, "..", "test-artifacts", "stack");

/** A fresh handoff folder for one stack (no spaces: the control plane's rule). */
export async function handoffFolder(label: string): Promise<string> {
  const folder = join(ROOT, `handoff-${label}-${Date.now().toString(36)}`);
  await mkdir(folder, { recursive: true });
  return folder;
}

export interface FakeHost {
  runner: FakeRunner;
  close(): Promise<void>;
}

async function joinToken(folder: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const token = (await readFile(join(folder, "host-join-token"), "utf8")).trim();
      if (token) return token;
    } catch {
      // Not written yet.
    }
    await Bun.sleep(200);
  }
  throw new Error(`The control plane left no host join token in ${folder}.`);
}

export async function connectFakeHost(controlUrl: string, folder: string): Promise<FakeHost> {
  const token = await joinToken(folder);
  const enrolled = await fetch(`${controlUrl}/api/v1/runner/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      joinToken: token,
      runnerVersion: "1.0.0-test",
      protocol: RUNNER_PROTOCOL_VERSION,
      minProtocol: RUNNER_PROTOCOL_MIN_SUPPORTED,
    }),
  });
  if (!enrolled.ok)
    throw new Error(`Enrolling the fake host runner failed: ${await enrolled.text()}`);
  const { credential } = (await enrolled.json()) as { credential: string };

  const url = new URL("/api/v1/runner/connect", controlUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url.toString(), {
    headers: { authorization: `Bearer ${credential}` },
  } as unknown as string[]);
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener(
      "error",
      () => fail(new Error("The fake host runner couldn't connect.")),
      {
        once: true,
      },
    );
  });

  let welcomed = false;
  let deliver: ((frame: string) => void) | null = null;
  socket.addEventListener("message", (event) => {
    const frame =
      typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
    if (frame.includes('"type":"welcome"')) welcomed = true;
    deliver?.(frame);
  });
  // The test runner talks to a hub; this one forwards over the socket instead.
  const hub = {
    attach(link: { send(frame: string): void; close(): void }) {
      deliver = (frame) => link.send(frame);
      return {
        message: (frame: string) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(frame);
        },
        closed: () => socket.close(),
      };
    },
    isOnline: () => welcomed,
  };
  const db = {
    insertInto: () => ({
      values: () => ({
        returning: () => ({ executeTakeFirstOrThrow: async () => ({ id: "fake-host" }) }),
      }),
    }),
  };
  const runner = await FakeRunner.connect(db as never, hub as never, null);
  // The link counts as dead after 35 s of silence: a heartbeat every 10 s, as the runner sends.
  let seq = 0;
  const beat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "heartbeat", seq: seq++, at: Date.now() }));
    }
  }, 10_000);
  return {
    runner,
    async close() {
      clearInterval(beat);
      socket.close();
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    },
  };
}
