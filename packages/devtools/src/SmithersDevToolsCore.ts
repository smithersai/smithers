import type { DevToolsEventBus } from "./DevToolsEventBus.ts";
import type { DevToolsNode } from "./DevToolsNode.ts";
import type { DevToolsSnapshot } from "./DevToolsSnapshot.ts";
import type { RunExecutionState } from "./RunExecutionState.ts";
import type { SmithersDevToolsOptions } from "./SmithersDevToolsOptions.ts";
import type { TaskExecutionState } from "./TaskExecutionState.ts";
export declare class SmithersDevToolsCore {
    private options;
    private _lastSnapshot;
    private _runStore;
    constructor(options?: SmithersDevToolsOptions);
    captureSnapshot(tree: DevToolsNode | null): DevToolsSnapshot;
    emitCommit(snapshot?: DevToolsSnapshot): DevToolsSnapshot;
    captureCommit(tree: DevToolsNode | null): DevToolsSnapshot;
    emitUnmount(snapshot?: DevToolsSnapshot): DevToolsSnapshot;
    attachEventBus(bus: DevToolsEventBus): this;
    detachEventBuses(): void;
    processEngineEvent(event: any): void;
    getRun(runId: string): RunExecutionState | undefined;
    get runs(): Map<string, RunExecutionState>;
    getTaskState(runId: string, nodeId: string, iteration?: number): TaskExecutionState | undefined;
    /** Get the last captured snapshot. */
    get snapshot(): DevToolsSnapshot | null;
    /** Get the current tree (shorthand). */
    get tree(): DevToolsNode | null;
    /** Pretty-print the current tree to a string. */
    printTree(): string;
    /** Find a node by task nodeId. */
    findTask(nodeId: string): DevToolsNode | null;
    /** List all tasks in the current tree. */
    listTasks(): DevToolsNode[];
}
