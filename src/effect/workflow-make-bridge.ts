import * as Workflow from "@effect/workflow/Workflow";
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { AsyncLocalStorage } from "node:async_hooks";
import { SmithersDb } from "../db/adapter";
import type { RunOptions } from "../RunOptions";
import type { RunResult } from "../RunResult";
import type { SmithersWorkflow } from "../SmithersWorkflow";

type RunBodyResult = RunResult | (RunResult & { status: "continued"; nextRunId: string });

type RunBodyExecutor = <Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
) => Promise<RunBodyResult>;

type WorkflowMakeBridgeRuntime = {
  readonly engineContext: any;
  readonly scope: Scope.CloseableScope;
  readonly parentInstance: WorkflowEngine.WorkflowInstance["Type"];
  readonly executeBody: RunBodyExecutor;
  executeChildWorkflow: <Schema>(
    workflow: SmithersWorkflow<Schema>,
    opts: RunOptions & { runId: string },
  ) => Promise<RunResult>;
};

type SchedulerWakeQueue = {
  notify(): void;
  wait(): Promise<void>;
};

const runtimeStorage = new AsyncLocalStorage<WorkflowMakeBridgeRuntime>();
const workflowNamespaces = new WeakMap<object, string>();
let nextWorkflowNamespace = 0;

function getWorkflowNamespace(workflow: SmithersWorkflow<any>): string {
  const existing = workflowNamespaces.get(workflow as object);
  if (existing) {
    return existing;
  }
  const created = `workflow-${++nextWorkflowNamespace}`;
  workflowNamespaces.set(workflow as object, created);
  return created;
}

function makeBridgeWorkflow(
  workflow: SmithersWorkflow<any>,
  runId: string,
) {
  return Workflow.make({
    name: `SmithersWorkflowBridge:${getWorkflowNamespace(workflow)}:${runId}`,
    payload: {
      executionId: Schema.String,
    },
    success: Schema.Unknown,
    idempotencyKey: ({ executionId }) => executionId,
  });
}

function isSuspendingStatus(
  status: RunResult["status"] | "continued",
): status is "waiting-approval" | "waiting-event" | "waiting-timer" {
  return (
    status === "waiting-approval" ||
    status === "waiting-event" ||
    status === "waiting-timer"
  );
}

async function registerBridgeWorkflow(
  workflowBridge: ReturnType<typeof makeBridgeWorkflow>,
  scope: Scope.CloseableScope,
  engineContext: any,
  execute: Effect.Effect<RunResult, unknown, any>,
) {
  await Effect.runPromise(
    (Layer.buildWithScope(
      workflowBridge.toLayer(() => execute as any),
      scope,
    ) as any).pipe(Effect.provide(engineContext)) as any,
  );
}

async function executeRegisteredChildWorkflow(
  workflowBridge: ReturnType<typeof makeBridgeWorkflow>,
  runId: string,
  scope: Scope.CloseableScope,
  engineContext: any,
  parentInstance: WorkflowMakeBridgeRuntime["parentInstance"],
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      return yield* engine.execute(workflowBridge, {
        executionId: runId,
        payload: { executionId: runId },
      });
    }).pipe(
      Effect.provideService(
        WorkflowEngine.WorkflowInstance,
        parentInstance,
      ),
      Effect.provideService(Scope.Scope, scope as any),
      Effect.provide(engineContext),
    ) as any,
  ) as Promise<RunResult>;
}

function createWorkflowExecutionEffect<Schema>(
  workflow: SmithersWorkflow<Schema>,
  initialOpts: RunOptions & { runId: string },
  services: Omit<WorkflowMakeBridgeRuntime, "parentInstance" | "executeChildWorkflow">,
  lastRunIdRef: { current: string },
) {
  return Effect.gen(function* () {
    const instance = yield* WorkflowEngine.WorkflowInstance;
    const runtime = createWorkflowMakeBridgeRuntime({
      ...services,
      parentInstance: instance,
    });
    let nextOpts = initialOpts;

    while (true) {
      lastRunIdRef.current = nextOpts.runId;
      const result = yield* Effect.tryPromise({
        try: () =>
          withWorkflowMakeBridgeRuntime(runtime, () =>
            services.executeBody(workflow, nextOpts),
          ),
        catch: (error) => error,
      });
      lastRunIdRef.current = result.runId;

      if (isSuspendingStatus(result.status)) {
        return yield* Workflow.suspend(instance);
      }

      if (result.status !== "continued" || !(result as any).nextRunId) {
        return result as RunResult;
      }

      nextOpts = {
        ...nextOpts,
        runId: (result as any).nextRunId,
        resume: true,
      };
    }
  });
}

function createWorkflowMakeBridgeRuntime(
  services: Omit<WorkflowMakeBridgeRuntime, "executeChildWorkflow">,
): WorkflowMakeBridgeRuntime {
  return {
    ...services,
    executeChildWorkflow: async <Schema>(
      workflow: SmithersWorkflow<Schema>,
      opts: RunOptions & { runId: string },
    ): Promise<RunResult> => {
      const workflowBridge = makeBridgeWorkflow(workflow, opts.runId);
      const lastRunIdRef = { current: opts.runId };
      const execute = createWorkflowExecutionEffect(
        workflow,
        opts,
        services,
        lastRunIdRef,
      );

      await registerBridgeWorkflow(
        workflowBridge,
        services.scope,
        services.engineContext,
        execute as any,
      );

      return executeRegisteredChildWorkflow(
        workflowBridge,
        opts.runId,
        services.scope,
        services.engineContext,
        services.parentInstance,
      );
    },
  };
}

export function withWorkflowMakeBridgeRuntime<T>(
  runtime: WorkflowMakeBridgeRuntime,
  execute: () => T,
): T {
  return runtimeStorage.run(runtime, execute);
}

export function getWorkflowMakeBridgeRuntime():
  | WorkflowMakeBridgeRuntime
  | undefined {
  return runtimeStorage.getStore();
}

export function createSchedulerWakeQueue(): SchedulerWakeQueue {
  let pending = 0;
  let resolver: (() => void) | null = null;

  return {
    notify() {
      if (resolver) {
        const current = resolver;
        resolver = null;
        current();
        return;
      }
      pending += 1;
    },
    wait() {
      if (pending > 0) {
        pending -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        resolver = () => {
          if (pending > 0) {
            pending -= 1;
          }
          resolve();
        };
      });
    },
  };
}

export async function runWorkflowWithMakeBridge<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions & { runId: string },
  executeBody: RunBodyExecutor,
): Promise<RunResult> {
  const adapter = new SmithersDb(workflow.db as any);
  const scope = await Effect.runPromise(Scope.make());
  let closed = false;

  try {
    const engineContext = await Effect.runPromise(
      Layer.buildWithScope(WorkflowEngine.layerMemory, scope),
    );
    const workflowBridge = makeBridgeWorkflow(workflow, opts.runId);
    const instance = WorkflowEngine.WorkflowInstance.initial(
      workflowBridge,
      opts.runId,
    );
    const lastRunIdRef = { current: opts.runId };
    const execute = createWorkflowExecutionEffect(
      workflow,
      opts,
      {
        engineContext,
        scope,
        executeBody,
      },
      lastRunIdRef,
    );

    await registerBridgeWorkflow(
      workflowBridge,
      scope,
      engineContext,
      execute as any,
    );

    const result = await Effect.runPromise(
      execute.pipe(
        Workflow.intoResult,
        Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
        Effect.provide(engineContext),
      ) as any,
    ) as Workflow.Result<RunResult, unknown>;

    if (result._tag === "Complete") {
      if (Exit.isSuccess(result.exit)) {
        return result.exit.value as RunResult;
      }
      throw result.exit;
    }

    const run = await adapter.getRun(lastRunIdRef.current);
    const status =
      run?.status === "waiting-approval" ||
      run?.status === "waiting-event" ||
      run?.status === "waiting-timer"
        ? run.status
        : "cancelled";
    return {
      runId: lastRunIdRef.current,
      status,
    };
  } finally {
    if (!closed) {
      closed = true;
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }
}
