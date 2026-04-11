import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { resolveWorkflowAtRevisionEffect } from "./resolveWorkflowAtRevisionEffect";

export function resolveWorkflowAtRevision(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  workspacePath: string,
): Promise<{ workspacePath: string; vcsPointer: string } | null> {
  return runPromise(
    resolveWorkflowAtRevisionEffect(adapter, runId, frameNo, workspacePath),
  );
}
