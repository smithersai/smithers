import { applyFrameDelta } from "./applyFrameDelta";
import { parseFrameDelta } from "./parseFrameDelta";

export function applyFrameDeltaJson(
  previousXmlJson: string,
  deltaJson: string,
): string {
  return applyFrameDelta(previousXmlJson, parseFrameDelta(deltaJson));
}
