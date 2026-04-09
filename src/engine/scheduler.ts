import type { XmlNode } from "../XmlNode";
import type { TaskDescriptor } from "../TaskDescriptor";
import { resolveStableId } from "../utils/tree-ids";
import { parseBool, parseNum } from "../utils/parse";
import { SmithersError } from "../utils/errors";

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
      continueAsNewEvery?: number;
    }
  | {
      kind: "continue-as-new";
      stateJson?: string;
    }
  | { kind: "group"; children: PlanNode[] }
  | {
      kind: "saga";
      id: string;
      children: PlanNode[];
      onFailure: "compensate" | "compensate-and-fail" | "fail";
    }
  | {
      kind: "try-catch-finally";
      id: string;
      tryChildren: PlanNode[];
      catchChildren: PlanNode[];
      finallyChildren: PlanNode[];
    };

export type TaskState =
  | "pending"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
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
  waitingEventExists: boolean;
  waitingTimerExists: boolean;
  readyRalphs: RalphMeta[];
  continuation?: ContinuationRequest;
  nextRetryAtMs?: number;
};

export type RalphMeta = {
  id: string;
  until: boolean;
  maxIterations: number;
  onMaxReached: "fail" | "return-last";
  continueAsNewEvery?: number;
};

export type ContinuationRequest = {
  stateJson?: string;
};

export type RalphState = {
  iteration: number;
  done: boolean;
};

export type RalphStateMap = Map<string, RalphState>;

function key(nodeId: string, iteration: number) {
  return `${nodeId}::${iteration}`;
}

function buildLoopScope(
  loopStack: { ralphId: string; iteration: number }[],
): string {
  if (loopStack.length === 0) return "";
  return (
    "@@" + loopStack.map((l) => `${l.ralphId}=${l.iteration}`).join(",")
  );
}

export function buildPlanTree(
  xml: XmlNode | null,
  ralphState?: RalphStateMap,
): {
  plan: PlanNode | null;
  ralphs: RalphMeta[];
} {
  if (!xml) return { plan: null, ralphs: [] };
  const ralphs: RalphMeta[] = [];
  const seenRalph = new Set<string>();

  function walk(
    node: XmlNode,
    ctx: {
      path: number[];
      parentIsRalph: boolean;
      loopStack: { ralphId: string; iteration: number }[];
    },
  ): PlanNode | null {
    if (node.kind === "text") return null;
    const tag = node.tag;

    if (ctx.parentIsRalph && tag === "smithers:ralph") {
      throw new SmithersError("NESTED_LOOP", "Nested <Ralph> is not supported.");
    }

    let loopStack = ctx.loopStack;

    // Scope ralph IDs by ancestor loop iterations for nested loops
    let scopedRalphId: string | undefined;
    if (tag === "smithers:ralph") {
      const logicalId = resolveStableId(node.props.id, "ralph", ctx.path);
      const scope = buildLoopScope(loopStack);
      scopedRalphId = logicalId + scope;
      const currentIter = ralphState?.get(scopedRalphId)?.iteration ?? 0;
      loopStack = [...loopStack, { ralphId: logicalId, iteration: currentIter }];
    }

    const children: PlanNode[] = [];
    let elementIndex = 0;
    const isRalph = tag === "smithers:ralph";
    for (const child of node.children) {
      const nextPath =
        child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
      const built = walk(child, {
        path: nextPath,
        parentIsRalph: isRalph,
        loopStack,
      });
      if (built) children.push(built);
    }

    if (tag === "smithers:task") {
      const logicalId = node.props.id;
      if (!logicalId) return null;
      // Scope task nodeId by ancestor loops (all except the innermost,
      // which is captured by desc.iteration).
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalId + ancestorScope;
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
    if (tag === "smithers:subflow") {
      const mode = node.props.mode ?? "childRun";
      if (mode === "inline") {
        // Inline mode: treat subflow children as a sequence in the parent plan
        return { kind: "sequence", children };
      }
      // childRun mode: behaves like a single task node
      const logicalId = node.props.id;
      if (!logicalId) return null;
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalId + ancestorScope;
      return { kind: "task", nodeId };
    }
    if (tag === "smithers:sandbox") {
      const logicalId = node.props.id;
      if (!logicalId) return null;
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalId + ancestorScope;
      return { kind: "task", nodeId };
    }
    if (tag === "smithers:wait-for-event") {
      const logicalId = node.props.id;
      if (!logicalId) return null;
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalId + ancestorScope;
      return { kind: "task", nodeId };
    }
    if (tag === "smithers:timer") {
      const logicalId = node.props.id;
      if (!logicalId) return null;
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalId + ancestorScope;
      return { kind: "task", nodeId };
    }
    if (tag === "smithers:continue-as-new") {
      return {
        kind: "continue-as-new",
        stateJson: node.props.stateJson,
      };
    }
    if (tag === "smithers:ralph") {
      const id = scopedRalphId!;
      if (seenRalph.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Ralph id detected: ${id}`, { kind: "ralph", id });
      }
      seenRalph.add(id);
      const until = parseBool(node.props.until);
      const maxIterations = parseNum(node.props.maxIterations, 5);
      const onMaxReached =
        (node.props.onMaxReached as "fail" | "return-last") ??
        "return-last";
      const parsedContinueAsNewEvery = Math.floor(
        parseNum(node.props.continueAsNewEvery, 0),
      );
      const continueAsNewEvery =
        Number.isFinite(parsedContinueAsNewEvery) &&
        parsedContinueAsNewEvery > 0
          ? parsedContinueAsNewEvery
          : undefined;
      const meta: RalphMeta = {
        id,
        until,
        maxIterations,
        onMaxReached,
        continueAsNewEvery,
      };
      ralphs.push(meta);
      return {
        kind: "ralph",
        id,
        children,
        until,
        maxIterations,
        onMaxReached,
        continueAsNewEvery,
      };
    }
    if (tag === "smithers:saga") {
      const id = resolveStableId(node.props.id, "saga", ctx.path);
      const onFailure =
        (node.props.onFailure as "compensate" | "compensate-and-fail" | "fail") ??
        "compensate";
      return {
        kind: "saga",
        id,
        children,
        onFailure,
      };
    }
    if (tag === "smithers:try-catch-finally") {
      const id = resolveStableId(node.props.id, "tcf", ctx.path);
      // Children are structured: try block children come first,
      // catch and finally are mounted by the engine on demand.
      // At plan-build time, only the try children are present.
      return {
        kind: "try-catch-finally",
        id,
        tryChildren: children,
        catchChildren: [],
        finallyChildren: [],
      };
    }
    return { kind: "group", children };
  }

  const plan = walk(xml, { path: [], parentIsRalph: false, loopStack: [] });
  return { plan, ralphs };
}

function isTerminal(state: TaskState, desc: TaskDescriptor): boolean {
  if (state === "finished" || state === "skipped") return true;
  if (state === "failed") return desc.continueOnFail;
  return false;
}

function isTraversalTerminal(state: TaskState, desc: TaskDescriptor): boolean {
  if (isTerminal(state, desc)) {
    return true;
  }
  return Boolean(
    desc.waitAsync &&
      (state === "waiting-approval" || state === "waiting-event"),
  );
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
  let waitingEventExists = false;
  let waitingTimerExists = false;
  const readyRalphs: RalphMeta[] = [];
  let continuation: ContinuationRequest | undefined;
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
        if (state === "waiting-event") waitingEventExists = true;
        if (state === "waiting-timer") waitingTimerExists = true;
        if (state === "pending" || state === "cancelled") pendingExists = true;
        const terminal = isTraversalTerminal(state, desc);
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
            continueAsNewEvery: node.continueAsNewEvery,
          });
        }
        return { terminal: false };
      }
      case "continue-as-new": {
        continuation = {
          stateJson: node.stateJson,
        };
        return { terminal: false };
      }
      case "saga": {
        // Saga runs its action steps sequentially (like a sequence).
        // If any step fails and onFailure !== "fail", compensation
        // steps are triggered by the engine in reverse order.
        for (const child of node.children) {
          const res = walk(child);
          if (!res.terminal) {
            return { terminal: false };
          }
        }
        return { terminal: true };
      }
      case "try-catch-finally": {
        // Try children run first (sequentially).
        let tryTerminal = true;
        for (const child of node.tryChildren) {
          const res = walk(child);
          if (!res.terminal) tryTerminal = false;
        }
        if (!tryTerminal) return { terminal: false };
        // Once try is terminal, check catch children if any were mounted.
        for (const child of node.catchChildren) {
          const res = walk(child);
          if (!res.terminal) return { terminal: false };
        }
        // Finally children run last.
        for (const child of node.finallyChildren) {
          const res = walk(child);
          if (!res.terminal) return { terminal: false };
        }
        return { terminal: true };
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
    waitingEventExists,
    waitingTimerExists,
    readyRalphs,
    continuation,
    nextRetryAtMs,
  };
}

export function buildStateKey(nodeId: string, iteration: number) {
  return key(nodeId, iteration);
}
