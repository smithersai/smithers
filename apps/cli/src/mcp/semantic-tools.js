import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { z } from "zod";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import { findAndOpenDb } from "../find-db.js";
import { aggregateNodeDetailEffect, } from "../node-detail.js";
import { diagnoseRunEffect, } from "../why-diagnosis.js";
import { chatAttemptKey, parseChatAttemptMeta, parseNodeOutputEvent, selectChatAttempts, } from "../chat.js";
import { WATCH_MIN_INTERVAL_MS } from "../watch.js";
import { discoverWorkflows, resolveWorkflow } from "../workflows.js";
import { mdxPlugin } from "smithers-orchestrator/mdx-plugin";
import { approveNode, denyNode } from "@smithers/engine/approvals";
import { runWorkflow } from "@smithers/engine";
import { revertToAttempt } from "@smithers/time-travel/revert";
import { runPromise } from "../smithersRuntime.js";
import { SmithersError } from "@smithers/errors";
import { toSmithersError } from "@smithers/errors/toSmithersError";
/**
 * @typedef {{ content: Array<{ type: "text"; text: string; }>; structuredContent: { ok: boolean; data?: unknown; error?: z.infer<typeof toolErrorSchema>; }; isError?: boolean; }} SemanticToolCallResult
 */
/**
 * @typedef {{ cwd: () => string; openDb: typeof findAndOpenDb; }} SemanticToolContext
 */
/** @typedef {import("./SemanticToolDefinition.ts").SemanticToolDefinition} SemanticToolDefinition */

export const SEMANTIC_TOOL_NAMES = [
    "list_workflows",
    "run_workflow",
    "list_runs",
    "get_run",
    "watch_run",
    "explain_run",
    "list_pending_approvals",
    "resolve_approval",
    "get_node_detail",
    "revert_attempt",
    "list_artifacts",
    "get_chat_transcript",
    "get_run_events",
];
const workflowSummarySchema = z.object({
    id: z.string(),
    displayName: z.string(),
    entryFile: z.string(),
    sourceType: z.enum(["seeded", "user", "generated"]),
});
const timerSchema = z.object({
    nodeId: z.string(),
    iteration: z.number().int(),
    firesAtMs: z.number(),
    remainingMs: z.number(),
    timerType: z.enum(["duration", "absolute"]),
});
const runSummarySchema = z.object({
    runId: z.string(),
    workflowName: z.string().nullable(),
    workflowPath: z.string().nullable(),
    parentRunId: z.string().nullable(),
    status: z.string(),
    createdAtMs: z.number(),
    startedAtMs: z.number().nullable(),
    finishedAtMs: z.number().nullable(),
    heartbeatAtMs: z.number().nullable(),
    activeNodeId: z.string().nullable(),
    activeNodeLabel: z.string().nullable(),
    pendingApprovalCount: z.number().int(),
    waitingTimers: z.array(timerSchema),
    countsByState: z.record(z.string(), z.number().int()),
});
const runStepSchema = z.object({
    nodeId: z.string(),
    iteration: z.number().int(),
    state: z.string(),
    lastAttempt: z.number().int().nullable(),
    updatedAtMs: z.number().nullable(),
    outputTable: z.string().nullable(),
    label: z.string().nullable(),
});
const pendingApprovalSchema = z.object({
    runId: z.string(),
    nodeId: z.string(),
    iteration: z.number().int(),
    status: z.string(),
    requestedAtMs: z.number().nullable().optional(),
    decidedAtMs: z.number().nullable().optional(),
    note: z.string().nullable().optional(),
    decidedBy: z.string().nullable().optional(),
    request: z.unknown().nullable().optional(),
    decision: z.unknown().nullable().optional(),
    autoApproved: z.boolean().optional(),
    workflowName: z.string().nullable().optional(),
    runStatus: z.string().nullable().optional(),
    nodeLabel: z.string().nullable().optional(),
});
const runLoopSchema = z.object({
    loopId: z.string(),
    iteration: z.number().int(),
    maxIterations: z.number().int().nullable(),
});
const runDetailSchema = runSummarySchema.extend({
    steps: z.array(runStepSchema),
    approvals: z.array(pendingApprovalSchema),
    loops: z.array(runLoopSchema),
    continuedFromRunIds: z.array(z.string()),
    activeDescendantRunId: z.string().nullable(),
    config: z.unknown().nullable(),
    error: z.unknown().nullable(),
});
const runWatchSnapshotSchema = z.object({
    observedAtMs: z.number(),
    run: runSummarySchema,
});
const nodeDetailSchema = z.object({
    node: z.object({
        runId: z.string(),
        nodeId: z.string(),
        iteration: z.number().int(),
        state: z.string(),
        lastAttempt: z.number().int().nullable(),
        updatedAtMs: z.number().nullable(),
        outputTable: z.string().nullable(),
        label: z.string().nullable(),
    }),
    status: z.string(),
    durationMs: z.number().nullable(),
    attemptsSummary: z.object({
        total: z.number().int(),
        failed: z.number().int(),
        cancelled: z.number().int(),
        succeeded: z.number().int(),
        waiting: z.number().int(),
    }),
    attempts: z.array(z.unknown()),
    toolCalls: z.array(z.unknown()),
    tokenUsage: z.unknown(),
    scorers: z.array(z.unknown()),
    output: z.object({
        validated: z.unknown().nullable(),
        raw: z.unknown().nullable(),
        source: z.enum(["cache", "output-table", "none"]),
        cacheKey: z.string().nullable(),
    }),
    limits: z.object({
        toolPayloadBytesHuman: z.number().int(),
        validatedOutputBytesHuman: z.number().int(),
    }),
});
const diagnosisSchema = z.object({
    runId: z.string(),
    status: z.string(),
    summary: z.string(),
    generatedAtMs: z.number(),
    blockers: z.array(z.object({
        kind: z.string(),
        nodeId: z.string(),
        iteration: z.number().nullable(),
        reason: z.string(),
        waitingSince: z.number(),
        unblocker: z.string(),
        context: z.string().optional(),
        signalName: z.string().nullable().optional(),
        dependencyNodeId: z.string().nullable().optional(),
        firesAtMs: z.number().nullable().optional(),
        remainingMs: z.number().nullable().optional(),
        attempt: z.number().nullable().optional(),
        maxAttempts: z.number().nullable().optional(),
    })),
    currentNodeId: z.string().nullable(),
});
const eventSchema = z.object({
    runId: z.string(),
    seq: z.number().int(),
    timestampMs: z.number(),
    type: z.string(),
    payload: z.unknown().nullable(),
});
const artifactSchema = z.object({
    artifactId: z.string(),
    kind: z.literal("node-output"),
    runId: z.string(),
    nodeId: z.string(),
    iteration: z.number().int(),
    label: z.string().nullable(),
    state: z.string(),
    outputTable: z.string().nullable(),
    source: z.enum(["cache", "output-table", "none"]),
    cacheKey: z.string().nullable(),
    value: z.unknown().nullable(),
    rawValue: z.unknown().nullable().optional(),
});
const chatAttemptSchema = z.object({
    attemptKey: z.string(),
    nodeId: z.string(),
    iteration: z.number().int(),
    attempt: z.number().int(),
    state: z.string(),
    startedAtMs: z.number(),
    finishedAtMs: z.number().nullable(),
    cached: z.boolean(),
    meta: z.unknown().nullable(),
});
const chatMessageSchema = z.object({
    id: z.string(),
    attemptKey: z.string(),
    nodeId: z.string(),
    iteration: z.number().int(),
    attempt: z.number().int(),
    role: z.enum(["user", "assistant", "stderr"]),
    stream: z.enum(["stdout", "stderr"]).nullable(),
    timestampMs: z.number(),
    text: z.string(),
    source: z.enum(["prompt", "event", "responseText"]),
});
const toolErrorSchema = z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).nullable().optional(),
    docsUrl: z.string().nullable().optional(),
});
/**
 * @template Data
 * @param {Data} data
 */
function resultSchema(data) {
    return z.object({
        ok: z.boolean(),
        data: data.optional(),
        error: toolErrorSchema.optional(),
    });
}
const listWorkflowsInputSchema = z.object({});
const listWorkflowsDataSchema = z.object({
    workflows: z.array(workflowSummarySchema),
});
const runWorkflowInputSchema = z.object({
    workflowId: z.string().describe("Discovered workflow ID from .smithers/workflows"),
    input: z.record(z.string(), z.unknown()).optional(),
    prompt: z.string().optional(),
    runId: z.string().optional(),
    resume: z.boolean().default(false),
    force: z.boolean().default(false),
    waitForTerminal: z.boolean().default(false),
    waitForStartMs: z.number().int().min(0).default(1_000),
    maxConcurrency: z.number().int().min(1).optional(),
    rootDir: z.string().optional(),
    logDir: z.string().optional(),
    allowNetwork: z.boolean().default(false),
    maxOutputBytes: z.number().int().min(1).optional(),
    toolTimeoutMs: z.number().int().min(1).optional(),
    hot: z.boolean().default(false),
}).superRefine((value, ctx) => {
    if (value.resume && !value.runId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "runId is required when resume=true",
            path: ["runId"],
        });
    }
});
const runWorkflowDataSchema = z.object({
    workflow: workflowSummarySchema,
    runId: z.string(),
    launchMode: z.enum(["background", "waited"]),
    requestedResume: z.boolean(),
    status: z.string(),
    observedRun: runSummarySchema.nullable(),
    result: z.object({
        runId: z.string(),
        status: z.string(),
        output: z.unknown().optional(),
        error: z.unknown().optional(),
    }).nullable(),
});
const listRunsInputSchema = z.object({
    limit: z.number().int().min(1).max(200).default(20),
    status: z.string().optional(),
});
const listRunsDataSchema = z.object({
    runs: z.array(runSummarySchema),
});
const getRunInputSchema = z.object({
    runId: z.string(),
});
const getRunDataSchema = z.object({
    run: runDetailSchema,
});
const watchRunInputSchema = z.object({
    runId: z.string(),
    intervalMs: z.number().int().min(1).default(1_000),
    timeoutMs: z.number().int().min(0).default(30_000),
});
const watchRunDataSchema = z.object({
    runId: z.string(),
    intervalMs: z.number().int(),
    pollCount: z.number().int(),
    reachedTerminal: z.boolean(),
    timedOut: z.boolean(),
    finalRun: runSummarySchema,
    snapshots: z.array(runWatchSnapshotSchema),
});
const explainRunInputSchema = z.object({
    runId: z.string(),
});
const explainRunDataSchema = z.object({
    diagnosis: diagnosisSchema,
});
const listPendingApprovalsInputSchema = z.object({
    runId: z.string().optional(),
    workflowName: z.string().optional(),
    nodeId: z.string().optional(),
});
const listPendingApprovalsDataSchema = z.object({
    approvals: z.array(pendingApprovalSchema),
});
const resolveApprovalInputSchema = z.object({
    action: z.enum(["approve", "deny"]),
    runId: z.string().optional(),
    workflowName: z.string().optional(),
    nodeId: z.string().optional(),
    iteration: z.number().int().min(0).optional(),
    note: z.string().optional(),
    decidedBy: z.string().optional(),
    decision: z.unknown().optional(),
});
const resolveApprovalDataSchema = z.object({
    action: z.enum(["approve", "deny"]),
    approval: pendingApprovalSchema,
    run: runSummarySchema.nullable(),
});
const getNodeDetailInputSchema = z.object({
    runId: z.string(),
    nodeId: z.string(),
    iteration: z.number().int().min(0).optional(),
});
const getNodeDetailDataSchema = z.object({
    detail: nodeDetailSchema,
});
const revertAttemptInputSchema = z.object({
    runId: z.string(),
    nodeId: z.string(),
    iteration: z.number().int().min(0).default(0),
    attempt: z.number().int().min(1),
});
const revertAttemptDataSchema = z.object({
    runId: z.string(),
    nodeId: z.string(),
    iteration: z.number().int(),
    attempt: z.number().int(),
    success: z.boolean(),
    error: z.string().optional(),
    jjPointer: z.string().optional(),
    run: runSummarySchema.nullable(),
});
const listArtifactsInputSchema = z.object({
    runId: z.string(),
    nodeId: z.string().optional(),
    includeRaw: z.boolean().default(false),
});
const listArtifactsDataSchema = z.object({
    artifacts: z.array(artifactSchema),
});
const getChatTranscriptInputSchema = z.object({
    runId: z.string(),
    all: z.boolean().default(false),
    includeStderr: z.boolean().default(true),
    tail: z.number().int().min(1).optional(),
});
const getChatTranscriptDataSchema = z.object({
    runId: z.string(),
    attempts: z.array(chatAttemptSchema),
    messages: z.array(chatMessageSchema),
});
const getRunEventsInputSchema = z.object({
    runId: z.string(),
    afterSeq: z.number().int().optional(),
    limit: z.number().int().min(1).max(10_000).default(200),
    nodeId: z.string().optional(),
    types: z.array(z.string()).optional(),
    sinceTimestampMs: z.number().int().optional(),
});
const getRunEventsDataSchema = z.object({
    runId: z.string(),
    events: z.array(eventSchema),
});
/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, ms);
    });
}
/**
 * @param {string | null | undefined} raw
 * @returns {unknown | null}
 */
function parseJsonValue(raw) {
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
/**
 * @param {Pick<RunRow, "workflowName" | "workflowPath">} run
 */
function resolveWorkflowName(run) {
    const fromPath = run.workflowPath
        ? basename(run.workflowPath, extname(run.workflowPath))
        : null;
    if (run.workflowName && run.workflowName !== "workflow") {
        return run.workflowName;
    }
    return fromPath ?? run.workflowName ?? null;
}
/**
 * @param {string | null} [metaJson]
 */
function parseWaitingTimerInfo(metaJson) {
    if (!metaJson)
        return null;
    try {
        const parsed = JSON.parse(metaJson);
        const timer = parsed?.timer;
        if (!timer || typeof timer !== "object")
            return null;
        const firesAtMs = Number(timer.firesAtMs);
        if (!Number.isFinite(firesAtMs))
            return null;
        return {
            firesAtMs: Math.floor(firesAtMs),
            timerType: timer.timerType === "absolute" ? "absolute" : "duration",
        };
    }
    catch {
        return null;
    }
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listWaitingTimers(adapter, runId) {
    const nodes = await adapter.listNodes(runId);
    const waits = [];
    for (const node of nodes) {
        if (node.state !== "waiting-timer")
            continue;
        const attempts = await adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0);
        const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-timer") ??
            attempts[0];
        const parsed = parseWaitingTimerInfo(waitingAttempt?.metaJson);
        if (!parsed)
            continue;
        waits.push({
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            firesAtMs: parsed.firesAtMs,
            remainingMs: parsed.firesAtMs - Date.now(),
            timerType: parsed.timerType,
        });
    }
    waits.sort((left, right) => left.firesAtMs - right.firesAtMs);
    return waits;
}
/**
 * @param {SmithersDb} adapter
 * @param {RunRow} run
 */
async function buildRunSummary(adapter, run) {
    const [nodes, approvals, waitingTimers, countsByStateRows] = await Promise.all([
        adapter.listNodes(run.runId),
        adapter.listPendingApprovals(run.runId),
        run.status === "waiting-timer"
            ? listWaitingTimers(adapter, run.runId)
            : Promise.resolve([]),
        adapter.countNodesByState(run.runId),
    ]);
    const activeNode = nodes
        .filter((node) => node.state === "in-progress")
        .sort((left, right) => {
        const leftUpdated = Number(left.updatedAtMs ?? 0);
        const rightUpdated = Number(right.updatedAtMs ?? 0);
        return rightUpdated - leftUpdated;
    })[0];
    const countsByState = Object.fromEntries(countsByStateRows.map((row) => [
        String(row.state),
        Number(row.count ?? 0),
    ]));
    return {
        runId: run.runId,
        workflowName: resolveWorkflowName(run),
        workflowPath: run.workflowPath ?? null,
        parentRunId: run.parentRunId ?? null,
        status: run.status,
        createdAtMs: run.createdAtMs,
        startedAtMs: run.startedAtMs ?? null,
        finishedAtMs: run.finishedAtMs ?? null,
        heartbeatAtMs: run.heartbeatAtMs ?? null,
        activeNodeId: activeNode?.nodeId ?? null,
        activeNodeLabel: activeNode?.label ?? activeNode?.nodeId ?? null,
        pendingApprovalCount: approvals.length,
        waitingTimers,
        countsByState,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function buildRunDetail(adapter, runId) {
    const run = await requireRun(adapter, runId);
    const [summary, nodes, approvals, loops, ancestry] = await Promise.all([
        buildRunSummary(adapter, run),
        adapter.listNodes(runId),
        adapter.listPendingApprovals(runId),
        adapter.listRalph(runId),
        adapter.listRunAncestry(runId, 1_000),
    ]);
    let activeDescendantRunId = null;
    const seen = new Set([runId]);
    let cursor = runId;
    while (true) {
        const child = await adapter.getLatestChildRun(cursor);
        if (!child || !child.runId || seen.has(child.runId))
            break;
        activeDescendantRunId = child.runId;
        seen.add(child.runId);
        cursor = child.runId;
    }
    return {
        ...summary,
        steps: nodes
            .map((node) => ({
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            state: node.state,
            lastAttempt: node.lastAttempt ?? null,
            updatedAtMs: node.updatedAtMs ?? null,
            outputTable: node.outputTable ?? null,
            label: node.label ?? null,
        }))
            .sort((left, right) => {
            if (left.nodeId !== right.nodeId) {
                return left.nodeId.localeCompare(right.nodeId);
            }
            return left.iteration - right.iteration;
        }),
        approvals: approvals.map((approval) => ({
            runId: approval.runId,
            nodeId: approval.nodeId,
            iteration: approval.iteration ?? 0,
            status: approval.status,
            requestedAtMs: approval.requestedAtMs ?? null,
            decidedAtMs: approval.decidedAtMs ?? null,
            note: approval.note ?? null,
            decidedBy: approval.decidedBy ?? null,
            request: parseJsonValue(approval.requestJson),
            decision: parseJsonValue(approval.decisionJson),
            autoApproved: Boolean(approval.autoApproved),
        })),
        loops: loops.map((loop) => ({
            loopId: loop.ralphId,
            iteration: loop.iteration,
            maxIterations: loop.maxIterations ?? null,
        })),
        continuedFromRunIds: ancestry.slice(1).map((row) => row.runId),
        activeDescendantRunId,
        config: parseJsonValue(run.configJson),
        error: parseJsonValue(run.errorJson),
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function requireRun(adapter, runId) {
    const run = await adapter.getRun(runId);
    if (!run) {
        throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, {
            runId,
        });
    }
    return run;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listAllEvents(adapter, runId) {
    const events = [];
    let lastSeq = -1;
    while (true) {
        const batch = await adapter.listEvents(runId, lastSeq, 1_000);
        if (batch.length === 0)
            break;
        events.push(...batch);
        lastSeq = batch[batch.length - 1].seq;
        if (batch.length < 1_000)
            break;
    }
    return events;
}
/**
 * @param {string} workflowId
 * @param {string} cwd
 */
async function loadWorkflowById(workflowId, cwd) {
    const discovered = resolveWorkflow(workflowId, cwd);
    mdxPlugin();
    const moduleUrl = pathToFileURL(resolve(discovered.entryFile)).href;
    const mod = await import(moduleUrl);
    if (!mod.default) {
        throw new SmithersError("WORKFLOW_MISSING_DEFAULT", `Workflow ${workflowId} must export default`, { workflowId, entryFile: discovered.entryFile });
    }
    const workflow = mod.default;
    ensureSmithersTables(workflow.db);
    return {
        workflow,
        summary: {
            id: discovered.id,
            displayName: discovered.displayName,
            entryFile: discovered.entryFile,
            sourceType: discovered.sourceType,
        },
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} waitForStartMs
 */
async function waitForObservedRun(adapter, runId, waitForStartMs) {
    const deadline = Date.now() + Math.max(0, waitForStartMs);
    while (true) {
        const run = await adapter.getRun(runId);
        if (run) {
            return buildRunSummary(adapter, run);
        }
        if (Date.now() >= deadline) {
            return null;
        }
        await sleep(25);
    }
}
/**
 * @param {unknown} error
 */
function toToolError(error) {
    const smithersError = toSmithersError(error);
    return {
        code: smithersError.code,
        message: smithersError.summary,
        details: smithersError.details ?? null,
        docsUrl: smithersError.docsUrl ?? null,
    };
}
/**
 * @template Data
 * @param {Data} data
 */
function toolSuccess(data) {
    const payload = { ok: true, data };
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
    };
}
/**
 * @param {unknown} error
 * @returns {SemanticToolCallResult}
 */
function toolFailure(error) {
    const payload = { ok: false, error: toToolError(error) };
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: true,
    };
}
/**
 * @template T
 * @param {SemanticToolContext} context
 * @param {(adapter: SmithersDb) => Promise<T>} run
 */
async function withDb(context, run) {
    const { adapter, cleanup } = await context.openDb(context.cwd());
    try {
        return await run(adapter);
    }
    finally {
        cleanup();
    }
}
/**
 * @param {any} row
 */
function parsePendingApproval(row) {
    return {
        runId: row.runId,
        nodeId: row.nodeId,
        iteration: row.iteration ?? 0,
        status: row.status,
        requestedAtMs: row.requestedAtMs ?? null,
        decidedAtMs: row.decidedAtMs ?? null,
        note: row.note ?? null,
        decidedBy: row.decidedBy ?? null,
        request: parseJsonValue(row.requestJson),
        decision: parseJsonValue(row.decisionJson),
        autoApproved: typeof row.autoApproved === "boolean" ? row.autoApproved : undefined,
        workflowName: row.workflowName ?? null,
        runStatus: row.runStatus ?? null,
        nodeLabel: row.nodeLabel ?? null,
    };
}
/**
 * @param {any[]} approvals
 * @param {{ runId?: string; workflowName?: string; nodeId?: string; iteration?: number; }} filters
 */
function filterPendingApprovals(approvals, filters) {
    return approvals.filter((approval) => {
        if (filters.runId && approval.runId !== filters.runId)
            return false;
        if (filters.workflowName && approval.workflowName !== filters.workflowName)
            return false;
        if (filters.nodeId && approval.nodeId !== filters.nodeId)
            return false;
        if (typeof filters.iteration === "number" &&
            Number(approval.iteration ?? 0) !== filters.iteration) {
            return false;
        }
        return true;
    });
}
/**
 * @template Data
 * @param {string} toolName
 * @param {() => Promise<Data>} handler
 * @returns {Promise<SemanticToolCallResult>}
 */
async function executeSemanticTool(toolName, handler) {
    try {
        const data = await runPromise(Effect.tryPromise(() => handler()).pipe(Effect.annotateLogs({
            toolName,
            surface: "semantic",
        }), Effect.withLogSpan("mcp:semantic")));
        return toolSuccess(data);
    }
    catch (error) {
        return toolFailure(error);
    }
}
/**
 * @param {Partial<SemanticToolContext>} [options]
 * @returns {SemanticToolDefinition[]}
 */
export function createSemanticToolDefinitions(options = {}) {
    const context = {
        cwd: options.cwd ?? (() => process.cwd()),
        openDb: options.openDb ?? findAndOpenDb,
    };
    return [
        {
            name: "list_workflows",
            description: "List discovered local Smithers workflows.",
            inputSchema: listWorkflowsInputSchema,
            outputSchema: resultSchema(listWorkflowsDataSchema),
            annotations: { readOnlyHint: true },
            handler: () => executeSemanticTool("list_workflows", async () => ({
                workflows: discoverWorkflows(context.cwd()),
            })),
        },
        {
            name: "run_workflow",
            description: "Start a discovered workflow directly through the engine. Defaults to background launch; set waitForTerminal=true to block until completion.",
            inputSchema: runWorkflowInputSchema,
            outputSchema: resultSchema(runWorkflowDataSchema),
            annotations: { readOnlyHint: false, openWorldHint: true },
            handler: (input) => executeSemanticTool("run_workflow", async () => {
                const runId = input.runId ?? crypto.randomUUID();
                const { workflow, summary } = await loadWorkflowById(input.workflowId, context.cwd());
                const adapter = workflow.db
                    ? new SmithersDb(workflow.db)
                    : null;
                const workflowInput = input.input ??
                    (typeof input.prompt === "string" ? { prompt: input.prompt } : {});
                const launchState = {
                    settled: false,
                    result: null,
                    error: null,
                };
                const launchPromise = Effect.runPromise(runWorkflow(workflow, {
                    input: workflowInput,
                    runId,
                    resume: input.resume,
                    force: input.force,
                    workflowPath: summary.entryFile,
                    maxConcurrency: input.maxConcurrency,
                    rootDir: input.rootDir,
                    logDir: input.logDir,
                    allowNetwork: input.allowNetwork,
                    maxOutputBytes: input.maxOutputBytes,
                    toolTimeoutMs: input.toolTimeoutMs,
                    hot: input.hot,
                })).then((result) => {
                    launchState.settled = true;
                    launchState.result = result;
                    return result;
                }, (error) => {
                    launchState.settled = true;
                    launchState.error = error;
                    throw error;
                });
                if (input.waitForTerminal) {
                    const result = await launchPromise;
                    const observedRun = adapter != null ? await adapter.getRun(result.runId) : null;
                    return {
                        workflow: summary,
                        runId: result.runId,
                        launchMode: "waited",
                        requestedResume: input.resume,
                        status: result.status,
                        observedRun: observedRun != null
                            ? await buildRunSummary(adapter, observedRun)
                            : null,
                        result,
                    };
                }
                void launchPromise.catch((error) => {
                    const rendered = toToolError(error);
                    console.error(`[smithers:mcp] run_workflow background failure ${runId}: ${rendered.code} ${rendered.message}`);
                });
                const observedRun = adapter != null
                    ? await waitForObservedRun(adapter, runId, input.waitForStartMs)
                    : null;
                if (observedRun == null && launchState.settled) {
                    if (launchState.error) {
                        throw launchState.error;
                    }
                    if (launchState.result) {
                        const finalRun = adapter != null
                            ? await adapter.getRun(launchState.result.runId)
                            : null;
                        return {
                            workflow: summary,
                            runId: launchState.result.runId,
                            launchMode: "background",
                            requestedResume: input.resume,
                            status: launchState.result.status,
                            observedRun: finalRun != null
                                ? await buildRunSummary(adapter, finalRun)
                                : null,
                            result: launchState.result,
                        };
                    }
                }
                return {
                    workflow: summary,
                    runId,
                    launchMode: "background",
                    requestedResume: input.resume,
                    status: observedRun?.status ?? "running",
                    observedRun,
                    result: null,
                };
            }),
        },
        {
            name: "list_runs",
            description: "List recent Smithers runs with stable structured summaries.",
            inputSchema: listRunsInputSchema,
            outputSchema: resultSchema(listRunsDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("list_runs", async () => withDb(context, async (adapter) => {
                const runs = await adapter.listRuns(input.limit, input.status);
                const summaries = await Promise.all(runs.map((run) => buildRunSummary(adapter, run)));
                return { runs: summaries };
            })),
        },
        {
            name: "get_run",
            description: "Get enriched structured state for a specific run, including steps, approvals, timers, lineage, and config.",
            inputSchema: getRunInputSchema,
            outputSchema: resultSchema(getRunDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("get_run", async () => withDb(context, async (adapter) => ({
                run: await buildRunDetail(adapter, input.runId),
            }))),
        },
        {
            name: "watch_run",
            description: "Poll a run until it reaches a terminal state or timeout. This is the explicit watch/poll semantic tool.",
            inputSchema: watchRunInputSchema,
            outputSchema: resultSchema(watchRunDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("watch_run", async () => withDb(context, async (adapter) => {
                const intervalMs = Math.max(WATCH_MIN_INTERVAL_MS, input.intervalMs);
                const deadline = Date.now() + input.timeoutMs;
                const snapshots = [];
                let pollCount = 0;
                while (true) {
                    const run = await adapter.getRun(input.runId);
                    if (!run) {
                        throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${input.runId}`, {
                            runId: input.runId,
                        });
                    }
                    const summary = await buildRunSummary(adapter, run);
                    snapshots.push({
                        observedAtMs: Date.now(),
                        run: summary,
                    });
                    if (run.status !== "running" &&
                        run.status !== "waiting-approval" &&
                        run.status !== "waiting-event" &&
                        run.status !== "waiting-timer") {
                        return {
                            runId: input.runId,
                            intervalMs,
                            pollCount,
                            reachedTerminal: true,
                            timedOut: false,
                            finalRun: summary,
                            snapshots,
                        };
                    }
                    if (Date.now() >= deadline) {
                        return {
                            runId: input.runId,
                            intervalMs,
                            pollCount,
                            reachedTerminal: false,
                            timedOut: true,
                            finalRun: summary,
                            snapshots,
                        };
                    }
                    pollCount += 1;
                    await sleep(intervalMs);
                }
            })),
        },
        {
            name: "explain_run",
            description: "Explain why a run is waiting, stale, or blocked by returning the diagnosis model directly.",
            inputSchema: explainRunInputSchema,
            outputSchema: resultSchema(explainRunDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("explain_run", async () => withDb(context, async (adapter) => ({
                diagnosis: await runPromise(diagnoseRunEffect(adapter, input.runId)),
            }))),
        },
        {
            name: "list_pending_approvals",
            description: "List pending approvals across all runs or a filtered subset.",
            inputSchema: listPendingApprovalsInputSchema,
            outputSchema: resultSchema(listPendingApprovalsDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("list_pending_approvals", async () => withDb(context, async (adapter) => {
                const approvals = await adapter.listAllPendingApprovals();
                return {
                    approvals: filterPendingApprovals(approvals, input).map(parsePendingApproval),
                };
            })),
        },
        {
            name: "resolve_approval",
            description: "Destructive: approve or deny a pending approval. If filters match more than one approval, this tool returns an ambiguity error instead of guessing.",
            inputSchema: resolveApprovalInputSchema,
            outputSchema: resultSchema(resolveApprovalDataSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
            },
            handler: (input) => executeSemanticTool("resolve_approval", async () => withDb(context, async (adapter) => {
                const approvals = await adapter.listAllPendingApprovals();
                const matches = filterPendingApprovals(approvals, input);
                if (matches.length === 0) {
                    throw new SmithersError("INVALID_INPUT", "No pending approval matched the provided filters.", {
                        filters: input,
                    });
                }
                if (matches.length > 1) {
                    throw new SmithersError("INVALID_INPUT", "Multiple pending approvals matched. Provide runId/nodeId/iteration to disambiguate.", {
                        matches: matches.map((approval) => ({
                            runId: approval.runId,
                            nodeId: approval.nodeId,
                            iteration: approval.iteration ?? 0,
                            workflowName: approval.workflowName ?? null,
                        })),
                    });
                }
                const approval = matches[0];
                if (input.action === "approve") {
                    await Effect.runPromise(approveNode(adapter, approval.runId, approval.nodeId, approval.iteration ?? 0, input.note, input.decidedBy, input.decision));
                }
                else {
                    await Effect.runPromise(denyNode(adapter, approval.runId, approval.nodeId, approval.iteration ?? 0, input.note, input.decidedBy, input.decision));
                }
                const run = await adapter.getRun(approval.runId);
                return {
                    action: input.action,
                    approval: {
                        ...parsePendingApproval(approval),
                        status: input.action === "approve" ? "approved" : "denied",
                        requestedAtMs: approval.requestedAtMs ?? null,
                        decidedAtMs: Date.now(),
                        note: input.note ?? null,
                        decidedBy: input.decidedBy ?? null,
                        decision: input.decision ?? null,
                    },
                    run: run != null
                        ? await buildRunSummary(adapter, run)
                        : null,
                };
            })),
        },
        {
            name: "get_node_detail",
            description: "Get enriched node state including attempts, tool calls, token usage, scorers, and validated output.",
            inputSchema: getNodeDetailInputSchema,
            outputSchema: resultSchema(getNodeDetailDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("get_node_detail", async () => withDb(context, async (adapter) => ({
                detail: await runPromise(aggregateNodeDetailEffect(adapter, {
                    runId: input.runId,
                    nodeId: input.nodeId,
                    iteration: input.iteration,
                })),
            }))),
        },
        {
            name: "revert_attempt",
            description: "Destructive: revert the workspace and frame history back to a recorded attempt.",
            inputSchema: revertAttemptInputSchema,
            outputSchema: resultSchema(revertAttemptDataSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
            },
            handler: (input) => executeSemanticTool("revert_attempt", async () => withDb(context, async (adapter) => {
                const result = await revertToAttempt(adapter, input);
                const run = await adapter.getRun(input.runId);
                return {
                    runId: input.runId,
                    nodeId: input.nodeId,
                    iteration: input.iteration,
                    attempt: input.attempt,
                    success: result.success,
                    ...(result.error ? { error: result.error } : {}),
                    ...(result.jjPointer ? { jjPointer: result.jjPointer } : {}),
                    run: run != null
                        ? await buildRunSummary(adapter, run)
                        : null,
                };
            })),
        },
        {
            name: "list_artifacts",
            description: "List structured output artifacts produced by nodes in a run.",
            inputSchema: listArtifactsInputSchema,
            outputSchema: resultSchema(listArtifactsDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("list_artifacts", async () => withDb(context, async (adapter) => {
                await requireRun(adapter, input.runId);
                const nodes = await adapter.listNodes(input.runId);
                const selectedNodes = nodes.filter((node) => {
                    if (input.nodeId && node.nodeId !== input.nodeId)
                        return false;
                    return Boolean(node.outputTable);
                });
                const artifacts = [];
                for (const node of selectedNodes) {
                    const detail = await runPromise(aggregateNodeDetailEffect(adapter, {
                        runId: input.runId,
                        nodeId: node.nodeId,
                        iteration: node.iteration ?? 0,
                    }));
                    if (detail.output.source === "none")
                        continue;
                    artifacts.push({
                        artifactId: `${input.runId}:${node.nodeId}:${node.iteration ?? 0}`,
                        kind: "node-output",
                        runId: input.runId,
                        nodeId: node.nodeId,
                        iteration: node.iteration ?? 0,
                        label: node.label ?? null,
                        state: node.state,
                        outputTable: node.outputTable ?? null,
                        source: detail.output.source,
                        cacheKey: detail.output.cacheKey,
                        value: detail.output.validated,
                        ...(input.includeRaw ? { rawValue: detail.output.raw } : {}),
                    });
                }
                return { artifacts };
            })),
        },
        {
            name: "get_chat_transcript",
            description: "Return the structured agent chat transcript for a run, grouped by attempts and message role.",
            inputSchema: getChatTranscriptInputSchema,
            outputSchema: resultSchema(getChatTranscriptDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("get_chat_transcript", async () => withDb(context, async (adapter) => {
                await requireRun(adapter, input.runId);
                const attempts = await adapter.listAttemptsForRun(input.runId);
                const events = await listAllEvents(adapter, input.runId);
                const knownOutputAttemptKeys = new Set();
                const parsedOutputs = events
                    .map((event) => parseNodeOutputEvent(event))
                    .filter(Boolean);
                for (const event of parsedOutputs) {
                    knownOutputAttemptKeys.add(chatAttemptKey(event));
                }
                const selectedAttempts = selectChatAttempts(attempts, knownOutputAttemptKeys, input.all);
                const selectedAttemptKeys = new Set(selectedAttempts.map((attempt) => chatAttemptKey(attempt)));
                const stdoutSeenAttempts = new Set();
                const messages = [];
                for (const attempt of selectedAttempts) {
                    const attemptKey = chatAttemptKey(attempt);
                    const meta = parseChatAttemptMeta(attempt.metaJson);
                    const prompt = typeof meta.prompt === "string" ? meta.prompt.trim() : "";
                    if (prompt) {
                        messages.push({
                            id: `prompt:${attemptKey}`,
                            attemptKey,
                            nodeId: attempt.nodeId,
                            iteration: attempt.iteration ?? 0,
                            attempt: attempt.attempt,
                            role: "user",
                            stream: null,
                            timestampMs: attempt.startedAtMs,
                            text: prompt,
                            source: "prompt",
                        });
                    }
                }
                for (const event of parsedOutputs) {
                    const attemptKey = chatAttemptKey(event);
                    if (!selectedAttemptKeys.has(attemptKey))
                        continue;
                    if (event.stream === "stderr" && !input.includeStderr)
                        continue;
                    if (event.stream === "stdout") {
                        stdoutSeenAttempts.add(attemptKey);
                    }
                    messages.push({
                        id: `event:${event.seq}`,
                        attemptKey,
                        nodeId: event.nodeId,
                        iteration: event.iteration,
                        attempt: event.attempt,
                        role: event.stream === "stderr" ? "stderr" : "assistant",
                        stream: event.stream,
                        timestampMs: event.timestampMs,
                        text: event.text,
                        source: "event",
                    });
                }
                for (const attempt of selectedAttempts) {
                    const attemptKey = chatAttemptKey(attempt);
                    const responseText = typeof attempt.responseText === "string"
                        ? attempt.responseText.trim()
                        : "";
                    if (!responseText || stdoutSeenAttempts.has(attemptKey))
                        continue;
                    messages.push({
                        id: `response:${attemptKey}`,
                        attemptKey,
                        nodeId: attempt.nodeId,
                        iteration: attempt.iteration ?? 0,
                        attempt: attempt.attempt,
                        role: "assistant",
                        stream: null,
                        timestampMs: attempt.finishedAtMs ?? attempt.startedAtMs ?? Date.now(),
                        text: responseText,
                        source: "responseText",
                    });
                }
                messages.sort((left, right) => {
                    if (left.timestampMs !== right.timestampMs) {
                        return left.timestampMs - right.timestampMs;
                    }
                    return left.id.localeCompare(right.id);
                });
                const tailedMessages = typeof input.tail === "number"
                    ? messages.slice(-input.tail)
                    : messages;
                return {
                    runId: input.runId,
                    attempts: selectedAttempts.map((attempt) => ({
                        attemptKey: chatAttemptKey(attempt),
                        nodeId: attempt.nodeId,
                        iteration: attempt.iteration ?? 0,
                        attempt: attempt.attempt,
                        state: attempt.state,
                        startedAtMs: attempt.startedAtMs,
                        finishedAtMs: attempt.finishedAtMs ?? null,
                        cached: Boolean(attempt.cached),
                        meta: parseJsonValue(attempt.metaJson),
                    })),
                    messages: tailedMessages,
                };
            })),
        },
        {
            name: "get_run_events",
            description: "Return structured event history for a run without relying on CLI table or NDJSON formatting.",
            inputSchema: getRunEventsInputSchema,
            outputSchema: resultSchema(getRunEventsDataSchema),
            annotations: { readOnlyHint: true },
            handler: (input) => executeSemanticTool("get_run_events", async () => withDb(context, async (adapter) => {
                await requireRun(adapter, input.runId);
                const events = await adapter.listEventHistory(input.runId, {
                    afterSeq: input.afterSeq,
                    limit: input.limit,
                    nodeId: input.nodeId,
                    types: input.types,
                    sinceTimestampMs: input.sinceTimestampMs,
                });
                return {
                    runId: input.runId,
                    events: events.map((event) => ({
                        runId: event.runId,
                        seq: event.seq,
                        timestampMs: event.timestampMs,
                        type: event.type,
                        payload: parseJsonValue(event.payloadJson),
                    })),
                };
            })),
        },
    ];
}
