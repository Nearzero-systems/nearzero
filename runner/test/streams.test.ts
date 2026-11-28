import { describe, expect, test } from "bun:test";
import { decodeChunk } from "@nearzero/shared";
import { LineChunker, OutputBuffer } from "../src/streams/buffer.ts";
import { RunnerStream, type StreamMessage } from "../src/streams/stream.ts";

/** Stream buffers and resume (docs/runner-protocol.md, "Streams and resume"). */

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (chunks: { bytes: Uint8Array }[]) =>
  chunks.map((chunk) => new TextDecoder().decode(chunk.bytes)).join("");

describe("the output buffer", () => {
  test("gives every byte an offset and serves from any of them", () => {
    const buffer = new OutputBuffer(1024);
    expect(buffer.append(bytes("hello ")).offset).toBe(0);
    expect(buffer.append(bytes("world")).offset).toBe(6);
    expect(buffer.endOffset).toBe(11);
    expect(text(buffer.from(0))).toBe("hello world");
    expect(text(buffer.from(3))).toBe("lo world");
    expect(buffer.from(8)[0]?.offset).toBe(8);
    expect(buffer.from(11)).toEqual([]);
  });

  test("forgets what was acknowledged", () => {
    const buffer = new OutputBuffer(1024);
    buffer.append(bytes("aaa"));
    buffer.append(bytes("bbb"));
    buffer.ack(3);
    expect(buffer.firstOffset).toBe(3);
    expect(buffer.heldBytes).toBe(3);
    expect(text(buffer.from(0))).toBe("bbb");
  });

  test("drops the oldest output past its limit, which shows as a gap", () => {
    const buffer = new OutputBuffer(10);
    buffer.append(bytes("123456"));
    buffer.append(bytes("789012"));
    expect(buffer.firstOffset).toBe(6);
    expect(buffer.from(0)[0]?.offset).toBe(6);
  });
});

describe("the line chunker", () => {
  test("sends whole lines together and holds a partial line briefly", async () => {
    const out: string[] = [];
    const chunker = new LineChunker((chunk) => out.push(new TextDecoder().decode(chunk)), 1024, 20);
    chunker.push(bytes("one\ntwo\nthr"));
    expect(out).toEqual(["one\ntwo\n"]);
    chunker.push(bytes("ee\n"));
    expect(out).toEqual(["one\ntwo\n", "three\n"]);
    chunker.push(bytes("partial"));
    await Bun.sleep(50);
    expect(out.at(-1)).toBe("partial");
  });
});

describe("a runner stream across a reconnect", () => {
  test("output written while the link is down is sent from exactly the control plane's offset", () => {
    const first: StreamMessage[] = [];
    const stream = new RunnerStream("s1", (message) => {
      first.push(message);
      return true;
    });
    stream.text("line 1\n");
    stream.text("line 2\n");
    expect(first).toHaveLength(2);
    // The control plane stored only the first line before the link dropped.
    stream.detach();
    stream.text("line 3\n");
    stream.text("line 4\n");
    stream.end(0);
    const second: StreamMessage[] = [];
    stream.resume((message) => {
      second.push(message);
      return true;
    }, 7);
    const data = second.filter((m) => m.type === "stream.data");
    expect(data.map((m) => m.offset)).toEqual([7, 14, 21]);
    expect(data.map((m) => new TextDecoder().decode(decodeChunk(m.data))).join("")).toBe(
      "line 2\nline 3\nline 4\n",
    );
    expect(second.at(-1)).toEqual({ type: "stream.end", streamId: "s1", offset: 28, exitCode: 0 });
    expect(stream.finished).toBe(false);
    stream.ack(28);
    expect(stream.finished).toBe(true);
  });

  test("input sent before the process is ready reaches it once it is", () => {
    const stream = new RunnerStream("s2", () => true);
    stream.input(bytes("early"));
    stream.resize(100, 40);
    const received: string[] = [];
    let size = "";
    stream.onInput = (input) => received.push(new TextDecoder().decode(input));
    stream.onResize = (cols, rows) => {
      size = `${cols}x${rows}`;
    };
    stream.input(bytes("late"));
    expect(received).toEqual(["early", "late"]);
    expect(size).toBe("100x40");
  });
});
