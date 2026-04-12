import type { DevToolsEventBus } from "./DevToolsEventBus.ts";
import type { DevToolsRunStoreOptions } from "./DevToolsRunStoreOptions.ts";
import type { RunExecutionState } from "./RunExecutionState.ts";
import type { TaskExecutionState } from "./TaskExecutionState.ts";
export declare class DevToolsRunStore {
    private options;
    private _runs;
    private _eventBusListeners;
    constructor(options?: DevToolsRunStoreOptions);
    /** Attach to a Smithers EventBus-like source. */
    attachEventBus(bus: DevToolsEventBus): this;
    /** Detach all EventBus listeners registered by this store. */
    detachEventBuses(): void;
    /** Get execution state for a specific run. */
    getRun(runId: string): RunExecutionState | undefined;
    /** Get all tracked runs. */
    get runs(): Map<string, RunExecutionState>;
    /** Get task execution state by nodeId within a run. Searches all iterations. */
    getTaskState(runId: string, nodeId: string, iteration?: number): TaskExecutionState | undefined;
    processEngineEvent(event: any): void;
    private ensureRun;
    private ensureTask;
}
