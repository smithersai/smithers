import type { FrameDelta } from "./FrameDelta";

const FRAME_DELTA_VERSION = 1;

export function parseFrameDelta(deltaJson: string): FrameDelta {
  const parsed = JSON.parse(deltaJson);
  if (!isRecord(parsed)) {
    throw new Error("Invalid frame delta payload (not an object)");
  }
  if (parsed.version !== FRAME_DELTA_VERSION) {
    throw new Error(`Unsupported frame delta version: ${String(parsed.version)}`);
  }
  if (!Array.isArray(parsed.ops)) {
    throw new Error("Invalid frame delta payload (missing ops array)");
  }
  return parsed as FrameDelta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
