import { defaultRoll, stableRoll } from "./extern-source";

export function combinedRoll(): number {
  return defaultRoll() + stableRoll();
}
