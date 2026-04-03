/**
 * Core voice provider types for Smithers.
 *
 * A VoiceProvider can speak (TTS), listen (STT), or handle real-time
 * bidirectional audio streaming. Providers implement only the methods
 * they support; callers check for method existence before invoking.
 */

// ---------------------------------------------------------------------------
// Audio format
// ---------------------------------------------------------------------------

export type AudioFormat = "mp3" | "wav" | "pcm" | "opus" | "flac" | "aac";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type SpeakOptions = {
  /** Override the default speaker/voice ID. */
  speaker?: string;
  /** Language code (e.g. "en", "fr"). */
  language?: string;
  /** Audio output format. */
  format?: AudioFormat;
  /** Provider-specific options. */
  providerOptions?: Record<string, unknown>;
  /** Abort signal. */
  abortSignal?: AbortSignal;
  /** Custom headers for the request. */
  headers?: Record<string, string>;
};

export type ListenOptions = {
  /** Language hint for transcription. */
  language?: string;
  /** Provider-specific options. */
  providerOptions?: Record<string, unknown>;
  /** Abort signal. */
  abortSignal?: AbortSignal;
  /** Custom headers for the request. */
  headers?: Record<string, string>;
};

export type SendOptions = {
  /** Optional event ID for tracking. */
  eventId?: string;
};

// ---------------------------------------------------------------------------
// Transcription result
// ---------------------------------------------------------------------------

export type TranscriptionSegment = {
  text: string;
  startMs: number;
  endMs: number;
};

export type TranscriptionResult = {
  text: string;
  segments?: TranscriptionSegment[];
  language?: string;
  durationMs?: number;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type VoiceEventMap = {
  speaking: { audio?: Buffer | string; response_id?: string };
  writing: { text: string; role: "assistant" | "user"; response_id?: string };
  error: { message: string; code?: string; details?: unknown };
  speaker: NodeJS.ReadableStream;
  [key: string]: unknown;
};

export type VoiceEventType = keyof VoiceEventMap | string;

export type VoiceEventCallback = (...args: any[]) => void;

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface VoiceProvider {
  /** Provider name for logging and diagnostics. */
  readonly name: string;

  /**
   * Convert text to speech (TTS).
   * Returns an audio stream.
   */
  speak?(
    input: string | NodeJS.ReadableStream,
    options?: SpeakOptions,
  ): Promise<NodeJS.ReadableStream>;

  /**
   * Convert speech to text (STT).
   * Returns transcribed text or a structured result.
   */
  listen?(
    audioStream: NodeJS.ReadableStream,
    options?: ListenOptions,
  ): Promise<string | TranscriptionResult>;

  /**
   * Send audio data for real-time processing.
   */
  send?(
    audioData: NodeJS.ReadableStream | Int16Array | Buffer,
    options?: SendOptions,
  ): Promise<void>;

  /**
   * Open a connection for real-time voice (WebSocket, WebRTC, etc.).
   */
  connect?(options?: Record<string, unknown>): Promise<void>;

  /**
   * Close any active real-time connection.
   */
  close?(): void;

  /**
   * Trigger the provider to generate a response.
   */
  answer?(options?: Record<string, unknown>): Promise<void>;

  /**
   * Register an event listener.
   */
  on?<E extends VoiceEventType>(
    event: E,
    callback: VoiceEventCallback,
  ): void;

  /**
   * Remove an event listener.
   */
  off?<E extends VoiceEventType>(
    event: E,
    callback: VoiceEventCallback,
  ): void;

  /**
   * List available speaker voices.
   */
  getSpeakers?(): Promise<Array<{ voiceId: string; [key: string]: unknown }>>;

  /**
   * Update provider configuration at runtime.
   */
  updateConfig?(options: Record<string, unknown>): void;
}
