import type { FrameDelta } from "./FrameDelta";

export function serializeFrameDelta(delta: FrameDelta): string {
  return JSON.stringify(delta);
}
