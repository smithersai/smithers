import {
  instrument,
  secure,
  installRDTHook,
  traverseFiber,
  getDisplayName,
  isCompositeFiber,
  isHostFiber,
  getFiberId,
  setFiberId,
  type Fiber,
  type ReactDevToolsGlobalHook,
} from "bippy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DevToolsNode = {
  id: number;
  /** Smithers-level type: "workflow" | "task" | "sequence" | etc. */
  type: SmithersNodeType;
  /** Display name (component function name or host tag) */
  name: string;
  /** Props snapshot (serializable subset) */
  props: Record<string, unknown>;
  /** Task-specific fields extracted from rawProps */
  task?: {
    nodeId: string;
    kind: "agent" | "compute" | "static";
    agent?: string;
    label?: string;
    outputTableName?: string;
    iteration?: number;
  };
  children: DevToolsNode[];
  /** Depth in the Smithers tree (not React fiber depth) */
  depth: number;
};

export type SmithersNodeType =
  | "workflow"
  | "task"
  | "sequence"
  | "parallel"
  | "merge-queue"
  | "branch"
  | "loop"
  | "worktree"
  | "approval"
  | "subflow"
  | "wait-for-event"
  | "saga"
  | "try-catch"
  | "fragment"
  | "unknown";

export type DevToolsSnapshot = {
  tree: DevToolsNode | null;
  nodeCount: number;
  taskCount: number;
  timestamp: number;
};

export type DevToolsEventHandler = (
  event: "commit" | "unmount",
  snapshot: DevToolsSnapshot,
) => void;

/** Execution state for a task, derived from SmithersEvent stream */
export type TaskExecutionState = {
  nodeId: string;
  iteration: number;
  status: "pending" | "started" | "finished" | "failed" | "cancelled" | "skipped" | "waiting-approval" | "waiting-event" | "retrying";
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: unknown;
  toolCalls: Array<{ name: string; seq: number; status?: "success" | "error" }>;
};

/** Execution state for a run, aggregated from SmithersEvent stream */
export type RunExecutionState = {
  runId: string;
  status: "running" | "finished" | "failed" | "cancelled" | "waiting-approval";
  frameNo: number;
  tasks: Map<string, TaskExecutionState>;
  events: Array<{ type: string; timestampMs: number; [key: string]: unknown }>;
  startedAt?: number;
  finishedAt?: number;
};

export type SmithersDevToolsOptions = {
  /** Called on every React commit that touches the Smithers renderer */
  onCommit?: DevToolsEventHandler;
  /** Called on every SmithersEvent from an attached EventBus */
  onEngineEvent?: (event: any) => void;
  /** Enable verbose console logging */
  verbose?: boolean;
};

// ---------------------------------------------------------------------------
// Tag mapping
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
  "smithers:subflow": "subflow",
  "smithers:wait-for-event": "wait-for-event",
  "smithers:saga": "saga",
  "smithers:try-catch-finally": "try-catch",
};

function resolveNodeType(fiber: Fiber): SmithersNodeType | null {
  // Only match host fibers (smithers:* tags).
  // Composite fibers (Task, Workflow, etc.) are pass-throughs that always
  // create a host fiber underneath — matching both would double-count.
  if (isHostFiber(fiber)) {
    const tag = fiber.type as string;
    return HOST_TAG_MAP[tag] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fiber → DevToolsNode
// ---------------------------------------------------------------------------

function extractSerializableProps(fiber: Fiber): Record<string, unknown> {
  const raw = fiber.memoizedProps;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("__")) continue; // skip internal props
    if (key === "children") continue;
    if (typeof value === "function") {
      out[key] = "[Function]";
      continue;
    }
    if (typeof value === "object" && value !== null) {
      // Agent objects, Zod schemas, Drizzle tables — just note the type
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
      agentName = agent.map((a: any) => a?.modelId ?? a?.model ?? "?").join(" → ");
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
      typeof (raw as any).output === "string"
        ? (raw as any).output
        : undefined,
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
      // Recurse through non-Smithers fibers to find nested Smithers nodes
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
// Walk fiber root → find Smithers root
// ---------------------------------------------------------------------------

function findSmithersRoot(fiberRoot: any): Fiber | null {
  const current = fiberRoot?.current;
  if (!current) return null;

  let result: Fiber | null = null;
  traverseFiber(current, (fiber) => {
    const nodeType = resolveNodeType(fiber);
    if (nodeType === "workflow") {
      result = fiber;
      return true; // stop traversal
    }
    return false;
  });
  return result;
}

function countNodes(node: DevToolsNode): { nodes: number; tasks: number } {
  let nodes = 1;
  let tasks = node.type === "task" ? 1 : 0;
  for (const child of node.children) {
    const c = countNodes(child);
    nodes += c.nodes;
    tasks += c.tasks;
  }
  return { nodes, tasks };
}

function buildSnapshot(root: DevToolsNode | null): DevToolsSnapshot {
  if (!root) {
    return { tree: null, nodeCount: 0, taskCount: 0, timestamp: Date.now() };
  }
  const { nodes, tasks } = countNodes(root);
  return { tree: root, nodeCount: nodes, taskCount: tasks, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Pretty-print
// ---------------------------------------------------------------------------

const ICONS: Record<SmithersNodeType, string> = {
  workflow: "📋",
  task: "⚡",
  sequence: "➡️",
  parallel: "⚡",
  "merge-queue": "🔀",
  branch: "🌿",
  loop: "🔁",
  worktree: "🌳",
  approval: "✋",
  subflow: "🔗",
  "wait-for-event": "📡",
  saga: "🔄",
  "try-catch": "🛡️",
  fragment: "📦",
  unknown: "❓",
};

function printTree(node: DevToolsNode, indent: string = ""): string {
  const icon = ICONS[node.type] ?? "❓";
  let line = `${indent}${icon} ${node.type}`;

  if (node.task) {
    line += ` [${node.task.nodeId}]`;
    if (node.task.kind === "agent" && node.task.agent) {
      line += ` (${node.task.agent})`;
    } else {
      line += ` (${node.task.kind})`;
    }
    if (node.task.label) {
      line += ` "${node.task.label}"`;
    }
  } else if (node.props.name) {
    line += ` "${node.props.name}"`;
  } else if (node.props.id) {
    line += ` [${node.props.id}]`;
  }

  let output = line + "\n";
  for (const child of node.children) {
    output += printTree(child, indent + "  ");
  }
  return output;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class SmithersDevTools {
  private options: SmithersDevToolsOptions;
  private _lastSnapshot: DevToolsSnapshot | null = null;
  private _active = false;
  private _cleanup: (() => void) | null = null;
  private _runs = new Map<string, RunExecutionState>();
  private _eventBusListeners: Array<{ bus: any; handler: (e: any) => void }> = [];

  constructor(options: SmithersDevToolsOptions = {}) {
    this.options = options;
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
          const snapshot = buildSnapshot(tree);
          self._lastSnapshot = snapshot;

          if (verbose && tree) {
            console.log(
              "\n🔍 [smithers-devtools] Commit detected:\n" +
              printTree(tree) +
              `   ${snapshot.nodeCount} nodes, ${snapshot.taskCount} tasks\n`,
            );
          }

          self.options.onCommit?.("commit", snapshot);
        },
        onCommitFiberUnmount(_rendererID: number, fiber: any) {
          const nodeType = resolveNodeType(fiber);
          if (nodeType && verbose) {
            const name = getDisplayName(fiber) ?? fiber.type;
            console.log(`🗑️  [smithers-devtools] Unmounted: ${nodeType} (${name})`);
          }

          self.options.onCommit?.("unmount", self._lastSnapshot ?? buildSnapshot(null));
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
      if (hook.onCommitFiberUnmount === installedUnmountHandler && previousUnmountHandler) {
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
    // Detach all event bus listeners
    for (const { bus, handler } of this._eventBusListeners) {
      bus.removeListener("event", handler);
    }
    this._eventBusListeners = [];
  }

  /**
   * Attach to a Smithers EventBus to track task execution state.
   * Listens for SmithersEvent emissions and builds up a run state model.
   */
  attachEventBus(bus: { on: (event: string, handler: (e: any) => void) => void; removeListener: (event: string, handler: (e: any) => void) => void }): this {
    const handler = (event: any) => this._processEngineEvent(event);
    bus.on("event", handler);
    this._eventBusListeners.push({ bus, handler });
    return this;
  }

  /** Get execution state for a specific run. */
  getRun(runId: string): RunExecutionState | undefined {
    return this._runs.get(runId);
  }

  /** Get all tracked runs. */
  get runs(): Map<string, RunExecutionState> {
    return this._runs;
  }

  /** Get task execution state by nodeId within a run. Searches all iterations. */
  getTaskState(runId: string, nodeId: string, iteration?: number): TaskExecutionState | undefined {
    const run = this._runs.get(runId);
    if (!run) return undefined;
    // Try exact key first (nodeId::iteration)
    if (typeof iteration === "number") {
      return run.tasks.get(`${nodeId}::${iteration}`);
    }
    // Search by nodeId across all iterations
    for (const task of run.tasks.values()) {
      if (task.nodeId === nodeId) return task;
    }
    return undefined;
  }

  private _ensureRun(runId: string): RunExecutionState {
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

  private _ensureTask(run: RunExecutionState, nodeId: string, iteration: number): TaskExecutionState {
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

  private _processEngineEvent(event: any): void {
    if (!event || !event.type || !event.runId) return;

    const run = this._ensureRun(event.runId);
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
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "pending";
        break;
      }

      case "NodeStarted": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "started";
        task.attempt = event.attempt;
        task.startedAt = event.timestampMs;
        if (verbose) {
          console.log(`▶️  [smithers-devtools] Task started: ${event.nodeId} (attempt ${event.attempt})`);
        }
        break;
      }

      case "NodeFinished": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "finished";
        task.attempt = event.attempt;
        task.finishedAt = event.timestampMs;
        if (verbose) {
          console.log(`✅ [smithers-devtools] Task finished: ${event.nodeId}`);
        }
        break;
      }

      case "NodeFailed": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
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
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "cancelled";
        break;
      }

      case "NodeSkipped": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "skipped";
        break;
      }

      case "NodeRetrying": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "retrying";
        task.attempt = event.attempt;
        break;
      }

      case "NodeWaitingApproval": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "waiting-approval";
        run.status = "waiting-approval";
        break;
      }

      case "NodeWaitingEvent": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.status = "waiting-event";
        break;
      }

      case "ToolCallStarted": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        task.toolCalls.push({ name: event.toolName, seq: event.seq });
        break;
      }

      case "ToolCallFinished": {
        const task = this._ensureTask(run, event.nodeId, event.iteration);
        const tc = task.toolCalls.find(
          (t) => t.name === event.toolName && t.seq === event.seq,
        );
        if (tc) tc.status = event.status;
        break;
      }
    }

    this.options.onEngineEvent?.(event);
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
    const tasks: DevToolsNode[] = [];
    collectTasks(this._lastSnapshot.tree, tasks);
    return tasks;
  }
}

function findNodeById(node: DevToolsNode, nodeId: string): DevToolsNode | null {
  if (node.task?.nodeId === nodeId) return node;
  for (const child of node.children) {
    const found = findNodeById(child, nodeId);
    if (found) return found;
  }
  return null;
}

function collectTasks(node: DevToolsNode, out: DevToolsNode[]): void {
  if (node.type === "task") out.push(node);
  for (const child of node.children) {
    collectTasks(child, out);
  }
}
