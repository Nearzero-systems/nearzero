import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ControlMessage,
  encodeChunk,
  HEARTBEAT_INTERVAL_MS,
  NEARZERO_LABELS,
  parseControlMessage,
  RUNNER_CONNECT_PATH,
  RUNNER_ENROLL_PATH,
  RUNNER_PROTOCOL_MIN_SUPPORTED,
  RUNNER_PROTOCOL_VERSION,
  type RunnerMessage,
} from "@nearzero/shared";

/**
 * A pretend server for the M10 console checks (Tasks, Analytics, monitoring, channels): it joins
 * with a real join token (a server's, or the host's from the handoff folder) and speaks the
 * runner protocol over a real WebSocket. It answers the task commands (the syntax check runs a
 * real `sh -n` here; runs print a few lines), serves a request log of Traefik-shaped JSON lines,
 * and reports a metrics sample every second, so every M10 page shows live data. Nothing runs on
 * any server.
 */

export class M10Runner {
  readonly commands: string[] = [];
  /** Services whose container "runs" here. */
  readonly services = new Set<string>();
  /** The request log, as the router would write it. */
  log = "";
  accessLogEnabled = false;
  #socket: WebSocket | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];
  #seq = 0;
  #cpu = 12;
  readonly #held = new Map<string, () => void>();

  private constructor(private readonly controlUrl: string) {}

  static async join(controlUrl: string, joinToken: string): Promise<M10Runner> {
    const runner = new M10Runner(controlUrl);
    const enrolled = await fetch(`${controlUrl}${RUNNER_ENROLL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        joinToken,
        runnerVersion: "1.0.0-fake",
        protocol: RUNNER_PROTOCOL_VERSION,
        minProtocol: RUNNER_PROTOCOL_MIN_SUPPORTED,
      }),
    });
    if (!enrolled.ok) throw new Error(`enroll failed: ${enrolled.status} ${await enrolled.text()}`);
    const { credential } = (await enrolled.json()) as { credential: string };
    await runner.#connect(credential);
    return runner;
  }

  /** The host's runner, with the join token the control plane left in its handoff folder. */
  static async joinHost(controlUrl: string, folder: string): Promise<M10Runner> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const token = await readFile(join(folder, "host-join-token"), "utf8").then(
        (text) => text.trim(),
        () => "",
      );
      if (token) return M10Runner.join(controlUrl, token);
      if (Date.now() > deadline) throw new Error(`No host join token in ${folder}.`);
      await Bun.sleep(200);
    }
  }

  /** Adds `count` requests to the log, ending now, with a status mix. */
  addRequests(count: number, host: string, endAt = Date.now()): void {
    const lines: string[] = [];
    for (let index = 0; index < count; index++) {
      const at = endAt - (count - index) * 37_000;
      const status = index % 10 === 0 ? 502 : index % 7 === 0 ? 404 : index % 9 === 0 ? 301 : 200;
      lines.push(
        JSON.stringify({
          ClientHost: `203.0.113.${(index % 20) + 1}`,
          ClientPort: String(40000 + index),
          DownstreamStatus: status,
          DownstreamContentSize: 512 + index,
          Duration: (3 + (index % 40)) * 1_000_000,
          OriginStatus: status,
          RequestHost: index % 4 === 0 ? `api.${host}` : host,
          RequestMethod: index % 5 === 0 ? "POST" : "GET",
          RequestPath: index % 6 === 0 ? `/api/items/${index}` : "/",
          RequestProtocol: "HTTP/1.1",
          RequestScheme: "https",
          RouterName: "nz-web-https@file",
          ServiceName: "nz-web@file",
          ServiceURL: "http://web-abc123:3000",
          StartUTC: new Date(at).toISOString(),
          entryPointName: "websecure",
          TLSVersion: "1.3",
          "request_User-Agent": "Mozilla/5.0 (fake)",
        }),
      );
    }
    this.log += `${lines.join("\n")}\n`;
  }

  async #connect(credential: string): Promise<void> {
    const url = `${this.controlUrl.replace(/^http/, "ws")}${RUNNER_CONNECT_PATH}`;
    const socket = new WebSocket(url, {
      // Standing in for a server's runner, which always reaches Nearzero encrypted (spec 31): the
      // test stack's plain port is told so, as the router says it for HTTPS. A runner the
      // control plane sees on plain HTTP gets no work (C4-05).
      headers: { authorization: `Bearer ${credential}`, "x-forwarded-proto": "https" },
    } as unknown as string[]);
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("the fake runner couldn't connect")),
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => this.#receive(String(event.data)));
    this.#send({
      type: "hello",
      runnerVersion: "1.0.0-fake",
      protocol: RUNNER_PROTOCOL_VERSION,
      minProtocol: RUNNER_PROTOCOL_MIN_SUPPORTED,
      startedAt: Date.now(),
      system: {
        hostname: "fake-server",
        os: "Ubuntu 24.04 LTS",
        kernel: "6.8.0-48-generic",
        architecture: "x86_64",
        cpuModel: "AMD EPYC 7763 64-Core Processor",
        cpuCores: 4,
        cpuThreads: 8,
        cpuMhz: 2450,
        memoryTotalBytes: 8 * 1024 ** 3,
        dockerVersion: "28.0.4",
        containerized: false,
        timeZone: "Europe/Berlin",
      },
      checks: { docker: true, network: true, router: true, routerDirectory: true },
      streams: [],
      commands: [],
    });
    this.#timers.push(
      setInterval(
        () => this.#send({ type: "heartbeat", seq: ++this.#seq, at: Date.now() }),
        HEARTBEAT_INTERVAL_MS,
      ),
      setInterval(() => this.#sample(), 1_000),
    );
    // A few minutes of history at once, as a runner does after a reconnect.
    const now = Date.now();
    this.#send({
      type: "metrics",
      samples: Array.from({ length: 60 }, (_, index) =>
        this.#makeSample(now - (60 - index) * 5_000),
      ),
    });
  }

  #makeSample(at: number) {
    this.#cpu = Math.max(3, Math.min(96, this.#cpu + (Math.random() - 0.48) * 9));
    return {
      at,
      cpuPercent: Math.round(this.#cpu * 10) / 10,
      memoryUsedBytes: Math.round((3.1 + Math.random() * 0.4) * 1024 ** 3),
      memoryTotalBytes: 8 * 1024 ** 3,
      diskUsedBytes: Math.round(41.5 * 1024 ** 3),
      diskTotalBytes: 160 * 1024 ** 3,
      uptimeSeconds: Math.floor(at / 1000) % 900_000,
    };
  }

  #sample(): void {
    this.#send({ type: "metrics", samples: [this.#makeSample(Date.now())] });
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#socket?.close();
  }

  #send(message: RunnerMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #receive(frame: string): void {
    const message = parseControlMessage(frame) as ControlMessage | null;
    if (message?.type !== "command") return;
    this.#send({ type: "ack", commandId: message.commandId });
    void this.#run(message);
  }

  async #run(message: Extract<ControlMessage, { type: "command" }>): Promise<void> {
    this.commands.push(message.kind);
    const params = (message.params ?? {}) as Record<string, unknown>;
    const streamId = message.streamId;
    let offset = 0;
    const write = (text: string) => {
      if (!streamId) return;
      const bytes = new TextEncoder().encode(text);
      this.#send({ type: "stream.data", streamId, offset, data: encodeChunk(bytes) });
      offset += bytes.length;
    };
    let data: unknown = {};
    let error: { code: "failed"; message: string } | null = null;
    try {
      data = await this.#handle(message.kind, params, write);
    } catch (problem) {
      error = { code: "failed", message: (problem as Error).message };
    }
    if (streamId) this.#send({ type: "stream.end", streamId, offset, ...(error ? { error } : {}) });
    this.#send({
      type: "result",
      commandId: message.commandId,
      ok: error === null,
      ...(error ? { error } : { data }),
    });
  }

  async #handle(
    kind: string,
    params: Record<string, unknown>,
    write: (text: string) => void,
  ): Promise<unknown> {
    switch (kind) {
      case "container.list": {
        const filter = ((params.labels as string[]) ?? [])[0] ?? "";
        const serviceId = filter.split("=")[1] ?? "";
        if (!this.services.has(serviceId)) return [];
        return [
          {
            id: `fake${serviceId.replaceAll("-", "").slice(0, 12)}`,
            name: "web",
            image: "nginx:1.27",
            state: "running",
            status: "Up 5 minutes",
            labels: { [NEARZERO_LABELS.service]: serviceId },
            createdAt: 1,
          },
        ];
      }
      case "task.check": {
        const child = Bun.spawn(["sh", "-n", "-c", String(params.script)], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(child.stderr).text();
        const code = await child.exited;
        const line = /(\d+):/.exec(output)?.[1] ?? "1";
        return {
          ok: code === 0,
          exitCode: code,
          output: code === 0 ? "" : `bash: -c: line ${line}: syntax error near unexpected token`,
        };
      }
      case "task.run": {
        write(
          `Running in ${params.place === "container" ? "the service's container" : "the server"}…\n`,
        );
        for (const line of String(params.script).split("\n").slice(0, 5))
          if (line.trim()) write(`+ ${line}\n`);
        await Bun.sleep(1200);
        write("Done.\n");
        if (String(params.script).includes("sleep 600")) {
          await new Promise<void>((resolve) => this.#held.set(String(params.runId), resolve));
          return { exitCode: null, stopped: true, timedOut: false };
        }
        return { exitCode: 0, stopped: false, timedOut: false };
      }
      case "task.stop": {
        const release = this.#held.get(String(params.runId));
        this.#held.delete(String(params.runId));
        release?.();
        return { stopped: Boolean(release) };
      }
      case "access-log.configure":
        this.accessLogEnabled = params.enabled === true;
        return { enabled: this.accessLogEnabled, changed: true };
      case "access-log.status":
        return {
          enabled: this.accessLogEnabled,
          applied: true,
          exists: true,
          sizeBytes: this.log.length,
        };
      case "access-log.read": {
        const bytes = new TextEncoder().encode(this.log);
        const from =
          params.fromOffset === null || Number(params.fromOffset) > bytes.length
            ? 0
            : Number(params.fromOffset);
        const slice = bytes.subarray(
          from,
          Math.min(bytes.length, from + Number(params.maxBytes ?? 2 * 1024 * 1024)),
        );
        const last = slice.lastIndexOf(10);
        const piece = last < 0 ? slice.subarray(0, 0) : slice.subarray(0, last + 1);
        return {
          exists: true,
          size: bytes.length,
          fileId: "1:1",
          start: from,
          end: from + piece.length,
          data: Buffer.from(piece).toString("base64"),
        };
      }
      case "access-log.clear":
        this.log = "";
        return { cleared: true };
      case "access-log.trim":
        return { kept: 0, removedBytes: 0 };
      default:
        return {};
    }
  }
}
