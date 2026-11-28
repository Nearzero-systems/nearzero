/**
 * Local stand-ins for notification providers (spec 15.2): one HTTP server that records every
 * request (Slack, Telegram, Discord, Lark, Teams, Resend, Gotify, ntfy, Mattermost, Pushover and
 * custom webhooks all post to it), and a small SMTP server that accepts mail. Tests never reach
 * a real service.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  json: unknown;
}

export class FakeHttpNotifier {
  readonly requests: RecordedRequest[] = [];
  /** Status (and body and headers) per path; 200 with "{}" otherwise. */
  readonly answers = new Map<
    string,
    { status: number; body?: string; headers?: Record<string, string> }
  >();
  #server: ReturnType<typeof Bun.serve> | null = null;

  start(): string {
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.text();
        let json: unknown = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        this.requests.push({
          method: request.method,
          path: url.pathname,
          headers: Object.fromEntries(request.headers),
          body,
          json,
        });
        const answer = this.answers.get(url.pathname);
        if (answer)
          return new Response(answer.body ?? "", {
            status: answer.status,
            ...(answer.headers ? { headers: answer.headers } : {}),
          });
        if (url.pathname.endsWith("/sendMessage")) return Response.json({ ok: true, result: {} });
        if (url.pathname.endsWith("/messages.json"))
          return Response.json({ status: 1, request: "r" });
        if (url.pathname.startsWith("/lark")) return Response.json({ code: 0, msg: "success" });
        return Response.json({});
      },
    });
    return `http://127.0.0.1:${this.#server.port}`;
  }

  on(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  reset(): void {
    this.requests.length = 0;
    this.answers.clear();
  }

  stop(): void {
    this.#server?.stop(true);
  }
}

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
}

/** Enough SMTP for nodemailer: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT; no TLS. */
export class FakeSmtpServer {
  readonly mails: ReceivedMail[] = [];
  #server: { port: number; stop(closeActive?: boolean): void } | null = null;

  start(): number {
    interface Session {
      buffer: string;
      inData: boolean;
      mail: ReceivedMail;
      authStep: "none" | "user" | "pass";
    }
    const sessions = new WeakMap<object, Session>();
    const fresh = (): ReceivedMail => ({ from: "", to: [], data: "", auth: null });
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          sessions.set(socket, { buffer: "", inData: false, mail: fresh(), authStep: "none" });
          socket.write("220 fake.smtp ESMTP ready\r\n");
        },
        data: (socket, chunk) => {
          const session = sessions.get(socket);
          if (!session) return;
          session.buffer += new TextDecoder().decode(chunk);
          for (;;) {
            if (session.inData) {
              const end = session.buffer.indexOf("\r\n.\r\n");
              if (end < 0) return;
              session.mail.data = session.buffer.slice(0, end);
              session.buffer = session.buffer.slice(end + 5);
              session.inData = false;
              this.mails.push(session.mail);
              session.mail = { ...fresh(), auth: session.mail.auth };
              socket.write("250 2.0.0 queued\r\n");
              continue;
            }
            const at = session.buffer.indexOf("\r\n");
            if (at < 0) return;
            const line = session.buffer.slice(0, at);
            session.buffer = session.buffer.slice(at + 2);
            const upper = line.toUpperCase();
            if (session.authStep === "user") {
              session.authStep = "pass";
              session.mail.auth = Buffer.from(line, "base64").toString();
              socket.write("334 UGFzc3dvcmQ6\r\n");
            } else if (session.authStep === "pass") {
              session.authStep = "none";
              socket.write("235 2.7.0 accepted\r\n");
            } else if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
              socket.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
            } else if (upper.startsWith("AUTH PLAIN")) {
              session.mail.auth =
                Buffer.from(line.slice(11).trim(), "base64").toString().split("\0")[1] ?? "";
              socket.write("235 2.7.0 accepted\r\n");
            } else if (upper.startsWith("AUTH LOGIN")) {
              session.authStep = "user";
              socket.write("334 VXNlcm5hbWU6\r\n");
            } else if (upper.startsWith("MAIL FROM:")) {
              session.mail.from = line
                .slice(10)
                .trim()
                .replace(/^<|>.*$/g, "");
              socket.write("250 2.1.0 ok\r\n");
            } else if (upper.startsWith("RCPT TO:")) {
              session.mail.to.push(
                line
                  .slice(8)
                  .trim()
                  .replace(/^<|>.*$/g, ""),
              );
              socket.write("250 2.1.5 ok\r\n");
            } else if (upper === "DATA") {
              session.inData = true;
              socket.write("354 go ahead\r\n");
            } else if (upper === "QUIT") {
              socket.write("221 bye\r\n");
              socket.end();
              return;
            } else if (upper === "RSET" || upper === "NOOP") {
              socket.write("250 ok\r\n");
            } else {
              socket.write("502 not implemented\r\n");
            }
          }
        },
      },
    });
    this.#server = listener;
    return listener.port;
  }

  stop(): void {
    this.#server?.stop(true);
  }
}
