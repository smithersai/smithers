import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { buildTimelineTreeEffect } from "./buildTimelineTreeEffect";
import type { TimelineTree } from "../TimelineTree";

export function buildTimelineTree(
  adapter: SmithersDb,
  runId: string,
): Promise<TimelineTree> {
  return runPromise(buildTimelineTreeEffect(adapter, runId));
}
