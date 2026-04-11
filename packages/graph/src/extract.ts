import { isAbsolute, resolve as resolvePath } from "node:path";
import { SmithersError } from "@smithers/core/errors";
import type {
  ExtractOptions,
  HostNode,
  TaskDescriptor,
  WorkflowGraph,
  XmlElement,
  XmlNode,
} from "./types.ts";

const DEFAULT_MERGE_QUEUE_CONCURRENCY = 1;
const WORKTREE_EMPTY_PATH_ERROR = "<Worktree> requires a non-empty path prop";
const DEFAULT_LOCAL_TASK_HEARTBEAT_TIMEOUT_MS = 300_000;
const DEFAULT_SANDBOX_TASK_HEARTBEAT_TIMEOUT_MS = 300_000;

function stablePathId(prefix: string, path: readonly number[]): string {
  if (path.length === 0) return `${prefix}:root`;
  return `${prefix}:${path.join(".")}`;
}

function resolveStableId(
  explicitId: unknown,
  prefix: string,
  path: readonly number[],
): string {
  if (typeof explicitId === "string" && explicitId.trim().length > 0) {
    return explicitId;
  }
  return stablePathId(prefix, path);
}

function isZodObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "shape" in value);
}

function maybeTableName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const symbols = Object.getOwnPropertySymbols(value);
  for (const symbol of symbols) {
    const key = String(symbol);
    if (key.includes("drizzle") || key.includes("Name")) {
      const symbolValue = (value as Record<PropertyKey, unknown>)[symbol];
      if (typeof symbolValue === "string" && symbolValue.length > 0) {
        return symbolValue;
      }
    }
  }
  const named = (value as { readonly name?: unknown }).name;
  return typeof named === "string" && named.length > 0 ? named : undefined;
}

function resolveOutput(raw: Record<string, unknown>): {
  outputTable: unknown | null;
  outputTableName: string;
  outputRef: unknown | undefined;
  outputSchema: unknown | undefined;
} {
  const outputRaw = raw.output;
  if (!outputRaw) {
    return {
      outputTable: null,
      outputTableName: "",
      outputRef: undefined,
      outputSchema: undefined,
    };
  }
  const outputRef = isZodObject(outputRaw) ? outputRaw : undefined;
  const tableName =
    typeof outputRaw === "string" ? outputRaw : maybeTableName(outputRaw) ?? "";
  const outputTable = outputRef ? null : typeof outputRaw === "string" ? null : outputRaw;
  const outputSchema = raw.outputSchema ?? outputRef;
  return {
    outputTable,
    outputTableName: tableName,
    outputRef,
    outputSchema,
  };
}

function parseHeartbeatTimeoutMs(raw: Record<string, unknown>): number | null {
  const candidate =
    typeof raw.heartbeatTimeoutMs === "number"
      ? raw.heartbeatTimeoutMs
      : typeof raw.heartbeatTimeout === "number"
        ? raw.heartbeatTimeout
        : null;
  if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) {
    return null;
  }
  return Math.floor(candidate);
}

function resolveRetryConfig(raw: Record<string, unknown>) {
  const noRetry = Boolean(raw.noRetry);
  const continueOnFail = Boolean(raw.continueOnFail);
  const hasExplicitRetries =
    typeof raw.retries === "number" && !Number.isNaN(raw.retries);
  const hasExplicitRetryPolicy =
    Boolean(raw.retryPolicy && typeof raw.retryPolicy === "object");
  const defaultNoRetryForContinueOnFail =
    continueOnFail && !hasExplicitRetries && !hasExplicitRetryPolicy;
  const retries =
    noRetry || defaultNoRetryForContinueOnFail
      ? 0
      : hasExplicitRetries
        ? (raw.retries as number)
        : Infinity;
  const retryPolicy =
    hasExplicitRetryPolicy
      ? (raw.retryPolicy as TaskDescriptor["retryPolicy"])
      : retries > 0
        ? ({ backoff: "exponential", initialDelayMs: 1000 } as const)
        : undefined;
  return { retries, retryPolicy };
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

function buildLoopScope(
  loopStack: readonly { readonly ralphId: string; readonly iteration: number }[],
): string {
  if (loopStack.length === 0) return "";
  return `@@${loopStack.map((entry) => `${entry.ralphId}=${entry.iteration}`).join(",")}`;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((entry): entry is string => typeof entry === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function needs(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const filtered = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return filtered.length > 0 ? Object.fromEntries(filtered) : undefined;
}

function approvalOptions(value: unknown): TaskDescriptor["approvalOptions"] {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    )
    .map((entry) => ({
      key: typeof entry.key === "string" ? entry.key : "",
      label: typeof entry.label === "string" ? entry.label : "",
      ...(typeof entry.summary === "string" ? { summary: entry.summary } : {}),
      ...(entry.metadata &&
      typeof entry.metadata === "object" &&
      !Array.isArray(entry.metadata)
        ? { metadata: entry.metadata as Record<string, unknown> }
        : {}),
    }))
    .filter((entry) => entry.key.length > 0 && entry.label.length > 0);
  return options.length > 0 ? options : undefined;
}

function approvalAutoApprove(
  value: unknown,
): TaskDescriptor["approvalAutoApprove"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.after === "number" ? { after: raw.after } : {}),
    ...(typeof raw.audit === "boolean" ? { audit: raw.audit } : {}),
    ...(typeof raw.conditionMet === "boolean"
      ? { conditionMet: raw.conditionMet }
      : {}),
    ...(typeof raw.revertOnMet === "boolean"
      ? { revertOnMet: raw.revertOnMet }
      : {}),
  };
}

function pushGroup(
  tag: "parallel" | "merge-queue",
  raw: Record<string, unknown>,
  path: readonly number[],
  stack: readonly { readonly id: string; readonly max?: number }[],
) {
  const id = resolveStableId(raw.id, tag, path);
  const parsed = Number(raw.maxConcurrency);
  const rawMax = Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
  let max: number | undefined;
  if (tag === "merge-queue") {
    max = Math.max(1, rawMax ?? DEFAULT_MERGE_QUEUE_CONCURRENCY);
  } else if (rawMax == null || rawMax <= 0) {
    max = undefined;
  } else {
    max = rawMax;
  }
  return [...stack, { id, max }];
}

function requireTaskId(raw: Record<string, unknown>, kind: string): string {
  if (!raw.id || typeof raw.id !== "string") {
    throw new SmithersError(
      "TASK_ID_REQUIRED",
      `${kind} id is required and must be a string.`,
    );
  }
  return raw.id;
}

function requireOutput(raw: Record<string, unknown>, nodeId: string, kind: string) {
  if (!raw.output) {
    throw new SmithersError(
      "TASK_MISSING_OUTPUT",
      `${kind} ${nodeId} is missing output.`,
      { nodeId },
    );
  }
}

export function extractGraph(
  root: HostNode | null,
  opts?: ExtractOptions,
): WorkflowGraph {
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

  function addDescriptor(
    raw: Record<string, unknown>,
    nodeId: string,
    descriptor: Omit<TaskDescriptor, "ordinal" | "nodeId">,
  ) {
    if (seen.has(nodeId)) {
      throw new SmithersError(
        "DUPLICATE_ID",
        `Duplicate ${String(raw.__smithersKind ?? "Task")} id detected: ${nodeId}`,
        { id: nodeId },
      );
    }
    seen.add(nodeId);
    tasks.push({ nodeId, ordinal: ordinal++, ...descriptor });
    mountedTaskIds.push(`${nodeId}::${descriptor.iteration}`);
  }

  function walk(
    node: HostNode,
    ctx: {
      readonly path: readonly number[];
      readonly iteration: number;
      readonly ralphId?: string;
      readonly parentIsRalph: boolean;
      readonly parallelStack: readonly { readonly id: string; readonly max?: number }[];
      readonly worktreeStack: readonly {
        readonly id: string;
        readonly path: string;
        readonly branch?: string;
        readonly baseBranch?: string;
      }[];
      readonly voiceStack: readonly { readonly provider: unknown; readonly speaker?: string }[];
      readonly loopStack: readonly { readonly ralphId: string; readonly iteration: number }[];
    },
  ) {
    if (node.kind === "text") return;

    const raw = node.rawProps ?? {};
    let iteration = ctx.iteration;
    let ralphId = ctx.ralphId;
    let loopStack = ctx.loopStack;
    let nextParallelStack = ctx.parallelStack;
    let nextWorktreeStack = ctx.worktreeStack;
    let nextVoiceStack = ctx.voiceStack;

    if (node.tag === "smithers:ralph") {
      if (ctx.parentIsRalph) {
        throw new SmithersError("NESTED_LOOP", "Nested <Ralph> is not supported.");
      }
      const logicalId = resolveStableId(raw.id, "ralph", ctx.path);
      const id = logicalId + buildLoopScope(loopStack);
      if (seenRalph.has(id)) {
        throw new SmithersError(
          "DUPLICATE_ID",
          `Duplicate Ralph id detected: ${id}`,
          { kind: "ralph", id },
        );
      }
      seenRalph.add(id);
      ralphId = id;
      iteration = getRalphIteration(opts, id);
      loopStack = [...loopStack, { ralphId: logicalId, iteration }];
    }

    if (node.tag === "smithers:parallel") {
      nextParallelStack = pushGroup("parallel", raw, ctx.path, ctx.parallelStack);
    }
    if (node.tag === "smithers:merge-queue") {
      nextParallelStack = pushGroup(
        "merge-queue",
        raw,
        ctx.path,
        nextParallelStack,
      );
    }
    if (node.tag === "smithers:worktree") {
      const id = resolveStableId(raw.id, "worktree", ctx.path);
      if (seenWorktree.has(id)) {
        throw new SmithersError(
          "DUPLICATE_ID",
          `Duplicate Worktree id detected: ${id}`,
          { kind: "worktree", id },
        );
      }
      seenWorktree.add(id);
      const pathVal = String(raw.path ?? "").trim();
      if (!pathVal) {
        throw new SmithersError("WORKTREE_EMPTY_PATH", WORKTREE_EMPTY_PATH_ERROR);
      }
      const base =
        typeof opts?.baseRootDir === "string" && opts.baseRootDir.length > 0
          ? opts.baseRootDir
          : process.cwd();
      nextWorktreeStack = [
        ...ctx.worktreeStack,
        {
          id,
          path: isAbsolute(pathVal) ? resolvePath(pathVal) : resolvePath(base, pathVal),
          ...(raw.branch ? { branch: String(raw.branch) } : {}),
          ...(raw.baseBranch ? { baseBranch: String(raw.baseBranch) } : {}),
        },
      ];
    }
    if (node.tag === "smithers:voice" && raw.provider) {
      nextVoiceStack = [
        ...ctx.voiceStack,
        {
          provider: raw.provider,
          ...(raw.speaker ? { speaker: String(raw.speaker) } : {}),
        },
      ];
    }

    const ancestorScope =
      loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
    const parallelGroup = nextParallelStack[nextParallelStack.length - 1];
    const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
    const topVoice = nextVoiceStack[nextVoiceStack.length - 1];

    const common = {
      iteration,
      ralphId,
      worktreeId: topWorktree?.id,
      worktreePath: topWorktree?.path,
      worktreeBranch: topWorktree?.branch,
      worktreeBaseBranch: topWorktree?.baseBranch,
      dependsOn: strings(raw.dependsOn),
      needs: needs(raw.needs),
      parallelGroupId: parallelGroup?.id,
      parallelMaxConcurrency: parallelGroup?.max,
    };

    if (node.tag === "smithers:subflow") {
      const logicalNodeId = requireTaskId(raw, "Subflow");
      const mode = raw.__smithersSubflowMode ?? raw.mode ?? "childRun";
      if (mode !== "inline") {
        const nodeId = logicalNodeId + ancestorScope;
        requireOutput(raw, nodeId, "Subflow");
        const { retries, retryPolicy } = resolveRetryConfig(raw);
        const output = resolveOutput(raw);
        addDescriptor(raw, nodeId, {
          ...common,
          ...output,
          needsApproval: false,
          skipIf: Boolean(raw.skipIf),
          retries,
          retryPolicy,
          timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null,
          heartbeatTimeoutMs: parseHeartbeatTimeoutMs(raw),
          continueOnFail: Boolean(raw.continueOnFail),
          cachePolicy:
            raw.cache && typeof raw.cache === "object"
              ? (raw.cache as TaskDescriptor["cachePolicy"])
              : undefined,
          label: typeof raw.label === "string" ? raw.label : undefined,
          meta: {
            ...(raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
              ? (raw.meta as Record<string, unknown>)
              : {}),
            __subflow: true,
            __subflowMode: mode,
            __subflowInput: raw.__smithersSubflowInput,
            __subflowWorkflow: raw.__smithersSubflowWorkflow,
          },
        });
      }
    }

    if (node.tag === "smithers:sandbox") {
      const logicalNodeId = requireTaskId(raw, "Sandbox");
      const nodeId = logicalNodeId + ancestorScope;
      requireOutput(raw, nodeId, "Sandbox");
      const { retries, retryPolicy } = resolveRetryConfig(raw);
      const output = resolveOutput(raw);
      const runtime = raw.__smithersSandboxRuntime ?? raw.runtime ?? "bubblewrap";
      addDescriptor(raw, nodeId, {
        ...common,
        ...output,
        needsApproval: false,
        skipIf: Boolean(raw.skipIf),
        retries,
        retryPolicy,
        timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null,
        heartbeatTimeoutMs:
          parseHeartbeatTimeoutMs(raw) ?? DEFAULT_SANDBOX_TASK_HEARTBEAT_TIMEOUT_MS,
        continueOnFail: Boolean(raw.continueOnFail),
        cachePolicy:
          raw.cache && typeof raw.cache === "object"
            ? (raw.cache as TaskDescriptor["cachePolicy"])
            : undefined,
        label: typeof raw.label === "string" ? raw.label : undefined,
        meta: {
          ...(raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
            ? (raw.meta as Record<string, unknown>)
            : {}),
          __sandbox: true,
          __sandboxRuntime: runtime,
          __sandboxInput: raw.__smithersSandboxInput ?? raw.input,
        },
      });
      return;
    }

    if (node.tag === "smithers:wait-for-event") {
      const logicalNodeId = requireTaskId(raw, "WaitForEvent");
      const nodeId = logicalNodeId + ancestorScope;
      requireOutput(raw, nodeId, "WaitForEvent");
      const output = resolveOutput(raw);
      const onTimeout = raw.__smithersOnTimeout ?? raw.onTimeout ?? "fail";
      addDescriptor(raw, nodeId, {
        ...common,
        ...output,
        needsApproval: false,
        waitAsync: Boolean(raw.waitAsync),
        skipIf: Boolean(raw.skipIf),
        retries: 0,
        timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null,
        heartbeatTimeoutMs: parseHeartbeatTimeoutMs(raw),
        continueOnFail: onTimeout === "continue" || onTimeout === "skip",
        label: typeof raw.label === "string" ? raw.label : undefined,
        meta: {
          ...(raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
            ? (raw.meta as Record<string, unknown>)
            : {}),
          __waitForEvent: true,
          __eventName: raw.__smithersEventName ?? raw.event,
          __correlationId: raw.__smithersCorrelationId ?? raw.correlationId,
          __onTimeout: onTimeout,
        },
      });
    }

    if (node.tag === "smithers:timer") {
      const logicalNodeId = requireTaskId(raw, "Timer");
      if (logicalNodeId.length > 256) {
        throw new SmithersError(
          "INVALID_INPUT",
          `Timer id must be 256 characters or fewer (received ${logicalNodeId.length}).`,
          { nodeId: logicalNodeId, maxLength: 256 },
        );
      }
      const nodeId = logicalNodeId + ancestorScope;
      const duration =
        typeof (raw.__smithersTimerDuration ?? raw.duration) === "string"
          ? String(raw.__smithersTimerDuration ?? raw.duration).trim()
          : "";
      const untilRaw = raw.__smithersTimerUntil ?? raw.until;
      const until =
        typeof untilRaw === "string"
          ? untilRaw.trim()
          : untilRaw instanceof Date
            ? untilRaw.toISOString()
            : "";
      const hasDuration = duration.length > 0;
      const hasUntil = until.length > 0;
      if ((hasDuration ? 1 : 0) + (hasUntil ? 1 : 0) !== 1) {
        throw new SmithersError(
          "INVALID_INPUT",
          `Timer ${nodeId} must define exactly one of duration or until.`,
          { nodeId, duration: raw.duration, until: raw.until },
        );
      }
      if (raw.every !== undefined) {
        throw new SmithersError(
          "INVALID_INPUT",
          `Timer ${nodeId} uses every=, but recurring timers are not supported yet.`,
          { nodeId, every: raw.every },
        );
      }
      addDescriptor(raw, nodeId, {
        ...common,
        outputTable: null,
        outputTableName: "",
        outputRef: undefined,
        outputSchema: undefined,
        needsApproval: false,
        skipIf: Boolean(raw.skipIf),
        retries: 0,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        label: typeof raw.label === "string" ? raw.label : `timer:${nodeId}`,
        meta: {
          ...(raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
            ? (raw.meta as Record<string, unknown>)
            : {}),
          __timer: true,
          __timerType: hasDuration ? "duration" : "absolute",
          ...(hasDuration ? { __timerDuration: duration } : {}),
          ...(hasUntil ? { __timerUntil: until } : {}),
        },
      });
    }

    if (node.tag === "smithers:saga") {
      const id = resolveStableId(raw.id, "saga", ctx.path);
      if (seenSaga.has(id)) {
        throw new SmithersError(
          "DUPLICATE_ID",
          `Duplicate Saga id detected: ${id}`,
          { kind: "saga", id },
        );
      }
      seenSaga.add(id);
    }

    if (node.tag === "smithers:try-catch-finally") {
      const id = resolveStableId(raw.id, "tcf", ctx.path);
      if (seenTcf.has(id)) {
        throw new SmithersError(
          "DUPLICATE_ID",
          `Duplicate TryCatchFinally id detected: ${id}`,
          { kind: "try-catch-finally", id },
        );
      }
      seenTcf.add(id);
    }

    if (node.tag === "smithers:task") {
      const logicalNodeId = requireTaskId(raw, "Task");
      const nodeId = logicalNodeId + ancestorScope;
      requireOutput(raw, nodeId, "Task");
      const output = resolveOutput(raw);
      const approvalMode =
        raw.approvalMode === "decision" ||
        raw.approvalMode === "select" ||
        raw.approvalMode === "rank"
          ? raw.approvalMode
          : "gate";
      const approvalOnDeny =
        raw.approvalOnDeny === "continue" ||
        raw.approvalOnDeny === "skip" ||
        raw.approvalOnDeny === "fail"
          ? raw.approvalOnDeny
          : undefined;
      const { retries, retryPolicy } = resolveRetryConfig(raw);
      const kind = raw.__smithersKind;
      const isAgent = kind === "agent" || Boolean(raw.agent);
      const isCompute =
        kind === "compute" && typeof raw.__smithersComputeFn === "function";
      const parsedHeartbeatTimeoutMs = parseHeartbeatTimeoutMs(raw);
      const heartbeatTimeoutMs =
        parsedHeartbeatTimeoutMs ??
        (isAgent ? DEFAULT_LOCAL_TASK_HEARTBEAT_TIMEOUT_MS : null);
      const prompt = isAgent ? String(raw.children ?? "") : undefined;
      if (prompt === "[object Object]") {
        throw new SmithersError(
          "MDX_PRELOAD_INACTIVE",
          `Task "${logicalNodeId}" prompt resolved to [object Object].`,
        );
      }
      addDescriptor(raw, nodeId, {
        ...common,
        ...output,
        needsApproval: Boolean(raw.needsApproval),
        waitAsync: Boolean(raw.waitAsync),
        approvalMode,
        approvalOnDeny,
        approvalOptions: approvalOptions(raw.approvalOptions),
        approvalAllowedScopes: strings(raw.approvalAllowedScopes),
        approvalAllowedUsers: strings(raw.approvalAllowedUsers),
        approvalAutoApprove: approvalAutoApprove(raw.approvalAutoApprove),
        skipIf: Boolean(raw.skipIf),
        retries,
        retryPolicy,
        timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null,
        heartbeatTimeoutMs,
        continueOnFail: Boolean(raw.continueOnFail),
        cachePolicy:
          raw.cache && typeof raw.cache === "object"
            ? (raw.cache as TaskDescriptor["cachePolicy"])
            : undefined,
        agent: raw.agent as TaskDescriptor["agent"],
        prompt,
        staticPayload:
          isAgent || isCompute
            ? undefined
            : (raw.__smithersPayload ?? raw.__payload ?? raw.children),
        computeFn: isCompute
          ? (raw.__smithersComputeFn as TaskDescriptor["computeFn"])
          : undefined,
        label: typeof raw.label === "string" ? raw.label : undefined,
        meta:
          raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
            ? (raw.meta as Record<string, unknown>)
            : undefined,
        scorers:
          raw.scorers && typeof raw.scorers === "object" && !Array.isArray(raw.scorers)
            ? (raw.scorers as Record<string, unknown>)
            : undefined,
        voice: topVoice?.provider,
        voiceSpeaker: topVoice?.speaker,
        memoryConfig:
          raw.memory && typeof raw.memory === "object" && !Array.isArray(raw.memory)
            ? (raw.memory as Record<string, unknown>)
            : undefined,
      });
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

  walk(root, {
    path: [],
    iteration: 0,
    parentIsRalph: false,
    parallelStack: [],
    worktreeStack: [],
    voiceStack: [],
    loopStack: [],
  });

  return { xml: toXmlNode(root), tasks, mountedTaskIds };
}

export const extractFromHost = extractGraph;
