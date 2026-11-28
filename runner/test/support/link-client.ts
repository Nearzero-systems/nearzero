import { checkCredential, enroll } from "../../src/credentials.ts";
import { type ControlLink, linkFetch, openLinkSocket } from "../../src/link/link.ts";

/**
 * A runner's requests, one after another, in a process of their own: link-impostor.test.ts runs
 * it with NODE_EXTRA_CA_CERTS naming a test authority, which then counts as a public one (as Let's
 * Encrypt would), the case in which a certificate it issued must still get nothing at a pinned
 * address (C4-01) or for another name (C4-03). Prints one JSON line per step.
 *
 *   bun link-client.ts '[{"kind":"check","link":{"url":"https://…","fingerprint":"…"}}, …]'
 */

export const CREDENTIAL = "nzr1.server-one.TOPSECRET-credential-0123456789";
export const JOIN_TOKEN = "nzj1.server-one.TOPSECRET-join-token-0123456789";

export type Kind = "check" | "enroll" | "upload" | "socket";

async function step(kind: Kind, link: ControlLink): Promise<{ ok: boolean; detail: string }> {
  try {
    if (kind === "check") {
      const answer = await checkCredential(link.url, CREDENTIAL, linkFetch(link));
      return { ok: answer.result === "accepted", detail: answer.message };
    }
    if (kind === "enroll") {
      await enroll(link.url, JOIN_TOKEN, {}, linkFetch(link));
      return { ok: true, detail: "" };
    }
    if (kind === "upload") {
      const response = await linkFetch(link)(new URL("/api/v1/runner/uploads/u1", link.url), {
        headers: { authorization: `Bearer ${CREDENTIAL}` },
      });
      return { ok: response.ok, detail: await response.text() };
    }
    const socket = openLinkSocket(link, "/api/v1/runner/connect", {
      authorization: `Bearer ${CREDENTIAL}`,
    });
    return await new Promise((resolve) => {
      let why = "";
      socket.addEventListener("error", (event) => {
        why = (event as unknown as { message?: string }).message ?? why;
      });
      socket.addEventListener("open", () => {
        socket.close(1000, "done");
        resolve({ ok: true, detail: "" });
      });
      socket.addEventListener("close", (event) =>
        resolve({ ok: false, detail: why || (event as CloseEvent).reason }),
      );
    });
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

if (import.meta.main) {
  const steps = JSON.parse(process.argv[2] ?? "[]") as { kind: Kind; link: ControlLink }[];
  for (const item of steps) {
    console.log(JSON.stringify(await step(item.kind, item.link)));
  }
  process.exit(0);
}
