import * as Activity from "@effect/workflow/Activity";
import { Effect, Schema } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";

const adapterNamespaces = new WeakMap<object, string>();
const completedActivityResults = new Map<string, unknown>();
let nextAdapterNamespace = 0;

const getAdapterNamespace = (adapter: SmithersDb): string => {
  const existing = adapterNamespaces.get(adapter);
  if (existing) {
    return existing;
  }
  const created = `adapter-${++nextAdapterNamespace}`;
  adapterNamespaces.set(adapter, created);
  return created;
};

export type TaskActivityContext = {
  attempt: number;
  idempotencyKey: string;
};

export type TaskActivityRetryOptions = {
  times: number;
  while?: (error: unknown) => boolean;
};

export type ExecuteTaskActivityOptions = {
  initialAttempt?: number;
  retry?: false | TaskActivityRetryOptions;
  includeAttemptInIdempotencyKey?: boolean;
};

export class RetriableTaskFailure extends Error {
  readonly nodeId: string;
  readonly attempt: number;

  constructor(nodeId: string, attempt: number) {
    super(`Task ${nodeId} failed on attempt ${attempt} and should be retried`);
    this.name = "RetriableTaskFailure";
    this.nodeId = nodeId;
    this.attempt = attempt;
  }
}

const isRetriableTaskFailure = (
  error: unknown,
): error is RetriableTaskFailure => error instanceof RetriableTaskFailure;

export const makeTaskBridgeKey = (
  adapter: SmithersDb,
  workflowName: string,
  runId: string,
  desc: TaskDescriptor,
): string =>
  [
    "smithers-task-bridge",
    getAdapterNamespace(adapter),
    workflowName,
    runId,
    desc.nodeId,
    String(desc.iteration),
  ].join(":");

const makeActivityIdempotencyKey = (
  adapter: SmithersDb,
  workflowName: string,
  runId: string,
  desc: TaskDescriptor,
  attempt: number,
  includeAttempt?: boolean,
): string => {
  const base = makeTaskBridgeKey(adapter, workflowName, runId, desc);
  return includeAttempt ? `${base}:attempt:${attempt}` : base;
};

export const makeTaskActivity = <A>(
  desc: TaskDescriptor,
  executeFn: (context: TaskActivityContext) => Promise<A> | A,
  options?: Pick<ExecuteTaskActivityOptions, "includeAttemptInIdempotencyKey">,
) =>
  Activity.make({
    name: desc.nodeId,
    success: Schema.Unknown,
    error: Schema.Unknown,
    execute: Effect.gen(function* () {
      const attempt = yield* Activity.CurrentAttempt;
      const idempotencyKey = yield* Activity.idempotencyKey(desc.nodeId, {
        includeAttempt: options?.includeAttemptInIdempotencyKey,
      });
      return yield* Effect.tryPromise({
        try: () => Promise.resolve(executeFn({ attempt, idempotencyKey })),
        catch: (error) => error,
      });
    }),
  });

export const executeTaskActivity = async <A>(
  adapter: SmithersDb,
  workflowName: string,
  runId: string,
  desc: TaskDescriptor,
  executeFn: (context: TaskActivityContext) => Promise<A> | A,
  options?: ExecuteTaskActivityOptions,
): Promise<A> => {
  const initialAttempt = Math.max(1, options?.initialAttempt ?? 1);
  const retry = options?.retry === undefined
    ? { times: desc.retries, while: isRetriableTaskFailure }
    : options.retry;

  let attempt = initialAttempt;
  while (true) {
    const idempotencyKey = makeActivityIdempotencyKey(
      adapter,
      workflowName,
      runId,
      desc,
      attempt,
      options?.includeAttemptInIdempotencyKey,
    );
    if (completedActivityResults.has(idempotencyKey)) {
      return completedActivityResults.get(idempotencyKey) as A;
    }

    try {
      const result = await Promise.resolve(executeFn({ attempt, idempotencyKey }));
      completedActivityResults.set(idempotencyKey, result);
      return result;
    } catch (error) {
      if (
        retry === false ||
        attempt - initialAttempt >= retry.times ||
        !(retry.while ?? isRetriableTaskFailure)(error)
      ) {
        throw error;
      }
      attempt += 1;
    }
  }
};
