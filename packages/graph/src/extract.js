import { isAbsolute, resolve as resolvePath } from "node:path";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./XmlNode.ts").XmlNode} XmlNode */
/** @typedef {import("./ExtractOptions.ts").ExtractOptions} ExtractOptions */
/** @typedef {import("./HostNode.ts").HostNode} HostNode */
/** @typedef {import("./WorkflowGraph.ts").WorkflowGraph} WorkflowGraph */

const DEFAULT_MERGE_QUEUE_CONCURRENCY = 1;
const WORKTREE_EMPTY_PATH_ERROR = "<Worktree> requires a non-empty path prop";
const DEFAULT_LOCAL_TASK_HEARTBEAT_TIMEOUT_MS = 300_000;
const DEFAULT_SANDBOX_TASK_HEARTBEAT_TIMEOUT_MS = 300_000;
/**
 * @param {string} prefix
 * @param {readonly number[]} path
 * @returns {string}
 */
function stablePathId(prefix, path) {
    if (path.length === 0)
        return `${prefix}:root`;
    return `${prefix}:${path.join(".")}`;
}
/**
 * @param {unknown} explicitId
 * @param {string} prefix
 * @param {readonly number[]} path
 * @returns {string}
 */
function resolveStableId(explicitId, prefix, path) {
    if (typeof explicitId === "string" && explicitId.trim().length > 0) {
        return explicitId;
    }
    return stablePathId(prefix, path);
}
/**
 * @param {unknown} value
 * @returns {value is import("zod").ZodObject<any>}
 */
function isZodObject(value) {
    return Boolean(value && typeof value === "object" && "shape" in value);
}
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function maybeTableName(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const symbols = Object.getOwnPropertySymbols(value);
    for (const symbol of symbols) {
        const key = String(symbol);
        if (key.includes("drizzle") || key.includes("Name")) {
            const symbolValue = value[symbol];
            if (typeof symbolValue === "string" && symbolValue.length > 0) {
                return symbolValue;
            }
        }
    }
    const named = value.name;
    return typeof named === "string" && named.length > 0 ? named : undefined;
}
/**
 * @param {Record<string, unknown>} raw
 * @returns {{ outputTable: unknown | null; outputTableName: string; outputRef: import("zod").ZodObject<any> | undefined; outputSchema: import("zod").ZodObject<any> | undefined; }}
 */
function resolveOutput(raw) {
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
    const tableName = typeof outputRaw === "string" ? outputRaw : maybeTableName(outputRaw) ?? "";
    const outputTable = outputRef ? null : typeof outputRaw === "string" ? null : outputRaw;
    const outputSchema = isZodObject(raw.outputSchema) ? raw.outputSchema : outputRef;
    return {
        outputTable,
        outputTableName: tableName,
        outputRef,
        outputSchema,
    };
}
/**
 * @param {Record<string, unknown>} raw
 * @returns {number | null}
 */
function parseHeartbeatTimeoutMs(raw) {
    const candidate = typeof raw.heartbeatTimeoutMs === "number"
        ? raw.heartbeatTimeoutMs
        : typeof raw.heartbeatTimeout === "number"
            ? raw.heartbeatTimeout
            : null;
    if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) {
        return null;
    }
    return Math.floor(candidate);
}
/**
 * @param {Record<string, unknown>} raw
 */
function resolveRetryConfig(raw) {
    const noRetry = Boolean(raw.noRetry);
    const continueOnFail = Boolean(raw.continueOnFail);
    const hasExplicitRetries = typeof raw.retries === "number" && !Number.isNaN(raw.retries);
    const hasExplicitRetryPolicy = Boolean(raw.retryPolicy && typeof raw.retryPolicy === "object");
    const defaultNoRetryForContinueOnFail = continueOnFail && !hasExplicitRetries && !hasExplicitRetryPolicy;
    const retries = noRetry || defaultNoRetryForContinueOnFail
        ? 0
        : hasExplicitRetries
            ? raw.retries
            : Infinity;
    const retryPolicy = hasExplicitRetryPolicy
        ? raw.retryPolicy
        : retries > 0
            ? { backoff: "exponential", initialDelayMs: 1000 }
            : undefined;
    return { retries, retryPolicy };
}
/**
 * @param {HostNode} node
 * @returns {XmlNode}
 */
function toXmlNode(node) {
    if (node.kind === "text") {
        return { kind: "text", text: node.text };
    }
    const element = {
        kind: "element",
        tag: node.tag,
        props: node.props ?? {},
        children: node.children.map(toXmlNode),
    };
    return element;
}
/**
 * @param {ExtractOptions | undefined} opts
 * @param {string} id
 * @returns {number}
 */
function getRalphIteration(opts, id) {
    const map = opts?.ralphIterations;
    const fallback = typeof opts?.defaultIteration === "number" ? opts.defaultIteration : 0;
    if (!map)
        return fallback;
    if (map instanceof Map) {
        return map.get(id) ?? fallback;
    }
    const value = map[id];
    return typeof value === "number" ? value : fallback;
}
/**
 * @param {readonly { readonly ralphId: string; readonly iteration: number }[]} loopStack
 * @returns {string}
 */
function buildLoopScope(loopStack) {
    if (loopStack.length === 0)
        return "";
    return `@@${loopStack.map((entry) => `${entry.ralphId}=${entry.iteration}`).join(",")}`;
}
/**
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function strings(value) {
    if (!Array.isArray(value))
        return undefined;
    const filtered = value.filter((entry) => typeof entry === "string");
    return filtered.length > 0 ? filtered : undefined;
}
/**
 * @param {unknown} value
 * @returns {Record<string, string> | undefined}
 */
function needs(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const filtered = Object.entries(value).filter((entry) => typeof entry[1] === "string");
    return filtered.length > 0 ? Object.fromEntries(filtered) : undefined;
}
/**
 * @param {unknown} value
 * @returns {TaskDescriptor["approvalOptions"]}
 */
function approvalOptions(value) {
    if (!Array.isArray(value))
        return undefined;
    const options = value
        .filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        .map((entry) => ({
        key: typeof entry.key === "string" ? entry.key : "",
        label: typeof entry.label === "string" ? entry.label : "",
        ...(typeof entry.summary === "string" ? { summary: entry.summary } : {}),
        ...(entry.metadata &&
            typeof entry.metadata === "object" &&
            !Array.isArray(entry.metadata)
            ? { metadata: entry.metadata }
            : {}),
    }))
        .filter((entry) => entry.key.length > 0 && entry.label.length > 0);
    return options.length > 0 ? options : undefined;
}
/**
 * @param {unknown} value
 * @returns {TaskDescriptor["approvalAutoApprove"]}
 */
function approvalAutoApprove(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const raw = value;
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
/**
 * @param {"parallel" | "merge-queue"} tag
 * @param {Record<string, unknown>} raw
 * @param {readonly number[]} path
 * @param {readonly { readonly id: string; readonly max?: number }[]} stack
 */
function pushGroup(tag, raw, path, stack) {
    const id = resolveStableId(raw.id, tag, path);
    const parsed = Number(raw.maxConcurrency);
    const rawMax = Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
    let max;
    if (tag === "merge-queue") {
        max = Math.max(1, rawMax ?? DEFAULT_MERGE_QUEUE_CONCURRENCY);
    }
    else if (rawMax == null || rawMax <= 0) {
        max = undefined;
    }
    else {
        max = rawMax;
    }
    return [...stack, { id, max }];
}
/**
 * @param {Record<string, unknown>} raw
 * @param {string} kind
 * @returns {string}
 */
function requireTaskId(raw, kind) {
    if (!raw.id || typeof raw.id !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", `${kind} id is required and must be a string.`);
    }
    return raw.id;
}
/**
 * @param {Record<string, unknown>} raw
 * @param {string} nodeId
 * @param {string} kind
 */
function requireOutput(raw, nodeId, kind) {
    if (!raw.output) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `${kind} ${nodeId} is missing output.`, { nodeId });
    }
}
/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {WorkflowGraph}
 */
export function extractGraph(root, opts) {
    if (!root) {
        return { xml: null, tasks: [], mountedTaskIds: [] };
    }
    const tasks = [];
    const mountedTaskIds = [];
    const seen = new Set();
    const seenRalph = new Set();
    const seenWorktree = new Set();
    const seenSaga = new Set();
    const seenTcf = new Set();
    let ordinal = 0;
    /**
   * @param {Record<string, unknown>} raw
   * @param {string} nodeId
   * @param {Omit<TaskDescriptor, "ordinal" | "nodeId">} descriptor
   */
    function addDescriptor(raw, nodeId, descriptor) {
        if (seen.has(nodeId)) {
            throw new SmithersError("DUPLICATE_ID", `Duplicate ${String(raw.__smithersKind ?? "Task")} id detected: ${nodeId}`, { id: nodeId });
        }
        seen.add(nodeId);
        tasks.push({ nodeId, ordinal: ordinal++, ...descriptor });
        mountedTaskIds.push(`${nodeId}::${descriptor.iteration}`);
    }
    /**
   * @param {HostNode} node
   * @param {{ readonly path: readonly number[]; readonly iteration: number; readonly ralphId?: string; readonly parentIsRalph: boolean; readonly parallelStack: readonly { readonly id: string; readonly max?: number }[]; readonly worktreeStack: readonly { readonly id: string; readonly path: string; readonly branch?: string; readonly baseBranch?: string; }[]; readonly loopStack: readonly { readonly ralphId: string; readonly iteration: number }[]; }} ctx
   */
    function walk(node, ctx) {
        if (node.kind === "text")
            return;
        const raw = node.rawProps ?? {};
        let iteration = ctx.iteration;
        let ralphId = ctx.ralphId;
        let loopStack = ctx.loopStack;
        let nextParallelStack = ctx.parallelStack;
        let nextWorktreeStack = ctx.worktreeStack;
        if (node.tag === "smithers:ralph") {
            if (ctx.parentIsRalph) {
                throw new SmithersError("NESTED_LOOP", "Nested <Ralph> is not supported.");
            }
            const logicalId = resolveStableId(raw.id, "ralph", ctx.path);
            const id = logicalId + buildLoopScope(loopStack);
            if (seenRalph.has(id)) {
                throw new SmithersError("DUPLICATE_ID", `Duplicate Ralph id detected: ${id}`, { kind: "ralph", id });
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
            nextParallelStack = pushGroup("merge-queue", raw, ctx.path, nextParallelStack);
        }
        if (node.tag === "smithers:worktree") {
            const id = resolveStableId(raw.id, "worktree", ctx.path);
            if (seenWorktree.has(id)) {
                throw new SmithersError("DUPLICATE_ID", `Duplicate Worktree id detected: ${id}`, { kind: "worktree", id });
            }
            seenWorktree.add(id);
            const pathVal = String(raw.path ?? "").trim();
            if (!pathVal) {
                throw new SmithersError("WORKTREE_EMPTY_PATH", WORKTREE_EMPTY_PATH_ERROR);
            }
            const base = typeof opts?.baseRootDir === "string" && opts.baseRootDir.length > 0
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
        const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
        const parallelGroup = nextParallelStack[nextParallelStack.length - 1];
        const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
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
                    cachePolicy: raw.cache && typeof raw.cache === "object"
                        ? raw.cache
                        : undefined,
                    label: typeof raw.label === "string" ? raw.label : undefined,
                    meta: {
                        ...(raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
                            ? raw.meta
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
                heartbeatTimeoutMs: parseHeartbeatTimeoutMs(raw) ?? DEFAULT_SANDBOX_TASK_HEARTBEAT_TIMEOUT_MS,
                continueOnFail: Boolean(raw.continueOnFail),
                cachePolicy: raw.cache && typeof raw.cache === "object"
                    ? raw.cache
                    : undefined,
                label: typeof raw.label === "string" ? raw.label : undefined,
                meta: {
                    ...(raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
                        ? raw.meta
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
                        ? raw.meta
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
                throw new SmithersError("INVALID_INPUT", `Timer id must be 256 characters or fewer (received ${logicalNodeId.length}).`, { nodeId: logicalNodeId, maxLength: 256 });
            }
            const nodeId = logicalNodeId + ancestorScope;
            const duration = typeof (raw.__smithersTimerDuration ?? raw.duration) === "string"
                ? String(raw.__smithersTimerDuration ?? raw.duration).trim()
                : "";
            const untilRaw = raw.__smithersTimerUntil ?? raw.until;
            const until = typeof untilRaw === "string"
                ? untilRaw.trim()
                : untilRaw instanceof Date
                    ? untilRaw.toISOString()
                    : "";
            const hasDuration = duration.length > 0;
            const hasUntil = until.length > 0;
            if ((hasDuration ? 1 : 0) + (hasUntil ? 1 : 0) !== 1) {
                throw new SmithersError("INVALID_INPUT", `Timer ${nodeId} must define exactly one of duration or until.`, { nodeId, duration: raw.duration, until: raw.until });
            }
            if (raw.every !== undefined) {
                throw new SmithersError("INVALID_INPUT", `Timer ${nodeId} uses every=, but recurring timers are not supported yet.`, { nodeId, every: raw.every });
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
                        ? raw.meta
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
                throw new SmithersError("DUPLICATE_ID", `Duplicate Saga id detected: ${id}`, { kind: "saga", id });
            }
            seenSaga.add(id);
        }
        if (node.tag === "smithers:try-catch-finally") {
            const id = resolveStableId(raw.id, "tcf", ctx.path);
            if (seenTcf.has(id)) {
                throw new SmithersError("DUPLICATE_ID", `Duplicate TryCatchFinally id detected: ${id}`, { kind: "try-catch-finally", id });
            }
            seenTcf.add(id);
        }
        if (node.tag === "smithers:task") {
            const logicalNodeId = requireTaskId(raw, "Task");
            const nodeId = logicalNodeId + ancestorScope;
            requireOutput(raw, nodeId, "Task");
            const output = resolveOutput(raw);
            const approvalMode = raw.approvalMode === "decision" ||
                raw.approvalMode === "select" ||
                raw.approvalMode === "rank"
                ? raw.approvalMode
                : "gate";
            const approvalOnDeny = raw.approvalOnDeny === "continue" ||
                raw.approvalOnDeny === "skip" ||
                raw.approvalOnDeny === "fail"
                ? raw.approvalOnDeny
                : undefined;
            const { retries, retryPolicy } = resolveRetryConfig(raw);
            const kind = raw.__smithersKind;
            const isAgent = kind === "agent" || Boolean(raw.agent);
            const isCompute = kind === "compute" && typeof raw.__smithersComputeFn === "function";
            const parsedHeartbeatTimeoutMs = parseHeartbeatTimeoutMs(raw);
            const heartbeatTimeoutMs = parsedHeartbeatTimeoutMs ??
                (isAgent ? DEFAULT_LOCAL_TASK_HEARTBEAT_TIMEOUT_MS : null);
            const prompt = isAgent ? String(raw.children ?? "") : undefined;
            if (prompt === "[object Object]") {
                throw new SmithersError("MDX_PRELOAD_INACTIVE", `Task "${logicalNodeId}" prompt resolved to [object Object].`);
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
                cachePolicy: raw.cache && typeof raw.cache === "object"
                    ? raw.cache
                    : undefined,
                agent: raw.agent,
                prompt,
                staticPayload: isAgent || isCompute
                    ? undefined
                    : (raw.__smithersPayload ?? raw.__payload ?? raw.children),
                computeFn: isCompute
                    ? raw.__smithersComputeFn
                    : undefined,
                label: typeof raw.label === "string" ? raw.label : undefined,
                meta: raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
                    ? raw.meta
                    : undefined,
                scorers: raw.scorers && typeof raw.scorers === "object" && !Array.isArray(raw.scorers)
                    ? raw.scorers
                    : undefined,
                memoryConfig: raw.memory && typeof raw.memory === "object" && !Array.isArray(raw.memory)
                    ? raw.memory
                    : undefined,
            });
        }
        let elementIndex = 0;
        for (const child of node.children) {
            const nextPath = child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
            walk(child, {
                path: nextPath,
                iteration,
                ralphId,
                parentIsRalph: node.tag === "smithers:ralph",
                parallelStack: nextParallelStack,
                worktreeStack: nextWorktreeStack,
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
        loopStack: [],
    });
    return { xml: toXmlNode(root), tasks, mountedTaskIds };
}
export const extractFromHost = extractGraph;
