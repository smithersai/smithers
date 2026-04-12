import * as SingleRunner from "@effect/cluster/SingleRunner";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Layer, Scope } from "effect";
import { fromTaggedErrorPayload } from "@smithers/errors/fromTaggedErrorPayload";
import { toTaggedErrorPayload } from "@smithers/errors/toTaggedErrorPayload";
import { isUnknownWorkerError, isTaskResultFailure, TaskWorkerEntity, } from "./entity-worker.js";
/**
 * @typedef {(task: WorkerTask) => void} TaskWorkerDispatchSubscriber
 */
/**
 * @typedef {{ terminal: boolean; }} WorkerExecutionResult
 */
/** @typedef {import("./entity-worker.ts").WorkerTask} WorkerTask */

const workerExecutions = new Map();
const workerErrors = new Map();
const dispatchSubscribers = new Set();
let singleRunnerRuntimePromise;
/**
 * @param {WorkerTask} task
 */
function notifyDispatchSubscribers(task) {
    for (const subscriber of dispatchSubscribers) {
        try {
            subscriber(task);
        }
        catch {
            // Dispatch observers are best-effort and should not affect execution.
        }
    }
}
/**
 * @param {WorkerTask} task
 * @returns {Extract<TaskResult, { _tag: "Failure" }>}
 */
function buildMissingExecutionResult(task) {
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
/**
 * @param {string} executionId
 * @param {unknown} error
 * @returns {string}
 */
function storeWorkerError(executionId, error) {
    const errorId = `${executionId}:error`;
    workerErrors.set(errorId, error);
    return errorId;
}
/**
 * @param {string} executionId
 * @param {unknown} error
 * @returns {WorkerTaskError}
 */
function toWorkerTaskError(executionId, error) {
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
/**
 * @param {TaskFailure} result
 * @returns {unknown}
 */
function consumeWorkerError(result) {
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
/**
 * @param {WorkerTask} task
 * @returns {Promise<TaskResult>}
 */
async function runRegisteredExecution(task) {
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
    }
    catch (error) {
        return {
            _tag: "Failure",
            executionId: task.executionId,
            error: toWorkerTaskError(task.executionId, error),
        };
    }
    finally {
        if (workerExecutions.get(task.executionId) === registered) {
            workerExecutions.delete(task.executionId);
        }
    }
}
/**
 * @returns {Promise<SingleRunnerRuntime>}
 */
async function buildSingleRunnerRuntime() {
    const runnerLayer = SingleRunner.layer({ runnerStorage: "memory" }).pipe(Layer.provide(Layer.orDie(SqliteClient.layer({
        filename: ":memory:",
        disableWAL: true,
    }))));
    const layer = TaskWorkerEntity.toLayer(TaskWorkerEntity.of({
        execute: (request) => Effect.promise(() => runRegisteredExecution(request.payload)),
    }), { concurrency: "unbounded" }).pipe(Layer.provideMerge(runnerLayer));
    const scope = await Effect.runPromise(Scope.make());
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    const client = await Effect.runPromise(TaskWorkerEntity.client.pipe(Effect.provide(context)));
    return {
        client: client,
        context,
    };
}
/**
 * @returns {Promise<SingleRunnerRuntime>}
 */
async function getSingleRunnerRuntime() {
    if (!singleRunnerRuntimePromise) {
        singleRunnerRuntimePromise = buildSingleRunnerRuntime().catch((error) => {
            singleRunnerRuntimePromise = undefined;
            throw error;
        });
    }
    return singleRunnerRuntimePromise;
}
/**
 * @param {WorkerTask} task
 * @param {() => Promise<WorkerExecutionResult>} execute
 * @returns {Promise<WorkerExecutionResult>}
 */
export async function dispatchWorkerTask(task, execute) {
    const runtime = await getSingleRunnerRuntime();
    const registered = {
        task,
        execute,
    };
    workerExecutions.set(task.executionId, registered);
    try {
        const result = await Effect.runPromise(runtime.client(task.bridgeKey).execute(task).pipe(Effect.provide(runtime.context)));
        if (isTaskResultFailure(result)) {
            throw consumeWorkerError(result);
        }
        return {
            terminal: result.terminal,
        };
    }
    finally {
        if (workerExecutions.get(task.executionId) === registered) {
            workerExecutions.delete(task.executionId);
        }
    }
}
/**
 * @param {TaskWorkerDispatchSubscriber} subscriber
 * @returns {() => void}
 */
export function subscribeTaskWorkerDispatches(subscriber) {
    dispatchSubscribers.add(subscriber);
    return () => {
        dispatchSubscribers.delete(subscriber);
    };
}
