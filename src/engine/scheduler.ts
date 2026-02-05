import type { XmlNode, TaskDescriptor } from "../types";
import { resolveStableId } from "../utils/tree-ids";

export type PlanNode =
  | { kind: "task"; nodeId: string }
  | { kind: "sequence"; children: PlanNode[] }
  | { kind: "parallel"; children: PlanNode[]; maxConcurrency?: number }
  | { kind: "ralph"; id: string; children: PlanNode[]; until: boolean; maxIterations: number; onMaxReached: "fail" | "return-last" }
  | { kind: "group"; children: PlanNode[] };

export type TaskState = "pending" | "waiting-approval" | "in-progress" | "finished" | "failed" | "cancelled" | "skipped";

export type TaskStateMap = Map<string, TaskState>;

export type ScheduleResult = {
  runnable: TaskDescriptor[];
  pendingExists: boolean;
  waitingApprovalExists: boolean;
  readyRalphs: RalphMeta[];
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

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value === "true" || value === "1";
}

function parseNum(value: string | undefined, fallback: number): number {
  const num = value ? Number(value) : NaN;
  return Number.isFinite(num) ? num : fallback;
}

export function buildPlanTree(xml: XmlNode | null): { plan: PlanNode | null; ralphs: RalphMeta[] } {
  if (!xml) return { plan: null, ralphs: [] };
  const ralphs: RalphMeta[] = [];
  const seenRalph = new Set<string>();

  function walk(node: XmlNode, ctx: { path: number[]; inRalph: boolean }): PlanNode | null {
    if (node.kind === "text") return null;
    const tag = node.tag;

    if (ctx.inRalph && tag === "smithers:ralph") {
      throw new Error("Nested <Ralph> is not supported.");
    }

    const children: PlanNode[] = [];
    let elementIndex = 0;
    for (const child of node.children) {
      const nextPath = child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
      const nextInRalph = ctx.inRalph || tag === "smithers:ralph";
      const built = walk(child, { path: nextPath, inRalph: nextInRalph });
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
      const max = parseNum(node.props.maxConcurrency, NaN);
      return { kind: "parallel", children, maxConcurrency: Number.isFinite(max) ? max : undefined };
    }
    if (tag === "smithers:ralph") {
      const id = resolveStableId(node.props.id, "ralph", ctx.path);
      if (seenRalph.has(id)) {
        throw new Error(`Duplicate Ralph id detected: ${id}`);
      }
      seenRalph.add(id);
      const until = parseBool(node.props.until);
      const maxIterations = parseNum(node.props.maxIterations, 5);
      const onMaxReached = (node.props.onMaxReached as "fail" | "return-last") ?? "return-last";
      const meta: RalphMeta = { id, until, maxIterations, onMaxReached };
      ralphs.push(meta);
      return { kind: "ralph", id, children, until, maxIterations, onMaxReached };
    }
    return { kind: "group", children };
  }

  const plan = walk(xml, { path: [], inRalph: false });
  return { plan, ralphs };
}

function isTerminal(state: TaskState, desc: TaskDescriptor): boolean {
  if (state === "finished" || state === "skipped") return true;
  if (state === "failed") return desc.continueOnFail;
  return false;
}

export function scheduleTasks(
  plan: PlanNode | null,
  states: TaskStateMap,
  descriptors: Map<string, TaskDescriptor>,
  ralphState: RalphStateMap,
): ScheduleResult {
  const runnable: TaskDescriptor[] = [];
  let pendingExists = false;
  let waitingApprovalExists = false;
  const readyRalphs: RalphMeta[] = [];

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
          readyRalphs.push({ id: node.id, until: node.until, maxIterations: node.maxIterations, onMaxReached: node.onMaxReached });
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

  return { runnable, pendingExists, waitingApprovalExists, readyRalphs };
}

export function buildStateKey(nodeId: string, iteration: number) {
  return key(nodeId, iteration);
}
