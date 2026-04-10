import { Cause, Duration, Effect, Either, Metric, Schedule } from "effect";
import { z } from "zod";
import type { TaskDescriptor } from "../TaskDescriptor";
import type { SmithersDb } from "../db/adapter";
import { buildOutputRow, stripAutoColumns, validateOutput } from "../db/output";
import { TaskHeartbeatTimeout, TaskTimeout } from "../errors/tagged";
import { EventBus } from "../events";
import { makeAbortError, wireAbortSignal } from "./bridge-utils";
import { withTaskRuntime } from "./task-runtime";
import { logDebug, logError, logInfo, logWarning } from "./logging";
import { attemptDuration, nodeDuration } from "./metrics";
import { runPromise } from "./runtime";
import { errorToJson, fromTaggedError, SmithersError } from "../utils/errors";
import { nowMs } from "../utils/time";
import { getJjPointer } from "../vcs/jj";

const TASK_HEARTBEAT_THROTTLE_MS = 500;
const TASK_HEARTBEAT_MAX_PAYLOAD_BYTES = 1_000_000;
const TASK_HEARTBEAT_TIMEOUT_CHECK_MS = 250;

type ComputeTaskBridgeToolConfig = {
  rootDir: string;
};

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof SmithersError && err.code === "TASK_ABORTED") return true;
  if (
    err &&
    typeof err === "object" &&
    (err as any).code === "TASK_ABORTED"
  ) {
    return true;
  }
  if (fromTaggedError(err)?.code === "TASK_ABORTED") return true;
  if ((err as any).name === "AbortError") return true;
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  ) {
    return true;
  }
  if (err instanceof Error) {
    return /aborted|abort/i.test(err.message);
  }
  return false;
}

function parseAttemptHeartbeatData(
  heartbeatDataJson?: string | null,
): unknown | null {
  if (typeof heartbeatDataJson !== "string" || heartbeatDataJson.length === 0) {
    return null;
  }
  try {
    return JSON.parse(heartbeatDataJson);
  } catch {
    return null;
  }
}

function validateHeartbeatValue(
  value: unknown,
  path: string,
  seen: Set<unknown>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SmithersError(
        "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
        `Heartbeat payload must contain only finite numbers (invalid at ${path}).`,
        { path, value },
      );
    }
    return;
  }
  if (value === undefined) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload cannot include undefined values (invalid at ${path}).`,
      { path },
    );
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload contains a non-JSON value (invalid at ${path}).`,
      { path, valueType: typeof value },
    );
  }
  if (typeof value !== "object") {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload contains an unsupported value at ${path}.`,
      { path },
    );
  }
  if (seen.has(value)) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload cannot contain circular references.",
      { path },
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateHeartbeatValue(value[i], `${path}[${i}]`, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(value instanceof Date)
  ) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload must contain plain JSON objects.",
      { path },
    );
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    validateHeartbeatValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function serializeHeartbeatPayload(data: unknown): {
  heartbeatDataJson: string;
  dataSizeBytes: number;
} {
  validateHeartbeatValue(data, "$", new Set());
  const heartbeatDataJson = JSON.stringify(data);
  const dataSizeBytes = Buffer.byteLength(heartbeatDataJson, "utf8");
  if (dataSizeBytes > TASK_HEARTBEAT_MAX_PAYLOAD_BYTES) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_TOO_LARGE",
      `Heartbeat payload exceeds ${TASK_HEARTBEAT_MAX_PAYLOAD_BYTES} bytes.`,
      {
        dataSizeBytes,
        maxBytes: TASK_HEARTBEAT_MAX_PAYLOAD_BYTES,
      },
    );
  }
  return { heartbeatDataJson, dataSizeBytes };
}

function heartbeatTimeoutReasonFromAbort(
  signal: AbortSignal | undefined,
  err: unknown,
): unknown | null {
  const reason = signal?.aborted ? (signal as any).reason : undefined;
  const candidate = reason ?? err;
  if (
    candidate instanceof TaskHeartbeatTimeout ||
    (candidate instanceof SmithersError &&
      candidate.code === "TASK_HEARTBEAT_TIMEOUT")
  ) {
    return candidate;
  }
  const taggedCandidate = fromTaggedError(candidate);
  if (taggedCandidate?.code === "TASK_HEARTBEAT_TIMEOUT") {
    return taggedCandidate;
  }
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as any).code === "TASK_HEARTBEAT_TIMEOUT"
  ) {
    return new SmithersError(
      "TASK_HEARTBEAT_TIMEOUT",
      String((candidate as any).message ?? "Task heartbeat timed out."),
      (candidate as any).details as Record<string, unknown> | undefined,
      { cause: candidate },
    );
  }
  return null;
}

function isHeartbeatPayloadValidationError(err: unknown): boolean {
  if (err instanceof SmithersError) {
    return (
      err.code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" ||
      err.code === "HEARTBEAT_PAYLOAD_TOO_LARGE"
    );
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as any).code;
  return (
    code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" ||
    code === "HEARTBEAT_PAYLOAD_TOO_LARGE"
  );
}

export const canExecuteBridgeManagedComputeTask = (
  desc: TaskDescriptor,
  cacheEnabled: boolean,
): boolean => {
  if (cacheEnabled || desc.cachePolicy) {
    return false;
  }
  if (desc.agent || !desc.computeFn) {
    return false;
  }
  if (desc.worktreePath) {
    return false;
  }
  return !desc.scorers || Object.keys(desc.scorers).length === 0;
};

export const executeComputeTaskBridge = async (
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  eventBus: EventBus,
  toolConfig: ComputeTaskBridgeToolConfig,
  workflowName: string,
  signal?: AbortSignal,
): Promise<void> => {
  const taskStartMs = performance.now();
  const attempts = await adapter.listAttempts(runId, desc.nodeId, desc.iteration);
  const previousHeartbeat = (() => {
    for (const attempt of attempts) {
      const parsed = parseAttemptHeartbeatData(attempt.heartbeatDataJson);
      if (parsed !== null) return parsed;
    }
    return null;
  })();
  const attemptNo = (attempts[0]?.attempt ?? 0) + 1;
  const taskAbortController = new AbortController();
  const removeAbortForwarder = wireAbortSignal(taskAbortController, signal);
  const taskSignal = taskAbortController.signal;
  const startedAtMs = nowMs();
  let taskCompleted = false;
  let taskExecutionReturned = false;
  let heartbeatClosed = false;
  let heartbeatWriteInFlight = false;
  let heartbeatPendingDataJson: string | null = null;
  let heartbeatPendingDataSizeBytes = 0;
  let heartbeatPendingAtMs = startedAtMs;
  let heartbeatHasPendingWrite = false;
  let heartbeatLastPersistedWriteAtMs = 0;
  let heartbeatLastReceivedAtMs: number | null = null;
  let heartbeatWriteTimer: ReturnType<typeof setTimeout> | undefined;

  const flushHeartbeat = async (force = false): Promise<void> => {
    if (heartbeatClosed || !heartbeatHasPendingWrite || heartbeatWriteInFlight) {
      return;
    }
    const now = nowMs();
    const minNextWriteAt = heartbeatLastPersistedWriteAtMs + TASK_HEARTBEAT_THROTTLE_MS;
    if (!force && now < minNextWriteAt) {
      const waitMs = Math.max(0, minNextWriteAt - now);
      if (!heartbeatWriteTimer) {
        heartbeatWriteTimer = setTimeout(() => {
          heartbeatWriteTimer = undefined;
          void flushHeartbeat();
        }, waitMs);
      }
      return;
    }

    heartbeatHasPendingWrite = false;
    heartbeatWriteInFlight = true;
    const heartbeatAtMs = heartbeatPendingAtMs;
    const heartbeatDataJson = heartbeatPendingDataJson;
    const dataSizeBytes = heartbeatPendingDataSizeBytes;
    const intervalMs =
      heartbeatLastReceivedAtMs == null
        ? null
        : Math.max(0, heartbeatAtMs - heartbeatLastReceivedAtMs);
    heartbeatLastReceivedAtMs = heartbeatAtMs;

    try {
      await adapter.heartbeatAttempt(
        runId,
        desc.nodeId,
        desc.iteration,
        attemptNo,
        heartbeatAtMs,
        heartbeatDataJson,
      );
      heartbeatLastPersistedWriteAtMs = nowMs();
      logDebug(
        "bridge-managed compute task heartbeat recorded",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          dataSizeBytes,
        },
        "heartbeat:record",
      );
      await eventBus.emitEventQueued({
        type: "TaskHeartbeat",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        hasData: heartbeatDataJson !== null,
        dataSizeBytes,
        intervalMs: intervalMs ?? undefined,
        timestampMs: heartbeatAtMs,
      });
    } catch (error) {
      logWarning(
        "failed to persist bridge-managed compute task heartbeat",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: error instanceof Error ? error.message : String(error),
        },
        "heartbeat:record",
      );
    } finally {
      heartbeatWriteInFlight = false;
      if (heartbeatHasPendingWrite && !heartbeatClosed) {
        if (heartbeatWriteTimer) {
          clearTimeout(heartbeatWriteTimer);
          heartbeatWriteTimer = undefined;
        }
        void flushHeartbeat();
      }
    }
  };

  const queueHeartbeat = (
    data: unknown,
    opts?: { internal?: boolean },
  ) => {
    if (
      taskCompleted ||
      heartbeatClosed ||
      (!opts?.internal && taskExecutionReturned)
    ) {
      return;
    }
    const heartbeatAtMs = nowMs();
    let nextHeartbeatDataJson: string | null = null;
    let dataSizeBytes = 0;
    try {
      if (data !== undefined) {
        const serialized = serializeHeartbeatPayload(data);
        nextHeartbeatDataJson = serialized.heartbeatDataJson;
        dataSizeBytes = serialized.dataSizeBytes;
      }
    } catch (error) {
      if (!opts?.internal) {
        throw error;
      }
      logWarning(
        "internal heartbeat payload rejected",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: error instanceof Error ? error.message : String(error),
        },
        "heartbeat:record",
      );
      return;
    }
    heartbeatPendingAtMs = heartbeatAtMs;
    heartbeatPendingDataJson = nextHeartbeatDataJson;
    heartbeatPendingDataSizeBytes = dataSizeBytes;
    heartbeatHasPendingWrite = true;
    if (!heartbeatWriteTimer) {
      void flushHeartbeat();
    }
  };

  const waitForHeartbeatWriteDrain = async () => {
    while (heartbeatWriteInFlight) {
      await Bun.sleep(5);
    }
  };

  const runWithHeartbeatWatchdog = async <A>(
    taskEffect: Effect.Effect<A, unknown>,
  ): Promise<A> => {
    const heartbeatTimeoutMs = desc.heartbeatTimeoutMs;
    if (!heartbeatTimeoutMs) {
      return await runPromise(taskEffect, { signal: taskSignal });
    }

    const checkHeartbeat = Effect.suspend(() => {
      const lastHeartbeatAtMs = Math.max(startedAtMs, heartbeatPendingAtMs);
      const staleForMs = nowMs() - lastHeartbeatAtMs;
      if (staleForMs <= heartbeatTimeoutMs) {
        return Effect.void;
      }

      const timeoutError = new TaskHeartbeatTimeout({
        message: `Task ${desc.nodeId} has not heartbeated in ${staleForMs}ms (timeout: ${heartbeatTimeoutMs}ms).`,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        timeoutMs: heartbeatTimeoutMs,
        staleForMs,
        lastHeartbeatAtMs,
      });
      logWarning(
        "bridge-managed compute task heartbeat timed out",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          timeoutMs: heartbeatTimeoutMs,
          staleForMs,
          lastHeartbeatAtMs,
        },
        "heartbeat:timeout",
      );
      void eventBus.emitEventQueued({
        type: "TaskHeartbeatTimeout",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        lastHeartbeatAtMs,
        timeoutMs: heartbeatTimeoutMs,
        timestampMs: nowMs(),
      });
      taskAbortController.abort(timeoutError);
      return Effect.fail(timeoutError);
    });
    const watchdog = Effect.repeat(
      checkHeartbeat,
      Schedule.spaced(Duration.millis(TASK_HEARTBEAT_TIMEOUT_CHECK_MS)),
    ).pipe(Effect.flatMap(() => Effect.never));
    const raced = await runPromise(
      Effect.race(Effect.either(taskEffect), Effect.either(watchdog)),
      { signal: taskSignal },
    );
    if (Either.isLeft(raced)) {
      throw raced.left;
    }
    return raced.right;
  };

  const attemptMeta: Record<string, unknown> = {
    kind: "compute",
    prompt: desc.prompt ?? null,
    staticPayload: desc.staticPayload ?? null,
    label: desc.label ?? null,
    outputTable: desc.outputTableName,
    needsApproval: desc.needsApproval,
    retries: desc.retries,
    timeoutMs: desc.timeoutMs,
    heartbeatTimeoutMs: desc.heartbeatTimeoutMs,
    lastHeartbeat: previousHeartbeat,
    agentId: null,
    agentModel: null,
    agentEngine: null,
    agentResume: null,
    agentConversation: null,
    resumedFromSession: null,
    resumedFromConversation: false,
    hijackHandoff: null,
  };

  await adapter.withTransaction(
    "task-start",
    Effect.gen(function* () {
      yield* adapter.insertAttemptEffect({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        state: "in-progress",
        startedAtMs,
        finishedAtMs: null,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: null,
        jjCwd: toolConfig.rootDir,
        cached: false,
        metaJson: JSON.stringify(attemptMeta),
      });
      yield* adapter.insertNodeEffect({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "in-progress",
        lastAttempt: attemptNo,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
    }),
  );

  await eventBus.emitEventWithPersist({
    type: "NodeStarted",
    runId,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    attempt: attemptNo,
    timestampMs: nowMs(),
  });

  try {
    if (taskSignal.aborted) {
      throw taskSignal.reason ?? makeAbortError();
    }

    logDebug(
      "bridge-managed compute task execution starting",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        workflowName,
        taskRoot: toolConfig.rootDir,
      },
      "engine:task",
    );

    let computeEffect = Effect.tryPromise({
      try: (effectSignal) => {
        const computeAbortController = new AbortController();
        const removeTaskAbortForwarder = wireAbortSignal(
          computeAbortController,
          taskSignal,
        );
        const forwardEffectAbort = () => {
          computeAbortController.abort(
            effectSignal.reason ?? makeAbortError(),
          );
        };
        if (effectSignal.aborted) {
          forwardEffectAbort();
        } else {
          effectSignal.addEventListener("abort", forwardEffectAbort, {
            once: true,
          });
        }
        return Promise.resolve()
          .then(() =>
            withTaskRuntime(
              {
                runId,
                stepId: desc.nodeId,
                attempt: attemptNo,
                iteration: desc.iteration,
                signal: computeAbortController.signal,
                db,
                heartbeat: (data?: unknown) => {
                  queueHeartbeat(data);
                },
                lastHeartbeat: previousHeartbeat,
              },
              () => desc.computeFn!(),
            ),
          )
          .finally(() => {
            removeTaskAbortForwarder();
            effectSignal.removeEventListener("abort", forwardEffectAbort);
          });
      },
      catch: (error) => error,
    });
    const timeoutMs = desc.timeoutMs;
    if (timeoutMs) {
      computeEffect = computeEffect.pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catchIf(Cause.isTimeoutException, () =>
          Effect.fail(
            new TaskTimeout({
              message: `Compute callback timed out after ${timeoutMs}ms`,
              attempt: attemptNo,
              nodeId: desc.nodeId,
              timeoutMs,
            }),
          ),
        ),
      );
    }

    let payload = await runWithHeartbeatWatchdog(computeEffect);
    payload = stripAutoColumns(payload);
    const payloadWithKeys = buildOutputRow(
      desc.outputTable as any,
      runId,
      desc.nodeId,
      desc.iteration,
      payload,
    );
    let validation = validateOutput(desc.outputTable as any, payloadWithKeys);

    if (validation.ok && desc.outputSchema) {
      const zodResult = (desc.outputSchema as z.ZodType).safeParse(payload);
      if (!zodResult.success) {
        validation = { ok: false, error: zodResult.error };
      }
    }

    if (!validation.ok) {
      attemptMeta.failureRetryable = false;
      throw new SmithersError(
        "INVALID_OUTPUT",
        `Task output failed validation for ${desc.outputTableName}`,
        {
          attempt: attemptNo,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          outputTable: desc.outputTableName,
          issues: validation.error?.issues,
        },
        { cause: validation.error },
      );
    }

    payload = validation.data;
    taskExecutionReturned = true;
    await eventBus.flush();
    const jjPointer = await getJjPointer(toolConfig.rootDir);

    await waitForHeartbeatWriteDrain();
    await flushHeartbeat(true);
    taskCompleted = true;
    const completedAtMs = nowMs();
    await adapter.withTransaction(
      "task-completion",
      Effect.gen(function* () {
        yield* adapter.upsertOutputRowEffect(
          desc.outputTable as any,
          { runId, nodeId: desc.nodeId, iteration: desc.iteration },
          payload as Record<string, unknown>,
        );
        yield* adapter.updateAttemptEffect(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          {
            state: "finished",
            finishedAtMs: completedAtMs,
            jjPointer,
            cached: false,
            metaJson: JSON.stringify(attemptMeta),
            responseText: null,
          },
        );
        yield* adapter.insertNodeEffect({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "finished",
          lastAttempt: attemptNo,
          updatedAtMs: completedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
      }),
    );

    await eventBus.emitEventWithPersist({
      type: "NodeFinished",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      timestampMs: nowMs(),
    });

    const taskElapsedMs = performance.now() - taskStartMs;
    void runPromise(
      Effect.all(
        [
          Metric.update(nodeDuration, taskElapsedMs),
          Metric.update(attemptDuration, taskElapsedMs),
        ],
        { discard: true },
      ),
    );

    logInfo(
      "bridge-managed compute task execution finished",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        durationMs: Math.round(taskElapsedMs),
        jjPointer,
      },
      "engine:task",
    );
  } catch (err) {
    try {
      await eventBus.flush();
    } catch (flushError) {
      logError(
        "failed to flush queued bridge-managed compute task events",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error:
            flushError instanceof Error
              ? flushError.message
              : String(flushError),
        },
        "engine:task-events",
      );
    }

    const heartbeatTimeoutError = heartbeatTimeoutReasonFromAbort(
      taskSignal,
      err,
    );
    const aborted = !heartbeatTimeoutError && (taskSignal.aborted || isAbortError(err));
    const effectiveError =
      heartbeatTimeoutError ??
      (aborted && taskSignal.reason !== undefined
        ? taskSignal.reason
        : aborted
          ? makeAbortError()
          : err);
    if (isHeartbeatPayloadValidationError(effectiveError)) {
      attemptMeta.failureRetryable = false;
    }

    if (aborted) {
      await waitForHeartbeatWriteDrain();
      await flushHeartbeat(true);
      taskCompleted = true;
      const cancelledAtMs = nowMs();
      await adapter.withTransaction(
        "task-cancel",
        Effect.gen(function* () {
          yield* adapter.updateAttemptEffect(
            runId,
            desc.nodeId,
            desc.iteration,
            attemptNo,
            {
              state: "cancelled",
              finishedAtMs: cancelledAtMs,
              errorJson: JSON.stringify(errorToJson(effectiveError)),
              metaJson: JSON.stringify(attemptMeta),
              responseText: null,
            },
          );
          yield* adapter.insertNodeEffect({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "cancelled",
            lastAttempt: attemptNo,
            updatedAtMs: cancelledAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
        }),
      );

      await eventBus.emitEventWithPersist({
        type: "NodeCancelled",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        reason: "aborted",
        timestampMs: nowMs(),
      });

      logInfo(
        "bridge-managed compute task execution cancelled",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error:
            effectiveError instanceof Error
              ? effectiveError.message
              : String(effectiveError),
        },
        "engine:task",
      );
      return;
    }

    await waitForHeartbeatWriteDrain();
    await flushHeartbeat(true);
    taskCompleted = true;
    logError(
      "bridge-managed compute task execution failed",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        maxAttempts: Number.isFinite(desc.retries) ? desc.retries + 1 : "infinite",
        error:
          effectiveError instanceof Error
            ? effectiveError.message
            : String(effectiveError),
      },
      "engine:task",
    );
    const failedAtMs = nowMs();
    await adapter.withTransaction(
      "task-fail",
      Effect.gen(function* () {
        yield* adapter.updateAttemptEffect(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          {
            state: "failed",
            finishedAtMs: failedAtMs,
            errorJson: JSON.stringify(errorToJson(effectiveError)),
            metaJson: JSON.stringify(attemptMeta),
            responseText: null,
          },
        );
        yield* adapter.insertNodeEffect({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "failed",
          lastAttempt: attemptNo,
          updatedAtMs: failedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
      }),
    );

    await eventBus.emitEventWithPersist({
      type: "NodeFailed",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      error: errorToJson(effectiveError),
      timestampMs: nowMs(),
    });

    const updatedAttempts = await adapter.listAttempts(
      runId,
      desc.nodeId,
      desc.iteration,
    );
    if (
      updatedAttempts.filter((attempt: any) => attempt.state === "failed").length <=
      desc.retries
    ) {
      await eventBus.emitEventWithPersist({
        type: "NodeRetrying",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo + 1,
        timestampMs: nowMs(),
      });
    }
  } finally {
    taskCompleted = true;
    heartbeatClosed = true;
    if (heartbeatWriteTimer) {
      clearTimeout(heartbeatWriteTimer);
      heartbeatWriteTimer = undefined;
    }
    removeAbortForwarder();
  }
};
