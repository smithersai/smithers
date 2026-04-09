import * as Activity from "@effect/workflow/Activity";
import * as Workflow from "@effect/workflow/Workflow";
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine";
import { Cause, Effect, Exit, Layer, Schema, Scope } from "effect";
import type { SmithersDb } from "../db/adapter";
import type { TaskDescriptor } from "../TaskDescriptor";

const TaskBridgeWorkflow = Workflow.make({
  name: "SmithersTaskBridge",
  payload: { executionId: Schema.String },
  success: Schema.Unknown,
  idempotencyKey: ({ executionId }) => executionId,
});

const adapterNamespaces = new WeakMap<object, string>();
let nextAdapterNamespace = 0;

let activityEngineScope: Scope.CloseableScope | undefined;
let activityEngineContextPromise: Promise<any> | undefined;

const getAdapterNamespace = (adapter: SmithersDb): string => {
  const existing = adapterNamespaces.get(adapter);
  if (existing) {
    return existing;
  }
  const created = `adapter-${++nextAdapterNamespace}`;
  adapterNamespaces.set(adapter, created);
  return created;
};

const buildActivityEngineContext = async () => {
  activityEngineScope = await Effect.runPromise(Scope.make());
  return Effect.runPromise(
    Layer.buildWithScope(WorkflowEngine.layerMemory, activityEngineScope),
  );
};

const getActivityEngineContext = async () => {
  if (!activityEngineContextPromise) {
    activityEngineContextPromise = buildActivityEngineContext().catch((error) => {
      activityEngineContextPromise = undefined;
      activityEngineScope = undefined;
      throw error;
    });
  }
  return activityEngineContextPromise;
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

const runTaskActivityAttempt = async <A>(
  engineContext: any,
  activity: ReturnType<typeof makeTaskActivity<A>>,
  instance: WorkflowEngine.WorkflowInstance["Type"],
  attempt: number,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    activity.pipe(
      Effect.provideService(Activity.CurrentAttempt, attempt),
      Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
      Effect.provide(engineContext),
    ) as Effect.Effect<A, unknown, never>,
  );

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    throw failure.value;
  }
  throw Cause.squash(exit.cause);
};

export const executeTaskActivity = async <A>(
  adapter: SmithersDb,
  workflowName: string,
  runId: string,
  desc: TaskDescriptor,
  executeFn: (context: TaskActivityContext) => Promise<A> | A,
  options?: ExecuteTaskActivityOptions,
): Promise<A> => {
  const engineContext = await getActivityEngineContext();
  const activity = makeTaskActivity(desc, executeFn, options);
  const instance = WorkflowEngine.WorkflowInstance.initial(
    TaskBridgeWorkflow,
    makeTaskBridgeKey(adapter, workflowName, runId, desc),
  );
  const initialAttempt = Math.max(1, options?.initialAttempt ?? 1);
  const retry = options?.retry === undefined
    ? { times: desc.retries, while: isRetriableTaskFailure }
    : options.retry;

  let attempt = initialAttempt;
  while (true) {
    try {
      return await runTaskActivityAttempt(engineContext, activity, instance, attempt);
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
