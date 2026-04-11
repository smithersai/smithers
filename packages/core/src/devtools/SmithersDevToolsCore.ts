import type { DevToolsEventBus } from "./DevToolsEventBus.ts";
import type { DevToolsNode } from "./DevToolsNode.ts";
import type { DevToolsSnapshot } from "./DevToolsSnapshot.ts";
import type { RunExecutionState } from "./RunExecutionState.ts";
import type { SmithersDevToolsOptions } from "./SmithersDevToolsOptions.ts";
import type { TaskExecutionState } from "./TaskExecutionState.ts";
import { buildSnapshot } from "./buildSnapshot.ts";
import { collectTasks } from "./collectTasks.ts";
import { DevToolsRunStore } from "./DevToolsRunStore.ts";
import { findNodeById } from "./findNodeById.ts";
import { printTree } from "./printTree.ts";

export class SmithersDevToolsCore {
  private _lastSnapshot: DevToolsSnapshot | null = null;
  private _runStore: DevToolsRunStore;

  constructor(private options: SmithersDevToolsOptions = {}) {
    this._runStore = new DevToolsRunStore(options);
  }

  captureSnapshot(tree: DevToolsNode | null): DevToolsSnapshot {
    const snapshot = buildSnapshot(tree);
    this._lastSnapshot = snapshot;
    return snapshot;
  }

  emitCommit(
    snapshot: DevToolsSnapshot = this._lastSnapshot ?? buildSnapshot(null),
  ): DevToolsSnapshot {
    this.options.onCommit?.("commit", snapshot);
    return snapshot;
  }

  captureCommit(tree: DevToolsNode | null): DevToolsSnapshot {
    const snapshot = this.captureSnapshot(tree);
    this.emitCommit(snapshot);
    return snapshot;
  }

  emitUnmount(
    snapshot: DevToolsSnapshot = this._lastSnapshot ?? buildSnapshot(null),
  ): DevToolsSnapshot {
    this.options.onCommit?.("unmount", snapshot);
    return snapshot;
  }

  attachEventBus(bus: DevToolsEventBus): this {
    this._runStore.attachEventBus(bus);
    return this;
  }

  detachEventBuses(): void {
    this._runStore.detachEventBuses();
  }

  processEngineEvent(event: any): void {
    this._runStore.processEngineEvent(event);
  }

  getRun(runId: string): RunExecutionState | undefined {
    return this._runStore.getRun(runId);
  }

  get runs(): Map<string, RunExecutionState> {
    return this._runStore.runs;
  }

  getTaskState(
    runId: string,
    nodeId: string,
    iteration?: number,
  ): TaskExecutionState | undefined {
    return this._runStore.getTaskState(runId, nodeId, iteration);
  }

  /** Get the last captured snapshot. */
  get snapshot(): DevToolsSnapshot | null {
    return this._lastSnapshot;
  }

  /** Get the current tree (shorthand). */
  get tree(): DevToolsNode | null {
    return this._lastSnapshot?.tree ?? null;
  }

  /** Pretty-print the current tree to a string. */
  printTree(): string {
    if (!this._lastSnapshot?.tree) return "(no tree captured yet)";
    return printTree(this._lastSnapshot.tree);
  }

  /** Find a node by task nodeId. */
  findTask(nodeId: string): DevToolsNode | null {
    if (!this._lastSnapshot?.tree) return null;
    return findNodeById(this._lastSnapshot.tree, nodeId);
  }

  /** List all tasks in the current tree. */
  listTasks(): DevToolsNode[] {
    if (!this._lastSnapshot?.tree) return [];
    return collectTasks(this._lastSnapshot.tree);
  }
}
