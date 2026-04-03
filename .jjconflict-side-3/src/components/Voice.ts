import React from "react";
import type { VoiceProvider } from "../voice/types";

export type VoiceProps = {
  /** Voice provider instance. */
  provider: VoiceProvider;
  /** Default speaker/voice ID for TTS within this subtree. */
  speaker?: string;
  children?: React.ReactNode;
};

/**
 * Wrap a subtree with voice I/O capabilities.
 *
 * Tasks inside a `<Voice>` scope receive the provider and optional speaker
 * on their descriptors, which the engine uses for TTS/STT operations.
 *
 * Renders to `<smithers:voice>`.
 */
export function Voice(props: VoiceProps) {
  const { provider, speaker, children } = props;
  return React.createElement(
    "smithers:voice",
    { provider, speaker },
    children,
  );
}
