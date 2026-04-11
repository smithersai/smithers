import {
  instrument,
  secure,
  installRDTHook,
  traverseFiber,
  getDisplayName,
  isHostFiber,
  getFiberId,
  setFiberId,
  type Fiber,
  type ReactDevToolsGlobalHook,
} from "bippy";
import {
  SmithersDevToolsCore,
  printTree,
  type DevToolsEventBus,
  type DevToolsNode,
  type DevToolsSnapshot,
  type RunExecutionState,
  type SmithersDevToolsOptions,
  type SmithersNodeType,
  type TaskExecutionState,
} from "@smithers/devtools";

export type {
  DevToolsEventBus,
  DevToolsEventHandler,
  DevToolsNode,
  DevToolsSnapshot,
  RunExecutionState,
  SmithersDevToolsOptions,
  SmithersNodeType,
  TaskExecutionState,
} from "@smithers/devtools";

// ---------------------------------------------------------------------------
// React host tag mapping
// ---------------------------------------------------------------------------

const HOST_TAG_MAP: Record<string, SmithersNodeType> = {
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

function resolveNodeType(fiber: Fiber): SmithersNodeType | null {
  // Only match host fibers (smithers:* tags).
  // Composite fibers (Task, Workflow, etc.) are pass-throughs that always
  // create a host fiber underneath, so matching both would double-count.
  if (isHostFiber(fiber)) {
    const tag = fiber.type as string;
    return HOST_TAG_MAP[tag] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fiber to DevToolsNode
// ---------------------------------------------------------------------------

function extractSerializableProps(fiber: Fiber): Record<string, unknown> {
  const raw = fiber.memoizedProps;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("__")) continue;
    if (key === "children") continue;
    if (typeof value === "function") {
      out[key] = "[Function]";
      continue;
    }
    if (typeof value === "object" && value !== null) {
      // Agent objects, Zod schemas, Drizzle tables: record a stable label only.
      if ("modelId" in value || "model" in value) {
        out[key] = `[Agent: ${(value as any).modelId ?? (value as any).model ?? "unknown"}]`;
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

function extractTaskInfo(fiber: Fiber): DevToolsNode["task"] | undefined {
  const raw = fiber.memoizedProps;
  if (!raw || typeof raw !== "object") return undefined;
  const nodeId = (raw as any).id;
  if (typeof nodeId !== "string") return undefined;

  const kind: "agent" | "compute" | "static" =
    (raw as any).__smithersKind === "agent"
      ? "agent"
      : (raw as any).__smithersKind === "compute"
        ? "compute"
        : "static";

  const agent = (raw as any).agent;
  let agentName: string | undefined;
  if (agent) {
    if (Array.isArray(agent)) {
      agentName = agent
        .map((a: any) => a?.modelId ?? a?.model ?? "?")
        .join(" → ");
    } else {
      agentName = agent.modelId ?? agent.model ?? "agent";
    }
  }

  return {
    nodeId,
    kind,
    agent: agentName,
    label: (raw as any).label,
    outputTableName:
      typeof (raw as any).output === "string" ? (raw as any).output : undefined,
    iteration: (raw as any).iteration,
  };
}

function fiberToNode(fiber: Fiber, depth: number): DevToolsNode | null {
  const nodeType = resolveNodeType(fiber);
  if (!nodeType) return null;

  const id = getFiberId(fiber) ?? setFiberId(fiber);

  const children: DevToolsNode[] = [];
  let child = fiber.child;
  while (child) {
    const childNode = fiberToNode(child, depth + 1);
    if (childNode) {
      children.push(childNode);
    } else {
      // Recurse through non-Smithers fibers to find nested Smithers nodes.
      let grandchild = child.child;
      while (grandchild) {
        const gc = fiberToNode(grandchild, depth + 1);
        if (gc) children.push(gc);
        grandchild = grandchild.sibling;
      }
    }
    child = child.sibling;
  }

  return {
    id,
    type: nodeType,
    name: getDisplayName(fiber) ?? (fiber.type as string) ?? "unknown",
    props: extractSerializableProps(fiber),
    task: nodeType === "task" ? extractTaskInfo(fiber) : undefined,
    children,
    depth,
  };
}

// ---------------------------------------------------------------------------
// Walk fiber root to find Smithers root
// ---------------------------------------------------------------------------

function findSmithersRoot(fiberRoot: any): Fiber | null {
  const current = fiberRoot?.current;
  if (!current) return null;

  let result: Fiber | null = null;
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
  private core: SmithersDevToolsCore;
  private _active = false;
  private _cleanup: (() => void) | null = null;

  constructor(private options: SmithersDevToolsOptions = {}) {
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
  start(): this {
    if (this._active) return this;
    this._active = true;

    // Avoid reinstalling the hook after renderers have already injected
    // themselves, otherwise we lose their registrations.
    if (!("__REACT_DEVTOOLS_GLOBAL_HOOK__" in globalThis)) {
      installRDTHook();
    }

    const self = this;
    const verbose = this.options.verbose ?? false;
    const hookHost = globalThis as typeof globalThis & {
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevToolsGlobalHook;
    };
    const hook = hookHost.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const previousRootHandler = hook?.onCommitFiberRoot;
    const previousUnmountHandler = hook?.onCommitFiberUnmount;

    instrument(
      secure({
        onCommitFiberRoot(rendererID: number, root: any) {
          const smithersRoot = findSmithersRoot(root);
          const tree = smithersRoot ? fiberToNode(smithersRoot, 0) : null;
          const snapshot = self.core.captureSnapshot(tree);

          if (verbose && tree) {
            console.log(
              "\n🔍 [smithers-devtools] Commit detected:\n" +
                printTree(tree) +
                `   ${snapshot.nodeCount} nodes, ${snapshot.taskCount} tasks\n`,
            );
          }

          self.core.emitCommit(snapshot);
        },
        onCommitFiberUnmount(_rendererID: number, fiber: any) {
          const nodeType = resolveNodeType(fiber);
          if (nodeType && verbose) {
            const name = getDisplayName(fiber) ?? fiber.type;
            console.log(
              `🗑️  [smithers-devtools] Unmounted: ${nodeType} (${name})`,
            );
          }

          self.core.emitUnmount();
        },
      }),
    );

    const installedRootHandler = hook?.onCommitFiberRoot;
    const installedUnmountHandler = hook?.onCommitFiberUnmount;

    this._cleanup = () => {
      if (!hook) return;
      if (hook.onCommitFiberRoot === installedRootHandler && previousRootHandler) {
        hook.onCommitFiberRoot = previousRootHandler;
      }
      if (
        hook.onCommitFiberUnmount === installedUnmountHandler &&
        previousUnmountHandler
      ) {
        hook.onCommitFiberUnmount = previousUnmountHandler;
      }
    };
    return this;
  }

  /** Stop instrumenting and clean up. */
  stop(): void {
    this._cleanup?.();
    this._cleanup = null;
    this._active = false;
    this.core.detachEventBuses();
  }

  /**
   * Attach to a Smithers EventBus to track task execution state.
   * Listens for SmithersEvent emissions and builds up a run state model.
   */
  attachEventBus(bus: DevToolsEventBus): this {
    this.core.attachEventBus(bus);
    return this;
  }

  /** Get execution state for a specific run. */
  getRun(runId: string): RunExecutionState | undefined {
    return this.core.getRun(runId);
  }

  /** Get all tracked runs. */
  get runs(): Map<string, RunExecutionState> {
    return this.core.runs;
  }

  /** Get task execution state by nodeId within a run. Searches all iterations. */
  getTaskState(
    runId: string,
    nodeId: string,
    iteration?: number,
  ): TaskExecutionState | undefined {
    return this.core.getTaskState(runId, nodeId, iteration);
  }

  /** Get the last captured snapshot. */
  get snapshot(): DevToolsSnapshot | null {
    return this.core.snapshot;
  }

  /** Get the current tree (shorthand). */
  get tree(): DevToolsNode | null {
    return this.core.tree;
  }

  /** Pretty-print the current tree to a string. */
  printTree(): string {
    return this.core.printTree();
  }

  /** Find a node by task nodeId. */
  findTask(nodeId: string): DevToolsNode | null {
    return this.core.findTask(nodeId);
  }

  /** List all tasks in the current tree. */
  listTasks(): DevToolsNode[] {
    return this.core.listTasks();
  }
}
