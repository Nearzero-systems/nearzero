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
 * A pretend server for the console's end-to-end flows: it joins with a real join token and
 * speaks the runner protocol over a real WebSocket to the control plane, and answers the backup
 * commands against an in-memory bucket and one running container per service it is told about.
 * Nothing runs on any machine; the flows exercise the console, the API and the jobs for real.
 */

interface BucketFile {
  size: number;
  modifiedAt: string;
}

export class FakeRunner {
  readonly commands: string[] = [];
  /** The parameters of the last command of each kind. */
  readonly lastParams = new Map<string, Record<string, unknown>>();
  readonly bucket = new Map<string, BucketFile>();
  readonly services = new Set<string>();
  #socket: WebSocket | null = null;
  #beat: ReturnType<typeof setInterval> | null = null;
  #seq = 0;

  private constructor(private readonly controlUrl: string) {}

  static async join(controlUrl: string, joinToken: string): Promise<FakeRunner> {
    const runner = new FakeRunner(controlUrl);
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
        {
          once: true,
        },
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
        os: "Ubuntu 24.04",
        kernel: "6.8",
        architecture: "x86_64",
        cpuModel: "Fake CPU",
        cpuCores: 2,
        cpuThreads: 2,
        cpuMhz: 2000,
        memoryTotalBytes: 4 * 1024 ** 3,
        dockerVersion: "28.0.0",
        containerized: false,
        timeZone: "Europe/Berlin",
      },
      checks: { docker: true, network: true, router: true, routerDirectory: true },
      streams: [],
      commands: [],
    });
    this.#beat = setInterval(
      () => this.#send({ type: "heartbeat", seq: ++this.#seq, at: Date.now() }),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.#beat) clearInterval(this.#beat);
    this.#socket?.close();
  }

  #send(message: RunnerMessage): void {
    this.#socket?.send(JSON.stringify(message));
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
    this.lastParams.set(message.kind, params);
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
    if (streamId) {
      this.#send({ type: "stream.end", streamId, offset, ...(error ? { error } : {}) });
    }
    this.#send({
      type: "result",
      commandId: message.commandId,
      ok: error === null,
      ...(error ? { error } : { data }),
    });
  }

  async #handle(kind: string, params: Record<string, unknown>, write: (text: string) => void) {
    switch (kind) {
      case "container.list": {
        const filter = ((params.labels as string[]) ?? [])[0] ?? "";
        const serviceId = filter.split("=")[1] ?? "";
        if (!this.services.has(serviceId)) return [];
        return [
          {
            id: `fake${serviceId.replaceAll("-", "").slice(0, 12)}`,
            name: "database",
            image: "postgres:18",
            state: "running",
            status: "Up 5 minutes",
            labels: { [NEARZERO_LABELS.service]: serviceId },
            createdAt: 1,
          },
        ];
      }
      case "backup.test":
        return { entries: this.bucket.size };
      case "backup.files": {
        const prefix = String(params.prefix);
        return {
          files: [...this.bucket]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, file]) => ({ key, size: file.size, modifiedAt: file.modifiedAt })),
        };
      }
      case "backup.prune":
        for (const key of params.keys as string[]) this.bucket.delete(key);
        return { deleted: params.keys };
      case "backup.database": {
        write("→ Dumping the database (pg_dump)\n");
        await Bun.sleep(1500);
        write("✓ Dumping the database (pg_dump)\n→ Uploading\n");
        await Bun.sleep(500);
        const key = String(params.key);
        this.bucket.set(key, { size: 2048, modifiedAt: new Date().toISOString() });
        write("✓ Uploading\n");
        return { key, bytes: 2048 };
      }
      case "restore.database": {
        write("→ Downloading the backup\n✓ Downloading the backup\n→ Loading the dump (psql)\n");
        await Bun.sleep(1500);
        write("✓ Loading the dump (psql)\n");
        return { bytes: this.bucket.get(String(params.key))?.size ?? 0 };
      }
      case "backup.volumes":
        return { containers: [], volumes: [], users: {}, missing: [] };
      default:
        return {};
    }
  }
}
