import type { XmlNode, XmlElement } from "../XmlNode";
import type { TaskDescriptor } from "../TaskDescriptor";
import type { VoiceProvider } from "../voice/types";
import { resolveStableId } from "../utils/tree-ids";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { getTableName } from "drizzle-orm";
import {
  DEFAULT_MERGE_QUEUE_CONCURRENCY,
  WORKTREE_EMPTY_PATH_ERROR,
} from "../constants";
import { SmithersError } from "../utils/errors";

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
  const seenSaga = new Set<string>();
  const seenTcf = new Set<string>();
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

  function buildLoopScope(
    loopStack: { ralphId: string; iteration: number }[],
  ): string {
    if (loopStack.length === 0) return "";
    return (
      "@@" +
      loopStack.map((l) => `${l.ralphId}=${l.iteration}`).join(",")
    );
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
      worktreeStack: { id: string; path: string; branch?: string; baseBranch?: string }[];
      /** Stack of active <Voice> contexts (outermost -> innermost). */
      voiceStack: { provider: VoiceProvider; speaker?: string }[];
      /** Stack of ancestor loop scopes (outermost -> innermost). */
      loopStack: { ralphId: string; iteration: number }[];
    },
  ) {
    if (node.kind === "text") return;

    let iteration = ctx.iteration;
    const parallelStack = ctx.parallelStack;
    let ralphId = ctx.ralphId;
    const worktreeStack = ctx.worktreeStack;
    let voiceStack = ctx.voiceStack;
    let loopStack = ctx.loopStack;

    if (node.tag === "smithers:ralph") {
      if (ctx.parentIsRalph) {
        throw new SmithersError("NESTED_LOOP", "Nested <Ralph> is not supported.");
      }
      const logicalId = resolveStableId(node.rawProps?.id, "ralph", ctx.path);
      // Scope ralph ID by ancestor loop iterations for nested loops
      const scope = buildLoopScope(loopStack);
      const id = logicalId + scope;
      if (seenRalph.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Ralph id detected: ${id}`, { kind: "ralph", id });
      }
      seenRalph.add(id);
      ralphId = id;
      iteration = getRalphIteration(opts, id);
      // Push this loop onto the stack for children
      loopStack = [...loopStack, { ralphId: logicalId, iteration }];
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
        throw new SmithersError("DUPLICATE_ID", `Duplicate Worktree id detected: ${id}`, { kind: "worktree", id });
      }
      seenWorktree.add(id);
      let pathVal = String(node.rawProps?.path ?? "").trim();
      if (!pathVal) {
        throw new SmithersError("WORKTREE_EMPTY_PATH", WORKTREE_EMPTY_PATH_ERROR);
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
      const baseBranch = node.rawProps?.baseBranch ? String(node.rawProps.baseBranch) : undefined;
      nextWorktreeStack = [...worktreeStack, { id, path: normPath, branch, baseBranch }];
    }
    // Entering a Voice node: push onto the voice stack
    let nextVoiceStack = voiceStack;
    if (node.tag === "smithers:voice") {
      const voiceProvider = node.rawProps?.provider as VoiceProvider | undefined;
      if (voiceProvider) {
        const voiceSpeaker = node.rawProps?.speaker ? String(node.rawProps.speaker) : undefined;
        nextVoiceStack = [...voiceStack, { provider: voiceProvider, speaker: voiceSpeaker }];
      }
    }
    if (node.tag === "smithers:subflow") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "Subflow id is required and must be a string.");
      }
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Subflow id detected: ${nodeId}`, { kind: "subflow", id: nodeId });
      }
      seen.add(nodeId);

      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `Subflow ${nodeId} is missing output.`, { nodeId });
      }
      const outputTable: any = isDrizzleTable(outputRaw) ? outputRaw : null;
      const outputTableName = outputTable
        ? getTableName(outputTable)
        : typeof outputRaw === "string"
          ? outputRaw
          : "";
      const outputRef = !outputTable && isZodObject(outputRaw) ? outputRaw : undefined;
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
      const dependsOn = Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter((v: unknown) => typeof v === "string")
        : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? (Object.fromEntries(
              Object.entries(raw.needs).filter(
                ([, v]) => typeof v === "string",
              ),
            ) as Record<string, string>)
          : undefined;

      const mode = raw.__smithersSubflowMode ?? raw.mode ?? "childRun";
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
        worktreeBaseBranch: topWorktree?.baseBranch,
        outputTable,
        outputTableName,
        outputRef,
        outputSchema: undefined,
        dependsOn,
        needs,
        needsApproval: false,
        skipIf: Boolean(raw.skipIf),
        retries,
        retryPolicy,
        timeoutMs,
        continueOnFail,
        cachePolicy,
        agent: undefined,
        prompt: undefined,
        staticPayload: undefined,
        computeFn: raw.__smithersSubflowWorkflow,
        label: raw.label,
        meta: {
          ...(raw.meta ?? {}),
          __subflow: true,
          __subflowMode: mode,
          __subflowInput: raw.__smithersSubflowInput,
        },
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
      };

      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
    }
    if (node.tag === "smithers:wait-for-event") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "WaitForEvent id is required and must be a string.");
      }
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate WaitForEvent id detected: ${nodeId}`, { kind: "wait-for-event", id: nodeId });
      }
      seen.add(nodeId);

      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `WaitForEvent ${nodeId} is missing output.`, { nodeId });
      }
      const outputTable: any = isDrizzleTable(outputRaw) ? outputRaw : null;
      const outputTableName = outputTable
        ? getTableName(outputTable)
        : typeof outputRaw === "string"
          ? outputRaw
          : "";
      const outputRef = !outputTable && isZodObject(outputRaw) ? outputRaw : undefined;
      const outputSchema = raw.outputSchema ?? outputRef;
      const timeoutMs =
        typeof raw.timeoutMs === "number" ? raw.timeoutMs : null;
      const dependsOn = Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter((v: unknown) => typeof v === "string")
        : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? (Object.fromEntries(
              Object.entries(raw.needs).filter(
                ([, v]) => typeof v === "string",
              ),
            ) as Record<string, string>)
          : undefined;

      const onTimeout = raw.__smithersOnTimeout ?? raw.onTimeout ?? "fail";
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
        worktreeBaseBranch: topWorktree?.baseBranch,
        outputTable,
        outputTableName,
        outputRef,
        outputSchema,
        dependsOn,
        needs,
        needsApproval: false,
        skipIf: Boolean(raw.skipIf),
        retries: 0,
        timeoutMs,
        continueOnFail: onTimeout === "continue" || onTimeout === "skip",
        agent: undefined,
        prompt: undefined,
        staticPayload: undefined,
        computeFn: undefined,
        label: raw.label,
        meta: {
          ...(raw.meta ?? {}),
          __waitForEvent: true,
          __eventName: raw.__smithersEventName ?? raw.event,
          __correlationId: raw.__smithersCorrelationId ?? raw.correlationId,
          __onTimeout: onTimeout,
        },
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
      };

      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
    }
    // Track Saga nodes for duplicate detection
    if (node.tag === "smithers:saga") {
      const id = resolveStableId(node.rawProps?.id, "saga", ctx.path);
      if (seenSaga.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Saga id detected: ${id}`, { kind: "saga", id });
      }
      seenSaga.add(id);
    }
    // Track TryCatchFinally nodes for duplicate detection
    if (node.tag === "smithers:try-catch-finally") {
      const id = resolveStableId(node.rawProps?.id, "tcf", ctx.path);
      if (seenTcf.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate TryCatchFinally id detected: ${id}`, { kind: "try-catch-finally", id });
      }
      seenTcf.add(id);
    }
    if (node.tag === "smithers:task") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "Task id is required and must be a string.");
      }
      // Scope task nodeId by ancestor loops (all except the innermost, which
      // is already captured by desc.iteration).
      const ancestorScope =
        loopStack.length > 1
          ? buildLoopScope(loopStack.slice(0, -1))
          : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Task id detected: ${nodeId}`, { kind: "task", id: nodeId });
      }
      seen.add(nodeId);

      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `Task ${nodeId} is missing output.`, { nodeId });
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
        throw new SmithersError(
          "MDX_PRELOAD_INACTIVE",
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
      const topVoice = nextVoiceStack[nextVoiceStack.length - 1];
      const descriptor: TaskDescriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        ralphId,
        worktreeId: topWorktree?.id,
        worktreePath: topWorktree?.path,
        worktreeBranch: topWorktree?.branch,
        worktreeBaseBranch: topWorktree?.baseBranch,
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
        scorers: raw.scorers,
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
        voice: topVoice?.provider,
        voiceSpeaker: topVoice?.speaker,
        memoryConfig: raw.memory ?? undefined,
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
        voiceStack: nextVoiceStack,
        loopStack,
      });
    }
  }

  walk(root, { path: [], iteration: 0, parentIsRalph: false, parallelStack: [], worktreeStack: [], voiceStack: [], loopStack: [] });

  return { xml: toXmlNode(root), tasks, mountedTaskIds };
}
