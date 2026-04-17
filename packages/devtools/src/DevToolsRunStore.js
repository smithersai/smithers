/** @typedef {import("./DevToolsEventBus.ts").DevToolsEventBus} DevToolsEventBus */
/** @typedef {import("./DevToolsRunStoreOptions.ts").DevToolsRunStoreOptions} DevToolsRunStoreOptions */
/** @typedef {import("./RunExecutionState.ts").RunExecutionState} RunExecutionState */
/** @typedef {import("./TaskExecutionState.ts").TaskExecutionState} TaskExecutionState */

export class DevToolsRunStore {
    /** @type {DevToolsRunStoreOptions} */
    options;
    /** @type {Map<string, RunExecutionState>} */
    _runs = new Map();
    /** @type {Array<{ bus: DevToolsEventBus; handler: (event: any) => void }>} */
    _eventBusListeners = [];
    /**
     * @param {DevToolsRunStoreOptions} [options]
     */
    constructor(options = {}) {
        this.options = options;
    }
    /**
     * Attach to a Smithers EventBus-like source.
     * @param {DevToolsEventBus} bus
     * @returns {this}
     */
    attachEventBus(bus) {
        /**
         * @param {any} event
         */
        const handler = (event) => this.processEngineEvent(event);
        bus.on("event", handler);
        this._eventBusListeners.push({ bus, handler });
        return this;
    }
    /** Detach all EventBus listeners registered by this store. */
    detachEventBuses() {
        for (const { bus, handler } of this._eventBusListeners) {
            bus.removeListener("event", handler);
        }
        this._eventBusListeners = [];
    }
    /**
     * Get execution state for a specific run.
     * @param {string} runId
     * @returns {RunExecutionState | undefined}
     */
    getRun(runId) {
        return this._runs.get(runId);
    }
    /**
     * Get all tracked runs.
     * @returns {Map<string, RunExecutionState>}
     */
    get runs() {
        return this._runs;
    }
    /**
     * Get task execution state by nodeId within a run. Searches all iterations.
     * @param {string} runId
     * @param {string} nodeId
     * @param {number} [iteration]
     * @returns {TaskExecutionState | undefined}
     */
    getTaskState(runId, nodeId, iteration) {
        const run = this._runs.get(runId);
        if (!run)
            return undefined;
        if (typeof iteration === "number") {
            return run.tasks.get(`${nodeId}::${iteration}`);
        }
        for (const task of run.tasks.values()) {
            if (task.nodeId === nodeId)
                return task;
        }
        return undefined;
    }
    /**
     * @param {any} event
     */
    processEngineEvent(event) {
        if (!event || !event.type || !event.runId)
            return;
        const run = this.ensureRun(event.runId);
        run.events.push(event);
        const verbose = this.options.verbose ?? false;
        switch (event.type) {
            case "RunStarted":
                run.status = "running";
                run.startedAt = event.timestampMs;
                break;
            case "RunFinished":
                run.status = "finished";
                run.finishedAt = event.timestampMs;
                break;
            case "RunFailed":
                run.status = "failed";
                run.finishedAt = event.timestampMs;
                break;
            case "RunCancelled":
                run.status = "cancelled";
                run.finishedAt = event.timestampMs;
                break;
            case "FrameCommitted":
                run.frameNo = event.frameNo;
                break;
            case "NodePending": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "pending";
                break;
            }
            case "NodeStarted": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "started";
                task.attempt = event.attempt;
                task.startedAt = event.timestampMs;
                if (verbose) {
                    console.log(`▶️  [smithers-devtools] Task started: ${event.nodeId} (attempt ${event.attempt})`);
                }
                break;
            }
            case "NodeFinished": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "finished";
                task.attempt = event.attempt;
                task.finishedAt = event.timestampMs;
                if (verbose) {
                    console.log(`✅ [smithers-devtools] Task finished: ${event.nodeId}`);
                }
                break;
            }
            case "NodeFailed": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "failed";
                task.attempt = event.attempt;
                task.finishedAt = event.timestampMs;
                task.error = event.error;
                if (verbose) {
                    console.log(`❌ [smithers-devtools] Task failed: ${event.nodeId}`);
                }
                break;
            }
            case "NodeCancelled": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "cancelled";
                break;
            }
            case "NodeSkipped": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "skipped";
                break;
            }
            case "NodeRetrying": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "retrying";
                task.attempt = event.attempt;
                break;
            }
            case "NodeWaitingApproval": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "waiting-approval";
                run.status = "waiting-approval";
                break;
            }
            case "NodeWaitingEvent": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "waiting-event";
                break;
            }
            case "NodeWaitingTimer": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.status = "waiting-timer";
                run.status = "waiting-timer";
                break;
            }
            case "ToolCallStarted": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                task.toolCalls.push({ name: event.toolName, seq: event.seq });
                break;
            }
            case "ToolCallFinished": {
                const task = this.ensureTask(run, event.nodeId, event.iteration);
                const tc = task.toolCalls.find((t) => t.name === event.toolName && t.seq === event.seq);
                if (tc)
                    tc.status = event.status;
                break;
            }
        }
        this.options.onEngineEvent?.(event);
    }
    /**
     * @param {string} runId
     * @returns {RunExecutionState}
     */
    ensureRun(runId) {
        let run = this._runs.get(runId);
        if (!run) {
            run = {
                runId,
                status: "running",
                frameNo: 0,
                tasks: new Map(),
                events: [],
            };
            this._runs.set(runId, run);
        }
        return run;
    }
    /**
     * @param {RunExecutionState} run
     * @param {string} nodeId
     * @param {number} iteration
     * @returns {TaskExecutionState}
     */
    ensureTask(run, nodeId, iteration) {
        const key = `${nodeId}::${iteration}`;
        let task = run.tasks.get(key);
        if (!task) {
            task = {
                nodeId,
                iteration,
                status: "pending",
                attempt: 0,
                toolCalls: [],
            };
            run.tasks.set(key, task);
        }
        return task;
    }
}
