import type { RunOptions } from "./RunOptions.ts";
import type {
  EngineDecision,
  RenderContext,
  RunResult,
  TaskOutput,
  WaitReason,
} from "@smithers/scheduler";
import type { CreateWorkflowSession } from "./CreateWorkflowSession.ts";
import type { SchedulerWaitHandler } from "./SchedulerWaitHandler.ts";
import type { TaskExecutor } from "./TaskExecutor.ts";
import type { TaskExecutorContext } from "./TaskExecutorContext.ts";
import type { WaitHandler } from "./WaitHandler.ts";
import type { ContinueAsNewHandler } from "./ContinueAsNewHandler.ts";
import type { WorkflowRuntime } from "./WorkflowRuntime.ts";
import type { WorkflowSession } from "./WorkflowSession.ts";
import type { WorkflowGraph, TaskDescriptor } from "@smithers/graph";
import { buildContext } from "./buildContext.ts";
import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { WorkflowDriverOptions } from "./WorkflowDriverOptions.ts";
import type { WorkflowGraphRenderer } from "./WorkflowGraphRenderer.ts";
import type { WorkflowDefinition } from "./WorkflowDefinition.ts";
import { defaultTaskExecutor } from "./defaultTaskExecutor.ts";
import { withAbort } from "./withAbort.ts";

const SCHEDULER_SPECIFIER = "@smithers/scheduler";
const LOCAL_SCHEDULER_SPECIFIER = "../../scheduler/src/index.ts";

function createRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isEngineDecision(value: unknown): value is EngineDecision {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { _tag?: unknown })._tag === "string";
}

function isRunResult(value: unknown): value is RunResult {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string";
}

function isWorkflowSession(value: unknown): value is WorkflowSession {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as WorkflowSession).submitGraph === "function" &&
      typeof (value as WorkflowSession).taskCompleted === "function" &&
      typeof (value as WorkflowSession).taskFailed === "function",
  );
}

function recordFromIterations(
  iterations?: Record<string, number> | ReadonlyMap<string, number>,
): Record<string, number> | undefined {
  if (!iterations) return undefined;
  if (typeof (iterations as ReadonlyMap<string, number>).entries === "function") {
    return Object.fromEntries(iterations as ReadonlyMap<string, number>);
  }
  return iterations as Record<string, number>;
}

function snapshotFromContext(
  context: RenderContext,
  knownOutputTables?: ReadonlyMap<string, string>,
): OutputSnapshot {
  const outputs = context.outputs;
  if (!outputs) return {};
  if (typeof (outputs as ReadonlyMap<string, unknown>).values !== "function") {
    return normalizeOutputSnapshot(outputs);
  }

  const outputMap = outputs as ReadonlyMap<string, TaskOutput>;
  const descriptors = new Map<string, { outputTableName?: string }>();
  for (const [nodeId, outputTableName] of knownOutputTables ?? []) {
    descriptors.set(nodeId, { outputTableName });
  }
  for (const task of context.graph?.tasks ?? []) {
    descriptors.set(task.nodeId, { outputTableName: task.outputTableName });
  }

  const snapshot: OutputSnapshot = {};
  for (const output of outputMap.values()) {
    const tableName = descriptors.get(output.nodeId)?.outputTableName;
    if (!tableName) continue;
    const row =
      output.output && typeof output.output === "object" && !Array.isArray(output.output)
        ? {
            ...(output.output as Record<string, unknown>),
            nodeId: output.nodeId,
            iteration: output.iteration,
          }
        : {
            nodeId: output.nodeId,
            iteration: output.iteration,
            payload: output.output,
          };
    (snapshot[tableName] ??= []).push(row);
  }
  return snapshot;
}

function normalizeOutputSnapshot(value: unknown): OutputSnapshot {
  if (!value || typeof value !== "object") return {};
  const snapshot: OutputSnapshot = {};
  for (const [key, rows] of Object.entries(value as Record<string, unknown>)) {
    snapshot[key] = Array.isArray(rows) ? rows : [];
  }
  return snapshot;
}

function mergeOutputSnapshots(base: OutputSnapshot, live: OutputSnapshot): OutputSnapshot {
  const merged: OutputSnapshot = {};
  for (const [key, rows] of Object.entries(base)) {
    merged[key] = [...rows];
  }
  for (const [key, rows] of Object.entries(live)) {
    merged[key] = [...(merged[key] ?? []), ...rows];
  }
  return merged;
}

async function loadCreateSession(): Promise<CreateWorkflowSession | null> {
  for (const specifier of [SCHEDULER_SPECIFIER, LOCAL_SCHEDULER_SPECIFIER]) {
    let mod: {
      createSession?: CreateWorkflowSession;
      makeWorkflowSession?: CreateWorkflowSession;
    };
    try {
      mod = (await import(specifier)) as typeof mod;
    } catch {
      continue;
    }
    if (typeof mod.createSession === "function") return mod.createSession;
    if (typeof mod.makeWorkflowSession === "function") {
      return mod.makeWorkflowSession;
    }
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      ("name" in error || "message" in error) &&
      (/abort/i.test(String((error as { name?: unknown }).name ?? "")) ||
        /abort/i.test(String((error as { message?: unknown }).message ?? ""))),
  );
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const error = new Error("Task aborted");
    error.name = "AbortError";
    throw error;
  }
  if (ms <= 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const sleep = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
  });
  try {
    await withAbort(sleep, signal);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class WorkflowDriver<Schema = unknown, Element = unknown> {
  private readonly workflow: WorkflowDriverOptions<Schema, Element>["workflow"];
  private readonly runtime: WorkflowRuntime;
  private readonly db?: unknown;
  private readonly configuredRunId?: string;
  private readonly rootDir?: string;
  private readonly workflowPath?: string | null;
  private readonly executeTask: TaskExecutor;
  private readonly onSchedulerWait?: SchedulerWaitHandler;
  private readonly onWait?: WaitHandler;
  private readonly continueAsNewHandler?: ContinueAsNewHandler;
  private readonly createSession?: CreateWorkflowSession;
  private readonly renderer: WorkflowGraphRenderer<Element>;

  private session?: WorkflowSession;
  private activeRunId = "";
  private activeOptions?: RunOptions;
  private lastGraph?: WorkflowGraph;
  private readonly outputTablesByNodeId = new Map<string, string>();
  private baseOutputs: OutputSnapshot = {};

  constructor(options: WorkflowDriverOptions<Schema, Element>) {
    this.workflow = options.workflow;
    this.runtime = options.runtime;
    this.db = options.db ?? options.workflow.db;
    this.configuredRunId = options.runId;
    this.rootDir = options.rootDir;
    this.workflowPath = options.workflowPath;
    this.session = options.session;
    this.createSession = options.createSession;
    this.executeTask = options.executeTask ?? defaultTaskExecutor;
    this.onSchedulerWait = options.onSchedulerWait;
    this.onWait = options.onWait;
    this.continueAsNewHandler = options.continueAsNew;
    this.renderer = options.renderer;
  }

  async run(options: RunOptions): Promise<RunResult> {
    const runId = options.runId ?? this.configuredRunId ?? createRunId();
    this.activeRunId = runId;
    this.activeOptions = options;
    this.baseOutputs = normalizeOutputSnapshot(
      (options as any).initialOutputs ?? (options as any).outputs,
    );
    this.session = this.session ?? (await this.initializeSession(runId, options));
    if (options.signal?.aborted) {
      return this.cancelRun();
    }

    const initialIterations = recordFromIterations(
      (options as any).initialIterations ??
        (options as any).iterations ??
        (options as any).ralphIterations,
    );
    let decision = await this.renderAndSubmit({
      runId,
      iteration:
        typeof (options as any).initialIteration === "number"
          ? (options as any).initialIteration
          : typeof (options as any).iteration === "number"
            ? (options as any).iteration
            : 0,
      iterations: initialIterations ?? {},
      input: options.input,
      outputs: {},
      auth: options.auth ?? null,
    });

    while (true) {
      if (this.activeOptions?.signal?.aborted) {
        return this.cancelRun();
      }
      switch (decision._tag) {
        case "Execute": {
          const next = await this.executeTasks(decision.tasks);
          if (isRunResult(next)) return next;
          decision = next;
          break;
        }
        case "ReRender":
          decision = await this.renderAndSubmit(decision.context);
          break;
        case "Wait": {
          const next = await this.handleWait(decision.reason);
          if (isRunResult(next)) return next;
          decision = next;
          break;
        }
        case "ContinueAsNew":
          return this.continueAsNew(decision.transition);
        case "Finished":
          return decision.result;
        case "Failed":
          return { runId, status: "failed", error: decision.error };
        default:
          return {
            runId,
            status: "failed",
            error: new Error(`Unknown engine decision: ${String((decision as any)?._tag)}`),
          };
      }
    }
  }

  private async initializeSession(
    runId: string,
    options: RunOptions,
  ): Promise<WorkflowSession> {
    const createSession = this.createSession ?? (await loadCreateSession());
    if (!createSession) {
      throw new Error(
        "WorkflowDriver requires a WorkflowSession or createSession from @smithers/scheduler.",
      );
    }
    const created = createSession({
      db: this.db,
      runId,
      rootDir: options.rootDir ?? this.rootDir,
      workflowPath: options.workflowPath ?? this.workflowPath ?? null,
      options,
    });
    if (isWorkflowSession(created)) {
      return created;
    }
    return this.runEffect<WorkflowSession>(created);
  }

  private async renderAndSubmit(context: RenderContext): Promise<EngineDecision> {
    if (!this.session) {
      throw new Error("WorkflowSession is not initialized.");
    }
    const iteration = typeof context.iteration === "number" ? context.iteration : 0;
    const iterations = recordFromIterations(
      context.iterations ?? context.ralphIterations,
    );
    const ctx = buildContext<Schema>({
      runId: context.runId,
      iteration,
      iterations,
      input: context.input ?? this.activeOptions?.input ?? {},
      auth: context.auth as any,
      outputs: mergeOutputSnapshots(
        this.baseOutputs,
        snapshotFromContext(context, this.outputTablesByNodeId),
      ),
      zodToKeyName: this.workflow.zodToKeyName,
      runtimeConfig: this.activeOptions?.cliAgentToolsDefault
        ? { cliAgentToolsDefault: this.activeOptions.cliAgentToolsDefault }
        : undefined,
    });
    const graph = await this.renderer.render(this.workflow.build(ctx), {
      ralphIterations: context.iterations ?? context.ralphIterations,
      defaultIteration: iteration,
      baseRootDir: this.activeOptions?.rootDir ?? this.rootDir,
      workflowPath: this.activeOptions?.workflowPath ?? this.workflowPath ?? null,
    });
    for (const task of graph.tasks) {
      if (task.outputTableName) {
        this.outputTablesByNodeId.set(task.nodeId, task.outputTableName);
      }
    }
    this.lastGraph = graph;
    return this.runEffect<EngineDecision>(this.session.submitGraph(graph));
  }

  private async executeTasks(
    tasks: readonly TaskDescriptor[],
  ): Promise<EngineDecision | RunResult> {
    if (!this.session) {
      throw new Error("WorkflowSession is not initialized.");
    }
    const context: TaskExecutorContext = {
      runId: this.activeRunId,
      options: this.activeOptions ?? { input: {} },
      signal: this.activeOptions?.signal,
    };
    if (context.signal?.aborted) {
      return this.cancelRun();
    }

    let latestDecision: EngineDecision | undefined;
    let cancelled = false;
    const waitStart = performance.now();
    try {
      await Promise.all(
        tasks.map(async (task) => {
          let report: unknown;
          try {
            const output = await withAbort(
              Promise.resolve().then(() => this.executeTask(task, context)),
              context.signal,
            );
            report = await this.runEffect<unknown>(
              this.session!.taskCompleted({
                nodeId: task.nodeId,
                iteration: task.iteration,
                output,
              }),
            );
          } catch (error) {
            if (context.signal?.aborted || isAbortError(error)) {
              cancelled = true;
              return;
            }
            report = await this.runEffect<unknown>(
              this.session!.taskFailed({
                nodeId: task.nodeId,
                iteration: task.iteration,
                error,
              }),
            );
          }
          if (isEngineDecision(report)) {
            latestDecision = report;
          }
        }),
      );
    } finally {
      await this.onSchedulerWait?.(performance.now() - waitStart, {
        runId: this.activeRunId,
        tasks,
      });
    }
    if (cancelled || context.signal?.aborted) {
      return this.cancelRun();
    }
    if (latestDecision) {
      return latestDecision;
    }
    if (typeof this.session.getNextDecision === "function") {
      return this.runEffect<EngineDecision>(this.session.getNextDecision());
    }
    throw new Error("WorkflowSession did not provide the next EngineDecision.");
  }

  private async handleWait(reason: WaitReason): Promise<EngineDecision | RunResult> {
    if (this.onWait) {
      return this.onWait(reason, {
        runId: this.activeRunId,
        options: this.activeOptions ?? { input: {} },
      });
    }

    switch (reason._tag) {
      case "Approval":
        return { runId: this.activeRunId, status: "waiting-approval" };
      case "Event":
      case "ExternalTrigger":
      case "HotReload":
      case "OrphanRecovery":
        return { runId: this.activeRunId, status: "waiting-event" };
      case "Timer":
        return { runId: this.activeRunId, status: "waiting-timer" };
      case "RetryBackoff": {
        await sleepWithAbort(reason.waitMs, this.activeOptions?.signal);
        if (this.activeOptions?.signal?.aborted) {
          return this.cancelRun();
        }
        if (this.session && typeof this.session.getNextDecision === "function") {
          return this.runEffect<EngineDecision>(this.session.getNextDecision());
        }
        if (this.session && this.lastGraph) {
          return this.runEffect<EngineDecision>(this.session.submitGraph(this.lastGraph));
        }
        return { runId: this.activeRunId, status: "waiting-timer" };
      }
    }
  }

  private async continueAsNew(transition: unknown): Promise<RunResult> {
    if (this.continueAsNewHandler) {
      return this.continueAsNewHandler(transition, {
        runId: this.activeRunId,
        options: this.activeOptions ?? { input: {} },
      });
    }
    return {
      runId: this.activeRunId,
      status: "continued",
      output: transition,
    };
  }

  private async cancelRun(): Promise<RunResult> {
    if (this.session && typeof this.session.cancelRequested === "function") {
      const result = await this.runEffect<unknown>(this.session.cancelRequested());
      if (isRunResult(result)) return result;
      if (isEngineDecision(result)) {
        if (result._tag === "Finished") return result.result;
        if (result._tag === "Failed") {
          return {
            runId: this.activeRunId,
            status: "failed",
            error: result.error,
          };
        }
      }
    }
    return { runId: this.activeRunId, status: "cancelled" };
  }

  private runEffect<A>(effect: unknown): Promise<A> {
    return this.runtime.runPromise<A>(effect);
  }
}
