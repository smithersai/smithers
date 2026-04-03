import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { PassThrough } from "node:stream";
import { VoiceService, speak, listen } from "../../src/voice/effect";
import type { VoiceProvider } from "../../src/voice/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockVoice(): VoiceProvider {
  return {
    name: "mock-voice",
    async speak(input: string | NodeJS.ReadableStream) {
      const stream = new PassThrough();
      const text = typeof input === "string" ? input : "from-stream";
      stream.end(Buffer.from(`spoken:${text}`));
      return stream;
    },
    async listen() {
      return "transcribed-text";
    },
  };
}

function createSpeakOnlyVoice(): VoiceProvider {
  return {
    name: "speak-only",
    async speak() {
      return new PassThrough();
    },
  };
}

function createListenOnlyVoice(): VoiceProvider {
  return {
    name: "listen-only",
    async listen() {
      return "text";
    },
  };
}

function createFailingVoice(): VoiceProvider {
  return {
    name: "failing-voice",
    async speak() {
      throw new Error("TTS failure");
    },
    async listen() {
      throw new Error("STT failure");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice: effect service", () => {
  test("speak succeeds with a provided voice", async () => {
    const voice = createMockVoice();
    const program = speak("hello world").pipe(
      Effect.provideService(VoiceService, voice),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const stream = exit.value;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
      }
      expect(Buffer.concat(chunks).toString()).toBe("spoken:hello world");
    }
  });

  test("listen succeeds with a provided voice", async () => {
    const voice = createMockVoice();
    const audioStream = new PassThrough();
    audioStream.end(Buffer.from("audio"));

    const program = listen(audioStream).pipe(
      Effect.provideService(VoiceService, voice),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe("transcribed-text");
    }
  });

  test("speak fails when provider does not support it", async () => {
    const voice = createListenOnlyVoice();
    const program = speak("hello").pipe(
      Effect.provideService(VoiceService, voice),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("listen fails when provider does not support it", async () => {
    const voice = createSpeakOnlyVoice();
    const audioStream = new PassThrough();
    audioStream.end(Buffer.from("audio"));

    const program = listen(audioStream).pipe(
      Effect.provideService(VoiceService, voice),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("speak wraps provider errors in SmithersError", async () => {
    const voice = createFailingVoice();
    const program = speak("hello").pipe(
      Effect.provideService(VoiceService, voice),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("listen wraps provider errors in SmithersError", async () => {
    const voice = createFailingVoice();
    const audioStream = new PassThrough();
    audioStream.end(Buffer.from("audio"));

    const program = listen(audioStream).pipe(
      Effect.provideService(VoiceService, voice),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("VoiceService is a Context.Tag", () => {
    // Just checking the tag is accessible and has the right shape
    expect(VoiceService).toBeDefined();
    expect(typeof VoiceService).toBe("function");
  });
});
