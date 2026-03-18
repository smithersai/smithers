import type { XmlNode } from "../XmlNode";
import type { TaskDescriptor } from "../TaskDescriptor";
import { resolveStableId } from "../utils/tree-ids";
import { parseBool, parseNum } from "../utils/parse";

export type PlanNode =
  | { kind: "task"; nodeId: string }
  | { kind: "sequence"; children: PlanNode[] }
  | { kind: "parallel"; children: PlanNode[] }
  | {
      kind: "ralph";
      id: string;
      children: PlanNode[];
      until: boolean;
      maxIterations: number;
      onMaxReached: "fail" | "return-last";
    }
  | { kind: "group"; children: PlanNode[] };

export type TaskState =
  | "pending"
  | "waiting-approval"
  | "in-progress"
  | "finished"
  | "failed"
  | "cancelled"
  | "skipped";

export type TaskStateMap = Map<string, TaskState>;

export type ScheduleResult = {
  runnable: TaskDescriptor[];
  pendingExists: boolean;
  waitingApprovalExists: boolean;
  readyRalphs: RalphMeta[];
  nextRetryAtMs?: number;
};

export type RalphMeta = {
  id: string;
  until: boolean;
  maxIterations: number;
  onMaxReached: "fail" | "return-last";
};

export type RalphState = {
  iteration: number;
  done: boolean;
};

export type RalphStateMap = Map<string, RalphState>;

function key(nodeId: string, iteration: number) {
  return `${nodeId}::${iteration}`;
}

export function buildPlanTree(xml: XmlNode | null): {
  plan: PlanNode | null;
  ralphs: RalphMeta[];
} {
  if (!xml) return { plan: null, ralphs: [] };
  const ralphs: RalphMeta[] = [];
  const seenRalph = new Set<string>();

  function walk(
    node: XmlNode,
    ctx: { path: number[]; parentIsRalph: boolean },
  ): PlanNode | null {
    if (node.kind === "text") return null;
    const tag = node.tag;

    if (ctx.parentIsRalph && tag === "smithers:ralph") {
      throw new Error("Nested <Ralph> is not supported.");
    }

    const children: PlanNode[] = [];
    let elementIndex = 0;
    const isRalph = tag === "smithers:ralph";
    for (const child of node.children) {
      const nextPath =
        child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
      const built = walk(child, { path: nextPath, parentIsRalph: isRalph });
      if (built) children.push(built);
    }

    if (tag === "smithers:task") {
      const nodeId = node.props.id;
      if (!nodeId) return null;
      return { kind: "task", nodeId };
    }
    if (tag === "smithers:workflow") {
      return { kind: "sequence", children };
    }
    if (tag === "smithers:sequence") {
      return { kind: "sequence", children };
    }
    if (tag === "smithers:parallel") {
      // Structural grouping only; concurrency enforced via descriptor group ids.
      return { kind: "parallel", children };
    }
    if (tag === "smithers:merge-queue") {
      // Treat as a parallel structural group; per-group concurrency defaults
      // to 1 and is enforced via extracted task descriptors.
      return { kind: "parallel", children };
    }
    // Worktree has no special scheduling semantics in the plan tree.
    // Recognize explicitly to preserve subtree boundaries and ordering.
    if (tag === "smithers:worktree") {
      return { kind: "group", children };
    }
    if (tag === "smithers:ralph") {
      const id = resolveStableId(node.props.id, "ralph", ctx.path);
      if (seenRalph.has(id)) {
        throw new Error(`Duplicate Ralph id detected: ${id}`);
      }
      seenRalph.add(id);
      const until = parseBool(node.props.until);
      const maxIterations = parseNum(node.props.maxIterations, 5);
      const onMaxReached =
        (node.props.onMaxReached as "fail" | "return-last") ??
        "return-last";
      const meta: RalphMeta = { id, until, maxIterations, onMaxReached };
      ralphs.push(meta);
      return {
        kind: "ralph",
        id,
        children,
        until,
        maxIterations,
        onMaxReached,
      };
    }
    return { kind: "group", children };
  }

  const plan = walk(xml, { path: [], parentIsRalph: false });
  return { plan, ralphs };
}

function isTerminal(state: TaskState, desc: TaskDescriptor): boolean {
  if (state === "finished" || state === "skipped") return true;
  if (state === "failed") return desc.continueOnFail;
  return false;
}

function dependenciesSatisfied(
  desc: TaskDescriptor,
  states: TaskStateMap,
  descriptors: Map<string, TaskDescriptor>,
): boolean {
  if (!desc.dependsOn || desc.dependsOn.length === 0) return true;
  for (const dependencyId of desc.dependsOn) {
    const dependency = descriptors.get(dependencyId);
    if (!dependency) return false;
    const state = states.get(key(dependency.nodeId, dependency.iteration));
    if (!state || !isTerminal(state, dependency)) {
      return false;
    }
  }
  return true;
}

export function scheduleTasks(
  plan: PlanNode | null,
  states: TaskStateMap,
  descriptors: Map<string, TaskDescriptor>,
  ralphState: RalphStateMap,
  retryWait: Map<string, number>,
  nowMs: number,
): ScheduleResult {
  const runnable: TaskDescriptor[] = [];
  let pendingExists = false;
  let waitingApprovalExists = false;
  const readyRalphs: RalphMeta[] = [];
  let nextRetryAtMs: number | undefined;

  // Track current usage per parallel/merge-queue group based on in-progress tasks.
  // This allows the scheduler to admit at most `parallelMaxConcurrency` new
  // tasks per group when selecting runnables in this cycle.
  const groupUsage = new Map<string, number>();
  for (const [stateKey, state] of states) {
    if (state !== "in-progress") continue;
    // Keys are built via `${nodeId}::${iteration}`; recover nodeId cheaply.
    const sep = stateKey.lastIndexOf("::");
    const nodeId = sep >= 0 ? stateKey.slice(0, sep) : stateKey;
    const desc = descriptors.get(nodeId);
    if (!desc) continue;
    const gid = desc.parallelGroupId;
    const cap = desc.parallelMaxConcurrency;
    if (gid && cap != null) {
      groupUsage.set(gid, (groupUsage.get(gid) ?? 0) + 1);
    }
  }

  function walk(node: PlanNode): { terminal: boolean } {
    switch (node.kind) {
      case "task": {
        const desc = descriptors.get(node.nodeId);
        if (!desc) return { terminal: true };
        const state = states.get(key(desc.nodeId, desc.iteration)) ?? "pending";
        if (state === "waiting-approval") waitingApprovalExists = true;
        if (state === "pending" || state === "cancelled") pendingExists = true;
        const terminal = isTerminal(state, desc);
        if (!terminal && (state === "pending" || state === "cancelled")) {
          if (!dependenciesSatisfied(desc, states, descriptors)) {
            return { terminal };
          }
          const retryAt = retryWait.get(key(desc.nodeId, desc.iteration));
          if (retryAt && retryAt > nowMs) {
            pendingExists = true;
            nextRetryAtMs =
              nextRetryAtMs == null ? retryAt : Math.min(nextRetryAtMs, retryAt);
            return { terminal };
          }
          const gid = desc.parallelGroupId;
          const cap = desc.parallelMaxConcurrency;
          if (gid && cap != null) {
            const used = groupUsage.get(gid) ?? 0;
            if (used >= cap) {
              // Group is at capacity — skip admitting this task now.
              return { terminal };
            }
            groupUsage.set(gid, used + 1);
          }
          runnable.push(desc);
        }
        return { terminal };
      }
      case "sequence": {
        for (const child of node.children) {
          const res = walk(child);
          if (!res.terminal) {
            return { terminal: false };
          }
        }
        return { terminal: true };
      }
      case "parallel": {
        let terminal = true;
        for (const child of node.children) {
          const res = walk(child);
          if (!res.terminal) terminal = false;
        }
        return { terminal };
      }
      case "ralph": {
        const state = ralphState.get(node.id);
        const done = node.until || state?.done;
        if (done) return { terminal: true };
        let terminal = true;
        for (const child of node.children) {
          const res = walk(child);
          if (!res.terminal) terminal = false;
        }
        if (terminal) {
          readyRalphs.push({
            id: node.id,
            until: node.until,
            maxIterations: node.maxIterations,
            onMaxReached: node.onMaxReached,
          });
        }
        return { terminal: false };
      }
      case "group": {
        let terminal = true;
        for (const child of node.children) {
          const res = walk(child);
          if (!res.terminal) terminal = false;
        }
        return { terminal };
      }
      default:
        return { terminal: true };
    }
  }

  if (plan) {
    walk(plan);
  }

  return {
    runnable,
    pendingExists,
    waitingApprovalExists,
    readyRalphs,
    nextRetryAtMs,
  };
}

export function buildStateKey(nodeId: string, iteration: number) {
  return key(nodeId, iteration);
}
