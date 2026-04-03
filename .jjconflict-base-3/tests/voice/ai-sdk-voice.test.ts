import { describe, expect, test, mock, beforeEach } from "bun:test";
import { PassThrough } from "node:stream";
import { createAiSdkVoice } from "../../src/voice/ai-sdk-voice";

// ---------------------------------------------------------------------------
// Mock AI SDK experimental functions
// ---------------------------------------------------------------------------

// We mock at the module level to intercept calls
const mockGenerateSpeech = mock(async (opts: any) => ({
  audio: {
    uint8Array: new Uint8Array([72, 101, 108, 108, 111]), // "Hello" in bytes
  },
}));

const mockTranscribe = mock(async (opts: any) => ({
  text: "transcribed text",
  segments: [],
}));

// Mock the ai module
mock.module("ai", () => ({
  experimental_generateSpeech: mockGenerateSpeech,
  experimental_transcribe: mockTranscribe,
}));

describe("voice: ai-sdk-voice", () => {
  beforeEach(() => {
    mockGenerateSpeech.mockClear();
    mockTranscribe.mockClear();
  });

  test("createAiSdkVoice returns a VoiceProvider with correct name", () => {
    const provider = createAiSdkVoice({
      name: "my-voice",
    });
    expect(provider.name).toBe("my-voice");
  });

  test("createAiSdkVoice uses default name when not specified", () => {
    const provider = createAiSdkVoice({});
    expect(provider.name).toBe("ai-sdk-voice");
  });

  test("speak is undefined when no speechModel is provided", () => {
    const provider = createAiSdkVoice({});
    expect(provider.speak).toBeUndefined();
  });

  test("listen is undefined when no transcriptionModel is provided", () => {
    const provider = createAiSdkVoice({});
    expect(provider.listen).toBeUndefined();
  });

  test("speak calls experimental_generateSpeech with correct params", async () => {
    const fakeSpeechModel = { modelId: "tts-1", specificationVersion: "v2" } as any;
    const provider = createAiSdkVoice({
      speechModel: fakeSpeechModel,
      speaker: "alloy",
    });

    expect(provider.speak).toBeDefined();

    const stream = await provider.speak!("Hello world", { speaker: "echo" });
    expect(stream).toBeDefined();
    expect(typeof (stream as any).read).toBe("function");

    expect(mockGenerateSpeech).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateSpeech.mock.calls[0]![0];
    expect(callArgs.model).toBe(fakeSpeechModel);
    expect(callArgs.text).toBe("Hello world");
    expect(callArgs.voice).toBe("echo"); // Override from options
  });

  test("speak uses default speaker when none in options", async () => {
    const fakeSpeechModel = { modelId: "tts-1", specificationVersion: "v2" } as any;
    const provider = createAiSdkVoice({
      speechModel: fakeSpeechModel,
      speaker: "alloy",
    });

    await provider.speak!("Hi");
    const callArgs = mockGenerateSpeech.mock.calls[0]![0];
    expect(callArgs.voice).toBe("alloy");
  });

  test("speak converts stream input to text", async () => {
    const fakeSpeechModel = { modelId: "tts-1", specificationVersion: "v2" } as any;
    const provider = createAiSdkVoice({
      speechModel: fakeSpeechModel,
    });

    const inputStream = new PassThrough();
    inputStream.end("stream text");

    await provider.speak!(inputStream, {});
    const callArgs = mockGenerateSpeech.mock.calls[0]![0];
    expect(callArgs.text).toBe("stream text");
  });

  test("speak returns a readable stream with audio data", async () => {
    const fakeSpeechModel = { modelId: "tts-1", specificationVersion: "v2" } as any;
    const provider = createAiSdkVoice({
      speechModel: fakeSpeechModel,
    });

    const result = await provider.speak!("test");
    const chunks: Buffer[] = [];
    for await (const chunk of result) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    }
    const buf = Buffer.concat(chunks);
    expect(buf.length).toBe(5); // "Hello" = 5 bytes from mock
  });

  test("listen calls experimental_transcribe with audio buffer", async () => {
    const fakeTranscriptionModel = { modelId: "whisper-1", specificationVersion: "v2" } as any;
    const provider = createAiSdkVoice({
      transcriptionModel: fakeTranscriptionModel,
    });

    expect(provider.listen).toBeDefined();

    const audioStream = new PassThrough();
    audioStream.end(Buffer.from("fake audio data"));

    const result = await provider.listen!(audioStream);
    expect(result).toBe("transcribed text");

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    const callArgs = mockTranscribe.mock.calls[0]![0];
    expect(callArgs.model).toBe(fakeTranscriptionModel);
    expect(Buffer.isBuffer(callArgs.audio)).toBe(true);
  });

  test("getSpeakers returns empty array", async () => {
    const provider = createAiSdkVoice({});
    expect(provider.getSpeakers).toBeDefined();
    const speakers = await provider.getSpeakers!();
    expect(speakers).toEqual([]);
  });

  test("provider with both models has speak and listen", () => {
    const provider = createAiSdkVoice({
      speechModel: { modelId: "tts-1", specificationVersion: "v2" } as any,
      transcriptionModel: { modelId: "whisper-1", specificationVersion: "v2" } as any,
    });
    expect(provider.speak).toBeDefined();
    expect(provider.listen).toBeDefined();
  });
});
