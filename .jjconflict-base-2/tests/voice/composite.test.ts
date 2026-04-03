import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createCompositeVoice } from "../../src/voice/composite";
import type { VoiceProvider } from "../../src/voice/types";

// ---------------------------------------------------------------------------
// Helper providers
// ---------------------------------------------------------------------------

function createMockSpeaker(name: string): VoiceProvider {
  return {
    name,
    async speak(input: string | NodeJS.ReadableStream) {
      const stream = new PassThrough();
      const text = typeof input === "string" ? input : "stream";
      stream.end(Buffer.from(`spoken-by-${name}:${text}`));
      return stream;
    },
    async getSpeakers() {
      return [{ voiceId: "test-voice" }];
    },
  };
}

function createMockListener(name: string): VoiceProvider {
  return {
    name,
    async listen() {
      return `transcribed-by-${name}`;
    },
  };
}

function createMockRealtime(name: string): VoiceProvider {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    name,
    async speak(input: string | NodeJS.ReadableStream) {
      const stream = new PassThrough();
      stream.end(Buffer.from(`realtime-${name}`));
      return stream;
    },
    async listen() {
      return `realtime-transcribed-${name}`;
    },
    async send() {},
    async connect() {},
    close() {},
    async answer() {},
    on(event: any, cb: (...args: any[]) => void) {
      const key = String(event);
      if (!listeners[key]) listeners[key] = [];
      listeners[key]!.push(cb);
    },
    off(event: any, cb: (...args: any[]) => void) {
      const key = String(event);
      const cbs = listeners[key];
      if (!cbs) return;
      const idx = cbs.indexOf(cb);
      if (idx !== -1) cbs.splice(idx, 1);
    },
    async getSpeakers() {
      return [{ voiceId: "realtime-voice" }];
    },
    updateConfig() {},
  };
}

describe("voice: composite", () => {
  test("routes speak to output provider", async () => {
    const composite = createCompositeVoice({
      output: createMockSpeaker("eleven"),
    });

    const result = await composite.speak!("hello");
    const chunks: Buffer[] = [];
    for await (const chunk of result) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    }
    expect(Buffer.concat(chunks).toString()).toBe("spoken-by-eleven:hello");
  });

  test("routes listen to input provider", async () => {
    const composite = createCompositeVoice({
      input: createMockListener("deepgram"),
    });

    const audioStream = new PassThrough();
    audioStream.end(Buffer.from("audio"));

    const result = await composite.listen!(audioStream);
    expect(result).toBe("transcribed-by-deepgram");
  });

  test("realtime provider takes priority for speak", async () => {
    const composite = createCompositeVoice({
      output: createMockSpeaker("eleven"),
      realtime: createMockRealtime("openai"),
    });

    const result = await composite.speak!("hello");
    const chunks: Buffer[] = [];
    for await (const chunk of result) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    }
    expect(Buffer.concat(chunks).toString()).toBe("realtime-openai");
  });

  test("realtime provider takes priority for listen", async () => {
    const composite = createCompositeVoice({
      input: createMockListener("deepgram"),
      realtime: createMockRealtime("openai"),
    });

    const audioStream = new PassThrough();
    audioStream.end(Buffer.from("audio"));

    const result = await composite.listen!(audioStream);
    expect(result).toBe("realtime-transcribed-openai");
  });

  test("throws when speak called without output or realtime", async () => {
    const composite = createCompositeVoice({
      input: createMockListener("deepgram"),
    });

    await expect(composite.speak!("hello")).rejects.toThrow(
      /No speak provider/,
    );
  });

  test("throws when listen called without input or realtime", async () => {
    const composite = createCompositeVoice({
      output: createMockSpeaker("eleven"),
    });

    const audioStream = new PassThrough();
    audioStream.end(Buffer.from("audio"));

    await expect(composite.listen!(audioStream)).rejects.toThrow(
      /No listen provider/,
    );
  });

  test("send delegates to realtime provider", async () => {
    const rt = createMockRealtime("openai");
    let sendCalled = false;
    rt.send = async () => {
      sendCalled = true;
    };
    const composite = createCompositeVoice({ realtime: rt });
    await composite.send!(Buffer.from("audio"));
    expect(sendCalled).toBe(true);
  });

  test("send throws without realtime provider", () => {
    const composite = createCompositeVoice({});
    expect(() => composite.send!(Buffer.from("audio"))).toThrow(
      /No realtime provider/,
    );
  });

  test("connect delegates to realtime provider", async () => {
    const rt = createMockRealtime("openai");
    let connected = false;
    rt.connect = async () => {
      connected = true;
    };
    const composite = createCompositeVoice({ realtime: rt });
    await composite.connect!();
    expect(connected).toBe(true);
  });

  test("connect throws without realtime provider", () => {
    const composite = createCompositeVoice({});
    expect(() => composite.connect!()).toThrow(/No realtime provider/);
  });

  test("close delegates to realtime provider", () => {
    const rt = createMockRealtime("openai");
    let closed = false;
    rt.close = () => {
      closed = true;
    };
    const composite = createCompositeVoice({ realtime: rt });
    composite.close!();
    expect(closed).toBe(true);
  });

  test("on/off delegate to realtime provider", () => {
    const rt = createMockRealtime("openai");
    const composite = createCompositeVoice({ realtime: rt });
    const cb = () => {};
    // Should not throw
    composite.on!("speaking", cb);
    composite.off!("speaking", cb);
  });

  test("getSpeakers delegates to realtime if present", async () => {
    const composite = createCompositeVoice({
      output: createMockSpeaker("eleven"),
      realtime: createMockRealtime("openai"),
    });
    const speakers = await composite.getSpeakers!();
    expect(speakers[0]!.voiceId).toBe("realtime-voice");
  });

  test("getSpeakers falls back to output provider", async () => {
    const composite = createCompositeVoice({
      output: createMockSpeaker("eleven"),
    });
    const speakers = await composite.getSpeakers!();
    expect(speakers[0]!.voiceId).toBe("test-voice");
  });

  test("getSpeakers returns empty when no provider has it", async () => {
    const composite = createCompositeVoice({});
    const speakers = await composite.getSpeakers!();
    expect(speakers).toEqual([]);
  });

  test("provider name is composite-voice", () => {
    const composite = createCompositeVoice({});
    expect(composite.name).toBe("composite-voice");
  });
});
