/**
 * Effect service layer for voice operations.
 *
 * Provides a `VoiceService` Context.Tag that can be injected into Effect
 * pipelines, plus `speak()` and `listen()` functions that pull the provider
 * from context automatically.
 */

import { Context, Effect } from "effect";
import type {
  VoiceProvider,
  SpeakOptions,
  ListenOptions,
  TranscriptionResult,
} from "./types";
import { SmithersError } from "../utils/errors";

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class VoiceService extends Context.Tag("VoiceService")<
  VoiceService,
  VoiceProvider
>() {}

// ---------------------------------------------------------------------------
// Effect functions
// ---------------------------------------------------------------------------

/**
 * Convert text to speech using the VoiceService from context.
 */
export function speak(
  input: string | NodeJS.ReadableStream,
  options?: SpeakOptions,
): Effect.Effect<NodeJS.ReadableStream, SmithersError, VoiceService> {
  return Effect.gen(function* () {
    const provider = yield* VoiceService;
    if (!provider.speak) {
      return yield* Effect.fail(
        new SmithersError(
          "VOICE_SPEAK_NOT_SUPPORTED",
          `Voice provider "${provider.name}" does not support speak().`,
        ),
      );
    }
    return yield* Effect.tryPromise({
      try: () => provider.speak!(input, options) as Promise<NodeJS.ReadableStream>,
      catch: (cause) =>
        new SmithersError(
          "VOICE_SPEAK_FAILED",
          `speak() failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
  });
}

/**
 * Convert speech to text using the VoiceService from context.
 */
export function listen(
  audioStream: NodeJS.ReadableStream,
  options?: ListenOptions,
): Effect.Effect<
  string | TranscriptionResult,
  SmithersError,
  VoiceService
> {
  return Effect.gen(function* () {
    const provider = yield* VoiceService;
    if (!provider.listen) {
      return yield* Effect.fail(
        new SmithersError(
          "VOICE_LISTEN_NOT_SUPPORTED",
          `Voice provider "${provider.name}" does not support listen().`,
        ),
      );
    }
    return yield* Effect.tryPromise({
      try: () => provider.listen!(audioStream, options) as Promise<string | TranscriptionResult>,
      catch: (cause) =>
        new SmithersError(
          "VOICE_LISTEN_FAILED",
          `listen() failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
  });
}
