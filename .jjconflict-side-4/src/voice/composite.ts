/**
 * CompositeVoice mixes different providers for input (STT), output (TTS),
 * and real-time streaming. When a realtime provider is set, it takes
 * priority for all operations.
 */

import type {
  VoiceProvider,
  SpeakOptions,
  ListenOptions,
  SendOptions,
  TranscriptionResult,
  VoiceEventType,
  VoiceEventCallback,
} from "./types";
import { SmithersError } from "../utils/errors";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type CompositeVoiceConfig = {
  /** Provider for STT (listen). */
  input?: VoiceProvider;
  /** Provider for TTS (speak). */
  output?: VoiceProvider;
  /** Real-time provider — takes priority when set. */
  realtime?: VoiceProvider;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCompositeVoice(
  config: CompositeVoiceConfig,
): VoiceProvider {
  const { input, output, realtime } = config;

  const provider: VoiceProvider = {
    name: "composite-voice",

    async speak(
      text: string | NodeJS.ReadableStream,
      options?: SpeakOptions,
    ): Promise<NodeJS.ReadableStream> {
      if (realtime?.speak) {
        return realtime.speak(text, options) as Promise<NodeJS.ReadableStream>;
      }
      if (output?.speak) {
        return output.speak(text, options) as Promise<NodeJS.ReadableStream>;
      }
      throw new SmithersError(
        "VOICE_NO_SPEAK_PROVIDER",
        "No speak provider or realtime provider configured in CompositeVoice.",
      );
    },

    async listen(
      audioStream: NodeJS.ReadableStream,
      options?: ListenOptions,
    ): Promise<string | TranscriptionResult> {
      if (realtime?.listen) {
        return realtime.listen(audioStream, options) as Promise<
          string | TranscriptionResult
        >;
      }
      if (input?.listen) {
        return input.listen(audioStream, options) as Promise<
          string | TranscriptionResult
        >;
      }
      throw new SmithersError(
        "VOICE_NO_LISTEN_PROVIDER",
        "No listen provider or realtime provider configured in CompositeVoice.",
      );
    },

    async send(
      audioData: NodeJS.ReadableStream | Int16Array | Buffer,
      options?: SendOptions,
    ): Promise<void> {
      if (!realtime?.send) {
        throw new SmithersError(
          "VOICE_NO_REALTIME_PROVIDER",
          "No realtime provider configured for send() in CompositeVoice.",
        );
      }
      return realtime.send(audioData, options);
    },

    async connect(options?: Record<string, unknown>): Promise<void> {
      if (!realtime?.connect) {
        throw new SmithersError(
          "VOICE_NO_REALTIME_PROVIDER",
          "No realtime provider configured for connect() in CompositeVoice.",
        );
      }
      return realtime.connect(options);
    },

    close(): void {
      if (!realtime?.close) {
        throw new SmithersError(
          "VOICE_NO_REALTIME_PROVIDER",
          "No realtime provider configured for close() in CompositeVoice.",
        );
      }
      realtime.close();
    },

    async answer(options?: Record<string, unknown>): Promise<void> {
      if (!realtime?.answer) {
        throw new SmithersError(
          "VOICE_NO_REALTIME_PROVIDER",
          "No realtime provider configured for answer() in CompositeVoice.",
        );
      }
      return realtime.answer(options);
    },

    on<E extends VoiceEventType>(
      event: E,
      callback: VoiceEventCallback,
    ): void {
      if (!realtime?.on) {
        throw new SmithersError(
          "VOICE_NO_REALTIME_PROVIDER",
          "No realtime provider configured for on() in CompositeVoice.",
        );
      }
      realtime.on(event, callback);
    },

    off<E extends VoiceEventType>(
      event: E,
      callback: VoiceEventCallback,
    ): void {
      if (!realtime?.off) {
        throw new SmithersError(
          "VOICE_NO_REALTIME_PROVIDER",
          "No realtime provider configured for off() in CompositeVoice.",
        );
      }
      realtime.off(event, callback);
    },

    async getSpeakers(): Promise<
      Array<{ voiceId: string; [key: string]: unknown }>
    > {
      if (realtime?.getSpeakers) return realtime.getSpeakers();
      if (output?.getSpeakers) return output.getSpeakers();
      return [];
    },

    updateConfig(options: Record<string, unknown>): void {
      if (realtime?.updateConfig) {
        realtime.updateConfig(options);
      }
    },
  };

  return provider;
}
