// Types
export type {
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
} from "./types";

// AI SDK voice provider (batch TTS/STT)
export { createAiSdkVoice } from "./ai-sdk-voice";
export type { AiSdkVoiceConfig } from "./ai-sdk-voice";

// Composite voice (mix providers)
export { createCompositeVoice } from "./composite";
export type { CompositeVoiceConfig } from "./composite";

// OpenAI Realtime voice (WebSocket speech-to-speech)
export { createOpenAIRealtimeVoice } from "./realtime";
export type { OpenAIRealtimeVoiceConfig } from "./realtime";

// Effect service layer
export { VoiceService, speak, listen } from "./effect";
