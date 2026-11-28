import { createSocket, type Socket } from "node:dgram";

/**
 * A tiny DNS server for tests, over UDP on 127.0.0.1 (RFC 1035 4.1): it answers A questions from
 * a map, NXDOMAIN for names it doesn't know, and no data for other types. Enough for the
 * runner's resolver, which asks one question per message.
 */
export class FakeDns {
  readonly records = new Map<string, string[]>();
  readonly questions: string[] = [];
  #socket: Socket | null = null;
  port = 0;

  async start(): Promise<string> {
    const socket = createSocket("udp4");
    this.#socket = socket;
    socket.on("message", (query, peer) => {
      const answer = this.#answer(query);
      if (answer) socket.send(answer, peer.port, peer.address);
    });
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    this.port = socket.address().port;
    return `127.0.0.1:${this.port}`;
  }

  stop(): void {
    this.#socket?.close();
    this.#socket = null;
  }

  #answer(query: Buffer): Buffer | null {
    if (query.length < 12) return null;
    // The question: labels up to a zero byte, then its type and class.
    const labels: string[] = [];
    let offset = 12;
    while (offset < query.length) {
      const length = query[offset] as number;
      if (length === 0) break;
      labels.push(query.subarray(offset + 1, offset + 1 + length).toString("ascii"));
      offset += 1 + length;
    }
    const questionEnd = offset + 5;
    if (questionEnd > query.length) return null;
    const type = query.readUInt16BE(offset + 1);
    const name = labels.join(".").toLowerCase();
    this.questions.push(name);
    const known = this.records.get(name);
    const addresses = type === 1 ? (known ?? []) : [];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(query.readUInt16BE(0), 0);
    // A response, recursion desired and available; NXDOMAIN when the name is unknown.
    header.writeUInt16BE(known ? 0x8180 : 0x8183, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(addresses.length, 6);
    const answers = addresses.map((address) => {
      const record = Buffer.alloc(16);
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(1, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt32BE(60, 6);
      record.writeUInt16BE(4, 10);
      for (const [index, part] of address.split(".").entries())
        record.writeUInt8(Number(part), 12 + index);
      return record;
    });
    return Buffer.concat([header, query.subarray(12, questionEnd), ...answers]);
  }
}
