import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { buildTimelineEffect } from "./buildTimelineEffect";
import type { RunTimeline } from "../RunTimeline";

export function buildTimeline(
  adapter: SmithersDb,
  runId: string,
): Promise<RunTimeline> {
  return runPromise(buildTimelineEffect(adapter, runId));
}
