import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { tagSnapshotVcsEffect } from "./tagSnapshotVcsEffect";
import type { VcsTag } from "./VcsTag";

export function tagSnapshotVcs(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Promise<VcsTag | null> {
  return runPromise(tagSnapshotVcsEffect(adapter, runId, frameNo, opts));
}
