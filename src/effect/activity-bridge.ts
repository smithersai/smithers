import * as Activity from "@effect/workflow/Activity";
import * as Workflow from "@effect/workflow/Workflow";
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine";
import { Effect, Layer, Schema, Scope } from "effect";
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
) =>
  Activity.make({
    name: desc.nodeId,
    success: Schema.Unknown,
    error: Schema.Unknown,
    execute: Effect.gen(function* () {
      const attempt = yield* Activity.CurrentAttempt;
      const idempotencyKey = yield* Activity.idempotencyKey(desc.nodeId);
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
): Promise<A> => {
  const engineContext = await getActivityEngineContext();
  const activity = makeTaskActivity(desc, executeFn);
  const instance = WorkflowEngine.WorkflowInstance.initial(
    TaskBridgeWorkflow,
    makeTaskBridgeKey(adapter, workflowName, runId, desc),
  );

  return Effect.runPromise(
    activity.pipe(
      Activity.retry({
        times: desc.retries,
        while: isRetriableTaskFailure,
      }),
      Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
      Effect.provide(engineContext),
    ),
  );
};
