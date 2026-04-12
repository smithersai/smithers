import { buildSnapshot } from "./buildSnapshot.js";
import { collectTasks } from "./collectTasks.js";
import { DevToolsRunStore } from "./DevToolsRunStore.js";
import { findNodeById } from "./findNodeById.js";
import { printTree } from "./printTree.js";
/** @typedef {import("./DevToolsEventBus.ts").DevToolsEventBus} DevToolsEventBus */
/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./DevToolsSnapshot.ts").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("./RunExecutionState.ts").RunExecutionState} RunExecutionState */
/** @typedef {import("./SmithersDevToolsOptions.ts").SmithersDevToolsOptions} SmithersDevToolsOptions */
/** @typedef {import("./TaskExecutionState.ts").TaskExecutionState} TaskExecutionState */

export class SmithersDevToolsCore {
    options;
    _lastSnapshot = null;
    _runStore;
    /**
   * @param {SmithersDevToolsOptions} [options]
   */
    constructor(options = {}) {
        this.options = options;
        this._runStore = new DevToolsRunStore(options);
    }
    /**
   * @param {DevToolsNode | null} tree
   * @returns {DevToolsSnapshot}
   */
    captureSnapshot(tree) {
        const snapshot = buildSnapshot(tree);
        this._lastSnapshot = snapshot;
        return snapshot;
    }
    /**
   * @param {DevToolsSnapshot} [snapshot]
   * @returns {DevToolsSnapshot}
   */
    emitCommit(snapshot = this._lastSnapshot ?? buildSnapshot(null)) {
        this.options.onCommit?.("commit", snapshot);
        return snapshot;
    }
    /**
   * @param {DevToolsNode | null} tree
   * @returns {DevToolsSnapshot}
   */
    captureCommit(tree) {
        const snapshot = this.captureSnapshot(tree);
        this.emitCommit(snapshot);
        return snapshot;
    }
    /**
   * @param {DevToolsSnapshot} [snapshot]
   * @returns {DevToolsSnapshot}
   */
    emitUnmount(snapshot = this._lastSnapshot ?? buildSnapshot(null)) {
        this.options.onCommit?.("unmount", snapshot);
        return snapshot;
    }
    /**
   * @param {DevToolsEventBus} bus
   * @returns {this}
   */
    attachEventBus(bus) {
        this._runStore.attachEventBus(bus);
        return this;
    }
    detachEventBuses() {
        this._runStore.detachEventBuses();
    }
    /**
   * @param {any} event
   */
    processEngineEvent(event) {
        this._runStore.processEngineEvent(event);
    }
    /**
   * @param {string} runId
   * @returns {RunExecutionState | undefined}
   */
    getRun(runId) {
        return this._runStore.getRun(runId);
    }
    get runs() {
        return this._runStore.runs;
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} [iteration]
   * @returns {TaskExecutionState | undefined}
   */
    getTaskState(runId, nodeId, iteration) {
        return this._runStore.getTaskState(runId, nodeId, iteration);
    }
    /** Get the last captured snapshot. */
    get snapshot() {
        return this._lastSnapshot;
    }
    /** Get the current tree (shorthand). */
    get tree() {
        return this._lastSnapshot?.tree ?? null;
    }
    /** Pretty-print the current tree to a string. */
    printTree() {
        if (!this._lastSnapshot?.tree)
            return "(no tree captured yet)";
        return printTree(this._lastSnapshot.tree);
    }
    /** Find a node by task nodeId. */
    findTask(nodeId) {
        if (!this._lastSnapshot?.tree)
            return null;
        return findNodeById(this._lastSnapshot.tree, nodeId);
    }
    /** List all tasks in the current tree. */
    listTasks() {
        if (!this._lastSnapshot?.tree)
            return [];
        return collectTasks(this._lastSnapshot.tree);
    }
}
