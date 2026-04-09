import * as SingleRunner from "@effect/cluster/SingleRunner";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Layer, Scope } from "effect";
import {
  fromTaggedErrorPayload,
  toTaggedErrorPayload,
} from "../errors/tagged";
import {
  isUnknownWorkerError,
  isTaskResultFailure,
  type WorkerTaskError,
  type TaskFailure,
  type TaskResult,
  type WorkerTask,
  TaskWorkerEntity,
} from "./entity-worker";

type WorkerExecutionResult = {
  terminal: boolean;
};

type WorkerExecution = {
  task: WorkerTask;
  execute: () => Promise<WorkerExecutionResult>;
};

type TaskWorkerDispatchSubscriber = (task: WorkerTask) => void;

type SingleRunnerRuntime = {
  readonly client: any;
  readonly context: any;
};

const workerExecutions = new Map<string, WorkerExecution>();
const workerErrors = new Map<string, unknown>();
const dispatchSubscribers = new Set<TaskWorkerDispatchSubscriber>();

let singleRunnerRuntimePromise: Promise<SingleRunnerRuntime> | undefined;

function notifyDispatchSubscribers(task: WorkerTask) {
  for (const subscriber of dispatchSubscribers) {
    try {
      subscriber(task);
    } catch {
      // Dispatch observers are best-effort and should not affect execution.
    }
  }
}

function buildMissingExecutionResult(task: WorkerTask): Extract<TaskResult, { _tag: "Failure" }> {
  return {
    _tag: "Failure",
    executionId: task.executionId,
    error: {
      _tag: "UnknownWorkerError",
      errorId: `missing:${task.executionId}`,
      message: `No worker execution registered for ${task.executionId}`,
    },
  };
}

function storeWorkerError(executionId: string, error: unknown): string {
  const errorId = `${executionId}:error`;
  workerErrors.set(errorId, error);
  return errorId;
}

function toWorkerTaskError(executionId: string, error: unknown): WorkerTaskError {
  const taggedError = toTaggedErrorPayload(error);
  if (taggedError) {
    return taggedError;
  }

  return {
    _tag: "UnknownWorkerError",
    errorId: storeWorkerError(executionId, error),
    message: error instanceof Error ? error.message : String(error),
  };
}

function consumeWorkerError(result: TaskFailure): unknown {
  if (!isUnknownWorkerError(result.error)) {
    return fromTaggedErrorPayload(result.error);
  }

  const error = workerErrors.get(result.error.errorId);
  workerErrors.delete(result.error.errorId);
  if (error !== undefined) {
    return error;
  }
  return new Error(result.error.message);
}

async function runRegisteredExecution(task: WorkerTask): Promise<TaskResult> {
  const registered = workerExecutions.get(task.executionId);
  if (!registered) {
    return buildMissingExecutionResult(task);
  }

  try {
    notifyDispatchSubscribers(registered.task);
    const result = await registered.execute();
    return {
      _tag: "Success",
      executionId: task.executionId,
      terminal: result.terminal,
    };
  } catch (error) {
    return {
      _tag: "Failure",
      executionId: task.executionId,
      error: toWorkerTaskError(task.executionId, error),
    };
  } finally {
    if (workerExecutions.get(task.executionId) === registered) {
      workerExecutions.delete(task.executionId);
    }
  }
}

async function buildSingleRunnerRuntime(): Promise<SingleRunnerRuntime> {
  const runnerLayer = SingleRunner.layer({ runnerStorage: "memory" }).pipe(
    Layer.provide(
      Layer.orDie(
        SqliteClient.layer({
          filename: ":memory:",
          disableWAL: true,
        }),
      ),
    ),
  );
  const layer = TaskWorkerEntity.toLayer(
    TaskWorkerEntity.of({
      execute: (request) =>
        Effect.promise(() => runRegisteredExecution(request.payload)),
    }),
    { concurrency: "unbounded" },
  ).pipe(
    Layer.provideMerge(runnerLayer),
  );

  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(layer as any, scope),
  );
  const client = await Effect.runPromise(
    (TaskWorkerEntity.client as any).pipe(Effect.provide(context)),
  );

  return {
    client: client as any,
    context,
  };
}

async function getSingleRunnerRuntime(): Promise<SingleRunnerRuntime> {
  if (!singleRunnerRuntimePromise) {
    singleRunnerRuntimePromise = buildSingleRunnerRuntime().catch((error) => {
      singleRunnerRuntimePromise = undefined;
      throw error;
    });
  }
  return singleRunnerRuntimePromise;
}

export async function dispatchWorkerTask(
  task: WorkerTask,
  execute: () => Promise<WorkerExecutionResult>,
): Promise<WorkerExecutionResult> {
  const runtime = await getSingleRunnerRuntime();
  const registered: WorkerExecution = {
    task,
    execute,
  };

  workerExecutions.set(task.executionId, registered);

  try {
    const result = await Effect.runPromise(
      (runtime.client(task.bridgeKey).execute(task) as any).pipe(
        Effect.provide(runtime.context),
      ),
    ) as TaskResult;

    if (isTaskResultFailure(result)) {
      throw consumeWorkerError(result);
    }

    return {
      terminal: result.terminal,
    };
  } finally {
    if (workerExecutions.get(task.executionId) === registered) {
      workerExecutions.delete(task.executionId);
    }
  }
}

export function subscribeTaskWorkerDispatches(
  subscriber: TaskWorkerDispatchSubscriber,
): () => void {
  dispatchSubscribers.add(subscriber);
  return () => {
    dispatchSubscribers.delete(subscriber);
  };
}
