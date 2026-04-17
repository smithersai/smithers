import { Effect, Metric } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { getJjPointer, revertToJjPointer } from "@smithers/vcs/jj";
import {
  rewindTotal,
  rewindRollbackTotal,
  rewindDurationMs,
  rewindFramesDeleted,
  rewindSandboxesReverted,
} from "@smithers/observability/metrics";
import { JUMP_RUN_ID_PATTERN } from "./JUMP_RUN_ID_PATTERN.js";
import { JUMP_MAX_FRAME_NO } from "./JUMP_MAX_FRAME_NO.js";
import { JumpToFrameError } from "./JumpToFrameError.js";
import { validateJumpRunId } from "./validateJumpRunId.js";
import { validateJumpFrameNo } from "./validateJumpFrameNo.js";
import { acquireRewindLock } from "./acquireRewindLock.js";
import { evaluateRewindRateLimit } from "./evaluateRewindRateLimit.js";
import { writeRewindAuditRow } from "./writeRewindAuditRow.js";
import { updateRewindAuditRow } from "./updateRewindAuditRow.js";

export { JUMP_RUN_ID_PATTERN };
export { JUMP_MAX_FRAME_NO };
export { JumpToFrameError };
export { validateJumpRunId };
export { validateJumpFrameNo };

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("./JumpResult.ts").JumpResult} JumpResult */
/** @typedef {import("./JumpToFrameInput.ts").JumpToFrameInput} JumpToFrameInput */
/** @typedef {import("./JumpStepName.ts").JumpStepName} JumpStepName */

const OUTPUT_TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asString(value) {
  return typeof value === "string" ? value : null;
}

/**
 * @param {SmithersDb} adapter
 */
function resolveSqliteClient(adapter) {
  const db = /** @type {any} */ (adapter)?.db;
  const client = db?.session?.client ?? db?.$client;
  if (!client || typeof client.query !== "function") {
    throw new TypeError("Could not resolve Bun SQLite client from adapter.");
  }
  return client;
}

/**
 * @param {string} identifier
 */
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * @param {JumpToFrameInput["onLog"]} logger
 * @param {"info" | "warn" | "error"} level
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
async function emitLog(logger, level, message, fields = {}) {
  if (!logger) {
    return;
  }
  try {
    await logger(level, message, fields);
  } catch {
    // logging failures must never derail the RPC
  }
}

/**
 * Run a segment of work inside a tracing span. We deliberately attach the
 * span annotation via {@link Effect.withSpan} while preserving native JS
 * error identity: if the inner promise rejects we re-throw the original
 * error object so callers can match on `.code`, `.details`, etc. This
 * mirrors the pattern used by `getNodeOutputRoute`/`streamDevToolsRoute`.
 *
 * @template T
 * @param {string} spanName
 * @param {Record<string, unknown>} attrs
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withSpan(spanName, attrs, run) {
  /** @type {T | undefined} */
  let result;
  /** @type {unknown} */
  let captured = undefined;
  let failed = false;
  const effect = Effect.tryPromise({
    try: async () => {
      try {
        result = await run();
      } catch (error) {
        captured = error;
        failed = true;
      }
    },
    catch: (error) => error,
  }).pipe(Effect.withSpan(spanName, { attributes: attrs }));
  try {
    await Effect.runPromise(effect);
  } catch {
    // Swallow: the real thrown error is re-surfaced below so we preserve
    // the original Error object (and its `.code`).
  }
  if (failed) {
    throw captured;
  }
  return /** @type {T} */ (result);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCaller(value) {
  if (typeof value !== "string") {
    return "unknown";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 256) : "unknown";
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<{ frameNo: number; createdAtMs: number; xmlJson: string } | null>}
 */
async function readLatestFrame(adapter, runId) {
  const latest = await adapter.getLastFrame(runId);
  if (!latest) {
    return null;
  }
  return {
    frameNo: Number(latest.frameNo),
    createdAtMs: Number(latest.createdAtMs),
    xmlJson: String(latest.xmlJson ?? "{}"),
  };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Promise<{ frameNo: number; createdAtMs: number; xmlJson: string } | null>}
 */
async function readFrameByNo(adapter, runId, frameNo) {
  const client = resolveSqliteClient(adapter);
  const row = client
    .query(
      `SELECT frame_no AS frameNo, created_at_ms AS createdAtMs, xml_json AS xmlJson
         FROM _smithers_frames
        WHERE run_id = ? AND frame_no = ?
        LIMIT 1`,
    )
    .get(runId, frameNo);
  if (!row) {
    return null;
  }
  return {
    frameNo: Number(row.frameNo),
    createdAtMs: Number(row.createdAtMs),
    xmlJson: String(row.xmlJson ?? "{}"),
  };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} targetFrameNo
 */
async function countFramesAfter(adapter, runId, targetFrameNo) {
  const client = resolveSqliteClient(adapter);
  const row = client
    .query(
      `SELECT COUNT(*) AS count
         FROM _smithers_frames
        WHERE run_id = ? AND frame_no > ?`,
    )
    .get(runId, targetFrameNo);
  return Number(row?.count ?? 0);
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} cutoffMs
 */
async function deleteAttemptsStartedAfter(adapter, runId, cutoffMs) {
  const client = resolveSqliteClient(adapter);
  client
    .query(
      `DELETE FROM _smithers_attempts
        WHERE run_id = ?
          AND started_at_ms > ?`,
    )
    .run(runId, cutoffMs);
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Array<{ nodeId: string; iteration: number }>} nodeKeys
 * @param {number} nowMs
 */
async function resetNodesToPending(adapter, runId, nodeKeys, nowMs) {
  if (nodeKeys.length === 0) {
    return;
  }
  const client = resolveSqliteClient(adapter);
  const statement = client.query(
    `UPDATE _smithers_nodes
        SET state = ?,
            last_attempt = NULL,
            updated_at_ms = ?
      WHERE run_id = ?
        AND node_id = ?
        AND iteration = ?`,
  );
  for (const key of nodeKeys) {
    statement.run("pending", nowMs, runId, key.nodeId, key.iteration);
  }
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function readNodeOutputTableMap(adapter, runId) {
  const rows = await adapter.listNodes(runId);
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const row of rows) {
    if (typeof row?.nodeId !== "string") {
      continue;
    }
    const iteration = Number(row?.iteration ?? 0);
    const outputTable = asString(row?.outputTable);
    if (!outputTable || outputTable.length === 0) {
      continue;
    }
    map.set(`${row.nodeId}::${iteration}`, outputTable);
  }
  return map;
}

/**
 * @param {SmithersDb} adapter
 * @param {Array<{ tableName: string; nodeId: string; iteration: number }>} targets
 * @param {string} runId
 */
async function deleteOutputTargets(adapter, targets, runId) {
  if (targets.length === 0) {
    return 0;
  }
  const client = resolveSqliteClient(adapter);
  let deleted = 0;
  for (const target of targets) {
    if (!OUTPUT_TABLE_PATTERN.test(target.tableName)) {
      continue;
    }
    const tableSql = quoteIdentifier(target.tableName);
    try {
      const countRow = client
        .query(
          `SELECT COUNT(*) AS count
             FROM ${tableSql}
            WHERE run_id = ? AND node_id = ? AND iteration = ?`,
        )
        .get(runId, target.nodeId, target.iteration);
      deleted += Number(countRow?.count ?? 0);
      client
        .query(
          `DELETE FROM ${tableSql}
            WHERE run_id = ? AND node_id = ? AND iteration = ?`,
        )
        .run(runId, target.nodeId, target.iteration);
    } catch (error) {
      const message = formatError(error);
      if (/no such table/i.test(message)) {
        continue;
      }
      throw error;
    }
  }
  return deleted;
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} nowMs
 * @param {string} reason
 */
async function markRunNeedsAttention(adapter, runId, nowMs, reason) {
  const payload = JSON.stringify({
    code: "RewindFailed",
    needsAttention: true,
    message: reason,
    timestampMs: nowMs,
  });
  try {
    await adapter.updateRun(runId, {
      status: "needs_attention",
      finishedAtMs: nowMs,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      errorJson: payload,
    });
    return;
  } catch {
    // Older status enums may not accept `needs_attention`; fall back while preserving intent in errorJson.
  }
  await adapter.updateRun(runId, {
    status: "failed",
    finishedAtMs: nowMs,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    errorJson: payload,
  });
}

/**
 * @param {string} pointer
 * @param {string | undefined} cwd
 */
async function defaultRevertToPointer(pointer, cwd) {
  return await Effect.runPromise(
    revertToJjPointer(pointer, cwd).pipe(Effect.provide(BunContext.layer)),
  );
}

/**
 * @param {string | undefined} cwd
 */
async function defaultGetCurrentPointer(cwd) {
  return await Effect.runPromise(
    getJjPointer(cwd).pipe(Effect.provide(BunContext.layer)),
  );
}

/**
 * @param {JumpToFrameInput["hooks"]} hooks
 * @param {"before" | "after"} stage
 * @param {JumpStepName} step
 */
async function runStepHook(hooks, stage, step) {
  if (!hooks) {
    return;
  }
  if (stage === "before" && hooks.beforeStep) {
    await hooks.beforeStep(step);
  }
  if (stage === "after" && hooks.afterStep) {
    await hooks.afterStep(step);
  }
}

/**
 * @param {Array<{ cwd: string; targetPointer: string; previousPointer: string | null }>} revertedSandboxes
 * @param {(pointer: string, cwd?: string) => Promise<{ success: boolean; error?: string }>} revertToPointerImpl
 * @returns {Promise<Array<{ cwd: string; error: string }>>}
 */
async function rollbackSandboxPointers(revertedSandboxes, revertToPointerImpl) {
  /** @type {Array<{ cwd: string; error: string }>} */
  const failures = [];
  for (let index = revertedSandboxes.length - 1; index >= 0; index -= 1) {
    const sandbox = revertedSandboxes[index];
    if (typeof sandbox.previousPointer !== "string" || sandbox.previousPointer.length === 0) {
      failures.push({ cwd: sandbox.cwd, error: "Missing pre-jump pointer." });
      continue;
    }
    const restored = await revertToPointerImpl(sandbox.previousPointer, sandbox.cwd);
    if (!restored.success) {
      failures.push({
        cwd: sandbox.cwd,
        error: restored.error ?? "Failed to restore sandbox pointer.",
      });
    }
  }
  return failures;
}

/**
 * @param {Array<any>} attemptsForRun
 * @param {Array<any>} attemptsToDelete
 * @param {number} cutoffMs
 * @param {(cwd?: string) => Promise<string | null>} getCurrentPointerImpl
 */
async function planSandboxReverts(
  attemptsForRun,
  attemptsToDelete,
  cutoffMs,
  getCurrentPointerImpl,
) {
  /** @type {Map<string, { cwd: string; targetPointer: string; previousPointer: string | null }>} */
  const byCwd = new Map();
  const affectedCwds = new Set(
    attemptsToDelete
      .map((attempt) => (typeof attempt?.jjCwd === "string" ? attempt.jjCwd : ""))
      .filter((cwd) => cwd.length > 0),
  );

  for (const cwd of affectedCwds) {
    const beforeAttempts = attemptsForRun.filter(
      (attempt) =>
        attempt?.jjCwd === cwd &&
        typeof attempt?.jjPointer === "string" &&
        attempt.jjPointer.length > 0 &&
        Number(attempt?.startedAtMs ?? -1) <= cutoffMs,
    );
    const targetAttempt = beforeAttempts[beforeAttempts.length - 1];
    if (!targetAttempt || typeof targetAttempt.jjPointer !== "string") {
      throw new JumpToFrameError(
        "UnsupportedSandbox",
        `Could not resolve a rewind pointer for sandbox cwd ${cwd}.`,
      );
    }
    const previousPointer = await getCurrentPointerImpl(cwd);
    byCwd.set(cwd, {
      cwd,
      targetPointer: targetAttempt.jjPointer,
      previousPointer,
    });
  }

  return [...byCwd.values()];
}

/**
 * Rewind a run to a previous frame and make it resumable from that point.
 *
 * @param {JumpToFrameInput} input
 * @returns {Promise<JumpResult>}
 */
export async function jumpToFrame(input) {
  const nowMs = input.nowMs ?? (() => Date.now());
  const startedAtMs = nowMs();
  const caller = normalizeCaller(input.caller);

  let runIdForAudit = typeof input.runId === "string" ? input.runId : "invalid-run-id";
  let fromFrameNoForAudit = -1;
  let toFrameNoForAudit = Number.isInteger(input.frameNo) ? Number(input.frameNo) : -1;
  /** @type {"success" | "failed" | "partial"} */
  let auditResult = "failed";

  /** @type {JumpResult | null} */
  let successResult = null;
  /** @type {JumpToFrameError | null} */
  let finalError = null;

  let lock = null;
  /** @type {number | null} */
  let auditRowId = null;

  try {
    return await withSpan(
      "timetravel.jumpToFrame",
      {
        runId: typeof input.runId === "string" ? input.runId : "",
        caller,
        toFrameNo: typeof input.frameNo === "number" ? input.frameNo : -1,
      },
      async () => {
        const runId = validateJumpRunId(input.runId);
        const targetFrameNo = validateJumpFrameNo(input.frameNo);
        runIdForAudit = runId;
        toFrameNoForAudit = targetFrameNo;

        if (input.confirm !== true) {
          throw new JumpToFrameError(
            "ConfirmationRequired",
            "jumpToFrame is destructive; pass confirm: true to proceed.",
          );
        }

        lock = await withSpan(
          "timetravel.lock.acquire",
          { runId },
          async () => {
            const handle = acquireRewindLock(runId);
            if (!handle) {
              throw new JumpToFrameError(
                "Busy",
                `Another jumpToFrame is already running for ${runId}.`,
              );
            }
            return handle;
          },
        );

        const rateLimit = await evaluateRewindRateLimit({
          adapter: input.adapter,
          runId,
          caller,
          nowMs,
          maxPerWindow: input.rateLimit?.maxPerWindow,
          windowMs: input.rateLimit?.windowMs,
        });
        if (rateLimit.limited) {
          throw new JumpToFrameError(
            "RateLimited",
            `Rewind quota exceeded for ${runId}; max ${rateLimit.max} per ${Math.floor(
              rateLimit.windowMs / 60_000,
            )}m.`,
          );
        }

        // Durable in_progress audit row is written BEFORE any mutation so a
        // process kill leaves a marker for startup recovery.
        auditRowId = await withSpan(
          "timetravel.db.audit.insert",
          { runId, caller, state: "in_progress" },
          async () =>
            await writeRewindAuditRow(input.adapter, {
              runId,
              fromFrameNo: fromFrameNoForAudit,
              toFrameNo: targetFrameNo,
              caller,
              timestampMs: startedAtMs,
              result: "in_progress",
              durationMs: null,
            }),
        );

        const run = await input.adapter.getRun(runId);
        if (!run) {
          throw new JumpToFrameError("RunNotFound", `Run not found: ${runId}`);
        }

        const latestFrame = await readLatestFrame(input.adapter, runId);
        if (!latestFrame) {
          throw new JumpToFrameError("FrameOutOfRange", `Run ${runId} has no frames.`);
        }
        fromFrameNoForAudit = latestFrame.frameNo;

        if (targetFrameNo > latestFrame.frameNo) {
          throw new JumpToFrameError(
            "FrameOutOfRange",
            `frameNo must be between 0 and ${latestFrame.frameNo}.`,
          );
        }

        const targetFrame = await readFrameByNo(input.adapter, runId, targetFrameNo);
        if (!targetFrame) {
          throw new JumpToFrameError(
            "FrameOutOfRange",
            `Frame ${targetFrameNo} does not exist for run ${runId}.`,
          );
        }

        await emitLog(input.onLog, "info", "jumpToFrame started", {
          runId,
          fromFrameNo: latestFrame.frameNo,
          toFrameNo: targetFrameNo,
          caller,
        });

        if (targetFrameNo === latestFrame.frameNo) {
          auditResult = "success";
          successResult = {
            ok: true,
            newFrameNo: targetFrameNo,
            revertedSandboxes: 0,
            deletedFrames: 0,
            deletedAttempts: 0,
            invalidatedDiffs: 0,
            durationMs: Math.max(0, nowMs() - startedAtMs),
          };
          return successResult;
        }

        await runStepHook(input.hooks, "before", "snapshot-pre-jump");
        const attemptsForRun = await input.adapter.listAttemptsForRun(runId);
        const attemptsToDelete = attemptsForRun.filter(
          (attempt) => Number(attempt?.startedAtMs ?? -1) > targetFrame.createdAtMs,
        );
        const getCurrentPointerImpl = input.getCurrentPointerImpl ?? defaultGetCurrentPointer;
        const revertToPointerImpl = input.revertToPointerImpl ?? defaultRevertToPointer;
        const sandboxPlan = await planSandboxReverts(
          attemptsForRun,
          attemptsToDelete,
          targetFrame.createdAtMs,
          getCurrentPointerImpl,
        );

        const reconcilerSnapshot = await withSpan(
          "timetravel.snapshot.preJump",
          { runId, sandboxes: sandboxPlan.length },
          async () =>
            input.captureReconcilerState ? await input.captureReconcilerState() : null,
        );
        await runStepHook(input.hooks, "after", "snapshot-pre-jump");

        /** @type {Array<{ cwd: string; targetPointer: string; previousPointer: string | null }>} */
        const revertedSandboxes = [];
        let paused = false;

        try {
          await runStepHook(input.hooks, "before", "pause-event-loop");
          if (input.pauseRunLoop) {
            await input.pauseRunLoop();
          }
          paused = true;
          await runStepHook(input.hooks, "after", "pause-event-loop");

          await runStepHook(input.hooks, "before", "revert-sandboxes");
          for (const sandbox of sandboxPlan) {
            const reverted = await withSpan(
              "timetravel.vcs.revert.target",
              { cwd: sandbox.cwd, pointer: sandbox.targetPointer },
              async () => revertToPointerImpl(sandbox.targetPointer, sandbox.cwd),
            );
            if (!reverted.success) {
              throw new JumpToFrameError(
                "VcsError",
                reverted.error ?? `Failed to revert sandbox cwd ${sandbox.cwd}.`,
                {
                  details: {
                    cwd: sandbox.cwd,
                    pointer: sandbox.targetPointer,
                  },
                },
              );
            }
            revertedSandboxes.push(sandbox);
          }
          await runStepHook(input.hooks, "after", "revert-sandboxes");

          const deletedFrames = await countFramesAfter(input.adapter, runId, targetFrameNo);
          const deletedAttempts = attemptsToDelete.length;

          const outputTableMap = await readNodeOutputTableMap(input.adapter, runId);
          /** @type {Map<string, { tableName: string; nodeId: string; iteration: number }>} */
          const outputTargetsMap = new Map();
          /** @type {Map<string, { nodeId: string; iteration: number }>} */
          const nodeResetMap = new Map();
          for (const attempt of attemptsToDelete) {
            const nodeId = asString(attempt?.nodeId);
            if (!nodeId) {
              continue;
            }
            const iteration = Number(attempt?.iteration ?? 0);
            const key = `${nodeId}::${iteration}`;
            nodeResetMap.set(key, { nodeId, iteration });
            const tableName = outputTableMap.get(key);
            if (!tableName) {
              continue;
            }
            outputTargetsMap.set(`${tableName}:${key}`, {
              tableName,
              nodeId,
              iteration,
            });
          }

          // Durable mutation: frames/attempts/outputs/diffs/reconciler/run-status/event
          // all commit together or roll back together. If the event insert throws
          // the frames truncation is reverted too, so DB is never left mutated
          // without an audit/event record.
          const dbStats = await (async () =>
              await input.adapter.withTransaction(
                `jump to frame ${runId}:${targetFrameNo}`,
                Effect.gen(function* () {
                  // Invalidate node-diff cache BEFORE we truncate frames /
                  // attempts: the adapter hook computes which diffs are beyond
                  // the target by looking at the frame/attempt join, and that
                  // only works while frames/attempts are still intact.
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "invalidate-diffs"),
                  );
                  const invalidatedDiffs = yield* input.adapter
                    .invalidateNodeDiffsAfterFrame(runId, targetFrameNo);
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "invalidate-diffs"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "truncate-frames"),
                  );
                  yield* input.adapter.deleteFramesAfter(runId, targetFrameNo);
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "truncate-frames"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "truncate-attempts"),
                  );
                  yield* Effect.promise(() =>
                    deleteAttemptsStartedAfter(
                      input.adapter,
                      runId,
                      targetFrame.createdAtMs,
                    ),
                  );
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "truncate-attempts"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "truncate-outputs"),
                  );
                  const deletedOutputs = yield* Effect.promise(() =>
                    deleteOutputTargets(
                      input.adapter,
                      [...outputTargetsMap.values()],
                      runId,
                    ),
                  );
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "truncate-outputs"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "rebuild-reconciler"),
                  );
                  if (input.rebuildReconcilerState) {
                    yield* Effect.promise(() =>
                      input.rebuildReconcilerState?.(targetFrame.xmlJson),
                    );
                  }
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "rebuild-reconciler"),
                  );

                  yield* Effect.promise(() =>
                    resetNodesToPending(
                      input.adapter,
                      runId,
                      [...nodeResetMap.values()],
                      nowMs(),
                    ),
                  );

                  yield* input.adapter.updateRun(runId, {
                    status: "running",
                    finishedAtMs: null,
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                    hijackRequestedAtMs: null,
                    hijackTarget: null,
                    errorJson: null,
                  });

                  // Persist the TimeTravelJumped event inside the same
                  // transaction so frames/attempts truncation and audit/event
                  // rows commit atomically — there is no partial durable state.
                  const event = {
                    type: "TimeTravelJumped",
                    runId,
                    fromFrameNo: latestFrame.frameNo,
                    toFrameNo: targetFrameNo,
                    timestampMs: nowMs(),
                    caller,
                  };
                  // Insert the event row via raw SQL inside the enclosing
                  // transaction. We deliberately avoid `insertEventWithNextSeq`
                  // here because it opens its own BEGIN IMMEDIATE and would
                  // error out under a nested transaction.
                  yield* Effect.promise(() => {
                    const txnClient = resolveSqliteClient(input.adapter);
                    const seqRow = txnClient
                      .query(
                        `SELECT COALESCE(MAX(seq), -1) + 1 AS seq
                           FROM _smithers_events
                          WHERE run_id = ?`,
                      )
                      .get(runId);
                    const seq = Number(seqRow?.seq ?? 0);
                    txnClient
                      .query(
                        `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
                         VALUES (?, ?, ?, ?, ?)`,
                      )
                      .run(
                        runId,
                        seq,
                        event.timestampMs,
                        event.type,
                        JSON.stringify(event),
                      );
                    return Promise.resolve(seq);
                  });

                  return {
                    deletedFrames,
                    deletedAttempts,
                    deletedOutputs,
                    invalidatedDiffs,
                    event,
                  };
                }),
              ))();

          // In-memory broadcast is non-fatal: the durable event row is already
          // committed, so subscribers can reconcile from seq on reconnect.
          if (input.emitEvent) {
            try {
              await withSpan(
                "timetravel.eventbus.emit",
                { runId, type: "TimeTravelJumped" },
                async () =>
                  input.emitEvent?.(/** @type {SmithersEvent} */ (dbStats.event)),
              );
            } catch (emitError) {
              await emitLog(input.onLog, "warn", "jumpToFrame emit broadcast failed", {
                runId,
                caller,
                error: formatError(emitError),
              });
            }
          }

          await runStepHook(input.hooks, "before", "resume-event-loop");
          if (input.resumeRunLoop) {
            await input.resumeRunLoop();
          }
          paused = false;
          await runStepHook(input.hooks, "after", "resume-event-loop");

          auditResult = "success";
          successResult = {
            ok: true,
            newFrameNo: targetFrameNo,
            revertedSandboxes: sandboxPlan.length,
            deletedFrames: dbStats.deletedFrames,
            deletedAttempts: dbStats.deletedAttempts,
            invalidatedDiffs: dbStats.invalidatedDiffs,
            durationMs: Math.max(0, nowMs() - startedAtMs),
          };

          await emitLog(input.onLog, "info", "jumpToFrame succeeded", {
            runId,
            caller,
            fromFrameNo: latestFrame.frameNo,
            toFrameNo: targetFrameNo,
            revertedSandboxes: sandboxPlan.length,
            deletedFrames: dbStats.deletedFrames,
            deletedAttempts: dbStats.deletedAttempts,
            deletedOutputs: dbStats.deletedOutputs,
            invalidatedDiffs: dbStats.invalidatedDiffs,
            durationMs: successResult.durationMs,
          });

          return successResult;
        } catch (error) {
          const rollbackSandboxErrors = await rollbackSandboxPointers(
            revertedSandboxes,
            revertToPointerImpl,
          );
          let rollbackReconcilerError = null;
          if (input.restoreReconcilerState) {
            try {
              await input.restoreReconcilerState(reconcilerSnapshot);
            } catch (restoreError) {
              rollbackReconcilerError = formatError(restoreError);
            }
          }

          if (paused) {
            try {
              await input.resumeRunLoop?.();
            } catch (resumeError) {
              rollbackSandboxErrors.push({
                cwd: "<event-loop>",
                error: formatError(resumeError),
              });
            }
          }

          if (rollbackSandboxErrors.length > 0 || rollbackReconcilerError) {
            auditResult = "partial";
            const now = nowMs();
            const reason = [
              `rollback sandbox failures=${rollbackSandboxErrors.length}`,
              rollbackReconcilerError ? `reconciler=${rollbackReconcilerError}` : null,
            ]
              .filter(Boolean)
              .join("; ");
            await markRunNeedsAttention(
              input.adapter,
              runId,
              now,
              reason || "Rewind rollback was partial.",
            );
            finalError = new JumpToFrameError(
              "RewindFailed",
              "Rewind failed and rollback was only partial; run needs attention.",
              {
                details: {
                  cause: formatError(error),
                  rollbackSandboxErrors,
                  rollbackReconcilerError,
                },
              },
            );
            await emitLog(input.onLog, "warn", "jumpToFrame rollback partial", {
              runId,
              caller,
              rollbackSandboxErrors,
              rollbackReconcilerError,
            });
          } else {
            finalError =
              error instanceof JumpToFrameError
                ? error
                : new JumpToFrameError("RewindFailed", formatError(error));
          }

          throw finalError;
        }
      },
    );
  } catch (error) {
    if (!finalError) {
      finalError =
        error instanceof JumpToFrameError
          ? error
          : new JumpToFrameError("RewindFailed", formatError(error));
    }
  } finally {
    const durationMs = Math.max(0, nowMs() - startedAtMs);

    // Persist the terminal audit state BEFORE releasing the lock so a second
    // caller cannot beat us to the rate-limit count.
    try {
      if (auditRowId !== null) {
        await updateRewindAuditRow(input.adapter, {
          id: auditRowId,
          result: auditResult,
          durationMs,
          fromFrameNo: fromFrameNoForAudit,
        });
      } else {
        // We threw before reaching the in_progress write (usually validation /
        // lock-busy / rate-limit). Still record the attempt for auditability.
        await writeRewindAuditRow(input.adapter, {
          runId: runIdForAudit,
          fromFrameNo: fromFrameNoForAudit,
          toFrameNo: toFrameNoForAudit,
          caller,
          timestampMs: startedAtMs,
          result: auditResult,
          durationMs,
        });
      }
      await emitLog(input.onLog, "info", "jumpToFrame audit row written", {
        runId: runIdForAudit,
        fromFrameNo: fromFrameNoForAudit,
        toFrameNo: toFrameNoForAudit,
        caller,
        result: auditResult,
      });
    } catch (auditError) {
      await emitLog(input.onLog, "error", "jumpToFrame audit write failed", {
        runId: runIdForAudit,
        fromFrameNo: fromFrameNoForAudit,
        toFrameNo: toFrameNoForAudit,
        caller,
        result: auditResult,
        error: formatError(auditError),
      });
      if (!finalError) {
        finalError = new JumpToFrameError(
          "RewindFailed",
          "Failed to persist rewind audit row.",
        );
      }
    }

    if (lock) {
      lock.release();
    }

    let metricResultTag = "failed";
    if (auditResult === "success") {
      metricResultTag = "success";
    } else if (auditResult === "partial") {
      metricResultTag = "partial";
    } else if (finalError?.code === "Busy") {
      metricResultTag = "busy";
    } else if (finalError?.code === "RateLimited") {
      metricResultTag = "rate_limited";
    }
    try {
      await Effect.runPromise(
        Effect.all([
          Metric.increment(Metric.tagged(rewindTotal, "result", metricResultTag)),
          Metric.update(rewindDurationMs, durationMs),
        ]),
      );
      if (successResult) {
        await Effect.runPromise(
          Effect.all([
            Metric.update(rewindFramesDeleted, successResult.deletedFrames),
            Metric.update(rewindSandboxesReverted, successResult.revertedSandboxes),
          ]),
        );
      }
      if (auditResult === "partial") {
        await Effect.runPromise(Metric.increment(rewindRollbackTotal));
      }
    } catch {
      // metrics failures must never fail the RPC
    }

    // Emit a final `error` log for VcsError/RewindFailed failures so operators
    // always see a crash in the log stream (complementing the partial-rollback
    // and audit-write logs emitted above).
    if (finalError && finalError.code !== "Busy" && finalError.code !== "RateLimited") {
      if (
        finalError.code === "VcsError" ||
        finalError.code === "RewindFailed" ||
        finalError.code === "UnsupportedSandbox"
      ) {
        await emitLog(input.onLog, "error", "jumpToFrame failed", {
          runId: runIdForAudit,
          fromFrameNo: fromFrameNoForAudit,
          toFrameNo: toFrameNoForAudit,
          caller,
          code: finalError.code,
          message: finalError.message,
        });
      }
    }
  }

  if (finalError) {
    throw finalError;
  }

  if (!successResult) {
    throw new JumpToFrameError("RewindFailed", "jumpToFrame completed without a result.");
  }

  return successResult;
}
