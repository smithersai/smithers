import { SmithersCtx } from "./SmithersCtx.js";
import { defaultTaskExecutor } from "./defaultTaskExecutor.js";
import { withAbort } from "./withAbort.js";
/** @typedef {import("./CreateWorkflowSession.ts").CreateWorkflowSession} CreateWorkflowSession */
/** @typedef {import("./OutputSnapshot.ts").OutputSnapshot} OutputSnapshot */
/** @typedef {import("./WorkflowSession.ts").WorkflowSession} WorkflowSession */
/** @typedef {import("./WorkflowRuntime.ts").WorkflowRuntime} WorkflowRuntime */
/** @typedef {import("./WorkflowGraphRenderer.ts").WorkflowGraphRenderer} WorkflowGraphRenderer */
/** @typedef {import("./TaskExecutor.ts").TaskExecutor} TaskExecutor */
/** @typedef {import("./SchedulerWaitHandler.ts").SchedulerWaitHandler} SchedulerWaitHandler */
/** @typedef {import("./WaitHandler.ts").WaitHandler} WaitHandler */
/** @typedef {import("./ContinueAsNewHandler.ts").ContinueAsNewHandler} ContinueAsNewHandler */

/** @typedef {import("./RunOptions.ts").RunOptions} RunOptions */
/** @typedef {import("@smithers-orchestrator/scheduler").RunResult} RunResult */
/** @typedef {import("@smithers-orchestrator/scheduler").EngineDecision} EngineDecision */
/** @typedef {import("@smithers-orchestrator/scheduler").RenderContext} RenderContext */
/** @typedef {import("@smithers-orchestrator/scheduler").WaitReason} WaitReason */
/** @typedef {import("@smithers-orchestrator/graph/types").TaskDescriptor} TaskDescriptor */

const SCHEDULER_SPECIFIER = "@smithers-orchestrator/scheduler";
const LOCAL_SCHEDULER_SPECIFIER = "../../scheduler/src/index.js";
function createRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
/**
 * @param {unknown} value
 * @returns {value is EngineDecision}
 */
function isEngineDecision(value) {
    if (!value || typeof value !== "object")
        return false;
    return typeof value._tag === "string";
}
/**
 * @param {unknown} value
 * @returns {value is RunResult}
 */
function isRunResult(value) {
    if (!value || typeof value !== "object")
        return false;
    const status = value.status;
    return typeof status === "string";
}
/**
 * @param {unknown} value
 * @returns {value is WorkflowSession}
 */
function isWorkflowSession(value) {
    return Boolean(value &&
        typeof value === "object" &&
        typeof value.submitGraph === "function" &&
        typeof value.taskCompleted === "function" &&
        typeof value.taskFailed === "function");
}
/**
 * @param {Record<string, number> | ReadonlyMap<string, number>} [iterations]
 * @returns {Record<string, number> | undefined}
 */
function recordFromIterations(iterations) {
    if (!iterations)
        return undefined;
    if (typeof iterations.entries === "function") {
        return Object.fromEntries(iterations);
    }
    return iterations;
}
/**
 * @param {RenderContext} context
 * @param {ReadonlyMap<string, string>} [knownOutputTables]
 * @returns {OutputSnapshot}
 */
function snapshotFromContext(context, knownOutputTables) {
    const outputs = context.outputs;
    if (!outputs)
        return {};
    if (typeof outputs.values !== "function") {
        return normalizeOutputSnapshot(outputs);
    }
    const outputMap = outputs;
    const descriptors = new Map();
    for (const [nodeId, outputTableName] of knownOutputTables ?? []) {
        descriptors.set(nodeId, { outputTableName });
    }
    for (const task of context.graph?.tasks ?? []) {
        descriptors.set(task.nodeId, { outputTableName: task.outputTableName });
    }
    const snapshot = {};
    for (const output of outputMap.values()) {
        const tableName = descriptors.get(output.nodeId)?.outputTableName;
        if (!tableName)
            continue;
        const row = output.output && typeof output.output === "object" && !Array.isArray(output.output)
            ? {
                ...output.output,
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
/**
 * @param {unknown} value
 * @returns {OutputSnapshot}
 */
function normalizeOutputSnapshot(value) {
    if (!value || typeof value !== "object")
        return {};
    const snapshot = {};
    for (const [key, rows] of Object.entries(value)) {
        snapshot[key] = Array.isArray(rows) ? rows : [];
    }
    return snapshot;
}
/**
 * @param {OutputSnapshot} base
 * @param {OutputSnapshot} live
 * @returns {OutputSnapshot}
 */
function mergeOutputSnapshots(base, live) {
    const merged = {};
    for (const [key, rows] of Object.entries(base)) {
        merged[key] = [...rows];
    }
    for (const [key, rows] of Object.entries(live)) {
        merged[key] = [...(merged[key] ?? []), ...rows];
    }
    return merged;
}
/**
 * @returns {Promise<CreateWorkflowSession | null>}
 */
async function loadCreateSession() {
    for (const specifier of [SCHEDULER_SPECIFIER, LOCAL_SCHEDULER_SPECIFIER]) {
        let mod;
        try {
            mod = (await import(specifier));
        }
        catch {
            continue;
        }
        if (typeof mod.createSession === "function")
            return mod.createSession;
        if (typeof mod.makeWorkflowSession === "function") {
            return mod.makeWorkflowSession;
        }
    }
    return null;
}
/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
    return Boolean(error &&
        typeof error === "object" &&
        ("name" in error || "message" in error) &&
        (/abort/i.test(String(error.name ?? "")) ||
            /abort/i.test(String(error.message ?? ""))));
}
/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function sleepWithAbort(ms, signal) {
    if (signal?.aborted) {
        const error = new Error("Task aborted");
        error.name = "AbortError";
        throw error;
    }
    if (ms <= 0)
        return;
    let timeout;
    const sleep = new Promise((resolve) => {
        timeout = setTimeout(resolve, ms);
    });
    try {
        await withAbort(sleep, signal);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
/**
 * @template {unknown} [Schema=unknown]
 */
export class WorkflowDriver {
    /** @type {import("./WorkflowDefinition.ts").WorkflowDefinition<Schema>} */
    workflow;
    /** @type {WorkflowRuntime} */
    runtime;
    /** @type {unknown} */
    db;
    /** @type {string | undefined} */
    configuredRunId;
    /** @type {string | undefined} */
    rootDir;
    /** @type {string | null | undefined} */
    workflowPath;
    /** @type {TaskExecutor} */
    executeTask;
    /** @type {SchedulerWaitHandler | undefined} */
    onSchedulerWait;
    /** @type {WaitHandler | undefined} */
    onWait;
    /** @type {ContinueAsNewHandler | undefined} */
    continueAsNewHandler;
    /** @type {CreateWorkflowSession | undefined} */
    createSession;
    /** @type {WorkflowGraphRenderer} */
    renderer;
    /** @type {WorkflowSession | undefined} */
    session;
    /** @type {string} */
    activeRunId = "";
    /** @type {RunOptions | undefined} */
    activeOptions;
    /** @type {import("@smithers-orchestrator/graph").WorkflowGraph | undefined} */
    lastGraph;
    /** @type {Map<string, string>} */
    outputTablesByNodeId = new Map();
    /** @type {OutputSnapshot} */
    baseOutputs = {};
    /**
     * @param {import("./WorkflowDriverOptions.ts").WorkflowDriverOptions<Schema>} options
     */
    constructor(options) {
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
    /**
   * @param {RunOptions} options
   * @returns {Promise<RunResult>}
   */
    async run(options) {
        const runId = options.runId ?? this.configuredRunId ?? createRunId();
        this.activeRunId = runId;
        this.activeOptions = options;
        this.baseOutputs = normalizeOutputSnapshot(options.initialOutputs ?? options.outputs);
        this.session = this.session ?? (await this.initializeSession(runId, options));
        if (options.signal?.aborted) {
            return this.cancelRun();
        }
        const initialIterations = recordFromIterations(options.initialIterations ??
            options.iterations ??
            options.ralphIterations);
        let decision = await this.renderAndSubmit({
            runId,
            iteration: typeof options.initialIteration === "number"
                ? options.initialIteration
                : typeof options.iteration === "number"
                    ? options.iteration
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
                    if (isRunResult(next))
                        return next;
                    decision = next;
                    break;
                }
                case "ReRender":
                    decision = await this.renderAndSubmit(decision.context);
                    break;
                case "Wait": {
                    const next = await this.handleWait(decision.reason);
                    if (isRunResult(next))
                        return next;
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
                        error: new Error(`Unknown engine decision: ${String(decision?._tag)}`),
                    };
            }
        }
    }
    /**
   * @param {string} runId
   * @param {RunOptions} options
   * @returns {Promise<WorkflowSession>}
   */
    async initializeSession(runId, options) {
        const createSession = this.createSession ?? (await loadCreateSession());
        if (!createSession) {
            throw new Error("WorkflowDriver requires a WorkflowSession or createSession from @smithers-orchestrator/scheduler.");
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
        return this.runEffect(created);
    }
    /**
   * @param {RenderContext} context
   * @returns {Promise<EngineDecision>}
   */
    async renderAndSubmit(context) {
        if (!this.session) {
            throw new Error("WorkflowSession is not initialized.");
        }
        const iteration = typeof context.iteration === "number" ? context.iteration : 0;
        const iterations = recordFromIterations(context.iterations ?? context.ralphIterations);
        const ctx = new SmithersCtx({
            runId: context.runId,
            iteration,
            iterations,
            input: context.input ?? this.activeOptions?.input ?? {},
            auth: context.auth,
            outputs: mergeOutputSnapshots(this.baseOutputs, snapshotFromContext(context, this.outputTablesByNodeId)),
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
        return this.runEffect(this.session.submitGraph(graph));
    }
    /**
   * @param {readonly TaskDescriptor[]} tasks
   * @returns {Promise<EngineDecision | RunResult>}
   */
    async executeTasks(tasks) {
        if (!this.session) {
            throw new Error("WorkflowSession is not initialized.");
        }
        const context = {
            runId: this.activeRunId,
            options: this.activeOptions ?? { input: {} },
            signal: this.activeOptions?.signal,
        };
        if (context.signal?.aborted) {
            return this.cancelRun();
        }
        let latestDecision;
        let cancelled = false;
        const waitStart = performance.now();
        try {
            await Promise.all(tasks.map(async (task) => {
                let report;
                try {
                    const output = await withAbort(Promise.resolve().then(() => this.executeTask(task, context)), context.signal);
                    report = await this.runEffect(this.session.taskCompleted({
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                        output,
                    }));
                }
                catch (error) {
                    if (context.signal?.aborted || isAbortError(error)) {
                        cancelled = true;
                        return;
                    }
                    report = await this.runEffect(this.session.taskFailed({
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                        error,
                    }));
                }
                if (isEngineDecision(report)) {
                    latestDecision = report;
                }
            }));
        }
        finally {
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
            return this.runEffect(this.session.getNextDecision());
        }
        throw new Error("WorkflowSession did not provide the next EngineDecision.");
    }
    /**
   * @param {WaitReason} reason
   * @returns {Promise<EngineDecision | RunResult>}
   */
    async handleWait(reason) {
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
                    return this.runEffect(this.session.getNextDecision());
                }
                if (this.session && this.lastGraph) {
                    return this.runEffect(this.session.submitGraph(this.lastGraph));
                }
                return { runId: this.activeRunId, status: "waiting-timer" };
            }
        }
    }
    /**
   * @param {unknown} transition
   * @returns {Promise<RunResult>}
   */
    async continueAsNew(transition) {
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
    /**
   * @returns {Promise<RunResult>}
   */
    async cancelRun() {
        if (this.session && typeof this.session.cancelRequested === "function") {
            const result = await this.runEffect(this.session.cancelRequested());
            if (isRunResult(result))
                return result;
            if (isEngineDecision(result)) {
                if (result._tag === "Finished")
                    return result.result;
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
    /**
   * @template A
   * @param {unknown} effect
   * @returns {Promise<A>}
   */
    runEffect(effect) {
        return this.runtime.runPromise(effect);
    }
}
