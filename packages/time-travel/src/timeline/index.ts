import { Effect } from "effect";
import { buildTimeline as buildTimelineEffect } from "./buildTimelineEffect";
import { buildTimelineTree as buildTimelineTreeEffect } from "./buildTimelineTreeEffect";
export { formatTimelineForTui } from "./formatTimelineForTui";
export { formatTimelineAsJson } from "./formatTimelineAsJson";

export {
  buildTimelineEffect,
  buildTimelineTreeEffect,
};

export function buildTimeline(
  ...args: Parameters<typeof buildTimelineEffect>
) {
  return Effect.runPromise(buildTimelineEffect(...args));
}

export function buildTimelineTree(
  ...args: Parameters<typeof buildTimelineTreeEffect>
) {
  return Effect.runPromise(buildTimelineTreeEffect(...args));
}
