import type { XmlNode, XmlElement } from "../XmlNode";
import type { TaskDescriptor } from "../TaskDescriptor";
import { resolveStableId } from "../utils/tree-ids";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { getTableName } from "drizzle-orm";
import {
  DEFAULT_MERGE_QUEUE_CONCURRENCY,
  WORKTREE_EMPTY_PATH_ERROR,
} from "../constants";

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

function isDrizzleTable(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  try {
    const name = getTableName(value as any);
    return typeof name === "string" && name.length > 0;
  } catch {
    return false;
  }
}

function isZodObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "shape" in (value as any));
}

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

  function pushGroup(
    tag: "parallel" | "merge-queue",
    raw: any,
    path: number[],
    stack: { id: string; max?: number }[],
  ) {
    const id = resolveStableId(raw?.id, tag, path);
    // Coerce numeric strings (e.g. from MDX) in line with scheduler.parseNum
    const n = Number(raw?.maxConcurrency);
    const rawMax = Number.isFinite(n) ? Math.floor(n) : undefined;
    // Concurrency semantics:
    // - merge-queue: default to 1 and always clamp to >= 1
    // - parallel: undefined => unlimited; <= 0 => unlimited; fractional floored
    let max: number | undefined;
    if (tag === "merge-queue") {
      const base = rawMax ?? DEFAULT_MERGE_QUEUE_CONCURRENCY;
      max = Math.max(1, base);
    } else {
      if (rawMax == null) {
        max = undefined;
      } else if (rawMax <= 0) {
        max = undefined; // unbounded for non-positive values
      } else {
        max = rawMax; // positive integer; fractional already floored
      }
    }
    return [...stack, { id, max }];
  }

  function walk(
    node: HostNode,
    ctx: {
      path: number[];
      iteration: number;
      ralphId?: string;
      parentIsRalph: boolean;
      parallelStack: { id: string; max?: number }[];
      /**
       * Stack of active <Worktree> contexts (outermost -> innermost).
       * The top of the stack controls the effective root override for tasks.
       */
      worktreeStack: { id: string; path: string; branch?: string }[];
    },
  ) {
    if (node.kind === "text") return;

    let iteration = ctx.iteration;
    const parallelStack = ctx.parallelStack;
    let ralphId = ctx.ralphId;
    const worktreeStack = ctx.worktreeStack;

    if (node.tag === "smithers:ralph") {
      if (ctx.parentIsRalph) {
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
      nextParallelStack = pushGroup(
        "parallel",
        node.rawProps,
        ctx.path,
        parallelStack,
      );
    }
    // Treat <MergeQueue> as a parallel-concurrency group with default 1
    if (node.tag === "smithers:merge-queue") {
      nextParallelStack = pushGroup(
        "merge-queue",
        node.rawProps,
        ctx.path,
        nextParallelStack,
      );
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
        throw new Error(WORKTREE_EMPTY_PATH_ERROR);
      }
      const baseRoot = opts?.baseRootDir;
      const base =
        typeof baseRoot === "string" && baseRoot.length > 0
          ? baseRoot
          : process.cwd();
      const normPath = isAbsolute(pathVal)
        ? resolvePath(pathVal)
        : resolvePath(base, pathVal);
      const branch = node.rawProps?.branch ? String(node.rawProps.branch) : undefined;
      nextWorktreeStack = [...worktreeStack, { id, path: normPath, branch }];
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
        throw new Error(`Task ${nodeId} is missing output.`);
      }

      const outputTable: any = isDrizzleTable(outputRaw) ? outputRaw : null;
      const outputTableName = outputTable
        ? getTableName(outputTable)
        : typeof outputRaw === "string"
          ? outputRaw
          : "";
      const outputRef = !outputTable && isZodObject(outputRaw) ? outputRaw : undefined;
      const outputSchema = raw.outputSchema ?? outputRef;
      const needsApproval = Boolean(raw.needsApproval);
      const approvalMode =
        raw.approvalMode === "decision" ? "decision" : "gate";
      const approvalOnDeny =
        raw.approvalOnDeny === "continue" ||
        raw.approvalOnDeny === "skip" ||
        raw.approvalOnDeny === "fail"
          ? raw.approvalOnDeny
          : undefined;
      const skipIf = Boolean(raw.skipIf);
      const retries = typeof raw.retries === "number" ? raw.retries : 0;
      const retryPolicy =
        raw.retryPolicy && typeof raw.retryPolicy === "object"
          ? raw.retryPolicy
          : undefined;
      const timeoutMs =
        typeof raw.timeoutMs === "number" ? raw.timeoutMs : null;
      const continueOnFail = Boolean(raw.continueOnFail);
      const cachePolicy =
        raw.cache && typeof raw.cache === "object" ? raw.cache : undefined;

      const agent = raw.agent;
      const kind = raw.__smithersKind;
      const isAgent = kind === "agent" || Boolean(agent);
      const prompt = isAgent ? String(raw.children ?? "") : undefined;
      if (prompt === "[object Object]") {
        throw new Error(
          `Task "${raw.id ?? nodeId}" prompt resolved to [object Object] — MDX preload is likely not active.\n` +
            `Check that bunfig.toml has a top-level preload (not under [run]) and mdxPlugin() is registered.`,
        );
      }
      const isCompute = kind === "compute" && typeof raw.__smithersComputeFn === "function";
      const computeFn = isCompute ? raw.__smithersComputeFn : undefined;
      const staticPayload = isAgent || isCompute
        ? undefined
        : (raw.__smithersPayload ?? raw.__payload ?? raw.children);
      const dependsOn = Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter((value: unknown) => typeof value === "string")
        : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? (Object.fromEntries(
              Object.entries(raw.needs).filter(
                ([, value]) => typeof value === "string",
              ),
            ) as Record<string, string>)
          : undefined;

      const parallelGroup = nextParallelStack[nextParallelStack.length - 1];

      const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
      const descriptor: TaskDescriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        ralphId,
        worktreeId: topWorktree?.id,
        worktreePath: topWorktree?.path,
        worktreeBranch: topWorktree?.branch,
        outputTable,
        outputTableName,
        outputRef,
        outputSchema,
        dependsOn,
        needs,
        needsApproval,
        approvalMode,
        approvalOnDeny,
        skipIf,
        retries,
        retryPolicy,
        timeoutMs,
        continueOnFail,
        cachePolicy,
        agent,
        prompt,
        staticPayload,
        computeFn,
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
        parentIsRalph: node.tag === "smithers:ralph",
        parallelStack: nextParallelStack,
        worktreeStack: nextWorktreeStack,
      });
    }
  }

  walk(root, { path: [], iteration: 0, parentIsRalph: false, parallelStack: [], worktreeStack: [] });

  return { xml: toXmlNode(root), tasks, mountedTaskIds };
}
