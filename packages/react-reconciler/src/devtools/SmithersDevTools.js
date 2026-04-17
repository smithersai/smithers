// @smithers-type-exports-begin
/** @typedef {import("@smithers/devtools").DevToolsEventBus} DevToolsEventBus */
/** @typedef {import("@smithers/devtools").DevToolsEventHandler} DevToolsEventHandler */
/** @typedef {import("@smithers/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers/devtools").RunExecutionState} RunExecutionState */
/** @typedef {import("@smithers/devtools").SmithersNodeType} SmithersNodeType */
/** @typedef {import("@smithers/devtools").TaskExecutionState} TaskExecutionState */
// @smithers-type-exports-end

import { instrument, secure, installRDTHook, traverseFiber, getDisplayName, isHostFiber, getFiberId, setFiberId, } from "bippy";
import { SmithersDevToolsCore, printTree, } from "@smithers/devtools";
/** @typedef {import("@smithers/devtools").DevToolsNode} DevToolsNode */
/** @typedef {import("@smithers/devtools").SmithersDevToolsCore} SmithersDevToolsCoreType */
/** @typedef {import("@smithers/devtools").SmithersDevToolsOptions} SmithersDevToolsOptions */
/** @typedef {import("bippy").Fiber} Fiber */
/** @typedef {import("bippy").FiberRoot} FiberRoot */

// ---------------------------------------------------------------------------
// React host tag mapping
// ---------------------------------------------------------------------------
const HOST_TAG_MAP = {
    "smithers:workflow": "workflow",
    "smithers:task": "task",
    "smithers:sequence": "sequence",
    "smithers:parallel": "parallel",
    "smithers:merge-queue": "merge-queue",
    "smithers:branch": "branch",
    "smithers:ralph": "loop",
    "smithers:worktree": "worktree",
    "smithers:approval": "approval",
    "smithers:timer": "timer",
    "smithers:subflow": "subflow",
    "smithers:wait-for-event": "wait-for-event",
    "smithers:saga": "saga",
    "smithers:try-catch-finally": "try-catch",
};
/**
 * @param {Fiber} fiber
 * @returns {SmithersNodeType | null}
 */
function resolveNodeType(fiber) {
    // Only match host fibers (smithers:* tags).
    // Composite fibers (Task, Workflow, etc.) are pass-throughs that always
    // create a host fiber underneath, so matching both would double-count.
    if (isHostFiber(fiber)) {
        const tag = fiber.type;
        return HOST_TAG_MAP[tag] ?? null;
    }
    return null;
}
// ---------------------------------------------------------------------------
// Fiber to DevToolsNode
// ---------------------------------------------------------------------------
/**
 * @param {Fiber} fiber
 * @returns {Record<string, unknown>}
 */
function extractSerializableProps(fiber) {
    const raw = fiber.memoizedProps;
    if (!raw || typeof raw !== "object")
        return {};
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith("__"))
            continue;
        if (key === "children")
            continue;
        if (typeof value === "function") {
            out[key] = "[Function]";
            continue;
        }
        if (typeof value === "object" && value !== null) {
            // Agent objects, Zod schemas, Drizzle tables: record a stable label only.
            if ("modelId" in value || "model" in value) {
                out[key] = `[Agent: ${value.modelId ?? value.model ?? "unknown"}]`;
                continue;
            }
            if ("shape" in value) {
                out[key] = "[ZodSchema]";
                continue;
            }
            out[key] = "[Object]";
            continue;
        }
        out[key] = value;
    }
    return out;
}
/**
 * @param {Fiber} fiber
 * @returns {DevToolsNode["task"] | undefined}
 */
function extractTaskInfo(fiber) {
    const raw = fiber.memoizedProps;
    if (!raw || typeof raw !== "object")
        return undefined;
    const nodeId = raw.id;
    if (typeof nodeId !== "string")
        return undefined;
    const kind = raw.__smithersKind === "agent"
        ? "agent"
        : raw.__smithersKind === "compute"
            ? "compute"
            : "static";
    const agent = raw.agent;
    let agentName;
    if (agent) {
        if (Array.isArray(agent)) {
            agentName = agent
                .map((a) => a?.modelId ?? a?.model ?? "?")
                .join(" → ");
        }
        else {
            agentName = agent.modelId ?? agent.model ?? "agent";
        }
    }
    return {
        nodeId,
        kind,
        agent: agentName,
        label: raw.label,
        outputTableName: typeof raw.output === "string" ? raw.output : undefined,
        iteration: raw.iteration,
    };
}
/**
 * @param {Fiber} fiber
 * @param {number} depth
 * @returns {DevToolsNode | null}
 */
function fiberToNode(fiber, depth) {
    const nodeType = resolveNodeType(fiber);
    if (!nodeType)
        return null;
    const id = getFiberId(fiber) ?? setFiberId(fiber);
    const children = [];
    let child = fiber.child;
    while (child) {
        const childNode = fiberToNode(child, depth + 1);
        if (childNode) {
            children.push(childNode);
        }
        else {
            // Recurse through non-Smithers fibers to find nested Smithers nodes.
            let grandchild = child.child;
            while (grandchild) {
                const gc = fiberToNode(grandchild, depth + 1);
                if (gc)
                    children.push(gc);
                grandchild = grandchild.sibling;
            }
        }
        child = child.sibling;
    }
    return {
        id,
        type: nodeType,
        name: getDisplayName(fiber) ?? fiber.type ?? "unknown",
        props: extractSerializableProps(fiber),
        task: nodeType === "task" ? extractTaskInfo(fiber) : undefined,
        children,
        depth,
    };
}
// ---------------------------------------------------------------------------
// Walk fiber root to find Smithers root
// ---------------------------------------------------------------------------
/**
 * @param {FiberRoot | null | undefined} fiberRoot
 * @returns {Fiber | null}
 */
function findSmithersRoot(fiberRoot) {
    const current = fiberRoot?.current;
    if (!current)
        return null;
    let result = null;
    traverseFiber(current, (fiber) => {
        const nodeType = resolveNodeType(fiber);
        if (nodeType === "workflow") {
            result = fiber;
            return true;
        }
        return false;
    });
    return result;
}
// ---------------------------------------------------------------------------
// React adapter
// ---------------------------------------------------------------------------
export class SmithersDevTools {
    /** @type {SmithersDevToolsOptions} */
    options;
    /** @type {SmithersDevToolsCoreType} */
    core;
    _active = false;
    _cleanup = null;
    /**
   * @param {SmithersDevToolsOptions} [options]
   */
    constructor(options = {}) {
        this.options = options;
        this.core = new SmithersDevToolsCore(options);
    }
    /**
     * Start instrumenting. Installs the React DevTools global hook (if not
     * already present) and begins listening for fiber commits.
     *
     * For best results, call this before `SmithersRenderer` is first imported.
     * If the renderer is already loaded, it will still work as long as the
     * renderer called `injectIntoDevTools` (which it does by default).
     */
    start() {
        if (this._active)
            return this;
        this._active = true;
        // Avoid reinstalling the hook after renderers have already injected
        // themselves, otherwise we lose their registrations.
        if (!("__REACT_DEVTOOLS_GLOBAL_HOOK__" in globalThis)) {
            installRDTHook();
        }
        const self = this;
        const verbose = this.options.verbose ?? false;
        const hookHost = globalThis;
        const hook = hookHost.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        const previousRootHandler = hook?.onCommitFiberRoot;
        const previousUnmountHandler = hook?.onCommitFiberUnmount;
        instrument(secure({
            /**
     * @param {number} rendererID
     * @param {FiberRoot} root
     * @returns {void}
     */
            onCommitFiberRoot(rendererID, root) {
                const smithersRoot = findSmithersRoot(root);
                const tree = smithersRoot ? fiberToNode(smithersRoot, 0) : null;
                const snapshot = self.core.captureSnapshot(tree);
                if (verbose && tree) {
                    console.log("\n🔍 [smithers-devtools] Commit detected:\n" +
                        printTree(tree) +
                        `   ${snapshot.nodeCount} nodes, ${snapshot.taskCount} tasks\n`);
                }
                self.core.emitCommit(snapshot);
            },
            /**
     * @param {number} _rendererID
     * @param {Fiber} fiber
     * @returns {void}
     */
            onCommitFiberUnmount(_rendererID, fiber) {
                const nodeType = resolveNodeType(fiber);
                if (nodeType && verbose) {
                    const name = getDisplayName(fiber) ?? fiber.type;
                    console.log(`🗑️  [smithers-devtools] Unmounted: ${nodeType} (${name})`);
                }
                self.core.emitUnmount();
            },
        }));
        const installedRootHandler = hook?.onCommitFiberRoot;
        const installedUnmountHandler = hook?.onCommitFiberUnmount;
        this._cleanup = () => {
            if (!hook)
                return;
            if (hook.onCommitFiberRoot === installedRootHandler) {
                if (previousRootHandler) {
                    hook.onCommitFiberRoot = previousRootHandler;
                }
                else {
                    delete hook.onCommitFiberRoot;
                }
            }
            if (hook.onCommitFiberUnmount === installedUnmountHandler) {
                if (previousUnmountHandler) {
                    hook.onCommitFiberUnmount = previousUnmountHandler;
                }
                else {
                    delete hook.onCommitFiberUnmount;
                }
            }
        };
        return this;
    }
    /** Stop instrumenting and clean up. */
    stop() {
        this._cleanup?.();
        this._cleanup = null;
        this._active = false;
        this.core.detachEventBuses();
    }
    /**
     * Attach to a Smithers EventBus to track task execution state.
     * Listens for SmithersEvent emissions and builds up a run state model.
     * @param {DevToolsEventBus} bus
     * @returns {this}
     */
    attachEventBus(bus) {
        this.core.attachEventBus(bus);
        return this;
    }
    /**
     * Get execution state for a specific run.
     * @param {string} runId
     * @returns {RunExecutionState | undefined}
     */
    getRun(runId) {
        return this.core.getRun(runId);
    }
    /**
     * Get all tracked runs.
     * @returns {Map<string, RunExecutionState>}
     */
    get runs() {
        return this.core.runs;
    }
    /**
     * Get task execution state by nodeId within a run. Searches all iterations.
     * @param {string} runId
     * @param {string} nodeId
     * @param {number} [iteration]
     * @returns {TaskExecutionState | undefined}
     */
    getTaskState(runId, nodeId, iteration) {
        return this.core.getTaskState(runId, nodeId, iteration);
    }
    /**
     * Get the last captured snapshot.
     * @returns {DevToolsSnapshot | null}
     */
    get snapshot() {
        return this.core.snapshot;
    }
    /**
     * Get the current tree (shorthand).
     * @returns {DevToolsNode | null}
     */
    get tree() {
        return this.core.tree;
    }
    /**
     * Pretty-print the current tree to a string.
     * @returns {string}
     */
    printTree() {
        return this.core.printTree();
    }
    /**
     * Find a node by task nodeId.
     * @param {string} nodeId
     * @returns {DevToolsNode | null}
     */
    findTask(nodeId) {
        return this.core.findTask(nodeId);
    }
    /**
     * List all tasks in the current tree.
     * @returns {DevToolsNode[]}
     */
    listTasks() {
        return this.core.listTasks();
    }
}
