import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { loadVcsTagEffect } from "./loadVcsTagEffect";
import type { VcsTag } from "./VcsTag";

export function loadVcsTag(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
): Promise<VcsTag | undefined> {
  return runPromise(loadVcsTagEffect(adapter, runId, frameNo));
}
