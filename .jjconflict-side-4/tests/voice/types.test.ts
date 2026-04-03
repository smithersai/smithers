import { describe, expect, test } from "bun:test";
import type {
  VoiceProvider,
  SpeakOptions,
  ListenOptions,
  SendOptions,
  AudioFormat,
  TranscriptionResult,
  TranscriptionSegment,
  VoiceEventMap,
  VoiceEventType,
  VoiceEventCallback,
} from "../../src/voice/types";

describe("voice: types", () => {
  test("VoiceProvider can be defined with minimal fields", () => {
    const provider: VoiceProvider = {
      name: "test-provider",
    };
    expect(provider.name).toBe("test-provider");
    expect(provider.speak).toBeUndefined();
    expect(provider.listen).toBeUndefined();
    expect(provider.send).toBeUndefined();
    expect(provider.connect).toBeUndefined();
    expect(provider.close).toBeUndefined();
  });

  test("VoiceProvider can have all optional methods", () => {
    const provider: VoiceProvider = {
      name: "full-provider",
      speak: async () => {
        const { PassThrough } = await import("node:stream");
        return new PassThrough();
      },
      listen: async () => "hello",
      send: async () => {},
      connect: async () => {},
      close: () => {},
      answer: async () => {},
      on: () => {},
      off: () => {},
      getSpeakers: async () => [{ voiceId: "alloy" }],
      updateConfig: () => {},
    };
    expect(provider.name).toBe("full-provider");
    expect(typeof provider.speak).toBe("function");
    expect(typeof provider.listen).toBe("function");
    expect(typeof provider.send).toBe("function");
    expect(typeof provider.connect).toBe("function");
    expect(typeof provider.close).toBe("function");
    expect(typeof provider.answer).toBe("function");
    expect(typeof provider.on).toBe("function");
    expect(typeof provider.off).toBe("function");
    expect(typeof provider.getSpeakers).toBe("function");
    expect(typeof provider.updateConfig).toBe("function");
  });

  test("SpeakOptions type structure", () => {
    const opts: SpeakOptions = {
      speaker: "alloy",
      language: "en",
      format: "mp3",
      providerOptions: { speed: 1.0 },
      headers: { "X-Custom": "value" },
    };
    expect(opts.speaker).toBe("alloy");
    expect(opts.format).toBe("mp3");
  });

  test("ListenOptions type structure", () => {
    const opts: ListenOptions = {
      language: "en",
      providerOptions: { model: "nova-3" },
    };
    expect(opts.language).toBe("en");
  });

  test("SendOptions type structure", () => {
    const opts: SendOptions = {
      eventId: "evt-123",
    };
    expect(opts.eventId).toBe("evt-123");
  });

  test("AudioFormat union type", () => {
    const formats: AudioFormat[] = ["mp3", "wav", "pcm", "opus", "flac", "aac"];
    expect(formats).toHaveLength(6);
  });

  test("TranscriptionResult type structure", () => {
    const result: TranscriptionResult = {
      text: "Hello world",
      segments: [{ text: "Hello", startMs: 0, endMs: 500 }],
      language: "en",
      durationMs: 1000,
    };
    expect(result.text).toBe("Hello world");
    expect(result.segments).toHaveLength(1);
  });

  test("TranscriptionResult can be minimal", () => {
    const result: TranscriptionResult = { text: "Hello" };
    expect(result.text).toBe("Hello");
    expect(result.segments).toBeUndefined();
  });

  test("VoiceEventType accepts standard and custom events", () => {
    const types: VoiceEventType[] = [
      "speaking",
      "writing",
      "error",
      "custom-event",
    ];
    expect(types).toHaveLength(4);
  });
});
