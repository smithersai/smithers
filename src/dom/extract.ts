import type { XmlNode, XmlElement, TaskDescriptor } from "../types";
import { getTableName } from "drizzle-orm";
import { resolveStableId } from "../utils/tree-ids";

export type HostNode = HostElement | HostText;

export type HostElement = {
  kind: "element";
  tag: string;
  props: Record<string, string>;
  rawProps: Record<string, any>;
  children: HostNode[];
};

export type HostText = {
  kind: "text";
  text: string;
};

export type ExtractResult = {
  xml: XmlNode | null;
  tasks: TaskDescriptor[];
  mountedTaskIds: string[];
};

export type ExtractOptions = {
  ralphIterations?: Map<string, number> | Record<string, number>;
  defaultIteration?: number;
};

function toXmlNode(node: HostNode): XmlNode {
  if (node.kind === "text") {
    return { kind: "text", text: node.text };
  }
  const element: XmlElement = {
    kind: "element",
    tag: node.tag,
    props: node.props ?? {},
    children: node.children.map(toXmlNode),
  };
  return element;
}

function getRalphIteration(opts: ExtractOptions | undefined, id: string): number {
  const map = opts?.ralphIterations;
  const fallback = typeof opts?.defaultIteration === "number" ? opts.defaultIteration : 0;
  if (!map) return fallback;
  if (map instanceof Map) {
    return map.get(id) ?? fallback;
  }
  const value = (map as Record<string, number>)[id];
  return typeof value === "number" ? value : fallback;
}

export function extractFromHost(root: HostNode | null, opts?: ExtractOptions): ExtractResult {
  if (!root) {
    return { xml: null, tasks: [], mountedTaskIds: [] };
  }

  const tasks: TaskDescriptor[] = [];
  const mountedTaskIds: string[] = [];
  const seen = new Set<string>();
  const seenRalph = new Set<string>();
  let ordinal = 0;

  function walk(node: HostNode, ctx: { path: number[]; iteration: number; ralphId?: string; parallelStack: { id: string; max?: number }[] }) {
    if (node.kind === "text") return;

    let iteration = ctx.iteration;
    const parallelStack = ctx.parallelStack;
    let ralphId = ctx.ralphId;

    if (node.tag === "smithers:ralph") {
      if (ralphId) {
        throw new Error("Nested <Ralph> is not supported.");
      }
      const id = resolveStableId(node.rawProps?.id, "ralph", ctx.path);
      if (seenRalph.has(id)) {
        throw new Error(`Duplicate Ralph id detected: ${id}`);
      }
      seenRalph.add(id);
      ralphId = id;
      iteration = getRalphIteration(opts, id);
    }

    let nextParallelStack = parallelStack;
    if (node.tag === "smithers:parallel") {
      const max = typeof node.rawProps?.maxConcurrency === "number" ? node.rawProps.maxConcurrency : undefined;
      const id = resolveStableId(node.rawProps?.id, "parallel", ctx.path);
      nextParallelStack = [...parallelStack, { id, max }];
    }

    if (node.tag === "smithers:task") {
      const raw = node.rawProps || {};
      const nodeId = raw.id;
      if (!nodeId || typeof nodeId !== "string") {
        throw new Error("Task id is required and must be a string.");
      }
      if (seen.has(nodeId)) {
        throw new Error(`Duplicate Task id detected: ${nodeId}`);
      }
      seen.add(nodeId);

      const outputTable = raw.output;
      if (!outputTable) {
        throw new Error(`Task ${nodeId} is missing output table.`);
      }

      const outputTableName = getTableName(outputTable as any);
      const needsApproval = Boolean(raw.needsApproval);
      const skipIf = Boolean(raw.skipIf);
      const retries = typeof raw.retries === "number" ? raw.retries : 0;
      const timeoutMs = typeof raw.timeoutMs === "number" ? raw.timeoutMs : null;
      const continueOnFail = Boolean(raw.continueOnFail);

      const agent = raw.agent;
      const kind = raw.__smithersKind;
      const isAgent = kind === "agent" || Boolean(agent);
      const prompt = isAgent ? String(raw.children ?? "") : undefined;
      const staticPayload = isAgent ? undefined : (raw.__smithersPayload ?? raw.__payload ?? raw.children);

      const parallelGroup = nextParallelStack[nextParallelStack.length - 1];

      const descriptor: TaskDescriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        ralphId,
        outputTable,
        outputTableName,
        needsApproval,
        skipIf,
        retries,
        timeoutMs,
        continueOnFail,
        agent,
        prompt,
        staticPayload,
        label: raw.label,
        meta: raw.meta,
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
      };
      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
    }

    let elementIndex = 0;
    for (const child of node.children) {
      const nextPath = child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
      walk(child, { path: nextPath, iteration, ralphId, parallelStack: nextParallelStack });
    }
  }

  walk(root, { path: [], iteration: 0, parallelStack: [] });

  return { xml: toXmlNode(root), tasks, mountedTaskIds };
}
