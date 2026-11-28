import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import { sendWithResend } from "../src/email/resend.ts";
import { nodemailerConnector } from "../src/email/smtp.ts";

const MAIL = {
  to: "dev@example.com",
  from: "Acme <team@acme.test>",
  subject: "Hello",
  text: "Plain words",
  html: "<p>Plain words</p>",
};

describe("sending through Resend", () => {
  const answer =
    (status: number, body: unknown = {}) =>
    async () =>
      Response.json(body, { status });

  test("a 2xx answer is sent; the key goes in the Authorization header only", async () => {
    let seen: RequestInit | undefined;
    const result = await sendWithResend(
      async (_url, init) => {
        seen = init;
        return Response.json({ id: "x" });
      },
      "re_key_1234",
      MAIL,
    );
    expect(result).toEqual({ sent: true });
    expect(new Headers(seen?.headers).get("authorization")).toBe("Bearer re_key_1234");
    expect(String(seen?.body)).not.toContain("re_key_1234");
  });

  test("failures are explained, never thrown", async () => {
    expect(await sendWithResend(answer(401), "re_x", MAIL)).toEqual({
      sent: false,
      reason: "Resend rejected the API key. Check it and save it again.",
    });
    expect(await sendWithResend(answer(429), "re_x", MAIL)).toMatchObject({ sent: false });
    expect(await sendWithResend(answer(503), "re_x", MAIL)).toEqual({
      sent: false,
      reason: "Resend had a problem (HTTP 503). Try again later.",
    });
    expect(
      await sendWithResend(answer(422, { message: "Invalid `from` field." }), "re_x", MAIL),
    ).toEqual({ sent: false, reason: "Resend refused the email: Invalid `from` field." });
    const offline = await sendWithResend(
      async () => {
        throw new TypeError("fetch failed");
      },
      "re_x",
      MAIL,
    );
    expect(offline).toEqual({
      sent: false,
      reason: "Resend couldn't be reached from this server. Check its internet connection.",
    });
  });
});

/** A tiny SMTP server that accepts one message at a time, for checking the real client. */
function smtpServer(options: { refuseAuth?: boolean }) {
  const received: { from: string; to: string[]; data: string; auth: string | null }[] = [];
  const listener: TCPSocketListener<{
    buffer: string;
    inData: boolean;
    current: (typeof received)[number];
  }> = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = {
          buffer: "",
          inData: false,
          current: { from: "", to: [], data: "", auth: null },
        };
        socket.write("220 test.local ESMTP ready\r\n");
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += chunk.toString();
        for (;;) {
          if (state.inData) {
            const end = state.buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            state.current.data = state.buffer.slice(0, end);
            state.buffer = state.buffer.slice(end + 5);
            state.inData = false;
            received.push(state.current);
            state.current = { from: "", to: [], data: "", auth: state.current.auth };
            socket.write("250 queued\r\n");
            continue;
          }
          const newline = state.buffer.indexOf("\r\n");
          if (newline === -1) return;
          const line = state.buffer.slice(0, newline);
          state.buffer = state.buffer.slice(newline + 2);
          respond(socket, line);
        }
      },
    },
  });
  function respond(
    socket: Socket<{ buffer: string; inData: boolean; current: (typeof received)[number] }>,
    line: string,
  ) {
    const upper = line.toUpperCase();
    if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
      socket.write("250-test.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
    } else if (upper.startsWith("AUTH PLAIN")) {
      if (options.refuseAuth) {
        socket.write("535 5.7.8 Authentication credentials invalid\r\n");
      } else {
        socket.data.current.auth = Buffer.from(line.slice(11), "base64").toString();
        socket.write("235 2.7.0 Authentication successful\r\n");
      }
    } else if (upper.startsWith("MAIL FROM:")) {
      socket.data.current.from = line.slice(10);
      socket.write("250 ok\r\n");
    } else if (upper.startsWith("RCPT TO:")) {
      socket.data.current.to.push(line.slice(8));
      socket.write("250 ok\r\n");
    } else if (upper === "DATA") {
      socket.data.inData = true;
      socket.write("354 end with <CRLF>.<CRLF>\r\n");
    } else if (upper === "QUIT") {
      socket.write("221 bye\r\n");
      socket.end();
    } else if (upper === "RSET" || upper === "NOOP") {
      socket.write("250 ok\r\n");
    } else {
      socket.write("502 not implemented\r\n");
    }
  }
  return { listener, received };
}

describe("sending through SMTP with the real client", () => {
  let good: ReturnType<typeof smtpServer>;
  let refusing: ReturnType<typeof smtpServer>;

  beforeAll(() => {
    good = smtpServer({});
    refusing = smtpServer({ refuseAuth: true });
  });

  afterAll(() => {
    good.listener.stop(true);
    refusing.listener.stop(true);
  });

  test("delivers a message with authentication", async () => {
    const result = await nodemailerConnector(
      {
        host: "127.0.0.1",
        port: good.listener.port,
        security: "none",
        username: "mailer",
        password: "pw-123",
      },
      MAIL,
    );
    expect(result).toEqual({ sent: true });
    expect(good.received).toHaveLength(1);
    expect(good.received[0]?.to).toEqual(["<dev@example.com>"]);
    expect(good.received[0]?.auth).toBe("\u0000mailer\u0000pw-123");
    expect(good.received[0]?.data).toContain("Subject: Hello");
  });

  test("a refused login is explained", async () => {
    const result = await nodemailerConnector(
      {
        host: "127.0.0.1",
        port: refusing.listener.port,
        security: "none",
        username: "mailer",
        password: "wrong",
      },
      MAIL,
    );
    expect(result).toEqual({
      sent: false,
      reason: "The SMTP server refused the user name or password. Check them and save again.",
    });
  });

  test("an unreachable server is explained", async () => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const result = await nodemailerConnector(
      { host: "127.0.0.1", port, security: "none", username: "", password: "" },
      MAIL,
    );
    expect(result).toEqual({
      sent: false,
      reason: `The SMTP server at 127.0.0.1:${port} couldn't be reached. Check the host, the port and the security setting.`,
    });
  });
});
