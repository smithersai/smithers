import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { rerunAtRevisionEffect } from "./rerunAtRevisionEffect";

export function rerunAtRevision(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Promise<{ restored: boolean; vcsPointer: string | null; error?: string }> {
  return runPromise(rerunAtRevisionEffect(adapter, runId, frameNo, opts));
}
