/**
 * AI SDK-backed voice provider for batch TTS and STT.
 *
 * Wraps `experimental_generateSpeech` and `experimental_transcribe` from the
 * Vercel AI SDK so callers do not need to interact with those APIs directly.
 */

import { PassThrough } from "node:stream";
import { experimental_generateSpeech, experimental_transcribe } from "ai";
import type { SpeechModel, TranscriptionModel } from "ai";
import type {
  VoiceProvider,
  SpeakOptions,
  ListenOptions,
  TranscriptionResult,
} from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type AiSdkVoiceConfig = {
  /** AI SDK speech model for TTS (e.g. openai.speech("tts-1")). */
  speechModel?: SpeechModel;
  /** AI SDK transcription model for STT (e.g. openai.transcription("whisper-1")). */
  transcriptionModel?: TranscriptionModel;
  /** Default speaker/voice for TTS. */
  speaker?: string;
  /** Provider name for logging. Defaults to "ai-sdk-voice". */
  name?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function streamToText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function streamToBuffer(
  audio: NodeJS.ReadableStream | Buffer | Uint8Array,
): Promise<Buffer> {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof Uint8Array) return Buffer.from(audio);
  const chunks: Buffer[] = [];
  for await (const chunk of audio as NodeJS.ReadableStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAiSdkVoice(config: AiSdkVoiceConfig): VoiceProvider {
  const providerName = config.name ?? "ai-sdk-voice";

  const provider: VoiceProvider = {
    name: providerName,
  };

  // TTS: speak
  if (config.speechModel) {
    const speechModel = config.speechModel;
    const defaultSpeaker = config.speaker;

    provider.speak = async (
      input: string | NodeJS.ReadableStream,
      options?: SpeakOptions,
    ): Promise<NodeJS.ReadableStream> => {
      const text =
        typeof input === "string" ? input : await streamToText(input);

      const result = await experimental_generateSpeech({
        model: speechModel,
        text,
        voice: options?.speaker ?? defaultSpeaker,
        providerOptions: options?.providerOptions as any,
        abortSignal: options?.abortSignal,
        headers: options?.headers,
      });

      // Convert Uint8Array to Node.js ReadableStream
      const passThrough = new PassThrough();
      passThrough.end(Buffer.from(result.audio.uint8Array));
      return passThrough;
    };
  }

  // STT: listen
  if (config.transcriptionModel) {
    const transcriptionModel = config.transcriptionModel;

    provider.listen = async (
      audioStream: NodeJS.ReadableStream,
      options?: ListenOptions,
    ): Promise<string | TranscriptionResult> => {
      const audioBuffer = await streamToBuffer(audioStream);

      const result = await experimental_transcribe({
        model: transcriptionModel,
        audio: audioBuffer,
        providerOptions: options?.providerOptions as any,
        abortSignal: options?.abortSignal,
        headers: options?.headers,
      });

      return result.text;
    };
  }

  // getSpeakers: return empty array (voice must be specified in options)
  provider.getSpeakers = async () => [];

  return provider;
}
