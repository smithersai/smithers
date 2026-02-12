import type { XmlNode, XmlElement, TaskDescriptor } from "../types";
import { getTableName } from "drizzle-orm";
import { resolveStableId } from "../utils/tree-ids";
import { isAbsolute, resolve as resolvePath } from "node:path";

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
  /** Base directory for resolving relative Worktree paths */
  baseRootDir?: string;
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

function getRalphIteration(
  opts: ExtractOptions | undefined,
  id: string,
): number {
  const map = opts?.ralphIterations;
  const fallback =
    typeof opts?.defaultIteration === "number" ? opts.defaultIteration : 0;
  if (!map) return fallback;
  if (map instanceof Map) {
    return map.get(id) ?? fallback;
  }
  const value = (map as Record<string, number>)[id];
  return typeof value === "number" ? value : fallback;
}

export function extractFromHost(
  root: HostNode | null,
  opts?: ExtractOptions,
): ExtractResult {
  if (!root) {
    return { xml: null, tasks: [], mountedTaskIds: [] };
  }

  const tasks: TaskDescriptor[] = [];
  const mountedTaskIds: string[] = [];
  const seen = new Set<string>();
  const seenRalph = new Set<string>();
  const seenWorktree = new Set<string>();
  let ordinal = 0;

  function walk(
    node: HostNode,
    ctx: {
      path: number[];
      iteration: number;
      ralphId?: string;
      parallelStack: { id: string; max?: number }[];
      /**
       * Stack of active <Worktree> contexts (outermost -> innermost).
       * The top of the stack controls the effective root override for tasks.
       */
      worktreeStack: { id: string; path: string }[];
    },
  ) {
    if (node.kind === "text") return;

    let iteration = ctx.iteration;
    const parallelStack = ctx.parallelStack;
    let ralphId = ctx.ralphId;
    const worktreeStack = ctx.worktreeStack;

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
      const max =
        typeof node.rawProps?.maxConcurrency === "number"
          ? node.rawProps.maxConcurrency
          : undefined;
      const id = resolveStableId(node.rawProps?.id, "parallel", ctx.path);
      nextParallelStack = [...parallelStack, { id, max }];
    }
    // Entering a Worktree node: push onto the worktree stack
    let nextWorktreeStack = worktreeStack;
    if (node.tag === "smithers:worktree") {
      const id = resolveStableId(node.rawProps?.id, "worktree", ctx.path);
      if (seenWorktree.has(id)) {
        throw new Error(`Duplicate Worktree id detected: ${id}`);
      }
      seenWorktree.add(id);
      let pathVal = String(node.rawProps?.path ?? "").trim();
      if (!pathVal) {
        throw new Error("<Worktree> requires a non-empty path");
      }
      const base =
        opts?.baseRootDir &&
        typeof opts.baseRootDir === "string" &&
        opts.baseRootDir.length > 0
          ? opts.baseRootDir
          : process.cwd();
      const normPath = isAbsolute(pathVal)
        ? resolvePath(pathVal)
        : resolvePath(base, pathVal);
      nextWorktreeStack = [...worktreeStack, { id, path: normPath }];
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

      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new Error(`Task ${nodeId} is missing output table.`);
      }

      // Support both Drizzle table objects and string keys
      let outputTable: any;
      let outputTableName: string;
      if (typeof outputRaw === "string") {
        // String key — will be resolved by the engine via schemaRegistry
        outputTable = null;
        outputTableName = outputRaw;
      } else {
        outputTable = outputRaw;
        outputTableName = getTableName(outputRaw as any);
      }
      const needsApproval = Boolean(raw.needsApproval);
      const skipIf = Boolean(raw.skipIf);
      const retries = typeof raw.retries === "number" ? raw.retries : 0;
      const timeoutMs =
        typeof raw.timeoutMs === "number" ? raw.timeoutMs : null;
      const continueOnFail = Boolean(raw.continueOnFail);

      const agent = raw.agent;
      const kind = raw.__smithersKind;
      const isAgent = kind === "agent" || Boolean(agent);
      const prompt = isAgent ? String(raw.children ?? "") : undefined;
      const staticPayload = isAgent
        ? undefined
        : (raw.__smithersPayload ?? raw.__payload ?? raw.children);

      const parallelGroup = nextParallelStack[nextParallelStack.length - 1];

      const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
      const descriptor: TaskDescriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        ralphId,
        worktreeId: topWorktree?.id,
        worktreePath: topWorktree?.path,
        outputTable,
        outputTableName,
        outputSchema: raw.outputSchema, // Pass through custom output schema
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

      // Worktree path is captured in typed fields (worktreeId/worktreePath) and
      // consumed by the engine; avoid attaching untyped ad-hoc properties.
      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
    }

    let elementIndex = 0;
    for (const child of node.children) {
      const nextPath =
        child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
      walk(child, {
        path: nextPath,
        iteration,
        ralphId,
        parallelStack: nextParallelStack,
        worktreeStack: nextWorktreeStack,
      });
    }
  }

  walk(root, { path: [], iteration: 0, parallelStack: [], worktreeStack: [] });

  return { xml: toXmlNode(root), tasks, mountedTaskIds };
}
