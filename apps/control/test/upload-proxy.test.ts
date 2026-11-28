import { afterAll, beforeAll, expect, test } from "bun:test";
import { UPLOAD_MAX_BYTES } from "@nearzero/shared";
import { connectionOf, forwardToControl } from "../../console/src/lib/control-api.ts";
import { MAX_REQUEST_BODY_BYTES } from "../src/service-runtime/routes.ts";

/**
 * A 200 MB app archive (spec 6.3) passes from the browser through the console's /api/v1 proxy to
 * the control plane: streamed, never refused by the HTTP servers' body limits, and not cut by
 * the proxy's wait for an answer while it is still being sent.
 */

let control: ReturnType<typeof Bun.serve>;
const previous = process.env.NEARZERO_CONTROL_URL;

beforeAll(() => {
  // Like the control plane's own server (main.ts), with its body limit.
  control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    async fetch(request) {
      let received = 0;
      for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
      }
      return Response.json({ received });
    },
  });
  process.env.NEARZERO_CONTROL_URL = `http://127.0.0.1:${control.port}`;
});

afterAll(() => {
  control.stop(true);
  if (previous === undefined) delete process.env.NEARZERO_CONTROL_URL;
  else process.env.NEARZERO_CONTROL_URL = previous;
});

test("an upload of the largest allowed size streams through the console's proxy", async () => {
  const size = UPLOAD_MAX_BYTES;
  const piece = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const next = Math.min(piece.length, size - sent);
      sent += next;
      controller.enqueue(next === piece.length ? piece : piece.subarray(0, next));
    },
  });
  const request = new Request("http://console.test/api/v1/services/x/source/upload", {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body,
    duplex: "half",
  } as RequestInit);
  const response = await forwardToControl(request, connectionOf(request, "203.0.113.7"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: size });
}, 120_000);
