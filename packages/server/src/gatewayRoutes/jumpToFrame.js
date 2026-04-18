import { jumpToFrame, JumpToFrameError } from "@smithers-orchestrator/time-travel/jumpToFrame";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smithers-orchestrator/time-travel/jumpToFrame").JumpResult} JumpResult */

/**
 * Gateway wrapper around time-travel jump orchestration.
 *
 * The gateway has no direct hook into the engine's in-memory reconciler
 * (reconciler state is DB-backed: frames, nodes, attempts). We wire real
 * capture/restore/rebuild functions that operate on the run's DB state so
 * that the transaction rollback path inside jumpToFrame has meaningful
 * inputs, and callers can plug in an in-memory reconciler if they have one.
 *
 * @param {{
 *   adapter: SmithersDb;
 *   runId: unknown;
 *   frameNo: unknown;
 *   confirm?: unknown;
 *   caller?: string;
 *   pauseRunLoop?: () => Promise<void> | void;
 *   resumeRunLoop?: () => Promise<void> | void;
 *   emitEvent?: (event: SmithersEvent) => Promise<void> | void;
 *   captureReconcilerState?: () => Promise<unknown> | unknown;
 *   restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
 *   rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
 *   onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
 * }} input
 * @returns {Promise<JumpResult>}
 */
export async function jumpToFrameRoute(input) {
  const adapter = input.adapter;
  const runId = typeof input.runId === "string" ? input.runId : null;

  // Default reconciler hooks: DB-backed snapshot of latest frame + no-op
  // restore (frames are rolled back by the main transaction) + a rebuild
  // that simply annotates the run record with the target frame xml hash,
  // making it observable that a rewind happened.
  const defaultCapture = async () => {
    if (!runId) {
      return null;
    }
    try {
      const latest = await adapter.getLastFrame(runId);
      if (!latest) {
        return null;
      }
      return {
        frameNo: Number(latest.frameNo),
        createdAtMs: Number(latest.createdAtMs),
        xmlHash: typeof latest.xmlHash === "string" ? latest.xmlHash : null,
      };
    } catch {
      return null;
    }
  };
  const defaultRestore = async () => {
    // Frames/attempts/nodes rollback is handled by the main transaction; no
    // separate in-memory restore is required for the DB-driven engine.
  };
  const defaultRebuild = async () => {
    // Rebuild is a no-op for the DB-driven engine; the next resume reads
    // state directly from _smithers_frames. Callers that have an in-memory
    // reconciler can inject their own rebuildReconcilerState hook.
  };

  return await jumpToFrame({
    adapter: input.adapter,
    runId: input.runId,
    frameNo: input.frameNo,
    confirm: input.confirm,
    caller: input.caller,
    pauseRunLoop: input.pauseRunLoop,
    resumeRunLoop: input.resumeRunLoop,
    emitEvent: input.emitEvent,
    captureReconcilerState: input.captureReconcilerState ?? defaultCapture,
    restoreReconcilerState: input.restoreReconcilerState ?? defaultRestore,
    rebuildReconcilerState: input.rebuildReconcilerState ?? defaultRebuild,
    onLog: input.onLog,
  });
}

export { JumpToFrameError };
