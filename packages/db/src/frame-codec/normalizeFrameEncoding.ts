import type { FrameEncoding } from "./FrameEncoding";

export function normalizeFrameEncoding(value: unknown): FrameEncoding {
  if (value === "delta") return "delta";
  if (value === "keyframe") return "keyframe";
  return "full";
}
