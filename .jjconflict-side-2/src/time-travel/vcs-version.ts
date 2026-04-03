import { eq, and } from "drizzle-orm";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect, Metric } from "effect";
import type { SmithersDb } from "../db/adapter";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { nowMs } from "../utils/time";
import { SmithersError } from "../utils/errors";
import { smithersVcsTags } from "./schema";
import {
  getJjPointerEffect,
  revertToJjPointerEffect,
  workspaceAddEffect,
  runJjEffect,
} from "../vcs/jj";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VcsTag = {
  runId: string;
  frameNo: number;
  vcsType: string;
  vcsPointer: string;
  vcsRoot: string | null;
  jjOperationId: string | null;
  createdAtMs: number;
};

// ---------------------------------------------------------------------------
// Tag a snapshot with VCS metadata
// ---------------------------------------------------------------------------

export function tagSnapshotVcsEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Effect.Effect<VcsTag | null, SmithersError, CommandExecutor> {
  return Effect.gen(function* () {
    const pointer = yield* getJjPointerEffect(opts.cwd);
    if (!pointer) return null;

    // Get current jj operation ID for precise restore
    const opRes = yield* runJjEffect(
      ["operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"],
      { cwd: opts.cwd },
    );
    const jjOperationId = opRes.code === 0 ? opRes.stdout.trim() || null : null;

    const ts = nowMs();
    const tag: VcsTag = {
      runId,
      frameNo,
      vcsType: "jj",
      vcsPointer: pointer,
      vcsRoot: opts.cwd ?? null,
      jjOperationId,
      createdAtMs: ts,
    };

    yield* fromPromise("insert vcs tag", () =>
      (adapter as any).db
        .insert(smithersVcsTags)
        .values(tag)
        .onConflictDoUpdate({
          target: [smithersVcsTags.runId, smithersVcsTags.frameNo],
          set: tag,
        }),
    {
      code: "DB_WRITE_FAILED",
      details: { frameNo, runId },
    },
    );

    yield* Effect.logDebug("VCS tag recorded").pipe(
      Effect.annotateLogs({
        runId,
        frameNo: String(frameNo),
        vcsPointer: pointer,
      }),
    );

    return tag;
  }).pipe(
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:tag-snapshot-vcs"),
  );
}

export function tagSnapshotVcs(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Promise<VcsTag | null> {
  return runPromise(tagSnapshotVcsEffect(adapter, runId, frameNo, opts));
}

// ---------------------------------------------------------------------------
// Load VCS tag for a snapshot
// ---------------------------------------------------------------------------

export function loadVcsTagEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
): Effect.Effect<VcsTag | undefined, SmithersError> {
  return fromPromise("load vcs tag", (): Promise<VcsTag[]> =>
    (adapter as any).db
      .select()
      .from(smithersVcsTags)
      .where(
        and(
          eq(smithersVcsTags.runId, runId),
          eq(smithersVcsTags.frameNo, frameNo),
        ),
      )
      .limit(1),
  {
    code: "DB_QUERY_FAILED",
    details: { frameNo, runId },
  },
  ).pipe(
    Effect.map((rows: any[]) => rows[0] as VcsTag | undefined),
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:load-vcs-tag"),
  );
}

export function loadVcsTag(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
): Promise<VcsTag | undefined> {
  return runPromise(loadVcsTagEffect(adapter, runId, frameNo));
}

// ---------------------------------------------------------------------------
// Resolve workflow at a specific VCS revision
// ---------------------------------------------------------------------------

/**
 * Create a jj workspace at the revision recorded for a specific snapshot.
 * Returns the workspace path or null if no VCS tag exists.
 */
export function resolveWorkflowAtRevisionEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  workspacePath: string,
): Effect.Effect<
  { workspacePath: string; vcsPointer: string } | null,
  SmithersError,
  CommandExecutor
> {
  return Effect.gen(function* () {
    const tag = yield* loadVcsTagEffect(adapter, runId, frameNo);
    if (!tag) return null;

    const workspaceName = `smithers-replay-${runId.slice(0, 8)}-f${frameNo}`;
    const result = yield* workspaceAddEffect(workspaceName, workspacePath, {
      cwd: tag.vcsRoot ?? undefined,
      atRev: tag.vcsPointer,
    });

    if (!result.success) {
      return yield* Effect.fail(
        new SmithersError(
          "VCS_WORKSPACE_CREATE_FAILED",
          `Failed to create workspace at ${tag.vcsPointer}: ${result.error}`,
          { frameNo, runId, vcsPointer: tag.vcsPointer, workspacePath },
        ),
      );
    }

    return { workspacePath, vcsPointer: tag.vcsPointer };
  }).pipe(
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:resolve-workflow-at-revision"),
  );
}

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

// ---------------------------------------------------------------------------
// Rerun at a specific revision (restore VCS + return info)
// ---------------------------------------------------------------------------

export function rerunAtRevisionEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Effect.Effect<
  { restored: boolean; vcsPointer: string | null; error?: string },
  SmithersError,
  CommandExecutor
> {
  return Effect.gen(function* () {
    const tag = yield* loadVcsTagEffect(adapter, runId, frameNo);
    if (!tag) {
      return { restored: false, vcsPointer: null };
    }

    const result = yield* revertToJjPointerEffect(
      tag.vcsPointer,
      opts.cwd ?? tag.vcsRoot ?? undefined,
    );

    if (!result.success) {
      return { restored: false, vcsPointer: tag.vcsPointer, error: result.error };
    }

    return { restored: true, vcsPointer: tag.vcsPointer };
  }).pipe(
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:rerun-at-revision"),
  );
}

export function rerunAtRevision(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Promise<{ restored: boolean; vcsPointer: string | null; error?: string }> {
  return runPromise(rerunAtRevisionEffect(adapter, runId, frameNo, opts));
}
