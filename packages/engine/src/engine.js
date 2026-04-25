import { makeWorkflowSession, } from "@smithers-orchestrator/scheduler";
import { ReactWorkflowDriver } from "@smithers-orchestrator/react-reconciler/driver";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import { loadInput, loadOutputs } from "@smithers-orchestrator/db/snapshot";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { selectOutputRow, validateOutput, validateExistingOutput, getAgentOutputSchema, describeSchemaShape, buildOutputRow, stripAutoColumns, } from "@smithers-orchestrator/db/output";
import { validateInput } from "@smithers-orchestrator/db/input";
import { schemaSignature } from "@smithers-orchestrator/db/schema-signature";
import { withSqliteWriteRetry } from "@smithers-orchestrator/db/write-retry";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { errorToJson } from "@smithers-orchestrator/errors/errorToJson";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { assertJsonPayloadWithinBounds, assertOptionalStringMaxLength, assertPositiveFiniteInteger, } from "@smithers-orchestrator/db/input-bounds";
import { retryPolicyToSchedule } from "@smithers-orchestrator/scheduler/retryPolicyToSchedule";
import { retryScheduleDelayMs } from "@smithers-orchestrator/scheduler/retryScheduleDelayMs";
import { buildPlanTree, scheduleTasks, buildStateKey, } from "./scheduler.js";
import { getDefinedToolMetadata } from "./getDefinedToolMetadata.js";
import { captureSnapshotEffect, loadLatestSnapshot, parseSnapshot, } from "@smithers-orchestrator/time-travel/snapshot";
import { EventBus } from "./events.js";
import { getJjPointer, runJj, workspaceAdd } from "@smithers-orchestrator/vcs/jj";
import { findVcsRoot } from "@smithers-orchestrator/vcs/find-root";
import * as BunContext from "@effect/platform-bun/BunContext";
import { z } from "zod";
import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Chunk, Duration, Effect, Fiber, Metric, Queue, Schedule } from "effect";
import { attemptDuration, cacheHits, cacheMisses, nodeDuration, promptSizeBytes, responseSizeBytes, runDuration, runsResumedTotal, schedulerConcurrencyUtilization, schedulerQueueDepth, schedulerWaitDuration, trackEvent, } from "@smithers-orchestrator/observability/metrics";
import { runScorersAsync } from "@smithers-orchestrator/scorers/run-scorers";
import { dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { logDebug, logError, logInfo, logWarning } from "@smithers-orchestrator/observability/logging";
import { isPidAlive, parseRuntimeOwnerPid } from "./runtime-owner.js";
import { HotWorkflowController } from "./hot/index.js";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { platform } from "node:os";
import { annotateSmithersTrace, smithersSpanNames, withSmithersSpan, } from "@smithers-orchestrator/observability";
import { withTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { hashCapabilityRegistry } from "@smithers-orchestrator/agents/capability-registry";
import { cancelPendingTimersBridge, executeTaskBridgeEffect, isBridgeManagedTimerTask as isTimerTask, resolveDeferredTaskStateBridge, } from "./effect/workflow-bridge.js";
import { AlertRuntime } from "./alert-runtime.js";
import { executeChildWorkflow } from "./child-workflow.js";
import { runWorkflowWithMakeBridge } from "./effect/workflow-make-bridge.js";
import { createWorkflowVersioningRuntime, getWorkflowPatchDecisions, withWorkflowVersioningRuntime, } from "./effect/versioning.js";
import { runWithCorrelationContext, updateCurrentCorrelationContext, withCorrelationContext, } from "@smithers-orchestrator/observability/correlation";
/** @typedef {import("@smithers-orchestrator/graph/GraphSnapshot").GraphSnapshot} GraphSnapshot */
/** @typedef {import("./HijackState.ts").HijackState} HijackState */
/** @typedef {import("@smithers-orchestrator/driver/RunOptions").RunOptions} RunOptions */
/** @typedef {import("@smithers-orchestrator/driver/RunResult").RunResult} RunResult */
/** @typedef {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow} SmithersWorkflow */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */
/** @typedef {import("@smithers-orchestrator/scheduler").TaskStateMap} TaskStateMap */
/** @typedef {import("@smithers-orchestrator/db/adapter/ApprovalRow").ApprovalRow} ApprovalRow */
/** @typedef {import("@smithers-orchestrator/db/adapter/RunRow").RunRow} RunRow */
/** @typedef {import("@smithers-orchestrator/graph/XmlNode").XmlNode} XmlNode */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} BunSQLiteDatabase */
/** @typedef {import("drizzle-orm/sqlite-core").SQLiteTable} SQLiteTable */

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
    return createHash("sha256").update(input).digest("hex");
}
/**
 * Track which worktree paths have already been created this run so we don't
 * re-create them for every task sharing the same worktree.
 */
const createdWorktrees = new Set();
const gitBinary = typeof Bun !== "undefined" ? Bun.which("git") : null;
const caffeinateBinary = typeof Bun !== "undefined" ? Bun.which("caffeinate") : null;
const RUN_WORKFLOW_RUN_ID_MAX_LENGTH = 256;
const RUN_WORKFLOW_WORKFLOW_PATH_MAX_LENGTH = 4096;
const RUN_WORKFLOW_INPUT_MAX_BYTES = 1024 * 1024;
const RUN_WORKFLOW_INPUT_MAX_DEPTH = 32;
const RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH = 512;
const RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH = 64 * 1024;
/**
 * @param {AgentCliActionKind} kind
 * @returns {boolean}
 */
function isBlockingAgentActionKind(kind) {
    return (kind === "command" ||
        kind === "tool" ||
        kind === "file_change" ||
        kind === "web_search");
}
/**
 * @returns {SmithersError}
 */
function makeAbortError(message = "Task aborted") {
    return new SmithersError("TASK_ABORTED", message, undefined, {
        name: "AbortError",
    });
}
/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
    if (!err)
        return false;
    if (err.name === "AbortError")
        return true;
    if (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "AbortError") {
        return true;
    }
    if (err instanceof Error) {
        return /aborted|abort/i.test(err.message);
    }
    return false;
}
/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<never> | null}
 */
function abortPromise(signal) {
    if (!signal)
        return null;
    if (signal.aborted)
        return Promise.reject(makeAbortError());
    return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(makeAbortError()), {
            once: true,
        });
    });
}
/**
 * @param {string | null} [metaJson]
 * @returns {Record<string, unknown>}
 */
function parseAttemptMetaJson(metaJson) {
    if (!metaJson)
        return {};
    try {
        const parsed = JSON.parse(metaJson);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
/**
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function asConversationMessages(value) {
    return Array.isArray(value) ? value : undefined;
}
/**
 * @template T
 * @param {T} value
 * @returns {T | undefined}
 */
function cloneJsonValue(value) {
    if (value === undefined)
        return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        return undefined;
    }
}
/**
 * @param {string | null} [heartbeatDataJson]
 * @returns {unknown | null}
 */
function parseAttemptHeartbeatData(heartbeatDataJson) {
    if (typeof heartbeatDataJson !== "string" || heartbeatDataJson.length === 0) {
        return null;
    }
    try {
        return JSON.parse(heartbeatDataJson);
    }
    catch {
        return null;
    }
}
/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<unknown>} seen
 */
function validateHeartbeatValue(value, path, seen) {
    if (value === null ||
        typeof value === "string" ||
        typeof value === "boolean") {
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new SmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", `Heartbeat payload must contain only finite numbers (invalid at ${path}).`, { path, value });
        }
        return;
    }
    if (value === undefined) {
        throw new SmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", `Heartbeat payload cannot include undefined values (invalid at ${path}).`, { path });
    }
    if (typeof value === "bigint" ||
        typeof value === "function" ||
        typeof value === "symbol") {
        throw new SmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", `Heartbeat payload contains a non-JSON value (invalid at ${path}).`, { path, valueType: typeof value });
    }
    if (typeof value !== "object") {
        throw new SmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", `Heartbeat payload contains an unsupported value at ${path}.`, { path });
    }
    if (seen.has(value)) {
        throw new SmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", "Heartbeat payload cannot contain circular references.", { path });
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            validateHeartbeatValue(value[i], `${path}[${i}]`, seen);
        }
        seen.delete(value);
        return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype &&
        prototype !== null &&
        !(value instanceof Date)) {
        throw new SmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", "Heartbeat payload must contain plain JSON objects.", { path });
    }
    for (const [key, entry] of Object.entries(value)) {
        validateHeartbeatValue(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
}
/**
 * @param {unknown} data
 * @returns {{ heartbeatDataJson: string; dataSizeBytes: number; }}
 */
function serializeHeartbeatPayload(data) {
    validateHeartbeatValue(data, "$", new Set());
    const heartbeatDataJson = JSON.stringify(data);
    const dataSizeBytes = Buffer.byteLength(heartbeatDataJson, "utf8");
    if (dataSizeBytes > TASK_HEARTBEAT_MAX_PAYLOAD_BYTES) {
        throw new SmithersError("HEARTBEAT_PAYLOAD_TOO_LARGE", `Heartbeat payload exceeds ${TASK_HEARTBEAT_MAX_PAYLOAD_BYTES} bytes.`, {
            dataSizeBytes,
            maxBytes: TASK_HEARTBEAT_MAX_PAYLOAD_BYTES,
        });
    }
    return { heartbeatDataJson, dataSizeBytes };
}
/**
 * @param {AbortSignal | undefined} signal
 * @param {unknown} err
 * @returns {SmithersError | null}
 */
function heartbeatTimeoutReasonFromAbort(signal, err) {
    const reason = signal?.aborted ? signal.reason : undefined;
    const candidate = reason ?? err;
    if (candidate instanceof SmithersError &&
        candidate.code === "TASK_HEARTBEAT_TIMEOUT") {
        return candidate;
    }
    if (candidate &&
        typeof candidate === "object" &&
        candidate.code === "TASK_HEARTBEAT_TIMEOUT") {
        return new SmithersError("TASK_HEARTBEAT_TIMEOUT", String(candidate.message ?? "Task heartbeat timed out."), candidate.details, { cause: candidate });
    }
    return null;
}
/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isHeartbeatPayloadValidationError(err) {
    if (err instanceof SmithersError) {
        return (err.code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" ||
            err.code === "HEARTBEAT_PAYLOAD_TOO_LARGE");
    }
    if (!err || typeof err !== "object") {
        return false;
    }
    const code = err.code;
    return (code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" ||
        code === "HEARTBEAT_PAYLOAD_TOO_LARGE");
}
/**
 * @param {Record<string, unknown>} meta
 * @param {string} engine
 * @returns {{ mode: "native-cli"; resume: string } | { mode: "conversation"; messages: unknown[] } | null}
 */
function extractHijackContinuation(meta, engine) {
    const handoff = meta.hijackHandoff;
    if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
        const handoffEngine = typeof handoff.engine === "string" ? handoff.engine : undefined;
        const handoffMode = handoff.mode === "conversation" ? "conversation" : "native-cli";
        if (handoffEngine === engine) {
            if (handoffMode === "native-cli") {
                const handoffResume = typeof handoff.resume === "string" ? handoff.resume : undefined;
                if (handoffResume) {
                    return { mode: "native-cli", resume: handoffResume };
                }
            }
            const handoffMessages = asConversationMessages(handoff.messages);
            if (handoffMode === "conversation" && handoffMessages?.length) {
                return { mode: "conversation", messages: handoffMessages };
            }
        }
    }
    const resume = typeof meta.agentResume === "string" ? meta.agentResume : undefined;
    if (typeof meta.agentEngine === "string" && meta.agentEngine === engine && resume) {
        return { mode: "native-cli", resume };
    }
    const messages = asConversationMessages(meta.agentConversation);
    if (typeof meta.agentEngine === "string" && meta.agentEngine === engine && messages?.length) {
        return { mode: "conversation", messages };
    }
    return null;
}
/**
 * @param {Array<{ metaJson?: string | null }>} attempts
 * @param {string} engine
 * @returns {{ mode: "native-cli"; resume: string } | { mode: "conversation"; messages: unknown[] } | undefined}
 */
function findHijackContinuation(attempts, engine) {
    for (const attempt of attempts) {
        const meta = parseAttemptMetaJson(attempt.metaJson);
        const continuation = extractHijackContinuation(meta, engine);
        if (continuation) {
            return continuation;
        }
    }
    return undefined;
}
const TOOL_RESUME_WARNING_MARKER = "[smithers:tool-resume-warning]";
/**
 * @param {any[]} agents
 * @returns {Map<string, ReturnType<typeof getDefinedToolMetadata>>}
 */
function collectDefinedToolMetadata(agents) {
    const metadataByName = new Map();
    for (const agent of agents) {
        const tools = agent && typeof agent === "object" && agent.tools && typeof agent.tools === "object"
            ? Object.entries(agent.tools)
            : [];
        for (const [toolName, tool] of tools) {
            const metadata = getDefinedToolMetadata(tool);
            if (!metadata) {
                continue;
            }
            metadataByName.set(toolName, metadata);
            metadataByName.set(metadata.name, metadata);
        }
    }
    return metadataByName;
}
/**
 * @param {Array<{ toolName?: string; attempt?: number; seq?: number; status?: string }>} toolCalls
 * @param {any[]} agents
 * @param {number} currentAttempt
 * @returns {ToolResumeWarning[]}
 */
function collectToolResumeWarnings(toolCalls, agents, currentAttempt) {
    if (currentAttempt <= 1 || toolCalls.length === 0) {
        return [];
    }
    const metadataByName = collectDefinedToolMetadata(agents);
    return toolCalls
        .filter((call) => typeof call.attempt === "number" && call.attempt < currentAttempt)
        .filter((call) => {
        const toolName = typeof call.toolName === "string" ? call.toolName : "";
        const metadata = metadataByName.get(toolName);
        return Boolean(metadata?.sideEffect && metadata.idempotent === false);
    })
        .map((call) => ({
        toolName: String(call.toolName ?? ""),
        attempt: Number(call.attempt ?? 0),
        seq: Number(call.seq ?? 0),
        status: String(call.status ?? "unknown"),
    }));
}
/**
 * @param {ToolResumeWarning[]} warnings
 * @returns {string | null}
 */
function buildToolResumeWarningMessage(warnings) {
    if (warnings.length === 0) {
        return null;
    }
    const shownWarnings = warnings.slice(0, 5);
    const lines = [
        `${TOOL_RESUME_WARNING_MARKER} Previous attempts in this task already called non-idempotent side-effect tools.`,
        "Those side effects may already have happened before the interruption or retry.",
        "Do not blindly call them again. Verify external state first or continue from the prior result.",
        "Smithers will reuse the same ctx.idempotencyKey for defineTool retries.",
        "Previously called tools:",
        ...shownWarnings.map((warning) => `- ${warning.toolName} (attempt ${warning.attempt}, seq ${warning.seq}, status ${warning.status})`),
    ];
    if (warnings.length > shownWarnings.length) {
        lines.push(`- ...and ${warnings.length - shownWarnings.length} more`);
    }
    return lines.join("\n");
}
/**
 * @param {unknown[] | undefined} messages
 * @returns {boolean}
 */
function hasToolResumeWarningMessage(messages) {
    return Array.isArray(messages)
        && messages.some((message) => {
            try {
                return JSON.stringify(message).includes(TOOL_RESUME_WARNING_MARKER);
            }
            catch {
                return false;
            }
        });
}
/**
 * @param {unknown[] | undefined} messages
 * @param {string | null} warningMessage
 * @returns {unknown[] | undefined}
 */
function appendToolResumeWarningMessage(messages, warningMessage) {
    if (!messages?.length || !warningMessage || hasToolResumeWarningMessage(messages)) {
        return messages;
    }
    return [
        ...messages,
        {
            role: "user",
            content: warningMessage,
        },
    ];
}
/**
 * @param {string} prompt
 * @param {string | null} warningMessage
 * @returns {string}
 */
function prependToolResumeWarningMessage(prompt, warningMessage) {
    if (!warningMessage || prompt.includes(TOOL_RESUME_WARNING_MARKER)) {
        return prompt;
    }
    return `${warningMessage}\n\n${prompt}`;
}
/**
 * @param {HijackCompletion} completion
 * @returns {Error}
 */
function buildHijackAbortError(completion) {
    const err = makeAbortError(`Hijack requested for ${completion.engine}`);
    err.code = "RUN_HIJACKED";
    err.hijack = completion;
    return err;
}
/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
async function runGitCommand(cwd, args) {
    return await new Promise((res) => {
        const child = nodeSpawn(gitBinary ?? "git", args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (err) => res({ code: 127, stdout: "", stderr: err.message }));
        child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    });
}
/**
 * Ensure a worktree exists at `worktreePath`, creating it from `rootDir`
 * if necessary. When `branch` is provided, a jj bookmark or git branch is
 * created/updated in the new worktree. Safe to call multiple times for the
 * same path.
 */
async function ensureWorktree(rootDir, worktreePath, branch, baseBranch) {
    if (existsSync(worktreePath)) {
        // Worktree exists — rebase onto the configured base branch so work starts from tip.
        const vcs = Effect.runSync(findVcsRoot(rootDir));
        const base = baseBranch || "main";
        if (vcs?.type === "jj") {
            await Effect.runPromise(runJj(["git", "fetch"], { cwd: worktreePath }).pipe(Effect.provide(BunContext.layer)));
            const rebaseRes = await Effect.runPromise(runJj(["rebase", "-d", base], { cwd: worktreePath }).pipe(Effect.provide(BunContext.layer)));
            if (rebaseRes.code !== 0) {
                console.warn(`[smithers] worktree sync: jj rebase -d ${base} failed (exit ${rebaseRes.code}): ${rebaseRes.stderr || "unknown error"}`);
            }
        }
        else if (vcs?.type === "git") {
            await runGitCommand(worktreePath, ["fetch", "origin"]);
            const rebaseRes = await runGitCommand(worktreePath, ["rebase", `origin/${base}`]);
            if (rebaseRes.code !== 0) {
                console.warn(`[smithers] worktree sync: git rebase origin/${base} failed (exit ${rebaseRes.code}): ${rebaseRes.stderr || "unknown error"}`);
            }
        }
        createdWorktrees.add(worktreePath);
        return;
    }
    if (createdWorktrees.has(worktreePath)) {
        createdWorktrees.delete(worktreePath);
    }
    // Walk up from rootDir to find the actual VCS root
    const vcs = Effect.runSync(findVcsRoot(rootDir));
    if (!vcs) {
        throw new SmithersError("VCS_NOT_FOUND", `Cannot create worktree: no git or jj repository found from ${rootDir}`, { rootDir });
    }
    // Best effort: refresh remote refs for git so origin/main can be used as a
    // base when local main is absent.
    if (vcs.type === "git") {
        await runGitCommand(vcs.root, ["fetch", "origin"]);
    }
    if (vcs.type === "jj") {
        const name = worktreePath.split("/").pop() ?? "worktree";
        const wsResult = await Effect.runPromise(workspaceAdd(name, worktreePath, { cwd: vcs.root, atRev: baseBranch }).pipe(Effect.provide(BunContext.layer)));
        if (!wsResult.success) {
            throw new SmithersError("WORKTREE_CREATE_FAILED", `Failed to create jj workspace at ${worktreePath}: ${wsResult.error}`, { worktreePath, vcsType: "jj" });
        }
        // Create a bookmark pointing at the new workspace's working copy
        if (branch) {
            const setRes = await Effect.runPromise(runJj(["bookmark", "set", branch, "-r", "@", "--allow-backwards"], {
                cwd: worktreePath,
            }).pipe(Effect.provide(BunContext.layer)));
            if (setRes.code !== 0) {
                throw new SmithersError("WORKTREE_CREATE_FAILED", `Failed to set jj bookmark ${branch} in ${worktreePath}: ${setRes.stderr || `exit ${setRes.code}`}`, { worktreePath, branch, vcsType: "jj" });
            }
        }
    }
    else {
        const baseRefs = baseBranch
            ? [baseBranch, `origin/${baseBranch}`, "HEAD"]
            : ["main", "origin/main", "HEAD"];
        if (branch) {
            // -B force-creates the branch (handles restarts gracefully)
            let created = false;
            const failures = [];
            for (const ref of baseRefs) {
                const result = await runGitCommand(vcs.root, [
                    "worktree",
                    "add",
                    "-B",
                    branch,
                    worktreePath,
                    ref,
                ]);
                if (result.code === 0) {
                    created = true;
                    break;
                }
                failures.push(`${ref}: ${result.stderr || `exit ${result.code}`}`);
            }
            if (!created) {
                throw new SmithersError("WORKTREE_CREATE_FAILED", `Failed to create git worktree at ${worktreePath} on branch ${branch}. Tried ${baseRefs.join(", ")}. ${failures.join(" | ")}`, { worktreePath, branch, vcsType: "git" });
            }
        }
        else {
            let created = false;
            const failures = [];
            for (const ref of baseRefs) {
                const result = await runGitCommand(vcs.root, [
                    "worktree",
                    "add",
                    worktreePath,
                    ref,
                ]);
                if (result.code === 0) {
                    created = true;
                    break;
                }
                failures.push(`${ref}: ${result.stderr || `exit ${result.code}`}`);
            }
            if (!created) {
                throw new SmithersError("WORKTREE_CREATE_FAILED", `Failed to create git worktree at ${worktreePath}. Tried ${baseRefs.join(", ")}. ${failures.join(" | ")}`, { worktreePath, vcsType: "git" });
            }
        }
    }
    createdWorktrees.add(worktreePath);
}
const DEFAULT_MAX_CONCURRENCY = 4;
const STALE_ATTEMPT_MS = 15 * 60 * 1000;
const SCHEDULER_EXTERNAL_EVENT_POLL_MS = 250;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const RUN_HEARTBEAT_MS = 1_000;
const RUN_HEARTBEAT_STALE_MS = 30_000;
const RUN_ABORT_SETTLE_POLL_MS = 10;
const RUN_ABORT_SETTLE_TIMEOUT_MS = 5_000;
const RUN_CANCEL_POLL_MS = 250;
const TASK_HEARTBEAT_THROTTLE_MS = 500;
const TASK_HEARTBEAT_MAX_PAYLOAD_BYTES = 1_000_000;
const TASK_HEARTBEAT_TIMEOUT_CHECK_MS = 250;
const MAX_CONTINUATION_STATE_BYTES = 10 * 1024 * 1024;
/**
 * @param {Pick<TaskDescriptor, "nodeId" | "iteration">} task
 * @returns {string}
 */
function workflowSessionTaskId(task) {
    return `${task.nodeId}::${task.iteration ?? 0}`;
}
/**
 * @param {readonly Pick<TaskDescriptor, "nodeId" | "iteration">[]} tasks
 * @returns {string[]}
 */
function workflowSessionTaskIds(tasks) {
    return tasks.map(workflowSessionTaskId).sort();
}
/**
 * @param {EngineDecision} decision
 * @returns {WorkflowSessionShadowDecisionSummary}
 */
function summarizeWorkflowSessionDecision(decision) {
    switch (decision._tag) {
        case "Execute":
            return { tag: "Execute", tasks: workflowSessionTaskIds(decision.tasks) };
        case "Wait":
            return { tag: "Wait", reason: decision.reason._tag };
        case "ContinueAsNew":
            return {
                tag: "ContinueAsNew",
                reason: decision.transition.reason,
            };
        case "Finished":
            return {
                tag: "Finished",
                status: decision.result.status,
            };
        case "Failed":
            return {
                tag: "Failed",
                code: typeof decision.error?.code === "string"
                    ? decision.error.code
                    : undefined,
            };
        case "ReRender":
            return { tag: "ReRender" };
    }
    return { tag: "Failed", code: "UNKNOWN_DECISION" };
}
/**
 * @param {{ runnable: TaskDescriptor[]; pendingExists: boolean; waitingApprovalExists: boolean; waitingEventExists: boolean; waitingTimerExists: boolean; readyRalphs: unknown[]; continuation?: unknown; nextRetryAtMs?: number; fatalError?: string; }} schedule
 * @param {TaskStateMap} stateMap
 * @param {TaskDescriptor[]} tasks
 * @param {ReadonlySet<string>} schedulerTaskKeys
 * @returns {WorkflowSessionShadowDecisionSummary}
 */
function summarizeLegacySchedulerDecision(schedule, stateMap, tasks, schedulerTaskKeys) {
    if (schedule.fatalError) {
        return { tag: "Failed" };
    }
    const failedTask = tasks.find((task) => {
        const state = stateMap.get(buildStateKey(task.nodeId, task.iteration));
        return state === "failed" && !task.continueOnFail;
    });
    if (failedTask) {
        return { tag: "Failed" };
    }
    if (schedule.continuation) {
        return { tag: "ContinueAsNew", reason: "explicit" };
    }
    if (schedule.runnable.length > 0) {
        return {
            tag: "Execute",
            tasks: workflowSessionTaskIds(schedule.runnable),
        };
    }
    if (schedulerTaskKeys.size > 0) {
        return { tag: "Wait", reason: "ExternalTrigger" };
    }
    if (schedule.waitingApprovalExists) {
        return { tag: "Wait", reason: "Approval" };
    }
    if (schedule.waitingEventExists) {
        return { tag: "Wait", reason: "Event" };
    }
    if (schedule.waitingTimerExists) {
        return { tag: "Wait", reason: "Timer" };
    }
    if (schedule.pendingExists) {
        return {
            tag: "Wait",
            reason: schedule.nextRetryAtMs == null ? "ExternalTrigger" : "RetryBackoff",
        };
    }
    if (schedule.readyRalphs.length > 0) {
        return { tag: "ReRender" };
    }
    return { tag: "Finished", status: "finished" };
}
/**
 * @param {WorkflowSessionShadowDecisionSummary} summary
 * @returns {string}
 */
function workflowSessionSummaryKey(summary) {
    return JSON.stringify(summary);
}
function buildRuntimeOwnerId() {
    return `pid:${process.pid}:${randomUUID()}`;
}
const DURABILITY_CONFIG_KEY = "__smithersDurability";
const DURABILITY_METADATA_VERSION = 2;
/** Prevent macOS idle sleep while a workflow is running. No-op on other platforms. */
function acquireCaffeinate() {
    if (platform() !== "darwin")
        return { release: () => { } };
    if (!caffeinateBinary)
        return { release: () => { } };
    try {
        const child = nodeSpawn(caffeinateBinary, ["-i", "-w", String(process.pid)], {
            stdio: "ignore",
            detached: true,
        });
        child.on("error", () => { });
        child.unref();
        return {
            release: () => {
                try {
                    child.kill();
                }
                catch { }
            },
        };
    }
    catch {
        return { release: () => { } };
    }
}
/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function coercePositiveInt(field, value, fallback) {
    if (value === undefined || value === null) {
        return fallback;
    }
    return Math.floor(assertPositiveFiniteInteger(field, Number(value)));
}
/**
 * @param {SQLiteTable} inputTable
 * @param {string} runId
 * @param {Record<string, unknown>} input
 */
function buildInputRow(inputTable, runId, input) {
    const cols = getTableColumns(inputTable);
    const keys = Object.keys(cols);
    const hasPayload = keys.includes("payload");
    const payloadOnly = hasPayload && keys.every((key) => key === "runId" || key === "payload");
    if (payloadOnly) {
        return { runId, payload: input };
    }
    return { runId, ...input };
}
/**
 * @param {any} row
 * @returns {Record<string, unknown>}
 */
function normalizeInputRow(row) {
    if (!row || typeof row !== "object")
        return {};
    if ("payload" in row) {
        const payload = row.payload;
        const { runId: _runId, payload: _payload, ...rest } = row;
        if (payload && typeof payload === "object") {
            return { ...payload, ...rest };
        }
        return rest;
    }
    const { runId: _runId, ...rest } = row;
    return rest;
}
/**
 * @param {any} row
 * @returns {unknown}
 */
function normalizeOutputRow(row) {
    if (!row || typeof row !== "object")
        return row;
    const keys = Object.keys(row);
    const payloadOnly = "payload" in row &&
        keys.every((key) => key === "runId" ||
            key === "nodeId" ||
            key === "iteration" ||
            key === "payload");
    if (payloadOnly) {
        return row.payload ?? null;
    }
    return stripAutoColumns(row);
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {Record<string, unknown>} schema
 * @param {SQLiteTable} inputTable
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
async function restoreDurableStateFromSnapshot(adapter, db, schema, inputTable, runId) {
    const snapshot = await loadLatestSnapshot(adapter, runId);
    if (!snapshot)
        return false;
    const parsed = parseSnapshot(snapshot);
    const restoredAtMs = snapshot.createdAtMs ?? nowMs();
    const inputRow = buildInputRow(inputTable, runId, normalizeInputRow(parsed.input));
    const inputValidation = validateInput(inputTable, inputRow);
    if (!inputValidation.ok) {
        throw new SmithersError("INVALID_INPUT", "Snapshot input does not match schema", {
            issues: inputValidation.error?.issues,
            runId,
            frameNo: snapshot.frameNo,
        });
    }
    const inputCols = getTableColumns(inputTable);
    await withSqliteWriteRetry(() => db
        .insert(inputTable)
        .values(inputRow)
        .onConflictDoUpdate({
        target: inputCols.runId,
        set: inputRow,
    }), { label: "restore input row from snapshot" });
    for (const node of Object.values(parsed.nodes)) {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            state: node.state,
            lastAttempt: node.lastAttempt ?? null,
            updatedAtMs: restoredAtMs,
            outputTable: node.outputTable ?? "",
            label: node.label ?? null,
        }));
    }
    for (const ralph of Object.values(parsed.ralph)) {
        await Effect.runPromise(adapter.insertOrUpdateRalph({
            runId,
            ralphId: ralph.ralphId,
            iteration: ralph.iteration ?? 0,
            done: Boolean(ralph.done),
            updatedAtMs: restoredAtMs,
        }));
    }
    for (const [schemaKey, table] of Object.entries(schema)) {
        if (!table || typeof table !== "object" || schemaKey === "input")
            continue;
        const tableName = getTableName(table);
        const rows = parsed.outputs[tableName] ??
            parsed.outputs[schemaKey] ??
            [];
        for (const rawRow of rows) {
            if (!rawRow || typeof rawRow !== "object")
                continue;
            const nodeId = typeof rawRow.nodeId === "string"
                ? rawRow.nodeId
                : null;
            if (!nodeId)
                continue;
            const iteration = typeof rawRow.iteration === "number"
                ? rawRow.iteration
                : 0;
            const nodeState = parsed.nodes[`${nodeId}::${iteration}`];
            if (nodeState?.state !== "finished")
                continue;
            const restoredRow = buildOutputRow(table, runId, nodeId, iteration, normalizeOutputRow(rawRow));
            const outputValidation = validateOutput(table, restoredRow);
            if (!outputValidation.ok) {
                throw new SmithersError("INVALID_OUTPUT", `Snapshot output does not match schema for ${tableName}`, {
                    issues: outputValidation.error?.issues,
                    nodeId,
                    iteration,
                    runId,
                    frameNo: snapshot.frameNo,
                    tableName,
                });
            }
            const outputCols = getTableColumns(table);
            const target = outputCols.iteration
                ? [outputCols.runId, outputCols.nodeId, outputCols.iteration]
                : [outputCols.runId, outputCols.nodeId];
            await withSqliteWriteRetry(() => db
                .insert(table)
                .values(restoredRow)
                .onConflictDoUpdate({
                target: target,
                set: restoredRow,
            }), { label: `restore output ${tableName} from snapshot` });
        }
    }
    return true;
}
/**
 * @param {string} identifier
 * @returns {string}
 */
function quoteSqlIdent(identifier) {
    return `"${identifier.replaceAll(`"`, `""`)}"`;
}
/**
 * @param {unknown} value
 * @returns {unknown}
 */
function toSqlValue(value) {
    if (value === undefined)
        return null;
    if (value === null)
        return null;
    if (typeof value === "object" &&
        !(value instanceof Uint8Array) &&
        !(value instanceof ArrayBuffer) &&
        !(value instanceof Date)) {
        return JSON.stringify(value);
    }
    return value;
}
/**
 * @param {any} table
 * @returns {Array<{ key: string; sqlName: string }>}
 */
function getTableColumnEntries(table) {
    const cols = getTableColumns(table);
    return Object.entries(cols).map(([key, col]) => ({
        key,
        sqlName: String(col?.name ?? key),
    }));
}
/**
 * @param {any} client
 * @param {string} tableName
 * @param {Record<string, unknown>} row
 * @param {Array<{ key: string; sqlName: string }>} columnEntries
 */
function insertRowWithClient(client, tableName, row, columnEntries) {
    const columns = columnEntries.filter((entry) => Object.prototype.hasOwnProperty.call(row, entry.key));
    if (columns.length === 0)
        return;
    const sql = `INSERT INTO ${quoteSqlIdent(tableName)} (${columns
        .map((entry) => quoteSqlIdent(entry.sqlName))
        .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    const values = columns.map((entry) => toSqlValue(row[entry.key]));
    client.query(sql).run(...values);
}
/**
 * @param {any} client
 * @param {any} table
 * @param {string} sourceRunId
 * @param {string} targetRunId
 */
function copyRunScopedRowsWithClient(client, table, sourceRunId, targetRunId) {
    const tableName = getTableName(table);
    const columnEntries = getTableColumnEntries(table);
    const runIdColumn = columnEntries.find((entry) => entry.key === "runId");
    if (!runIdColumn)
        return;
    const insertColumnsSql = columnEntries
        .map((entry) => quoteSqlIdent(entry.sqlName))
        .join(", ");
    const selectColumnsSql = columnEntries
        .map((entry) => entry.key === "runId" ? "?" : quoteSqlIdent(entry.sqlName))
        .join(", ");
    const sql = `INSERT INTO ${quoteSqlIdent(tableName)} (${insertColumnsSql}) SELECT ${selectColumnsSql} FROM ${quoteSqlIdent(tableName)} WHERE ${quoteSqlIdent(runIdColumn.sqlName)} = ?`;
    client.query(sql).run(targetRunId, sourceRunId);
}
/**
 * @param {RalphStateMap} ralphState
 * @returns {Record<string, { iteration: number; done: boolean }>}
 */
function ralphStateToObject(ralphState) {
    const out = {};
    const entries = [...ralphState.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [ralphId, state] of entries) {
        out[ralphId] = {
            iteration: state.iteration,
            done: state.done,
        };
    }
    return out;
}
/**
 * @param {RalphStateMap} ralphState
 * @returns {RalphStateMap}
 */
function cloneRalphStateMap(ralphState) {
    const next = new Map();
    for (const [ralphId, state] of ralphState.entries()) {
        next.set(ralphId, { iteration: state.iteration, done: state.done });
    }
    return next;
}
/**
 * @param {SQLiteTable} inputTable
 * @param {string} newRunId
 * @param {Record<string, unknown>} sourceInputRow
 * @param {Record<string, unknown>} continuationEnvelope
 * @returns {Record<string, unknown>}
 */
function buildCarriedInputRow(inputTable, newRunId, sourceInputRow, continuationEnvelope) {
    const columns = getTableColumns(inputTable);
    if (!columns.runId) {
        throw new SmithersError("DB_MISSING_COLUMNS", "schema.input must include runId column");
    }
    const row = {};
    for (const key of Object.keys(columns)) {
        if (key === "runId") {
            row[key] = newRunId;
            continue;
        }
        if (key === "payload") {
            const sourcePayload = sourceInputRow.payload;
            const payloadBase = sourcePayload && typeof sourcePayload === "object" && !Array.isArray(sourcePayload)
                ? { ...sourcePayload }
                : { value: sourcePayload ?? null };
            payloadBase.__smithersContinuation = continuationEnvelope;
            row[key] = payloadBase;
            continue;
        }
        row[key] = sourceInputRow[key] ?? null;
    }
    return row;
}
/**
 * @param {{ db: BunSQLiteDatabase; adapter: SmithersDb; schema: Record<string, unknown>; inputTable: SQLiteTable; runId: string; workflowPath: string | null; runMetadata: RunDurabilityMetadata; currentFrameNo: number; continuation: ContinueAsNewRequest; ralphState: RalphStateMap; }} params
 * @returns {Promise<ContinueAsNewTransition>}
 */
async function continueRunAsNew(params) {
    const { db, adapter, schema, inputTable, runId, workflowPath, runMetadata, currentFrameNo, continuation, ralphState, } = params;
    const sourceRun = await Effect.runPromise(adapter.getRun(runId));
    if (!sourceRun) {
        throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, { runId });
    }
    if (sourceRun.cancelRequestedAtMs) {
        throw new SmithersError("RUN_CANCELLED", `Run ${runId} was cancelled before continue-as-new handoff`, { runId });
    }
    const sourceInputRow = await loadInput(db, inputTable, runId);
    if (!sourceInputRow) {
        throw new SmithersError("MISSING_INPUT", `Cannot continue run ${runId} because no input row exists`, { runId });
    }
    const ancestry = await Effect.runPromise(adapter.listRunAncestry(runId, 10_000));
    const ancestryDepth = ancestry.length;
    const targetRunId = crypto.randomUUID();
    const ts = nowMs();
    const carriedRalphState = continuation.nextRalphState
        ? cloneRalphStateMap(continuation.nextRalphState)
        : cloneRalphStateMap(ralphState);
    const continuationEnvelope = {
        parentRunId: runId,
        reason: continuation.reason,
        iteration: continuation.iteration,
        loopId: continuation.loopId ?? null,
        continueAsNewEvery: continuation.continueAsNewEvery ?? null,
        payload: continuation.statePayload ?? null,
        ralph: ralphStateToObject(carriedRalphState),
        timestampMs: ts,
    };
    const carriedStateJson = JSON.stringify(continuationEnvelope);
    const carriedStateBytes = Buffer.byteLength(carriedStateJson, "utf8");
    if (carriedStateBytes > MAX_CONTINUATION_STATE_BYTES) {
        throw new SmithersError("CONTINUATION_STATE_TOO_LARGE", `Carried continuation state is ${carriedStateBytes} bytes (max ${MAX_CONTINUATION_STATE_BYTES}). Reduce continuation payload size or use external storage.`, {
            carriedStateBytes,
            maxBytes: MAX_CONTINUATION_STATE_BYTES,
        });
    }
    const outputTables = Object.entries(schema)
        .filter(([key, table]) => key !== "input" && table && typeof table === "object")
        .map(([, table]) => table);
    const inputTableName = getTableName(inputTable);
    const inputRow = buildCarriedInputRow(inputTable, targetRunId, sourceInputRow, continuationEnvelope);
    const inputColumnEntries = getTableColumnEntries(inputTable);
    const runConfigBase = sourceRun.configJson && sourceRun.configJson.trim().length > 0
        ? (() => {
            try {
                const parsed = JSON.parse(sourceRun.configJson);
                return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                    ? parsed
                    : {};
            }
            catch {
                return {};
            }
        })()
        : {};
    const nextConfigJson = JSON.stringify({
        ...runConfigBase,
        continuation: {
            ...continuationEnvelope,
            carriedStateBytes,
            ancestryDepth: ancestryDepth + 1,
        },
    });
    const continuationEvent = {
        type: "RunContinuedAsNew",
        runId,
        newRunId: targetRunId,
        iteration: continuation.iteration,
        carriedStateSize: carriedStateBytes,
        ancestryDepth: ancestryDepth + 1,
        timestampMs: ts,
    };
    await withSqliteWriteRetry(async () => {
        const client = db.$client;
        if (!client || typeof client.run !== "function" || typeof client.query !== "function") {
            throw new SmithersError("DB_REQUIRES_BUN_SQLITE", "Continue-as-new requires Bun SQLite client transaction primitives.");
        }
        client.run("BEGIN IMMEDIATE");
        try {
            const cancelState = client
                .query("SELECT cancel_requested_at_ms AS cancelRequestedAtMs FROM _smithers_runs WHERE run_id = ? LIMIT 1")
                .get(runId);
            if (cancelState?.cancelRequestedAtMs) {
                throw new SmithersError("RUN_CANCELLED", `Run ${runId} was cancelled before continue-as-new handoff`, { runId });
            }
            client
                .query(`INSERT INTO _smithers_runs (
              run_id,
              parent_run_id,
              workflow_name,
              workflow_path,
              workflow_hash,
              status,
              created_at_ms,
              started_at_ms,
              finished_at_ms,
              heartbeat_at_ms,
              runtime_owner_id,
              cancel_requested_at_ms,
              hijack_requested_at_ms,
              hijack_target,
              vcs_type,
              vcs_root,
              vcs_revision,
              error_json,
              config_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(targetRunId, runId, sourceRun.workflowName ?? "workflow", workflowPath ?? sourceRun.workflowPath ?? null, runMetadata.workflowHash ?? sourceRun.workflowHash ?? null, "running", ts, ts, null, null, null, null, null, null, runMetadata.vcsType ?? sourceRun.vcsType ?? null, runMetadata.vcsRoot ?? sourceRun.vcsRoot ?? null, runMetadata.vcsRevision ?? sourceRun.vcsRevision ?? null, null, nextConfigJson);
            insertRowWithClient(client, inputTableName, inputRow, inputColumnEntries);
            for (const table of outputTables) {
                copyRunScopedRowsWithClient(client, table, runId, targetRunId);
            }
            for (const [ralphId, state] of carriedRalphState.entries()) {
                client
                    .query(`INSERT INTO _smithers_ralph (run_id, ralph_id, iteration, done, updated_at_ms)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(run_id, ralph_id)
               DO UPDATE SET iteration = excluded.iteration, done = excluded.done, updated_at_ms = excluded.updated_at_ms`)
                    .run(targetRunId, ralphId, state.iteration, state.done ? 1 : 0, ts);
            }
            client
                .query(`INSERT INTO _smithers_branches (
              run_id,
              parent_run_id,
              parent_frame_no,
              branch_label,
              fork_description,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id)
            DO UPDATE SET
              parent_run_id = excluded.parent_run_id,
              parent_frame_no = excluded.parent_frame_no,
              branch_label = excluded.branch_label,
              fork_description = excluded.fork_description,
              created_at_ms = excluded.created_at_ms`)
                .run(targetRunId, runId, currentFrameNo, "continue-as-new", `continue-as-new:${continuation.reason}`, ts);
            client
                .query(`UPDATE _smithers_runs
             SET status = ?, finished_at_ms = ?, heartbeat_at_ms = NULL, runtime_owner_id = NULL,
                 cancel_requested_at_ms = NULL, hijack_requested_at_ms = NULL, hijack_target = NULL
             WHERE run_id = ?`)
                .run("continued", ts, runId);
            const nextEventSeq = Number(client
                .query("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_events WHERE run_id = ?")
                .get(runId)?.seq ?? 0);
            client
                .query(`INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
             VALUES (?, ?, ?, ?, ?)`)
                .run(runId, nextEventSeq, ts, continuationEvent.type, JSON.stringify(continuationEvent));
            client.run("COMMIT");
        }
        catch (error) {
            try {
                client.run("ROLLBACK");
            }
            catch {
                // ignore rollback failures
            }
            throw error;
        }
    }, { label: "continue-as-new handoff" });
    return {
        newRunId: targetRunId,
        ancestryDepth: ancestryDepth + 1,
        carriedStateBytes,
    };
}
/**
 * @param {BunSQLiteDatabase} db
 * @param {SQLiteTable} inputTable
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {Map<string, TaskDescriptor>} descriptorMap
 * @param {number} attempt
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildCacheContext(db, inputTable, runId, desc, descriptorMap, attempt) {
    const inputRow = await loadInput(db, inputTable, runId);
    const ctx = {
        input: normalizeInputRow(inputRow),
        executionId: runId,
        stepId: desc.nodeId,
        attempt,
        iteration: desc.iteration,
        loop: { iteration: desc.iteration + 1 },
    };
    const needs = desc.needs ??
        (desc.dependsOn
            ? Object.fromEntries(desc.dependsOn.map((id) => [id, id]))
            : undefined);
    if (needs) {
        for (const [key, depId] of Object.entries(needs)) {
            const dep = descriptorMap.get(depId);
            if (!dep?.outputTable)
                continue;
            const row = await selectOutputRow(db, dep.outputTable, {
                runId,
                nodeId: dep.nodeId,
                iteration: dep.iteration,
            });
            if (row !== undefined) {
                ctx[key] = normalizeOutputRow(row);
            }
        }
    }
    return ctx;
}
/**
 * @param {RunOptions} opts
 * @param {string | null} [workflowPath]
 * @returns {string}
 */
function resolveRootDir(opts, workflowPath) {
    if (opts.rootDir)
        return resolve(opts.rootDir);
    if (workflowPath)
        return resolve(dirname(workflowPath));
    return resolve(process.cwd());
}
/**
 * @param {string} rootDir
 * @param {string} runId
 * @param {string | null} [logDir]
 * @returns {string | undefined}
 */
function resolveLogDir(rootDir, runId, logDir) {
    if (logDir === null)
        return undefined;
    if (typeof logDir === "string") {
        return resolve(rootDir, logDir);
    }
    return resolve(rootDir, ".smithers", "executions", runId, "logs");
}
const STATIC_IMPORT_RE = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const WORKFLOW_IMPORT_EXTENSIONS = [
    "",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
];
/**
 * @param {string | null | undefined} sourcePath
 */
function getWorkflowImportScanLoader(sourcePath) {
    const lower = sourcePath?.toLowerCase() ?? "";
    if (lower.endsWith(".tsx"))
        return "tsx";
    if (lower.endsWith(".jsx"))
        return "jsx";
    if (lower.endsWith(".ts") ||
        lower.endsWith(".mts") ||
        lower.endsWith(".cts")) {
        return "ts";
    }
    return "js";
}
/**
 * @param {string | null} workflowPath
 * @returns {Promise<string | null>}
 */
async function readWorkflowEntryHash(workflowPath) {
    if (!workflowPath)
        return null;
    try {
        const raw = await readFile(workflowPath, "utf8");
        return sha256Hex(raw);
    }
    catch {
        return null;
    }
}
/**
 * @param {string} source
 * @param {string | null} [sourcePath]
 * @returns {string[]}
 */
function extractWorkflowImportSpecifiers(source, sourcePath) {
    if (typeof Bun !== "undefined" && typeof Bun.Transpiler === "function") {
        try {
            const scanned = new Bun.Transpiler({
                loader: getWorkflowImportScanLoader(sourcePath),
            }).scanImports(source);
            const specifiers = new Set();
            for (const entry of scanned) {
                const specifier = entry?.path?.trim();
                if (specifier?.startsWith(".")) {
                    specifiers.add(specifier);
                }
            }
            return [...specifiers];
        }
        catch {
            // Fall back to regex scanning if Bun's parser cannot handle the source.
        }
    }
    const specifiers = new Set();
    for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) {
            const specifier = match[1]?.trim();
            if (!specifier?.startsWith("."))
                continue;
            specifiers.add(specifier);
        }
    }
    return [...specifiers];
}
/**
 * @param {string} baseFile
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveWorkflowImport(baseFile, specifier) {
    const basePath = resolve(dirname(baseFile), specifier);
    const candidates = [
        ...WORKFLOW_IMPORT_EXTENSIONS.map((ext) => `${basePath}${ext}`),
        ...WORKFLOW_IMPORT_EXTENSIONS
            .filter((ext) => ext.length > 0)
            .map((ext) => resolve(basePath, `index${ext}`)),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return resolve(candidate);
        }
    }
    return null;
}
/**
 * @param {string} workflowPath
 * @returns {Promise<string[]>}
 */
async function collectWorkflowModuleHashEntries(workflowPath, visited = new Set()) {
    const resolvedPath = resolve(workflowPath);
    if (visited.has(resolvedPath)) {
        return [];
    }
    visited.add(resolvedPath);
    const source = await readFile(resolvedPath, "utf8");
    const entries = [`${resolvedPath}:${sha256Hex(source)}`];
    for (const specifier of extractWorkflowImportSpecifiers(source, resolvedPath)) {
        const importedPath = resolveWorkflowImport(resolvedPath, specifier);
        if (!importedPath) {
            throw new SmithersError("WORKFLOW_HASH_RESOLUTION_FAILED", `Unable to resolve workflow import "${specifier}" from ${resolvedPath}.`, { workflowPath: resolvedPath, specifier });
        }
        entries.push(...(await collectWorkflowModuleHashEntries(importedPath, visited)));
    }
    return entries;
}
/**
 * @param {string | null} workflowPath
 * @returns {Promise<string | null>}
 */
async function readWorkflowGraphHash(workflowPath) {
    if (!workflowPath)
        return null;
    try {
        const entries = await collectWorkflowModuleHashEntries(workflowPath);
        return sha256Hex(entries.sort().join("|"));
    }
    catch {
        return null;
    }
}
/**
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function getGitPointer(cwd) {
    const res = await runGitCommand(cwd, ["rev-parse", "HEAD"]);
    if (res.code !== 0)
        return null;
    const out = res.stdout.trim();
    return out ? out : null;
}
/**
 * @param {string | null} workflowPath
 * @param {string} rootDir
 * @returns {Promise<RunDurabilityMetadata>}
 */
async function getRunDurabilityMetadata(workflowPath, rootDir) {
    const entryWorkflowHash = await readWorkflowEntryHash(workflowPath);
    const workflowHash = await readWorkflowGraphHash(workflowPath);
    const vcs = Effect.runSync(findVcsRoot(rootDir));
    if (!vcs) {
        return {
            workflowHash,
            entryWorkflowHash,
            vcsType: null,
            vcsRoot: null,
            vcsRevision: null,
        };
    }
    const vcsRevision = vcs.type === "jj"
        ? await Effect.runPromise(getJjPointer(rootDir).pipe(Effect.provide(BunContext.layer)))
        : await getGitPointer(rootDir);
    return {
        workflowHash,
        entryWorkflowHash,
        vcsType: vcs.type,
        vcsRoot: vcs.root,
        vcsRevision,
    };
}
/**
 * @param {Record<string, unknown>} config
 * @param {RunDurabilityMetadata} metadata
 * @returns {Record<string, unknown> & { [DURABILITY_CONFIG_KEY]: { version: number; entryWorkflowHash: string | null; }; }}
 */
function buildDurabilityConfig(config, metadata) {
    return {
        ...config,
        [DURABILITY_CONFIG_KEY]: {
            version: DURABILITY_METADATA_VERSION,
            entryWorkflowHash: metadata.entryWorkflowHash,
        },
    };
}
/**
 * @param {Record<string, unknown>} config
 * @returns {{ version: number; entryWorkflowHash: string | null } | null}
 */
function getStoredDurabilityConfig(config) {
    const raw = config[DURABILITY_CONFIG_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    return {
        version: typeof raw.version === "number"
            ? raw.version
            : 0,
        entryWorkflowHash: typeof raw.entryWorkflowHash === "string"
            ? raw.entryWorkflowHash
            : null,
    };
}
/**
 * @param {string | null | undefined} left
 * @param {string | null | undefined} right
 * @param {string} mismatchLabel
 * @param {string[]} mismatches
 */
function compareNullableString(left, right, mismatchLabel, mismatches) {
    const normalizedLeft = left ?? null;
    const normalizedRight = right ?? null;
    if (normalizedLeft !== normalizedRight) {
        mismatches.push(mismatchLabel);
    }
}
/**
 * @param {RunRow | null | undefined} existingRun
 * @param {Record<string, unknown>} existingConfig
 * @param {RunDurabilityMetadata} current
 * @param {string | null} workflowPath
 */
function assertResumeDurabilityMetadata(existingRun, existingConfig, current, workflowPath) {
    const mismatches = [];
    const storedDurability = getStoredDurabilityConfig(existingConfig);
    const storedDurabilityVersion = storedDurability?.version ?? 0;
    const storedEntryWorkflowHash = storedDurability?.entryWorkflowHash ?? null;
    if (existingRun.workflowPath &&
        workflowPath &&
        resolve(existingRun.workflowPath) !== resolve(workflowPath)) {
        mismatches.push("workflow path changed");
    }
    const shouldCheckWorkflowHashes = Boolean(existingRun.workflowPath ||
        workflowPath ||
        existingRun.workflowHash ||
        current.workflowHash ||
        storedDurability?.entryWorkflowHash ||
        current.entryWorkflowHash);
    if (shouldCheckWorkflowHashes &&
        storedDurabilityVersion >= DURABILITY_METADATA_VERSION) {
        if (!existingRun.workflowHash || !current.workflowHash) {
            mismatches.push("workflow module graph unavailable");
        }
        else {
            compareNullableString(existingRun.workflowHash, current.workflowHash, "workflow module graph changed", mismatches);
        }
        if (!storedEntryWorkflowHash || !current.entryWorkflowHash) {
            mismatches.push("workflow entry hash unavailable");
        }
        else {
            compareNullableString(storedEntryWorkflowHash, current.entryWorkflowHash, "workflow entry file changed", mismatches);
        }
    }
    else if (shouldCheckWorkflowHashes) {
        compareNullableString(existingRun.workflowHash, current.entryWorkflowHash, "workflow entry file changed", mismatches);
    }
    if ((existingRun.vcsRoot && current.vcsRoot
        ? resolve(existingRun.vcsRoot) !== resolve(current.vcsRoot)
        : (existingRun.vcsRoot ?? null) !== (current.vcsRoot ?? null))) {
        mismatches.push("VCS root changed");
    }
    if (mismatches.length > 0) {
        throw new SmithersError("RESUME_METADATA_MISMATCH", `Cannot resume run because durable metadata changed: ${mismatches.join(", ")}`, {
            existing: {
                workflowPath: existingRun.workflowPath ?? null,
                workflowHash: existingRun.workflowHash ?? null,
                vcsType: existingRun.vcsType ?? null,
                vcsRoot: existingRun.vcsRoot ?? null,
                vcsRevision: existingRun.vcsRevision ?? null,
            },
            current,
        });
    }
}
/**
 * @param {AbortController} controller
 * @param {AbortSignal} [signal]
 */
function wireAbortSignal(controller, signal) {
    if (!signal)
        return () => { };
    if (signal.aborted) {
        controller.abort();
        return () => { };
    }
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} runtimeOwnerId
 * @param {AbortController} controller
 * @param {HijackState} hijackState
 */
function startRunSupervisor(adapter, runId, runtimeOwnerId, controller, hijackState) {
    let closed = false;
    const heartbeat = setInterval(() => {
        if (closed || controller.signal.aborted)
            return;
        void Effect.runPromise(adapter.heartbeatRun(runId, runtimeOwnerId, nowMs())).catch((error) => {
            logWarning("failed to persist run heartbeat", {
                runId,
                runtimeOwnerId,
                error: error instanceof Error ? error.message : String(error),
            }, "engine:heartbeat");
        });
    }, RUN_HEARTBEAT_MS);
    const cancelWatcher = (async () => {
        while (!closed && !controller.signal.aborted) {
            try {
                const run = await Effect.runPromise(adapter.getRun(runId));
                if (run?.hijackRequestedAtMs &&
                    (!hijackState.request ||
                        run.hijackRequestedAtMs > hijackState.request.requestedAtMs)) {
                    hijackState.request = {
                        requestedAtMs: run.hijackRequestedAtMs,
                        target: run.hijackTarget ?? null,
                    };
                    logInfo("detected durable run hijack request", {
                        runId,
                        runtimeOwnerId,
                        hijackRequestedAtMs: run.hijackRequestedAtMs,
                        hijackTarget: run.hijackTarget ?? null,
                    }, "engine:hijack-watch");
                }
                if (run?.cancelRequestedAtMs) {
                    logInfo("detected durable run cancellation", {
                        runId,
                        runtimeOwnerId,
                        cancelRequestedAtMs: run.cancelRequestedAtMs,
                    }, "engine:cancel-watch");
                    controller.abort();
                    return;
                }
            }
            catch (error) {
                logWarning("failed to poll run cancel state", {
                    runId,
                    runtimeOwnerId,
                    error: error instanceof Error ? error.message : String(error),
                }, "engine:cancel-watch");
            }
            await Bun.sleep(RUN_CANCEL_POLL_MS);
        }
    })();
    return async () => {
        closed = true;
        clearInterval(heartbeat);
        await cancelWatcher.catch(() => undefined);
    };
}
/**
 * @param {{ status?: string | null; heartbeatAtMs?: number | null } | null | undefined} run
 * @returns {boolean}
 */
export function isRunHeartbeatFresh(run, now = nowMs()) {
    return Boolean(run &&
        run.status === "running" &&
        typeof run.heartbeatAtMs === "number" &&
        now - run.heartbeatAtMs <= RUN_HEARTBEAT_STALE_MS);
}
/**
 * @param {string | null | undefined} value
 * @returns {Record<string, unknown>}
 */
function parseRunConfigJson(value) {
    if (!value) {
        return {};
    }
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
/**
 * @param {unknown} value
 * @returns {RunAuthContext | null}
 */
function parseRunAuthContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const record = value;
    if (typeof record.triggeredBy !== "string" ||
        !Array.isArray(record.scopes) ||
        typeof record.role !== "string" ||
        typeof record.createdAt !== "string") {
        return null;
    }
    const scopes = record.scopes.filter((entry) => typeof entry === "string");
    return {
        triggeredBy: record.triggeredBy,
        scopes,
        role: record.role,
        createdAt: record.createdAt,
    };
}
const RESUMABLE_RUN_STATUSES = new Set([
    "running",
    "waiting-approval",
    "waiting-event",
    "waiting-timer",
    "cancelled",
    "finished",
    "failed",
]);
/**
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
function isResumableRunStatus(status) {
    return typeof status === "string" && RESUMABLE_RUN_STATUSES.has(status);
}
/**
 * @param {boolean | HotReloadOptions | undefined} hot
 * @returns {HotReloadOptions & { enabled: boolean }}
 */
function normalizeHotOptions(hot) {
    if (!hot)
        return { enabled: false };
    if (hot === true)
        return { enabled: true };
    return { enabled: true, ...hot };
}
/**
 * @param {unknown} input
 */
function assertInputObject(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new SmithersError("INVALID_INPUT", "Run input must be a JSON object");
    }
}
/**
 * @param {RunOptions} opts
 */
function validateRunOptions(opts) {
    assertOptionalStringMaxLength("runId", opts.runId, RUN_WORKFLOW_RUN_ID_MAX_LENGTH);
    assertOptionalStringMaxLength("workflowPath", opts.workflowPath, RUN_WORKFLOW_WORKFLOW_PATH_MAX_LENGTH);
    assertInputObject(opts.input);
    assertJsonPayloadWithinBounds("input", opts.input, {
        maxArrayLength: RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH,
        maxBytes: RUN_WORKFLOW_INPUT_MAX_BYTES,
        maxDepth: RUN_WORKFLOW_INPUT_MAX_DEPTH,
        maxStringLength: RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH,
    });
    if (opts.maxConcurrency !== undefined) {
        assertPositiveFiniteInteger("maxConcurrency", Number(opts.maxConcurrency));
    }
    if (opts.maxOutputBytes !== undefined) {
        assertPositiveFiniteInteger("maxOutputBytes", Number(opts.maxOutputBytes));
    }
    if (opts.toolTimeoutMs !== undefined) {
        assertPositiveFiniteInteger("toolTimeoutMs", Number(opts.toolTimeoutMs));
    }
    if (opts.resumeClaim) {
        assertOptionalStringMaxLength("resumeClaim.claimOwnerId", opts.resumeClaim.claimOwnerId, RUN_WORKFLOW_RUN_ID_MAX_LENGTH);
        assertPositiveFiniteInteger("resumeClaim.claimHeartbeatAtMs", Number(opts.resumeClaim.claimHeartbeatAtMs));
        if (opts.resumeClaim.restoreHeartbeatAtMs !== undefined && opts.resumeClaim.restoreHeartbeatAtMs !== null) {
            assertPositiveFiniteInteger("resumeClaim.restoreHeartbeatAtMs", Number(opts.resumeClaim.restoreHeartbeatAtMs));
        }
    }
}
/**
 * @param {{ _?: { fullSchema?: Record<string, unknown>; schema?: Record<string, unknown> }; schema?: Record<string, unknown> }} db
 * @returns {Record<string, unknown>}
 */
export function resolveSchema(db) {
    const candidates = [db?._?.fullSchema, db?._?.schema, db?.schema];
    let schema = {};
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object")
            continue;
        if (candidate.input) {
            try {
                getTableName(candidate.input);
                schema = candidate;
                break;
            }
            catch {
                continue;
            }
        }
        else {
            schema = candidate;
            break;
        }
    }
    const filtered = {};
    for (const [key, table] of Object.entries(schema)) {
        if (key.startsWith("_smithers"))
            continue;
        if (table && typeof table === "object") {
            try {
                const name = getTableName(table);
                if (name.startsWith("_smithers"))
                    continue;
            }
            catch {
                continue; // Skip non-table entries (e.g. Drizzle relations/metadata)
            }
        }
        else {
            continue; // Skip non-object entries
        }
        filtered[key] = table;
    }
    return filtered;
}
/**
 * Resolve task output references:
 * Match the ZodObject on outputSchema against zodToKeyName to find the
 * schema registry entry, then set outputTable and outputTableName.
 */
function resolveTaskOutputs(tasks, workflow) {
    for (const task of tasks) {
        if (isTimerTask(task)) {
            continue;
        }
        // Already resolved (has a table)
        if (task.outputTable) {
            if (!task.outputSchema && task.outputTableName && workflow.schemaRegistry) {
                const entry = workflow.schemaRegistry.get(task.outputTableName);
                if (entry) {
                    task.outputSchema = entry.zodSchema;
                }
            }
            continue;
        }
        // Resolve ZodObject via outputRef (output prop) first.
        if (task.outputRef && workflow.zodToKeyName) {
            const keyName = workflow.zodToKeyName.get(task.outputRef);
            if (keyName && workflow.schemaRegistry) {
                const entry = workflow.schemaRegistry.get(keyName);
                if (entry) {
                    task.outputTable = entry.table;
                    task.outputTableName = keyName;
                    if (!task.outputSchema)
                        task.outputSchema = entry.zodSchema;
                }
            }
            if (!task.outputTable) {
                throw new SmithersError("UNKNOWN_OUTPUT_SCHEMA", `Task "${task.nodeId}" uses an output ZodObject that is not registered in createSmithers()`);
            }
        }
        const raw = task.outputSchema;
        // Resolve ZodObject via outputSchema when no outputRef resolved.
        if (!task.outputTable && raw && typeof raw === "object" && workflow.zodToKeyName) {
            const keyName = workflow.zodToKeyName.get(raw);
            if (keyName && workflow.schemaRegistry) {
                const entry = workflow.schemaRegistry.get(keyName);
                if (entry) {
                    task.outputTable = entry.table;
                    task.outputTableName = keyName;
                    if (!task.outputSchema)
                        task.outputSchema = entry.zodSchema;
                }
            }
            if (!task.outputTable) {
                throw new SmithersError("UNKNOWN_OUTPUT_SCHEMA", `Task "${task.nodeId}" uses an output ZodObject that is not registered in createSmithers()`);
            }
        }
        if (!task.outputTable) {
            const keyName = typeof task.outputTableName === "string" && task.outputTableName.length > 0
                ? task.outputTableName
                : typeof raw === "string"
                    ? raw
                    : undefined;
            if (keyName && workflow.schemaRegistry) {
                const entry = workflow.schemaRegistry.get(keyName);
                if (entry) {
                    task.outputTable = entry.table;
                    task.outputTableName = keyName;
                    if (!task.outputSchema || typeof task.outputSchema === "string") {
                        task.outputSchema = entry.zodSchema;
                    }
                }
            }
        }
        if (!task.outputTable) {
            throw new SmithersError("UNKNOWN_OUTPUT_SCHEMA", `Task "${task.nodeId}" uses an output schema key that is not registered in createSmithers()`, {
                output: task.outputTableName ?? (typeof raw === "string" ? raw : undefined),
            });
        }
    }
}
/**
 * @param {TaskDescriptor[]} tasks
 * @param {SmithersWorkflow<any>} workflow
 * @param {{ rootDir?: string; workflowPath?: string | null }} [opts]
 */
function attachSubflowComputeFns(tasks, workflow, opts = {}) {
    for (const task of tasks) {
        if (!task.meta?.__subflow || task.computeFn)
            continue;
        const subflowWorkflow = task.meta.__subflowWorkflow;
        if (!subflowWorkflow)
            continue;
        const subflowInput = task.meta.__subflowInput;
        task.computeFn = async () => {
            const result = await executeChildWorkflow(workflow, {
                workflow: subflowWorkflow,
                input: subflowInput,
                rootDir: opts.rootDir,
                workflowPath: opts.workflowPath ?? undefined,
            });
            if (result.status !== "finished") {
                throw new SmithersError("WORKFLOW_EXECUTION_FAILED", `Subflow ${task.nodeId} failed with status ${result.status}.`, { nodeId: task.nodeId, status: result.status });
            }
            return result.output;
        };
        const { __subflowWorkflow: _workflow, ...persistableMeta } = task.meta;
        task.meta = persistableMeta;
    }
}
/**
 * @param {XmlNode} xml
 * @returns {string}
 */
function getWorkflowNameFromXml(xml) {
    if (!xml || xml.kind !== "element")
        return "workflow";
    if (xml.tag !== "smithers:workflow")
        return "workflow";
    return xml.props?.name ?? "workflow";
}
/**
 * @param {TaskDescriptor[]} tasks
 * @returns {Map<string, TaskDescriptor>}
 */
function buildDescriptorMap(tasks) {
    const map = new Map();
    for (const task of tasks)
        map.set(task.nodeId, task);
    return map;
}
/**
 * @param {any[]} rows
 * @returns {RalphStateMap}
 */
function buildRalphStateMap(rows) {
    const map = new Map();
    for (const row of rows) {
        map.set(row.ralphId, {
            iteration: row.iteration ?? 0,
            done: Boolean(row.done),
        });
    }
    return map;
}
/**
 * @param {RalphStateMap} state
 * @returns {Map<string, number>}
 */
function ralphIterationsFromState(state) {
    const map = new Map();
    for (const [id, value] of state.entries()) {
        map.set(id, value.iteration ?? 0);
    }
    return map;
}
/**
 * @param {RalphStateMap} state
 * @returns {Record<string, number>}
 */
function ralphIterationsObject(state) {
    const obj = {};
    // First pass: set all entries including scoped ones
    for (const [id, value] of state.entries()) {
        obj[id] = value.iteration ?? 0;
    }
    // Second pass: for scoped ralph IDs like "inner@@outer=0", set the logical
    // shortcut "inner" to the iteration of the scoped variant whose ancestor
    // scope matches the current ancestor iterations.
    //
    // Collect all logical IDs that have scoped variants so we can detect when
    // the current-scope variant doesn't exist yet (meaning it should default to 0).
    const logicalIdsWithScope = new Set();
    for (const id of state.keys()) {
        const atIdx = id.indexOf("@@");
        if (atIdx >= 0)
            logicalIdsWithScope.add(id.slice(0, atIdx));
    }
    // Initialize logical shortcuts to 0 (for when current scope variant hasn't
    // been created yet, e.g. outer just advanced but inner hasn't been initialized).
    for (const logicalId of logicalIdsWithScope) {
        obj[logicalId] = 0;
    }
    for (const [id, value] of state.entries()) {
        const atIdx = id.indexOf("@@");
        if (atIdx < 0)
            continue;
        const logicalId = id.slice(0, atIdx);
        const scopeSuffix = id.slice(atIdx + 2);
        const parts = scopeSuffix.split(",");
        let isCurrent = true;
        for (const part of parts) {
            const eqIdx = part.indexOf("=");
            if (eqIdx < 0) {
                isCurrent = false;
                break;
            }
            const ancestorId = part.slice(0, eqIdx);
            const ancestorIter = Number(part.slice(eqIdx + 1));
            // Look up the ancestor's current iteration (unscoped entry)
            const currentAncestorIter = obj[ancestorId];
            if (currentAncestorIter !== ancestorIter) {
                isCurrent = false;
                break;
            }
        }
        if (isCurrent) {
            obj[logicalId] = value.iteration ?? 0;
        }
    }
    return obj;
}
/**
 * @param {{ id: string; until: boolean }[]} ralphs
 * @param {RalphStateMap} state
 * @returns {Map<string, boolean>}
 */
function buildRalphDoneMap(ralphs, state) {
    const done = new Map();
    for (const ralph of ralphs) {
        const st = state.get(ralph.id);
        done.set(ralph.id, Boolean(ralph.until || st?.done));
    }
    return done;
}
/**
 * @param {string | null} [errorJson]
 * @returns {string | null}
 */
function parseAttemptErrorCode(errorJson) {
    if (!errorJson)
        return null;
    try {
        const parsed = JSON.parse(errorJson);
        return typeof parsed?.code === "string" ? parsed.code : null;
    }
    catch {
        return null;
    }
}
/**
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 */
function isRetryableTaskFailure(attempt) {
    const meta = parseAttemptMetaJson(attempt?.metaJson);
    if (meta?.failureRetryable === false) {
        return false;
    }
    const errorCode = parseAttemptErrorCode(attempt?.errorJson);
    // AGENT_CONFIG_INVALID is a deterministic configuration failure (e.g.
    // "LLM not set", unknown model). Retrying is guaranteed to fail again
    // and just multiplies cost — short-circuit immediately.
    if (errorCode === "AGENT_CONFIG_INVALID") {
        return false;
    }
    const kind = typeof meta?.kind === "string" ? meta.kind : null;
    return !(kind !== "agent" && errorCode === "INVALID_OUTPUT");
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {TaskDescriptor[]} tasks
 * @param {EventBus} eventBus
 * @param {Map<string, boolean>} ralphDone
 * @returns {Promise<{ stateMap: TaskStateMap; retryWait: Map<string, number> }>}
 */
async function computeTaskStates(adapter, db, runId, tasks, eventBus, ralphDone) {
    const stateMap = new Map();
    const retryWait = new Map();
    const existing = await Effect.runPromise(adapter.listNodes(runId));
    const existingState = new Map();
    for (const node of existing) {
        existingState.set(buildStateKey(node.nodeId, node.iteration ?? 0), node.state);
    }
    /**
   * @param {TaskState} state
   * @param {TaskDescriptor} desc
   */
    const maybeEmitStateEvent = async (state, desc) => {
        const key = buildStateKey(desc.nodeId, desc.iteration);
        const prev = existingState.get(key);
        if (state === "pending" && prev !== "pending") {
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodePending",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                timestampMs: nowMs(),
            }));
            existingState.set(key, state);
        }
        if (state === "skipped" && prev !== "skipped") {
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodeSkipped",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                timestampMs: nowMs(),
            }));
            existingState.set(key, state);
        }
    };
    for (const desc of tasks) {
        const key = buildStateKey(desc.nodeId, desc.iteration);
        if (desc.skipIf) {
            stateMap.set(key, "skipped");
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "skipped",
                lastAttempt: null,
                updatedAtMs: nowMs(),
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            }));
            await maybeEmitStateEvent("skipped", desc);
            continue;
        }
        const deferredState = await resolveDeferredTaskStateBridge(adapter, db, runId, desc, eventBus, (state) => maybeEmitStateEvent(state, desc));
        if (deferredState.handled) {
            stateMap.set(key, deferredState.state);
            continue;
        }
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
        // Check for a valid output row BEFORE checking attempt state.
        // After hot reload (or resume/restart), a task may have a stale
        // "in-progress" attempt in the DB even though its output was already
        // written.  By checking the output first we let the Sequence
        // fast-forward through already-completed children in the same render
        // cycle instead of waiting for a completion event that will never fire.
        if (desc.outputTable) {
            const outputRow = await selectOutputRow(db, desc.outputTable, {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
            });
            if (outputRow) {
                const valid = validateExistingOutput(desc.outputTable, outputRow);
                if (valid.ok) {
                    stateMap.set(key, "finished");
                    await Effect.runPromise(adapter.insertNode({
                        runId,
                        nodeId: desc.nodeId,
                        iteration: desc.iteration,
                        state: "finished",
                        lastAttempt: attempts[0]?.attempt ?? null,
                        updatedAtMs: nowMs(),
                        outputTable: desc.outputTableName,
                        label: desc.label ?? null,
                    }));
                    continue;
                }
            }
        }
        const inProgress = attempts.find((a) => a.state === "in-progress");
        if (inProgress) {
            stateMap.set(key, "in-progress");
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "in-progress",
                lastAttempt: inProgress.attempt,
                updatedAtMs: nowMs(),
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            }));
            continue;
        }
        if (desc.ralphId && ralphDone.get(desc.ralphId)) {
            stateMap.set(key, "skipped");
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "skipped",
                lastAttempt: attempts[0]?.attempt ?? null,
                updatedAtMs: nowMs(),
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            }));
            await maybeEmitStateEvent("skipped", desc);
            continue;
        }
        const maxAttempts = desc.retries + 1;
        const failedAttempts = attempts.filter((a) => a.state === "failed");
        const hasNonRetryableFailure = failedAttempts.some((attempt) => !isRetryableTaskFailure(attempt));
        if (hasNonRetryableFailure || failedAttempts.length >= maxAttempts) {
            stateMap.set(key, "failed");
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "failed",
                lastAttempt: attempts[0]?.attempt ?? null,
                updatedAtMs: nowMs(),
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            }));
            continue;
        }
        let waitingForRetry = false;
        if (failedAttempts.length > 0 && desc.retryPolicy && !hasNonRetryableFailure) {
            const lastFailed = failedAttempts[0];
            const retrySchedule = retryPolicyToSchedule(desc.retryPolicy);
            const delayMs = retryScheduleDelayMs(retrySchedule, lastFailed?.attempt ?? failedAttempts.length);
            const finishedAtMs = lastFailed?.finishedAtMs ?? lastFailed?.startedAtMs;
            if (delayMs > 0 && typeof finishedAtMs === "number") {
                const nextRetryAtMs = finishedAtMs + delayMs;
                if (nowMs() < nextRetryAtMs) {
                    retryWait.set(key, nextRetryAtMs);
                    waitingForRetry = true;
                }
            }
        }
        stateMap.set(key, "pending");
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "pending",
            lastAttempt: attempts[0]?.attempt ?? null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        if (!waitingForRetry) {
            await maybeEmitStateEvent("pending", desc);
        }
    }
    return { stateMap, retryWait };
}
/**
 * Apply only the global maxConcurrency cap.
 *
 * Per-group caps (Parallel/MergeQueue) are enforced upstream by the scheduler
 * when selecting runnable tasks. Keeping group logic in a single place avoids
 * double-enforcement and admission drift.
 *
 * @param {TaskDescriptor[]} runnable
 * @param {TaskStateMap} stateMap
 * @param {number} maxConcurrency
 * @param {TaskDescriptor[]} allTasks
 * @returns {TaskDescriptor[]}
 */
export function applyConcurrencyLimits(runnable, stateMap, maxConcurrency, allTasks) {
    const selected = [];
    let inProgressTotal = 0;
    for (const desc of allTasks) {
        const state = stateMap.get(buildStateKey(desc.nodeId, desc.iteration));
        if (state === "in-progress") {
            inProgressTotal += 1;
        }
    }
    void Effect.runPromise(Metric.set(schedulerConcurrencyUtilization, maxConcurrency > 0 ? inProgressTotal / maxConcurrency : 0));
    const capacity = Math.max(0, maxConcurrency - inProgressTotal);
    for (const desc of runnable) {
        if (selected.length >= capacity)
            break;
        selected.push(desc);
    }
    return selected;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {EventBus} eventBus
 */
async function cancelInProgress(adapter, runId, eventBus) {
    const inProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
    for (const attempt of inProgress) {
        const existingNode = await Effect.runPromise(adapter.getNode(runId, attempt.nodeId, attempt.iteration));
        const cancelledAtMs = nowMs();
        await adapter.withTransaction("cancel-in-progress", Effect.gen(function* () {
            yield* adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                state: "cancelled",
                finishedAtMs: cancelledAtMs,
            });
            yield* adapter.insertNode({
                runId,
                nodeId: attempt.nodeId,
                iteration: attempt.iteration,
                state: "cancelled",
                lastAttempt: attempt.attempt,
                updatedAtMs: cancelledAtMs,
                outputTable: existingNode?.outputTable ?? "",
                label: existingNode?.label ?? null,
            });
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "NodeCancelled",
            runId,
            nodeId: attempt.nodeId,
            iteration: attempt.iteration,
            attempt: attempt.attempt,
            reason: "unmounted",
            timestampMs: nowMs(),
        }));
    }
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {EventBus} eventBus
 * @param {string} reason
 */
async function cancelPendingTimers(adapter, runId, eventBus, reason) {
    await cancelPendingTimersBridge(adapter, runId, eventBus, reason);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function cancelStaleAttempts(adapter, runId) {
    const inProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
    const now = nowMs();
    for (const attempt of inProgress) {
        if (attempt.startedAtMs && now - attempt.startedAtMs > STALE_ATTEMPT_MS) {
            const existingNode = await Effect.runPromise(adapter.getNode(runId, attempt.nodeId, attempt.iteration));
            await adapter.withTransaction("cancel-stale-attempt", Effect.gen(function* () {
                yield* adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                    state: "cancelled",
                    finishedAtMs: now,
                });
                yield* adapter.insertNode({
                    runId,
                    nodeId: attempt.nodeId,
                    iteration: attempt.iteration,
                    state: "pending",
                    lastAttempt: attempt.attempt,
                    updatedAtMs: now,
                    outputTable: existingNode?.outputTable ?? "",
                    label: existingNode?.label ?? null,
                });
            }));
        }
    }
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {Map<string, TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {{ rootDir: string; allowNetwork: boolean; maxOutputBytes: number; toolTimeoutMs: number; }} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {AbortSignal} [signal]
 * @param {Set<any>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 */
async function legacyExecuteTask(adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, signal, disabledAgents, runAbortController, hijackState) {
    // Legacy execution goes here (renamed function)
    const taskStartMs = performance.now();
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    const previousHeartbeat = (() => {
        for (const attempt of attempts) {
            const parsed = parseAttemptHeartbeatData(attempt.heartbeatDataJson);
            if (parsed !== null)
                return parsed;
        }
        return null;
    })();
    const attemptNo = (attempts[0]?.attempt ?? 0) + 1;
    updateCurrentCorrelationContext({ attempt: attemptNo });
    const taskSpanContext = {
        runId,
        workflowName,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        nodeLabel: desc.label ?? null,
    };
    /**
   * @param {Readonly<Record<string, unknown>>} attributes
   */
    const annotateTaskSpan = (attributes) => Effect.runPromise(annotateSmithersTrace({
        ...taskSpanContext,
        ...attributes,
    }));
    const taskAbortController = new AbortController();
    const removeAbortForwarder = wireAbortSignal(taskAbortController, signal);
    const taskSignal = taskAbortController.signal;
    const startedAtMs = nowMs();
    let taskCompleted = false;
    let taskExecutionReturned = false;
    let heartbeatClosed = false;
    let heartbeatWriteInFlight = false;
    let heartbeatPendingDataJson = null;
    let heartbeatPendingDataSizeBytes = 0;
    let heartbeatPendingAtMs = startedAtMs;
    let heartbeatHasPendingWrite = false;
    let heartbeatLastPersistedWriteAtMs = 0;
    let heartbeatLastReceivedAtMs = null;
    let heartbeatWriteTimer;
    /**
   * @returns {Promise<void>}
   */
    const flushHeartbeat = async (force = false) => {
        if (heartbeatClosed || !heartbeatHasPendingWrite || heartbeatWriteInFlight) {
            return;
        }
        const now = nowMs();
        const minNextWriteAt = heartbeatLastPersistedWriteAtMs + TASK_HEARTBEAT_THROTTLE_MS;
        if (!force && now < minNextWriteAt) {
            const waitMs = Math.max(0, minNextWriteAt - now);
            if (!heartbeatWriteTimer) {
                heartbeatWriteTimer = setTimeout(() => {
                    heartbeatWriteTimer = undefined;
                    void flushHeartbeat();
                }, waitMs);
            }
            return;
        }
        heartbeatHasPendingWrite = false;
        heartbeatWriteInFlight = true;
        const heartbeatAtMs = heartbeatPendingAtMs;
        const heartbeatDataJson = heartbeatPendingDataJson;
        const dataSizeBytes = heartbeatPendingDataSizeBytes;
        const intervalMs = heartbeatLastReceivedAtMs == null
            ? null
            : Math.max(0, heartbeatAtMs - heartbeatLastReceivedAtMs);
        heartbeatLastReceivedAtMs = heartbeatAtMs;
        try {
            await Effect.runPromise(adapter.heartbeatAttempt(runId, desc.nodeId, desc.iteration, attemptNo, heartbeatAtMs, heartbeatDataJson));
            heartbeatLastPersistedWriteAtMs = nowMs();
            logDebug("task heartbeat recorded", {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                dataSizeBytes,
            }, "heartbeat:record");
            await eventBus.emitEventQueued({
                type: "TaskHeartbeat",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                hasData: heartbeatDataJson !== null,
                dataSizeBytes,
                intervalMs: intervalMs ?? undefined,
                timestampMs: heartbeatAtMs,
            });
        }
        catch (error) {
            logWarning("failed to persist task heartbeat", {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                error: error instanceof Error ? error.message : String(error),
            }, "heartbeat:record");
        }
        finally {
            heartbeatWriteInFlight = false;
            if (heartbeatHasPendingWrite && !heartbeatClosed) {
                if (heartbeatWriteTimer) {
                    clearTimeout(heartbeatWriteTimer);
                    heartbeatWriteTimer = undefined;
                }
                void flushHeartbeat();
            }
        }
    };
    /**
   * @param {unknown} data
   * @param {{ internal?: boolean }} [opts]
   */
    const queueHeartbeat = (data, opts) => {
        if (taskCompleted ||
            heartbeatClosed ||
            (!opts?.internal && taskExecutionReturned)) {
            return;
        }
        const heartbeatAtMs = nowMs();
        let heartbeatDataJson = null;
        let dataSizeBytes = 0;
        try {
            if (data !== undefined) {
                const serialized = serializeHeartbeatPayload(data);
                heartbeatDataJson = serialized.heartbeatDataJson;
                dataSizeBytes = serialized.dataSizeBytes;
            }
        }
        catch (error) {
            if (!opts?.internal) {
                throw error;
            }
            logWarning("internal heartbeat payload rejected", {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                error: error instanceof Error ? error.message : String(error),
            }, "heartbeat:record");
            return;
        }
        heartbeatPendingAtMs = heartbeatAtMs;
        heartbeatPendingDataJson = heartbeatDataJson;
        heartbeatPendingDataSizeBytes = dataSizeBytes;
        heartbeatHasPendingWrite = true;
        if (!heartbeatWriteTimer) {
            void flushHeartbeat();
        }
    };
    /**
   * @param {unknown} [data]
   */
    const recordInternalHeartbeat = (data) => {
        queueHeartbeat(data, { internal: true });
    };
    const waitForHeartbeatWriteDrain = async () => {
        while (heartbeatWriteInFlight) {
            await Bun.sleep(5);
        }
    };
    const attemptMeta = {
        kind: desc.agent ? "agent" : desc.computeFn ? "compute" : "static",
        prompt: desc.prompt ?? null,
        staticPayload: desc.staticPayload ?? null,
        label: desc.label ?? null,
        outputTable: desc.outputTableName,
        needsApproval: desc.needsApproval,
        retries: desc.retries,
        timeoutMs: desc.timeoutMs,
        heartbeatTimeoutMs: desc.heartbeatTimeoutMs,
        lastHeartbeat: previousHeartbeat,
        agentId: null,
        agentModel: null,
        agentEngine: null,
        agentResume: null,
        agentConversation: null,
        resumedFromSession: null,
        resumedFromConversation: false,
        hijackHandoff: null,
    };
    await adapter.withTransaction("task-start", Effect.gen(function* () {
        yield* adapter.insertAttempt({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            state: "in-progress",
            startedAtMs,
            finishedAtMs: null,
            heartbeatAtMs: null,
            heartbeatDataJson: null,
            errorJson: null,
            jjPointer: null,
            jjCwd: desc.worktreePath ?? toolConfig.rootDir,
            cached: false,
            metaJson: JSON.stringify(attemptMeta),
        });
        yield* adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "in-progress",
            lastAttempt: attemptNo,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        });
    }));
    await Effect.runPromise(eventBus.emitEventWithPersist({
        type: "NodeStarted",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        timestampMs: nowMs(),
    }));
    let payload = null;
    let cached = false;
    let cacheKey = null;
    let cacheJjBase = null;
    let responseText = null;
    let effectiveAgent = null;
    // Resolve effective root once so both caching and execution share it.
    const taskRoot = desc.worktreePath ?? toolConfig.rootDir;
    const stepCacheEnabled = cacheEnabled || Boolean(desc.cachePolicy);
    const cacheAgent = Array.isArray(desc.agent) ? desc.agent[0] : desc.agent;
    let heartbeatWatchdogFiber = null;
    try {
        if (taskSignal.aborted) {
            throw makeAbortError();
        }
        logDebug("task execution starting", {
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            workflowName,
            taskRoot,
            hasAgent: Boolean(desc.agent),
            cacheEnabled: stepCacheEnabled,
        }, "engine:task");
        await annotateTaskSpan({ status: "running" });
        if (desc.heartbeatTimeoutMs) {
            heartbeatWatchdogFiber = Effect.runFork(Effect.repeat(Effect.suspend(() => {
                const lastHeartbeatAtMs = Math.max(startedAtMs, heartbeatPendingAtMs);
                const staleForMs = nowMs() - lastHeartbeatAtMs;
                if (staleForMs <= desc.heartbeatTimeoutMs) {
                    return Effect.void;
                }
                const timeoutError = new SmithersError("TASK_HEARTBEAT_TIMEOUT", `Task ${desc.nodeId} has not heartbeated in ${staleForMs}ms (timeout: ${desc.heartbeatTimeoutMs}ms).`, {
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    timeoutMs: desc.heartbeatTimeoutMs,
                    staleForMs,
                    lastHeartbeatAtMs,
                });
                logWarning("task heartbeat timed out", {
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    timeoutMs: desc.heartbeatTimeoutMs,
                    staleForMs,
                    lastHeartbeatAtMs,
                }, "heartbeat:timeout");
                void eventBus.emitEventQueued({
                    type: "TaskHeartbeatTimeout",
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    lastHeartbeatAtMs,
                    timeoutMs: desc.heartbeatTimeoutMs,
                    timestampMs: nowMs(),
                });
                taskAbortController.abort(timeoutError);
                return Effect.fail(timeoutError);
            }), Schedule.spaced(Duration.millis(TASK_HEARTBEAT_TIMEOUT_CHECK_MS))).pipe(Effect.flatMap(() => Effect.never)));
        }
        if (desc.worktreePath) {
            await ensureWorktree(toolConfig.rootDir, desc.worktreePath, desc.worktreeBranch, desc.worktreeBaseBranch);
        }
        if (stepCacheEnabled) {
            const schemaSig = schemaSignature(desc.outputTable);
            const outputSchemaSig = desc.outputSchema
                ? sha256Hex(describeSchemaShape(desc.outputTable, desc.outputSchema))
                : null;
            const agentSig = cacheAgent?.id ?? "agent";
            const toolsSig = hashCapabilityRegistry(cacheAgent?.capabilities ?? null);
            // Incorporate JJ state so workspace changes invalidate cache as documented.
            const jjBase = await Effect.runPromise(getJjPointer(taskRoot).pipe(Effect.provide(BunContext.layer)));
            cacheJjBase = jjBase ?? null;
            let cacheBase;
            let cacheKeyDisabled = false;
            if (desc.cachePolicy) {
                let cachePayload = null;
                let cacheByOk = true;
                try {
                    const ctx = await buildCacheContext(db, inputTable, runId, desc, descriptorMap, attemptNo);
                    if (desc.cachePolicy.by) {
                        cachePayload = desc.cachePolicy.by(ctx);
                    }
                }
                catch (err) {
                    cacheByOk = false;
                    logWarning("cache by evaluation failed", {
                        runId,
                        nodeId: desc.nodeId,
                        iteration: desc.iteration,
                        attempt: attemptNo,
                        error: err instanceof Error ? err.message : String(err),
                    }, "engine:task-cache");
                }
                if (desc.cachePolicy.by && !cacheByOk) {
                    cacheKeyDisabled = true;
                }
                cacheBase = {
                    workflowName,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    outputTableName: desc.outputTableName,
                    schemaSig,
                    outputSchemaSig,
                    agentSig,
                    toolsSig,
                    jjPointer: cacheJjBase,
                    cacheVersion: desc.cachePolicy.version ?? null,
                    cacheBy: cachePayload ?? null,
                };
            }
            else {
                cacheBase = {
                    workflowName,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    outputTableName: desc.outputTableName,
                    schemaSig,
                    outputSchemaSig,
                    agentSig,
                    toolsSig,
                    jjPointer: cacheJjBase,
                    prompt: desc.prompt ?? null,
                    payload: desc.staticPayload ?? null,
                };
            }
            try {
                if (!cacheKeyDisabled) {
                    cacheKey = sha256Hex(JSON.stringify(cacheBase));
                }
            }
            catch (err) {
                cacheKey = null;
                logWarning("cache key serialization failed", {
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    error: err instanceof Error ? err.message : String(err),
                }, "engine:task-cache");
            }
            if (cacheKey) {
                const cachedRow = await Effect.runPromise(adapter.getCache(cacheKey));
                if (cachedRow) {
                    const parsed = JSON.parse(cachedRow.payloadJson);
                    const valid = validateOutput(desc.outputTable, parsed);
                    if (valid.ok) {
                        payload = valid.data;
                        cached = true;
                        void Effect.runPromise(Metric.increment(cacheHits));
                        logInfo("cache hit for task output", {
                            runId,
                            nodeId: desc.nodeId,
                            iteration: desc.iteration,
                            attempt: attemptNo,
                            cacheKey,
                        }, "engine:task-cache");
                    }
                    else {
                        void Effect.runPromise(Metric.increment(cacheMisses));
                    }
                }
                else {
                    void Effect.runPromise(Metric.increment(cacheMisses));
                }
            }
        }
        let agentResult;
        /**
     * @param {string} _text
     * @param {"stdout" | "stderr"} _stream
     */
        let emitOutput = (_text, _stream) => { };
        if (!payload) {
            const allAgents = Array.isArray(desc.agent) ? desc.agent : (desc.agent ? [desc.agent] : []);
            const agents = disabledAgents ? allAgents.filter((a) => !disabledAgents.has(a)) : allAgents;
            effectiveAgent = agents.length > 0
                ? agents[Math.min(attemptNo - 1, agents.length - 1)]
                : allAgents[Math.min(attemptNo - 1, allAgents.length - 1)]; // fallback to disabled agent if all disabled
            const priorToolCalls = attemptNo > 1
                ? await Effect.runPromise(adapter.listToolCalls(runId, desc.nodeId, desc.iteration))
                : [];
            const toolResumeWarnings = collectToolResumeWarnings(priorToolCalls, allAgents, attemptNo);
            const toolResumeWarningMessage = buildToolResumeWarningMessage(toolResumeWarnings);
            emitOutput = (text, stream) => {
                recordInternalHeartbeat();
                void eventBus.emitEventQueued({
                    type: "NodeOutput",
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    text,
                    stream,
                    timestampMs: nowMs(),
                });
            };
            // Capture the agent result at this scope so schema-retry can build
            // conversation history from the original response messages.
            if (effectiveAgent) {
                attemptMeta.agentId =
                    effectiveAgent.id ??
                        effectiveAgent.constructor?.name ??
                        null;
                attemptMeta.agentModel =
                    effectiveAgent.model ??
                        effectiveAgent.modelId ??
                        null;
                const hijackCapableEngine = typeof effectiveAgent.cliEngine === "string"
                    ? effectiveAgent.cliEngine
                    : typeof effectiveAgent.hijackEngine === "string"
                        ? effectiveAgent.hijackEngine
                        : null;
                const currentAgentEngine = hijackCapableEngine ??
                    (typeof effectiveAgent.constructor?.name === "string"
                        ? effectiveAgent.constructor.name
                        : null);
                attemptMeta.agentEngine = currentAgentEngine;
                const heartbeatCheckpoint = previousHeartbeat &&
                    typeof previousHeartbeat === "object" &&
                    !Array.isArray(previousHeartbeat)
                    ? previousHeartbeat
                    : null;
                const heartbeatCheckpointEngine = typeof heartbeatCheckpoint?.agentEngine === "string"
                    ? heartbeatCheckpoint.agentEngine
                    : null;
                const heartbeatCheckpointUsable = !currentAgentEngine ||
                    !heartbeatCheckpointEngine ||
                    heartbeatCheckpointEngine === currentAgentEngine;
                const checkpointResumeSession = heartbeatCheckpointUsable &&
                    typeof heartbeatCheckpoint?.agentResume === "string"
                    ? heartbeatCheckpoint.agentResume
                    : undefined;
                const checkpointResumeMessages = heartbeatCheckpointUsable
                    ? asConversationMessages(heartbeatCheckpoint?.agentConversation)
                    : undefined;
                const priorContinuation = hijackCapableEngine
                    ? findHijackContinuation(attempts, hijackCapableEngine)
                    : undefined;
                const resumeSession = priorContinuation?.mode === "native-cli"
                    ? priorContinuation.resume
                    : checkpointResumeSession;
                const resumeMessages = priorContinuation?.mode === "conversation"
                    ? (cloneJsonValue(priorContinuation.messages) ?? priorContinuation.messages)
                    : (cloneJsonValue(checkpointResumeMessages) ??
                        checkpointResumeMessages);
                const guidedResumeMessages = appendToolResumeWarningMessage(resumeMessages, toolResumeWarningMessage);
                if (desc.hijack) {
                    if (!hijackCapableEngine) {
                        attemptMeta.failureRetryable = false;
                        throw new SmithersError("TASK_HIJACK_UNSUPPORTED", `Task ${desc.nodeId} sets hijack, but its agent is not hijack-capable. Hijack requires an agent with cliEngine or hijackEngine.`, {
                            nodeId: desc.nodeId,
                            agentId: attemptMeta.agentId ?? undefined,
                        });
                    }
                    const shouldAutoHijack = desc.onHijackExit === "reopen" || !priorContinuation;
                    if (shouldAutoHijack && !hijackState) {
                        attemptMeta.failureRetryable = false;
                        throw new SmithersError("TASK_HIJACK_UNSUPPORTED", `Task ${desc.nodeId} cannot auto-hijack in this execution mode.`, {
                            nodeId: desc.nodeId,
                            agentId: attemptMeta.agentId ?? undefined,
                        });
                    }
                    if (shouldAutoHijack && !hijackState.request && !hijackState.completion) {
                        const requestedAtMs = nowMs();
                        hijackState.request = {
                            requestedAtMs,
                            target: hijackCapableEngine,
                        };
                        await Effect.runPromise(adapter.requestRunHijack(runId, requestedAtMs, hijackCapableEngine));
                        await Effect.runPromise(eventBus.emitEventWithPersist({
                            type: "RunHijackRequested",
                            runId,
                            target: hijackCapableEngine,
                            timestampMs: requestedAtMs,
                        }));
                    }
                }
                if (resumeSession) {
                    attemptMeta.resumedFromSession = resumeSession;
                }
                if (guidedResumeMessages?.length) {
                    attemptMeta.resumedFromConversation = true;
                    attemptMeta.agentConversation = guidedResumeMessages;
                }
                if (toolResumeWarnings.length > 0) {
                    attemptMeta.toolResumeWarnings = toolResumeWarnings;
                }
                await Effect.runPromise(adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
                    metaJson: JSON.stringify(attemptMeta),
                }));
                const activeCliActions = new Set();
                let conversationMessages = guidedResumeMessages ? [...guidedResumeMessages] : null;
                /**
         * @param {unknown[] | undefined} messages
         */
                const updateConversation = (messages) => {
                    const cloned = cloneJsonValue(messages);
                    if (!cloned?.length) {
                        return;
                    }
                    conversationMessages = cloned;
                    attemptMeta.agentConversation = cloned;
                    recordInternalHeartbeat({
                        agentEngine: typeof attemptMeta.agentEngine === "string"
                            ? attemptMeta.agentEngine
                            : null,
                        agentConversation: cloned,
                    });
                    maybeCompleteHijack();
                };
                let effectivePrompt = desc.prompt ?? "";
                if (desc.outputTable) {
                    const schemaDesc = describeSchemaShape(desc.outputTable, desc.outputSchema);
                    const jsonInstructions = [
                        "**REQUIRED OUTPUT** — You MUST end your response with a JSON object in a code fence matching this schema:",
                        "```json",
                        schemaDesc,
                        "```",
                        "Output the JSON at the END of your response. The workflow will fail without it.",
                    ].join("\n");
                    effectivePrompt = [
                        "IMPORTANT: After completing the task below, you MUST output a JSON object in a ```json code fence at the very end of your response. Do NOT forget this — the workflow fails without it.",
                        "",
                        effectivePrompt,
                        "",
                        "",
                        jsonInstructions,
                    ].join("\n");
                }
                effectivePrompt = prependToolResumeWarningMessage(effectivePrompt, toolResumeWarningMessage);
                const maybeCompleteHijack = () => {
                    if (!hijackState?.request || hijackState.completion || !runAbortController) {
                        return;
                    }
                    const target = hijackState.request.target ?? null;
                    const engine = typeof attemptMeta.agentEngine === "string" ? attemptMeta.agentEngine : null;
                    const resume = typeof attemptMeta.agentResume === "string" ? attemptMeta.agentResume : undefined;
                    const messages = asConversationMessages(attemptMeta.agentConversation);
                    const handoffMode = resume
                        ? "native-cli"
                        : (messages?.length ? "conversation" : null);
                    if (!engine || !handoffMode) {
                        return;
                    }
                    if (target && target !== engine) {
                        return;
                    }
                    if (handoffMode === "native-cli" && activeCliActions.size > 0) {
                        return;
                    }
                    const completion = {
                        requestedAtMs: hijackState.request.requestedAtMs,
                        nodeId: desc.nodeId,
                        iteration: desc.iteration,
                        attempt: attemptNo,
                        engine,
                        mode: handoffMode,
                        resume,
                        messages: handoffMode === "conversation" ? cloneJsonValue(messages) : undefined,
                        cwd: desc.worktreePath ?? taskRoot,
                    };
                    hijackState.completion = completion;
                    attemptMeta.hijackHandoff = {
                        engine: completion.engine,
                        mode: completion.mode,
                        resume: completion.resume ?? null,
                        messages: completion.mode === "conversation" ? completion.messages ?? null : null,
                        requestedAtMs: completion.requestedAtMs,
                        cwd: completion.cwd,
                        nodeId: completion.nodeId,
                        iteration: completion.iteration,
                        attempt: completion.attempt,
                    };
                    void eventBus.emitEventQueued({
                        type: "RunHijacked",
                        runId,
                        nodeId: completion.nodeId,
                        iteration: completion.iteration,
                        attempt: completion.attempt,
                        engine: completion.engine,
                        mode: completion.mode,
                        resume: completion.resume ?? null,
                        cwd: completion.cwd,
                        timestampMs: nowMs(),
                    });
                    runAbortController.abort();
                };
                /**
         * @param {AgentCliEvent} event
         */
                const handleAgentEvent = (event) => {
                    attemptMeta.agentEngine = event.engine ?? attemptMeta.agentEngine;
                    if ("resume" in event && typeof event.resume === "string") {
                        attemptMeta.agentResume = event.resume;
                        recordInternalHeartbeat({
                            agentEngine: event.engine,
                            agentResume: event.resume,
                        });
                    }
                    else {
                        recordInternalHeartbeat();
                    }
                    if (event.type === "completed" && !responseText && event.answer) {
                        responseText = event.answer;
                    }
                    if (event.type === "action" &&
                        isBlockingAgentActionKind(event.action.kind)) {
                        if (event.phase === "started") {
                            activeCliActions.add(event.action.id);
                        }
                        else if (event.phase === "completed") {
                            activeCliActions.delete(event.action.id);
                        }
                    }
                    void eventBus.emitEventQueued({
                        type: "AgentEvent",
                        runId,
                        nodeId: desc.nodeId,
                        iteration: desc.iteration,
                        attempt: attemptNo,
                        engine: event.engine,
                        event,
                        timestampMs: nowMs(),
                    });
                    maybeCompleteHijack();
                };
                /**
         * @param {unknown} stepResult
         */
                const handleSdkStepFinish = (stepResult) => {
                    recordInternalHeartbeat();
                    if (!conversationMessages) {
                        conversationMessages = [
                            { role: "user", content: effectivePrompt },
                        ];
                    }
                    const stepMessages = Array.isArray(stepResult?.response?.messages)
                        ? (cloneJsonValue(stepResult.response.messages) ?? stepResult.response.messages)
                        : [];
                    if (!stepMessages.length) {
                        maybeCompleteHijack();
                        return;
                    }
                    conversationMessages = [
                        ...conversationMessages,
                        ...stepMessages,
                    ];
                    attemptMeta.agentConversation = conversationMessages;
                    maybeCompleteHijack();
                };
                const hijackPollingInterval = hijackState
                    ? setInterval(() => {
                        try {
                            maybeCompleteHijack();
                        }
                        catch {
                            // Best-effort only; the normal event hooks still drive hijack.
                        }
                    }, 100)
                    : undefined;
                // Use fallback agent on retry attempts when available
                let result;
                try {
                    result = await Effect.runPromise(withSmithersSpan(smithersSpanNames.agent, Effect.promise(() => {
                        const agentCall = guidedResumeMessages?.length
                            ? {
                                messages: guidedResumeMessages,
                            }
                            : {
                                prompt: effectivePrompt,
                            };
                        return effectiveAgent.generate({
                            options: undefined,
                            abortSignal: taskSignal,
                            ...agentCall,
                            resumeSession,
                            lastHeartbeat: previousHeartbeat,
                            rootDir: taskRoot,
                            maxOutputBytes: toolConfig.maxOutputBytes,
                            timeout: desc.timeoutMs
                                ? { totalMs: desc.timeoutMs }
                                : undefined,
                            onStdout: (text) => {
                                recordInternalHeartbeat();
                                emitOutput(text, "stdout");
                            },
                            onStderr: (text) => {
                                recordInternalHeartbeat();
                                emitOutput(text, "stderr");
                            },
                            onEvent: handleAgentEvent,
                            onStepFinish: handleSdkStepFinish,
                            outputSchema: desc.outputSchema,
                        });
                    }), {
                        ...taskSpanContext,
                        agent: attemptMeta.agentId ??
                            attemptMeta.agentEngine ??
                            "unknown",
                        model: attemptMeta.agentModel,
                    }));
                }
                finally {
                    if (hijackPollingInterval) {
                        clearInterval(hijackPollingInterval);
                    }
                }
                agentResult = result;
                if (!conversationMessages) {
                    const responseMessages = Array.isArray(result?.response?.messages)
                        ? (cloneJsonValue(result.response.messages) ?? result.response.messages)
                        : [];
                    if (responseMessages.length > 0) {
                        updateConversation([
                            ...(resumeMessages?.length ? resumeMessages : [{ role: "user", content: effectivePrompt }]),
                            ...responseMessages,
                        ]);
                    }
                }
                else {
                    updateConversation(conversationMessages);
                }
                maybeCompleteHijack();
                // --- Track prompt/response sizes ---
                const promptBytes = Buffer.byteLength(desc.prompt ?? "", "utf8");
                void Effect.runPromise(Metric.update(promptSizeBytes, promptBytes));
                responseText = result.text ?? null;
                if (responseText) {
                    void Effect.runPromise(Metric.update(responseSizeBytes, Buffer.byteLength(responseText, "utf8")));
                }
                // --- Track token usage ---
                const usage = result.usage ?? result.totalUsage;
                if (usage) {
                    const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
                    const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
                    const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? usage.cacheReadTokens ?? undefined;
                    const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? usage.cacheWriteTokens ?? undefined;
                    const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? undefined;
                    if (inputTokens > 0 || outputTokens > 0) {
                        void eventBus.emitEventQueued({
                            type: "TokenUsageReported",
                            runId,
                            nodeId: desc.nodeId,
                            iteration: desc.iteration,
                            attempt: attemptNo,
                            model: effectiveAgent.model ?? effectiveAgent.id ?? "unknown",
                            agent: effectiveAgent.id ?? effectiveAgent.constructor?.name ?? "unknown",
                            inputTokens,
                            outputTokens,
                            cacheReadTokens,
                            cacheWriteTokens,
                            reasoningTokens,
                            timestampMs: nowMs(),
                        });
                    }
                }
                let output;
                // Try structured output first (wrapping in try/catch since getters may throw)
                try {
                    if (result._output !== undefined &&
                        result._output !== null) {
                        output = result._output;
                    }
                    else if (result.output !== undefined &&
                        result.output !== null) {
                        output = result.output;
                    }
                }
                catch {
                    // Structured output access threw
                }
                // Fall back to parsing text/steps for JSON
                if (output === undefined) {
                    const text = result.text ?? "";
                    // Try to parse the whole text as JSON first. Strip a leading
                    // UTF-8 BOM and accept either object or array at the root,
                    // since Zod schemas occasionally validate arrays.
                    try {
                        const trimmed = text.replace(/^\uFEFF/, "").trim();
                        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                            output = JSON.parse(trimmed);
                        }
                    }
                    catch {
                        // Not valid JSON, try extraction
                    }
                    // Helper to extract balanced JSON from text (first occurrence)
                    /**
           * @param {string} str
           * @returns {string | null}
           */
                    function extractBalancedJson(str) {
                        const start = str.indexOf("{");
                        if (start === -1)
                            return null;
                        let depth = 0;
                        let inString = false;
                        let escape = false;
                        for (let i = start; i < str.length; i++) {
                            const c = str[i];
                            if (escape) {
                                escape = false;
                                continue;
                            }
                            if (c === "\\") {
                                escape = true;
                                continue;
                            }
                            if (c === '"' && !escape) {
                                inString = !inString;
                                continue;
                            }
                            if (inString)
                                continue;
                            if (c === "{")
                                depth++;
                            else if (c === "}") {
                                depth--;
                                if (depth === 0) {
                                    return str.slice(start, i + 1);
                                }
                            }
                        }
                        return null;
                    }
                    // Helper to extract the LAST balanced JSON object in text.
                    // Agents like Kimi emit all intermediate tool output before the final
                    // required JSON, so searching from the end finds the right object.
                    /**
           * @param {string} str
           * @returns {string | null}
           */
                    function extractLastBalancedJson(str) {
                        let pos = str.lastIndexOf("{");
                        while (pos >= 0) {
                            const json = extractBalancedJson(str.slice(pos));
                            if (json !== null)
                                return json;
                            pos = str.lastIndexOf("{", pos - 1);
                        }
                        return null;
                    }
                    // Try to extract JSON from code fence (```json ... ```)
                    if (output === undefined) {
                        // Find the LAST code fence — the required output is always at the end
                        const allFences = [...text.matchAll(/```(?:json)?\s*\{/g)];
                        const lastFence = allFences[allFences.length - 1];
                        if (lastFence?.index !== undefined) {
                            const afterFence = text
                                .slice(lastFence.index)
                                .replace(/```(?:json)?\s*/, "");
                            const jsonStr = extractBalancedJson(afterFence);
                            if (jsonStr) {
                                try {
                                    output = JSON.parse(jsonStr);
                                }
                                catch {
                                    // Not valid JSON in code fence
                                }
                            }
                        }
                        // Check all steps for code fences with balanced JSON
                        if (output === undefined) {
                            const steps = result.steps ?? [];
                            for (let i = steps.length - 1; i >= 0; i--) {
                                const stepText = steps[i]?.text ?? "";
                                const fenceStart = stepText.search(/```(?:json)?\s*\{/);
                                if (fenceStart !== -1) {
                                    const afterFence = stepText
                                        .slice(fenceStart)
                                        .replace(/```(?:json)?\s*/, "");
                                    const jsonStr = extractBalancedJson(afterFence);
                                    if (jsonStr) {
                                        try {
                                            output = JSON.parse(jsonStr);
                                            break;
                                        }
                                        catch {
                                            // Not valid JSON
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Extract JSON object using balanced brace matching
                    if (output === undefined) {
                        const steps = result.steps ?? [];
                        // Look through steps from end to find valid JSON
                        for (let i = steps.length - 1; i >= 0; i--) {
                            const stepText = steps[i]?.text ?? "";
                            const jsonStr = extractBalancedJson(stepText);
                            if (jsonStr) {
                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    if (typeof parsed === "object" && parsed !== null) {
                                        output = parsed;
                                        break;
                                    }
                                }
                                catch {
                                    // Not valid JSON
                                }
                            }
                        }
                    }
                    // Try text itself — search from END so we get the required output JSON,
                    // not an earlier JSON object from intermediate tool output
                    if (output === undefined) {
                        const jsonStr = extractLastBalancedJson(text);
                        if (jsonStr) {
                            try {
                                const parsed = JSON.parse(jsonStr);
                                if (typeof parsed === "object" && parsed !== null) {
                                    output = parsed;
                                }
                            }
                            catch {
                                // Not valid JSON
                            }
                        }
                    }
                    // If no JSON found, send a follow-up prompt asking for just the JSON with schema info
                    if (output === undefined && desc.agent) {
                        const schemaDesc = describeSchemaShape(desc.outputTable, desc.outputSchema);
                        // Include a truncated summary of the original response so the model has context
                        const responseSummary = text.length > 2000
                            ? text.slice(0, 1000) + "\n...[truncated]...\n" + text.slice(-1000)
                            : text;
                        const jsonPrompt = [
                            `You previously completed a task and produced this response (possibly truncated):`,
                            ``,
                            responseSummary,
                            ``,
                            `Now you MUST output ONLY a valid JSON object (no other text) summarizing your work above, with exactly these fields and types:`,
                            schemaDesc,
                            ``,
                            `Output ONLY the JSON object, nothing else.`,
                        ].join("\n");
                        const retryResult = await effectiveAgent.generate({
                            options: undefined,
                            abortSignal: taskSignal,
                            prompt: jsonPrompt,
                            timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
                            onStdout: (text) => {
                                recordInternalHeartbeat();
                                emitOutput(text, "stdout");
                            },
                            onStderr: (text) => {
                                recordInternalHeartbeat();
                                emitOutput(text, "stderr");
                            },
                        });
                        const retryText = retryResult.text ?? "";
                        responseText = retryText || responseText;
                        try {
                            const trimmed = retryText.replace(/^\uFEFF/, "").trim();
                            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                                output = JSON.parse(trimmed);
                            }
                        }
                        catch {
                            // Still not valid JSON
                        }
                        if (output === undefined) {
                            // Try extracting JSON from a markdown code fence
                            // (```json ... ``` or just ``` ... ```).
                            const fenceMatch = retryText.match(/```(?:json)?\s*([\s\S]*?)```/i);
                            if (fenceMatch) {
                                const inner = fenceMatch[1].trim();
                                try {
                                    output = JSON.parse(inner);
                                }
                                catch {
                                    // Fall through to balanced extraction
                                }
                            }
                        }
                        if (output === undefined) {
                            // Try extracting balanced JSON from retry text
                            const jsonStr = extractBalancedJson(retryText);
                            if (jsonStr) {
                                try {
                                    output = JSON.parse(jsonStr);
                                }
                                catch {
                                    // Not valid JSON
                                }
                            }
                        }
                    }
                    if (output === undefined) {
                        // Debug: log what we have
                        const debugSteps = result.steps ?? [];
                        const stepTexts = debugSteps.map((s, i) => `Step ${i}: ${(s?.text ?? "").slice(0, 200)}`);
                        const finishReason = result.finishReason ?? "unknown";
                        logDebug("agent response did not contain valid JSON output", {
                            runId,
                            nodeId: desc.nodeId,
                            iteration: desc.iteration,
                            attempt: attemptNo,
                            finishReason,
                            textLength: text.length,
                            stepCount: debugSteps.length,
                            textStart: text.slice(0, 300),
                            textEnd: text.slice(-500),
                            lastStepText: debugSteps[debugSteps.length - 1]?.text?.slice(0, 500) ??
                                "none",
                        }, "engine:task-json");
                        const tail = (text ?? "").slice(-200).replace(/\s+/g, " ").trim();
                        const tailHint = tail
                            ? ` Last 200 chars of response: ${JSON.stringify(tail)}`
                            : " Agent returned an empty response.";
                        throw new SmithersError("INVALID_OUTPUT", `No valid JSON output found in agent response (finishReason=${finishReason}, textLength=${text.length}).${tailHint}`);
                    }
                }
                // Output should already be parsed, but handle string case
                if (typeof output === "string") {
                    try {
                        payload = JSON.parse(output);
                    }
                    catch (e) {
                        throw new SmithersError("INVALID_OUTPUT", `Failed to parse agent output as JSON. Output starts with: "${output.slice(0, 100)}"`);
                    }
                }
                else {
                    payload = output;
                }
            }
            else if (desc.computeFn) {
                const computePromise = Promise.resolve().then(() => withTaskRuntime({
                    runId,
                    stepId: desc.nodeId,
                    attempt: attemptNo,
                    iteration: desc.iteration,
                    signal: taskSignal,
                    db,
                    heartbeat: (data) => {
                        queueHeartbeat(data);
                    },
                    lastHeartbeat: previousHeartbeat,
                }, () => desc.computeFn()));
                const races = [computePromise];
                if (desc.timeoutMs) {
                    races.push(new Promise((_, reject) => setTimeout(() => reject(new SmithersError("TASK_TIMEOUT", `Compute callback timed out after ${desc.timeoutMs}ms`, {
                        attempt: attemptNo,
                        nodeId: desc.nodeId,
                        timeoutMs: desc.timeoutMs,
                    })), desc.timeoutMs)));
                }
                const abort = abortPromise(taskSignal);
                if (abort)
                    races.push(abort);
                payload = await Promise.race(races);
            }
            else {
                payload = desc.staticPayload;
            }
        }
        payload = stripAutoColumns(payload);
        const payloadWithKeys = buildOutputRow(desc.outputTable, runId, desc.nodeId, desc.iteration, payload);
        let validation = validateOutput(desc.outputTable, payloadWithKeys);
        // If the Drizzle insert schema passed but we have a stricter Zod schema
        // from the user, validate against that too. This catches cases where e.g.
        // a JSON text column accepts any valid JSON but the Zod schema requires
        // a specific shape (array vs string, enum values, etc).
        if (validation.ok && desc.outputSchema) {
            const zodResult = desc.outputSchema.safeParse(payload);
            if (!zodResult.success) {
                validation = { ok: false, error: zodResult.error };
            }
        }
        /**
     * @param {unknown} cause
     * @param {number} schemaRetryAttempts
     */
        const toInvalidOutputError = (cause, schemaRetryAttempts) => new SmithersError("INVALID_OUTPUT", `Task output failed validation for ${desc.outputTableName}`, {
            attempt: attemptNo,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            outputTable: desc.outputTableName,
            schemaRetryAttempts,
            issues: cause && typeof cause === "object" && "issues" in cause
                ? cause.issues
                : undefined,
        }, { cause });
        // Schema-validation retry: if the agent returned parseable JSON but it
        // doesn't match the Zod schema, resume the SAME agent conversation with
        // the validation error up to 3 times before giving up. These attempts
        // are NOT counted as normal task retries — the agent did the work, it
        // just formatted the output wrong.
        const MAX_SCHEMA_RETRIES = 3;
        let schemaRetry = 0;
        // Build a conversation history so each schema-fix attempt resumes the
        // same conversation instead of starting fresh. For SDK-based agents
        // this means true multi-turn; for CLI agents `extractPrompt` will
        // flatten the messages to text which is the best we can do.
        let schemaRetryMessages = [];
        if (!validation.ok && desc.agent && effectiveAgent) {
            // Seed from the original result when available
            const originalResponseMessages = agentResult?.response?.messages;
            if (Array.isArray(originalResponseMessages) && originalResponseMessages.length > 0) {
                // Start with the original prompt as a user message
                schemaRetryMessages = [
                    { role: "user", content: desc.prompt ?? "" },
                    ...originalResponseMessages,
                ];
            }
            else {
                // Fallback: reconstruct from the text we captured
                schemaRetryMessages = [
                    { role: "user", content: desc.prompt ?? "" },
                    { role: "assistant", content: responseText ?? "" },
                ];
            }
        }
        while (!validation.ok && desc.agent && schemaRetry < MAX_SCHEMA_RETRIES) {
            schemaRetry++;
            const schemaDesc = describeSchemaShape(desc.outputTable, desc.outputSchema);
            const zodIssues = validation.error?.issues
                ?.map((iss) => `  - ${(iss.path ?? []).join(".")}: ${iss.message}`)
                .join("\n") ?? "Unknown validation error";
            const schemaRetryPrompt = [
                `Your output didn't match the required schema. Validation errors:`,
                zodIssues,
                ``,
                `Please return valid JSON matching the schema exactly.`,
                ``,
                `You MUST output ONLY a valid JSON object with exactly these fields and types:`,
                schemaDesc,
                ``,
                `Output ONLY the JSON object, no other text.`,
            ].join("\n");
            logInfo("schema validation retry", {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                schemaRetry,
                maxSchemaRetries: MAX_SCHEMA_RETRIES,
                zodIssues,
            }, "engine:schema-retry");
            // Append the correction as a user message to the conversation
            const retryMessages = [
                ...schemaRetryMessages,
                { role: "user", content: schemaRetryPrompt },
            ];
            const schemaRetryResult = await effectiveAgent.generate({
                options: undefined,
                abortSignal: taskSignal,
                messages: retryMessages,
                rootDir: taskRoot,
                maxOutputBytes: toolConfig.maxOutputBytes,
                timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
                onStdout: (text) => {
                    recordInternalHeartbeat();
                    emitOutput(text, "stdout");
                },
                onStderr: (text) => {
                    recordInternalHeartbeat();
                    emitOutput(text, "stderr");
                },
            });
            const retryText = (schemaRetryResult.text ?? "").trim();
            responseText = retryText || responseText;
            // Update conversation history for the next iteration
            const retryResponseMessages = schemaRetryResult?.response?.messages;
            if (Array.isArray(retryResponseMessages) && retryResponseMessages.length > 0) {
                schemaRetryMessages = [
                    ...retryMessages,
                    ...retryResponseMessages,
                ];
            }
            else {
                schemaRetryMessages = [
                    ...retryMessages,
                    { role: "assistant", content: retryText },
                ];
            }
            attemptMeta.agentConversation =
                cloneJsonValue(schemaRetryMessages) ?? schemaRetryMessages;
            // Try to parse the retry response
            let retryOutput;
            try {
                if (retryText.startsWith("{") || retryText.startsWith("[")) {
                    retryOutput = JSON.parse(retryText);
                }
            }
            catch {
                // Not valid JSON directly, try extraction
            }
            if (retryOutput === undefined) {
                // Try code-fence extraction
                const fenceMatch = retryText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
                if (fenceMatch) {
                    try {
                        retryOutput = JSON.parse(fenceMatch[1]);
                    }
                    catch { }
                }
            }
            if (retryOutput === undefined) {
                // Try balanced JSON extraction as a last resort
                const jsonStart = retryText.indexOf("{");
                if (jsonStart !== -1) {
                    let depth = 0;
                    let inStr = false;
                    let esc = false;
                    for (let i = jsonStart; i < retryText.length; i++) {
                        const c = retryText[i];
                        if (esc) {
                            esc = false;
                            continue;
                        }
                        if (c === "\\") {
                            esc = true;
                            continue;
                        }
                        if (c === '"' && !esc) {
                            inStr = !inStr;
                            continue;
                        }
                        if (inStr)
                            continue;
                        if (c === "{")
                            depth++;
                        else if (c === "}") {
                            depth--;
                            if (depth === 0) {
                                try {
                                    retryOutput = JSON.parse(retryText.slice(jsonStart, i + 1));
                                }
                                catch { }
                                break;
                            }
                        }
                    }
                }
            }
            if (retryOutput && typeof retryOutput === "object") {
                payload = stripAutoColumns(retryOutput);
                const retryPayload = buildOutputRow(desc.outputTable, runId, desc.nodeId, desc.iteration, payload);
                validation = validateOutput(desc.outputTable, retryPayload);
                if (validation.ok && desc.outputSchema) {
                    const zodCheck = desc.outputSchema.safeParse(payload);
                    if (!zodCheck.success) {
                        validation = { ok: false, error: zodCheck.error };
                    }
                }
                if (validation.ok) {
                    payload = validation.data;
                    logInfo("schema validation retry succeeded", {
                        runId,
                        nodeId: desc.nodeId,
                        iteration: desc.iteration,
                        attempt: attemptNo,
                        schemaRetry,
                    }, "engine:schema-retry");
                }
            }
        }
        if (!validation.ok && !desc.agent) {
            attemptMeta.failureRetryable = false;
        }
        if (!validation.ok) {
            throw toInvalidOutputError(validation.error, schemaRetry);
        }
        payload = validation.data;
        taskExecutionReturned = true;
        await Effect.runPromise(eventBus.flush());
        // Reuse the resolved taskRoot for JJ pointer capture to avoid recomputing.
        const jjPointer = await Effect.runPromise(getJjPointer(taskRoot).pipe(Effect.provide(BunContext.layer)));
        await waitForHeartbeatWriteDrain();
        await flushHeartbeat(true);
        taskCompleted = true;
        const completedAtMs = nowMs();
        await adapter.withTransaction("task-completion", Effect.gen(function* () {
            yield* adapter.upsertOutputRow(desc.outputTable, { runId, nodeId: desc.nodeId, iteration: desc.iteration }, payload);
            if (stepCacheEnabled && cacheKey && !cached) {
                yield* adapter.insertCache({
                    cacheKey,
                    createdAtMs: completedAtMs,
                    workflowName,
                    nodeId: desc.nodeId,
                    outputTable: desc.outputTableName,
                    schemaSig: schemaSignature(desc.outputTable),
                    outputSchemaSig: desc.outputSchema
                        ? sha256Hex(describeSchemaShape(desc.outputTable, desc.outputSchema))
                        : null,
                    agentSig: cacheAgent?.id ?? "agent",
                    toolsSig: hashCapabilityRegistry(cacheAgent?.capabilities ?? null),
                    jjPointer: cacheJjBase,
                    payloadJson: JSON.stringify(payload),
                });
            }
            yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
                state: "finished",
                finishedAtMs: completedAtMs,
                jjPointer,
                cached,
                metaJson: JSON.stringify(attemptMeta),
                responseText,
            });
            yield* adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "finished",
                lastAttempt: attemptNo,
                updatedAtMs: completedAtMs,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            });
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "NodeFinished",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            timestampMs: nowMs(),
        }));
        const taskElapsedMs = performance.now() - taskStartMs;
        void Effect.runPromise(Effect.all([
            Metric.update(nodeDuration, taskElapsedMs),
            Metric.update(attemptDuration, taskElapsedMs),
        ], { discard: true }));
        await annotateTaskSpan({
            status: "finished",
        });
        // Fire async scorers if the task has any attached
        if (desc.scorers && Object.keys(desc.scorers).length > 0) {
            runScorersAsync(desc.scorers, {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                input: desc.prompt ?? desc.staticPayload ?? null,
                output: payload,
                latencyMs: taskElapsedMs,
                outputSchema: desc.outputSchema,
            }, adapter, eventBus);
        }
        logInfo("task execution finished", {
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            cached,
            jjPointer,
            durationMs: Math.round(taskElapsedMs),
        }, "engine:task");
    }
    catch (err) {
        try {
            await Effect.runPromise(eventBus.flush());
        }
        catch (flushError) {
            logError("failed to flush queued task events", {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                error: flushError instanceof Error
                    ? flushError.message
                    : String(flushError),
            }, "engine:task-events");
        }
        const heartbeatTimeoutError = heartbeatTimeoutReasonFromAbort(taskSignal, err);
        const effectiveError = heartbeatTimeoutError ?? err;
        if (isHeartbeatPayloadValidationError(effectiveError)) {
            attemptMeta.failureRetryable = false;
        }
        // Allow agents (e.g. BaseCliAgent on "LLM not set") to flag a failure as
        // non-retryable via SmithersError details. Without this, the engine would
        // retry deterministic configuration errors up to desc.retries times.
        if (effectiveError &&
            typeof effectiveError === "object" &&
            // @ts-ignore — duck-type on SmithersError shape
            effectiveError.details &&
            // @ts-ignore
            effectiveError.details.failureRetryable === false) {
            attemptMeta.failureRetryable = false;
        }
        if (!heartbeatTimeoutError && (taskSignal.aborted || isAbortError(err))) {
            await waitForHeartbeatWriteDrain();
            await flushHeartbeat(true);
            taskCompleted = true;
            const cancelledAtMs = nowMs();
            await adapter.withTransaction("task-cancel", Effect.gen(function* () {
                yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
                    state: "cancelled",
                    finishedAtMs: cancelledAtMs,
                    errorJson: JSON.stringify(errorToJson(effectiveError)),
                    metaJson: JSON.stringify(attemptMeta),
                    responseText,
                });
                yield* adapter.insertNode({
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    state: "cancelled",
                    lastAttempt: attemptNo,
                    updatedAtMs: cancelledAtMs,
                    outputTable: desc.outputTableName,
                    label: desc.label ?? null,
                });
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodeCancelled",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                reason: "aborted",
                timestampMs: nowMs(),
            }));
            await annotateTaskSpan({
                status: "cancelled",
            });
            logInfo("task execution cancelled", {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                error: effectiveError instanceof Error
                    ? effectiveError.message
                    : String(effectiveError),
            }, "engine:task");
            return;
        }
        await waitForHeartbeatWriteDrain();
        await flushHeartbeat(true);
        taskCompleted = true;
        logError("task execution failed", {
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            maxAttempts: Number.isFinite(desc.retries) ? desc.retries + 1 : "infinite",
            error: effectiveError instanceof Error
                ? effectiveError.message
                : String(effectiveError),
        }, "engine:task");
        const failedAtMs = nowMs();
        await adapter.withTransaction("task-fail", Effect.gen(function* () {
            yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
                state: "failed",
                finishedAtMs: failedAtMs,
                errorJson: JSON.stringify(errorToJson(effectiveError)),
                metaJson: JSON.stringify(attemptMeta),
                responseText,
            });
            yield* adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "failed",
                lastAttempt: attemptNo,
                updatedAtMs: failedAtMs,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            });
        }));
        // Circuit-breaker: disable agents that fail with auth errors
        if (disabledAgents && effectiveAgent) {
            const errStr = String(effectiveError?.message ??
                effectiveError ??
                "") + (responseText ?? "");
            const isAuthError = /invalid_authentication|401|api.key.*invalid|expired.*credentials|authentication.*failed/i.test(errStr);
            if (isAuthError) {
                disabledAgents.add(effectiveAgent);
                const agentName = effectiveAgent?.model ?? effectiveAgent?.id ?? "unknown";
                logWarning("disabled agent after auth failure", {
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    agentName,
                }, "engine:task-circuit-breaker");
            }
        }
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "NodeFailed",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            error: errorToJson(effectiveError),
            timestampMs: nowMs(),
        }));
        await annotateTaskSpan({
            status: "failed",
        });
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
        const failedAttempts = attempts.filter((a) => a.state === "failed");
        const hasNonRetryableFailure = failedAttempts.some((attempt) => !isRetryableTaskFailure(attempt));
        if (!hasNonRetryableFailure && failedAttempts.length <= desc.retries) {
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodeRetrying",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo + 1,
                timestampMs: nowMs(),
            }));
            logInfo("task scheduled for retry", {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                failedAttempt: attemptNo,
                nextAttempt: attemptNo + 1,
            }, "engine:task");
        }
    }
    finally {
        taskCompleted = true;
        heartbeatClosed = true;
        if (heartbeatWatchdogFiber) {
            await Effect.runPromise(Fiber.interrupt(heartbeatWatchdogFiber)).catch(() => { });
            heartbeatWatchdogFiber = null;
        }
        if (heartbeatWriteTimer) {
            clearTimeout(heartbeatWriteTimer);
            heartbeatWriteTimer = undefined;
        }
        removeAbortForwarder();
    }
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {SmithersCtx<unknown>} ctx
 * @param {{ baseRootDir?: string; workflowPath?: string | null }} [opts]
 * @returns {Promise<GraphSnapshot>}
 */
async function renderFrameAsync(workflow, ctx, opts) {
    const renderer = new SmithersRenderer();
    const result = await renderer.render(workflow.build(ctx), {
        ralphIterations: ctx?.iterations,
        baseRootDir: opts?.baseRootDir,
        workflowPath: opts?.workflowPath,
        defaultIteration: ctx?.iteration,
    });
    const tasks = result.tasks;
    // Resolve output tasks: ZodObject references via zodToKeyName, string keys via schemaRegistry
    resolveTaskOutputs(tasks, workflow);
    attachSubflowComputeFns(tasks, workflow, {
        rootDir: opts?.baseRootDir,
        workflowPath: opts?.workflowPath,
    });
    return { runId: ctx.runId, frameNo: 0, xml: result.xml, tasks };
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {SmithersCtx<unknown>} ctx
 * @param {{ baseRootDir?: string; workflowPath?: string | null }} [opts]
 * @returns {Effect.Effect<GraphSnapshot, SmithersError>}
 */
export function renderFrame(workflow, ctx, opts) {
    return Effect.tryPromise({
        try: () => renderFrameAsync(workflow, ctx, opts),
        catch: (cause) => toSmithersError(cause, "render frame"),
    }).pipe(Effect.annotateLogs({
        runId: ctx?.runId ?? "",
        iteration: ctx?.iteration ?? 0,
    }), Effect.withLogSpan("engine:render-frame"));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {ResumeClaimCleanup} cleanup
 */
async function releaseResumeClaimQuietly(adapter, runId, cleanup) {
    try {
        await Effect.runPromise(adapter.releaseRunResumeClaim({
            runId,
            claimOwnerId: cleanup.claimOwnerId,
            restoreRuntimeOwnerId: cleanup.restoreRuntimeOwnerId,
            restoreHeartbeatAtMs: cleanup.restoreHeartbeatAtMs,
        }));
    }
    catch (error) {
        logWarning("failed to release resume claim", {
            runId,
            claimOwnerId: cleanup.claimOwnerId,
            error: error instanceof Error ? error.message : String(error),
        }, "engine:resume");
    }
}
/**
 * @param {SmithersDb} adapter
 * @param {RunRow | null | undefined} existingRun
 * @param {RunOptions} opts
 * @param {string} runtimeOwnerId
 * @param {string} runConfigJson
 * @param {RunDurabilityMetadata} runMetadata
 * @param {string | null} workflowPath
 */
async function activateRunForResume(adapter, existingRun, opts, runtimeOwnerId, runConfigJson, runMetadata, workflowPath) {
    if (!isResumableRunStatus(existingRun?.status)) {
        throw new SmithersError("RUN_NOT_RESUMABLE", `Run ${existingRun?.runId ?? opts.runId ?? "unknown"} cannot be resumed from status ${existingRun?.status ?? "unknown"}.`, {
            runId: existingRun?.runId ?? opts.runId ?? null,
            status: existingRun?.status ?? null,
        });
    }
    const ownerPid = parseRuntimeOwnerPid(existingRun.runtimeOwnerId);
    if (existingRun.status === "running" &&
        ownerPid !== null &&
        isPidAlive(ownerPid)) {
        throw new SmithersError("RUN_OWNER_ALIVE", `Run ${existingRun.runId} still belongs to live process ${ownerPid}.`, {
            runId: existingRun.runId,
            runtimeOwnerId: existingRun.runtimeOwnerId ?? null,
            ownerPid,
        });
    }
    const claimOwnerId = opts.resumeClaim?.claimOwnerId ?? runtimeOwnerId;
    const claimHeartbeatAtMs = opts.resumeClaim?.claimHeartbeatAtMs ?? nowMs();
    const cleanup = {
        claimOwnerId,
        restoreRuntimeOwnerId: opts.resumeClaim?.restoreRuntimeOwnerId ??
            existingRun.runtimeOwnerId ??
            null,
        restoreHeartbeatAtMs: opts.resumeClaim?.restoreHeartbeatAtMs ??
            existingRun.heartbeatAtMs ??
            null,
    };
    let claimHeld = false;
    try {
        if (opts.resumeClaim) {
            const claimedRun = await Effect.runPromise(adapter.getRun(existingRun.runId));
            if (!claimedRun ||
                claimedRun.runtimeOwnerId !== claimOwnerId ||
                (claimedRun.heartbeatAtMs ?? null) !== claimHeartbeatAtMs) {
                throw new SmithersError("RUN_RESUME_CLAIM_LOST", `Resume claim for run ${existingRun.runId} is no longer held.`, {
                    runId: existingRun.runId,
                    claimOwnerId,
                    claimHeartbeatAtMs,
                });
            }
            claimHeld = true;
        }
        else {
            if (existingRun.status === "running") {
                const fresh = isRunHeartbeatFresh(existingRun);
                if (fresh && !opts.force) {
                    throw new SmithersError("RUN_STILL_RUNNING", `Run ${existingRun.runId} is still actively running.`, {
                        runId: existingRun.runId,
                        heartbeatAtMs: existingRun.heartbeatAtMs ?? null,
                    });
                }
            }
            const claimed = await Effect.runPromise(adapter.claimRunForResume({
                runId: existingRun.runId,
                expectedStatus: existingRun.status,
                expectedRuntimeOwnerId: existingRun.runtimeOwnerId ?? null,
                expectedHeartbeatAtMs: existingRun.heartbeatAtMs ?? null,
                staleBeforeMs: nowMs() - RUN_HEARTBEAT_STALE_MS,
                claimOwnerId,
                claimHeartbeatAtMs,
                requireStale: existingRun.status === "running" ? !opts.force : false,
            }));
            if (!claimed) {
                throw new SmithersError("RUN_RESUME_CLAIM_FAILED", `Failed to acquire durable resume claim for run ${existingRun.runId}.`, {
                    runId: existingRun.runId,
                    status: existingRun.status,
                });
            }
            claimHeld = true;
        }
        const activatedAtMs = nowMs();
        const activated = await Effect.runPromise(adapter.updateClaimedRun({
            runId: existingRun.runId,
            expectedRuntimeOwnerId: claimOwnerId,
            expectedHeartbeatAtMs: claimHeartbeatAtMs,
            patch: {
                status: "running",
                startedAtMs: existingRun.startedAtMs ?? activatedAtMs,
                finishedAtMs: null,
                heartbeatAtMs: activatedAtMs,
                runtimeOwnerId,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                workflowPath: workflowPath ??
                    opts.workflowPath ??
                    existingRun.workflowPath ??
                    null,
                workflowHash: runMetadata.workflowHash,
                vcsType: runMetadata.vcsType,
                vcsRoot: runMetadata.vcsRoot,
                vcsRevision: runMetadata.vcsRevision,
                errorJson: null,
                configJson: runConfigJson,
            },
        }));
        if (!activated) {
            throw new SmithersError("RUN_RESUME_ACTIVATION_FAILED", `Run ${existingRun.runId} changed before the resume claim could be activated.`, {
                runId: existingRun.runId,
                claimOwnerId,
                claimHeartbeatAtMs,
            });
        }
    }
    catch (error) {
        if (claimHeld) {
            await releaseResumeClaimQuietly(adapter, existingRun.runId, cleanup);
        }
        throw error;
    }
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Promise<RunResult>}
 */
async function runWorkflowAsync(workflow, opts) {
    validateRunOptions(opts);
    const runId = opts.runId ?? crypto.randomUUID();
    return runWithCorrelationContext({
        runId,
        parentRunId: opts.parentRunId ?? undefined,
        workflowName: "workflow",
    }, () => runWorkflowWithMakeBridge(workflow, {
        ...opts,
        runId,
    }, runWorkflowBody));
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Promise<RunBodyResult>}
 */
async function runWorkflowBody(workflow, opts) {
    if (process.env.SMITHERS_LEGACY_ENGINE === "1") {
        return runWorkflowBodyLegacy(workflow, opts);
    }
    return runWorkflowBodyDriver(workflow, opts);
}
/**
 * @param {ReadonlyMap<string, number> | Record<string, number> | null} [iterations]
 * @returns {Map<string, number>}
 */
function iterationsToMap(iterations) {
    if (!iterations)
        return new Map();
    if (typeof iterations.entries === "function") {
        return new Map(iterations);
    }
    return new Map(Object.entries(iterations));
}
/**
 * @param {unknown} transition
 * @returns {RalphStateMap | undefined}
 */
function ralphStateFromDriverTransition(transition) {
    const payload = transition &&
        typeof transition === "object" &&
        "statePayload" in transition
        ? transition.statePayload
        : undefined;
    const raw = payload &&
        typeof payload === "object" &&
        "ralphState" in payload
        ? payload.ralphState
        : undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return undefined;
    }
    const state = new Map();
    for (const [ralphId, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object")
            continue;
        const iteration = Number(value.iteration);
        state.set(ralphId, {
            iteration: Number.isFinite(iteration) ? iteration : 0,
            done: Boolean(value.done),
        });
    }
    return state;
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Promise<RunBodyResult>}
 */
async function runWorkflowBodyDriver(workflow, opts) {
    const db = workflow.db;
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = opts.runId ?? crypto.randomUUID();
    const schema = resolveSchema(db);
    const inputTable = schema.input;
    if (!inputTable) {
        throw new SmithersError("MISSING_INPUT_TABLE", "Schema must include input table");
    }
    const resolvedWorkflowPath = opts.workflowPath
        ? resolve(opts.workflowPath)
        : null;
    const rootDir = resolveRootDir(opts, resolvedWorkflowPath);
    const logDir = resolveLogDir(rootDir, runId, opts.logDir);
    const maxConcurrency = coercePositiveInt("maxConcurrency", opts.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    const maxOutputBytes = coercePositiveInt("maxOutputBytes", opts.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    const toolTimeoutMs = coercePositiveInt("toolTimeoutMs", opts.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
    const allowNetwork = Boolean(opts.allowNetwork);
    const runtimeOwnerId = buildRuntimeOwnerId();
    const runAbortController = new AbortController();
    const hijackState = {
        request: null,
        completion: null,
    };
    const detachAbort = wireAbortSignal(runAbortController, opts.signal);
    let stopSupervisor = async () => { };
    const runMetadata = await getRunDurabilityMetadata(resolvedWorkflowPath, rootDir);
    const lastSeq = await Effect.runPromise(adapter.getLastEventSeq(runId));
    const eventBus = new EventBus({
        db: adapter,
        logDir,
        startSeq: (lastSeq ?? -1) + 1,
    });
    if (opts.onProgress) {
        eventBus.on("event", (e) => opts.onProgress?.(e));
    }
    const wakeLock = acquireCaffeinate();
    let alertRuntime = null;
    let runOwnedByCurrentProcess = false;
    let driverTaskError = null;
    const activeDriverTaskKeys = new Set();
    /**
   * @param {Readonly<Record<string, unknown>>} attributes
   */
    const annotateRunSpan = (attributes) => Effect.runPromise(annotateSmithersTrace({
        runId,
        ...attributes,
    }));
    let workflowSession;
    const renderer = new SmithersRenderer();
    const disabledAgents = new Set();
    const toolConfig = {
        rootDir,
        allowNetwork,
        maxOutputBytes,
        toolTimeoutMs,
    };
    let frameNo = ((await adapter.getLastFrame(runId))?.frameNo ?? 0);
    let defaultIteration = 0;
    let workflowRef = workflow;
    let lastGraph = null;
    let descriptorMap = new Map();
    let workflowName = "workflow";
    let cacheEnabled = Boolean(workflow.opts.cache);
    let ralphState = new Map();
    let activeTaskCount = 0;
    const taskWaiters = [];
    const acquireTaskSlot = async () => {
        if (activeTaskCount < maxConcurrency) {
            activeTaskCount += 1;
            return;
        }
        await new Promise((resolveWaiter) => {
            taskWaiters.push(resolveWaiter);
        });
        activeTaskCount += 1;
    };
    const releaseTaskSlot = () => {
        activeTaskCount = Math.max(0, activeTaskCount - 1);
        const next = taskWaiters.shift();
        next?.();
    };
    /**
   * @template A
   * @param {() => Promise<A>} execute
   * @returns {Promise<A>}
   */
    const withTaskSlot = async (execute) => {
        await acquireTaskSlot();
        try {
            return await execute();
        }
        finally {
            releaseTaskSlot();
        }
    };
    const waitForAbortedTasksToSettle = async () => {
        const deadlineAt = nowMs() + RUN_ABORT_SETTLE_TIMEOUT_MS;
        while (true) {
            const inProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
            if (activeDriverTaskKeys.size === 0 && inProgress.length === 0) {
                return;
            }
            if (nowMs() >= deadlineAt) {
                logWarning("timed out waiting for aborted tasks to settle", {
                    runId,
                    activeTaskCount: activeDriverTaskKeys.size,
                    inProgressAttemptCount: inProgress.length,
                }, "engine:run");
                return;
            }
            await Bun.sleep(RUN_ABORT_SETTLE_POLL_MS);
        }
    };
    /**
   * @param {TaskDescriptor} task
   * @returns {Promise<unknown>}
   */
    const readTaskOutput = async (task) => {
        if (!task.outputTable)
            return undefined;
        const outputRow = await selectOutputRow(db, task.outputTable, {
            runId,
            nodeId: task.nodeId,
            iteration: task.iteration,
        });
        return outputRow ? stripAutoColumns(outputRow) : undefined;
    };
    /**
   * @param {TaskDescriptor} task
   * @returns {Promise<unknown>}
   */
    const readTaskFailure = async (task) => {
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
        const latest = attempts[0];
        if (latest?.errorJson) {
            try {
                return JSON.parse(latest.errorJson);
            }
            catch {
                return latest.errorJson;
            }
        }
        return new SmithersError("TASK_FAILED", `Task ${task.nodeId} failed.`, { nodeId: task.nodeId, iteration: task.iteration });
    };
    /**
   * @param {TaskDescriptor} task
   */
    const completeSessionTask = async (task) => Effect.runPromise(workflowSession.taskCompleted({
        nodeId: task.nodeId,
        iteration: task.iteration,
        output: await readTaskOutput(task),
    }));
    /**
   * @param {TaskDescriptor} task
   */
    const failSessionTask = async (task) => Effect.runPromise(workflowSession.taskFailed({
        nodeId: task.nodeId,
        iteration: task.iteration,
        error: await readTaskFailure(task),
    }));
    const submitLastGraph = async () => {
        if (!lastGraph) {
            return {
                _tag: "Wait",
                reason: { _tag: "ExternalTrigger" },
            };
        }
        return Effect.runPromise(workflowSession.submitGraph(lastGraph));
    };
    /**
   * @param {"waiting-approval" | "waiting-event" | "waiting-timer"} status
   * @param {"approval" | "event" | "timer"} waitReason
   * @returns {Promise<RunResult>}
   */
    const markRunWaiting = async (status, waitReason) => {
        await Effect.runPromise(adapter.updateRun(runId, {
            status,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "RunStatusChanged",
            runId,
            status,
            timestampMs: nowMs(),
        }));
        await annotateRunSpan({
            status,
            waitReason,
        });
        return { runId, status };
    };
    /**
   * @param {string} nodeId
   */
    const reconcileApprovalWait = async (nodeId) => {
        const task = lastGraph?.tasks.find((candidate) => candidate.nodeId === nodeId);
        if (!task) {
            return markRunWaiting("waiting-approval", "approval");
        }
        /**
     * @param {{ note?: string | null; decidedBy?: string | null; decisionJson?: string | null; }} approval
     */
        const approvalResolutionPayload = (approval) => ({
            note: approval.note ?? undefined,
            decidedBy: approval.decidedBy ?? undefined,
            payload: approval.decisionJson
                ? JSON.parse(approval.decisionJson)
                : undefined,
        });
        /**
     * @param {{ status?: string | null; note?: string | null; decidedBy?: string | null; decisionJson?: string | null; }} approval
     * @param {boolean} approved
     */
        const resolveSessionApproval = async (approval, approved) => Effect.runPromise(workflowSession.approvalResolved(task.nodeId, {
            approved,
            ...approvalResolutionPayload(approval),
        }));
        /**
     * @param {{ status?: string | null }} approval
     */
        const shouldExecuteDeniedApprovalTask = (approval) => approval.status === "denied" &&
            task.approvalMode !== "gate" &&
            task.approvalOnDeny !== "fail";
        const resolved = await resolveDeferredTaskStateBridge(adapter, db, runId, task, eventBus);
        if (resolved.handled) {
            if (resolved.state === "finished" || resolved.state === "skipped") {
                return completeSessionTask(task);
            }
            if (resolved.state === "failed") {
                const approval = await Effect.runPromise(adapter.getApproval(runId, task.nodeId, task.iteration));
                if (approval?.status === "denied") {
                    return resolveSessionApproval(approval, false);
                }
                return failSessionTask(task);
            }
            if (resolved.state === "pending") {
                const approval = await Effect.runPromise(adapter.getApproval(runId, task.nodeId, task.iteration));
                if (approval && shouldExecuteDeniedApprovalTask(approval)) {
                    return resolveSessionApproval(approval, true);
                }
                return submitLastGraph();
            }
            return markRunWaiting("waiting-approval", "approval");
        }
        const approval = await Effect.runPromise(adapter.getApproval(runId, task.nodeId, task.iteration));
        if (approval?.status === "approved" || approval?.status === "denied") {
            return resolveSessionApproval(approval, approval.status === "approved");
        }
        return markRunWaiting("waiting-approval", "approval");
    };
    /**
   * @param {string} eventName
   */
    const reconcileEventWait = async (eventName) => {
        const tasks = lastGraph?.tasks.filter((candidate) => candidate.meta?.__waitForEvent &&
            (eventName.length === 0 ||
                candidate.meta?.__eventName === eventName)) ?? [];
        for (const task of tasks) {
            const resolved = await resolveDeferredTaskStateBridge(adapter, db, runId, task, eventBus);
            if (!resolved.handled)
                continue;
            if (resolved.state === "finished" || resolved.state === "skipped") {
                return completeSessionTask(task);
            }
            if (resolved.state === "failed") {
                return failSessionTask(task);
            }
            if (resolved.state === "pending") {
                return submitLastGraph();
            }
        }
        return markRunWaiting("waiting-event", "event");
    };
    /**
   * @param {number} resumeAtMs
   */
    const reconcileTimerWait = async (resumeAtMs) => {
        const sessionStates = await Effect.runPromise(workflowSession.getTaskStates());
        const tasks = lastGraph?.tasks.filter((candidate) => {
            if (!candidate.meta?.__timer)
                return false;
            const state = sessionStates.get(buildStateKey(candidate.nodeId, candidate.iteration));
            return (state !== "finished" &&
                state !== "skipped" &&
                state !== "failed" &&
                state !== "cancelled");
        }) ?? [];
        for (const task of tasks) {
            const resolved = await resolveDeferredTaskStateBridge(adapter, db, runId, task, eventBus);
            if (!resolved.handled)
                continue;
            if (resolved.state === "finished") {
                return Effect.runPromise(workflowSession.timerFired(task.nodeId, nowMs()));
            }
            if (resolved.state === "failed") {
                return failSessionTask(task);
            }
            if (resolved.state === "skipped") {
                return completeSessionTask(task);
            }
        }
        const waitMs = Math.max(0, resumeAtMs - nowMs());
        if (waitMs <= 0) {
            return submitLastGraph();
        }
        return markRunWaiting("waiting-timer", "timer");
    };
    /**
   * @param {WaitReason} reason
   * @returns {Promise<EngineDecision | RunResult>}
   */
    const handleDriverWait = async (reason) => {
        if (runAbortController.signal.aborted) {
            return { runId, status: "cancelled" };
        }
        switch (reason._tag) {
            case "Approval":
                return reconcileApprovalWait(reason.nodeId);
            case "Event":
                return reconcileEventWait(reason.eventName);
            case "Timer":
                return reconcileTimerWait(reason.resumeAtMs);
            case "RetryBackoff":
                await Bun.sleep(Math.max(0, reason.waitMs));
                return submitLastGraph();
            case "HotReload":
            case "OrphanRecovery":
            case "ExternalTrigger":
            default:
                return markRunWaiting("waiting-event", "event");
        }
    };
    /**
   * @param {TaskDescriptor} task
   * @returns {Promise<unknown>}
   */
    const executeDriverTask = async (task) => withTaskSlot(async () => {
        const taskKey = buildStateKey(task.nodeId, task.iteration);
        activeDriverTaskKeys.add(taskKey);
        try {
            const existingOutput = await readTaskOutput(task);
            if (existingOutput !== undefined) {
                await Effect.runPromise(adapter.insertNode({
                    runId,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                    state: "finished",
                    lastAttempt: null,
                    updatedAtMs: nowMs(),
                    outputTable: task.outputTableName,
                    label: task.label ?? null,
                }));
                return existingOutput;
            }
            const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
            const failedAttempts = attempts.filter((attempt) => attempt.state === "failed");
            const hasNonRetryableFailure = failedAttempts.some((attempt) => !isRetryableTaskFailure(attempt));
            if (hasNonRetryableFailure ||
                failedAttempts.length >= task.retries + 1) {
                await Effect.runPromise(adapter.insertNode({
                    runId,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                    state: "failed",
                    lastAttempt: attempts[0]?.attempt ?? null,
                    updatedAtMs: nowMs(),
                    outputTable: task.outputTableName,
                    label: task.label ?? null,
                }));
                throw await readTaskFailure(task);
            }
            await Effect.runPromise(withCorrelationContext(withSmithersSpan(smithersSpanNames.task, executeTaskBridgeEffect(adapter, db, runId, task, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, runAbortController.signal, disabledAgents, runAbortController, hijackState, legacyExecuteTask), {
                runId,
                workflowName,
                nodeId: task.nodeId,
                iteration: task.iteration,
                nodeLabel: task.label ?? null,
                status: "running",
            }), {
                workflowName,
                nodeId: task.nodeId,
                iteration: task.iteration,
            }));
            const node = await Effect.runPromise(adapter.getNode(runId, task.nodeId, task.iteration));
            if (node?.state === "failed") {
                throw await readTaskFailure(task);
            }
            if (node?.state === "cancelled") {
                throw makeAbortError();
            }
            return readTaskOutput(task);
        }
        catch (error) {
            if (driverTaskError == null) {
                driverTaskError = error;
            }
            throw error;
        }
        finally {
            activeDriverTaskKeys.delete(taskKey);
        }
    });
    /**
   * @param {WorkflowGraph} graph
   */
    const persistDriverFrame = async (graph) => {
        const xmlJson = canonicalizeXml(graph.xml);
        const xmlHash = sha256Hex(xmlJson);
        frameNo += 1;
        const frameCreatedAtMs = nowMs();
        const frameRow = {
            runId,
            frameNo,
            createdAtMs: frameCreatedAtMs,
            xmlJson,
            xmlHash,
            mountedTaskIdsJson: JSON.stringify(graph.mountedTaskIds),
            taskIndexJson: JSON.stringify(graph.tasks.map((task) => ({
                nodeId: task.nodeId,
                ordinal: task.ordinal,
                iteration: task.iteration,
            }))),
            note: "react-driver",
        };
        const snapNodes = await Effect.runPromise(adapter.listNodes(runId));
        const snapRalph = await Effect.runPromise(adapter.listRalph(runId));
        const snapInputRow = await loadInput(db, inputTable, runId);
        const snapOutputs = await loadOutputs(db, schema, runId);
        const snapshotData = {
            nodes: snapNodes.map((node) => ({
                nodeId: node.nodeId,
                iteration: node.iteration ?? 0,
                state: node.state,
                lastAttempt: node.lastAttempt ?? null,
                outputTable: node.outputTable ?? "",
                label: node.label ?? null,
            })),
            outputs: snapOutputs,
            ralph: snapRalph.map((row) => ({
                ralphId: row.ralphId,
                iteration: row.iteration ?? 0,
                done: Boolean(row.done),
            })),
            input: snapInputRow ?? {},
            vcsPointer: runMetadata?.vcsRevision ?? null,
            workflowHash: workflowRef.opts.workflowHash ?? null,
        };
        try {
            const snap = await adapter.withTransaction("frame-commit", Effect.gen(function* () {
                yield* adapter.insertFrame(frameRow);
                return yield* captureSnapshotEffect(adapter, runId, frameNo, snapshotData);
            }));
            const frameCommittedAtMs = nowMs();
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "FrameCommitted",
                runId,
                frameNo,
                xmlHash,
                timestampMs: frameCommittedAtMs,
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "SnapshotCaptured",
                runId,
                frameNo,
                contentHash: snap.contentHash,
                timestampMs: frameCommittedAtMs,
            }));
        }
        catch (snapErr) {
            logWarning("snapshot capture failed", {
                runId,
                frameNo,
                error: snapErr instanceof Error ? snapErr.message : String(snapErr),
            }, "engine:snapshot");
        }
    };
    /**
   * @param {WorkflowGraph} graph
   */
    const persistDriverGraphTaskStates = async (graph) => {
        const existingRows = await Effect.runPromise(adapter.listNodes(runId));
        const existingState = new Map();
        for (const node of existingRows) {
            existingState.set(buildStateKey(node.nodeId, node.iteration ?? 0), node.state);
        }
        for (const task of graph.tasks) {
            if (task.meta?.__timer || task.needsApproval || task.meta?.__waitForEvent) {
                continue;
            }
            const key = buildStateKey(task.nodeId, task.iteration);
            const previous = existingState.get(key);
            if (task.skipIf) {
                if (previous === "skipped")
                    continue;
                await Effect.runPromise(adapter.insertNode({
                    runId,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                    state: "skipped",
                    lastAttempt: null,
                    updatedAtMs: nowMs(),
                    outputTable: task.outputTableName,
                    label: task.label ?? null,
                }));
                await Effect.runPromise(eventBus.emitEventWithPersist({
                    type: "NodeSkipped",
                    runId,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                    timestampMs: nowMs(),
                }));
                existingState.set(key, "skipped");
                continue;
            }
            if (previous != null)
                continue;
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: task.nodeId,
                iteration: task.iteration,
                state: "pending",
                lastAttempt: null,
                updatedAtMs: nowMs(),
                outputTable: task.outputTableName,
                label: task.label ?? null,
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodePending",
                runId,
                nodeId: task.nodeId,
                iteration: task.iteration,
                timestampMs: nowMs(),
            }));
            existingState.set(key, "pending");
        }
    };
    /**
   * @param {RunResult} result
   * @param {number} runStartPerformanceMs
   * @returns {Promise<RunBodyResult>}
   */
    const finalizeDriverResult = async (result, runStartPerformanceMs) => {
        if (result.status === "continued") {
            return result;
        }
        if (result.status === "waiting-approval" ||
            result.status === "waiting-event" ||
            result.status === "waiting-timer") {
            return result;
        }
        if (result.status === "cancelled") {
            const hijackError = hijackState.completion
                ? {
                    code: "RUN_HIJACKED",
                    ...hijackState.completion,
                }
                : null;
            await waitForAbortedTasksToSettle();
            await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "cancelled",
                finishedAtMs: nowMs(),
                heartbeatAtMs: null,
                runtimeOwnerId: null,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                errorJson: hijackError ? JSON.stringify(hijackError) : null,
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "RunCancelled",
                runId,
                timestampMs: nowMs(),
            }));
            await annotateRunSpan({ status: "cancelled" });
            return { runId, status: "cancelled" };
        }
        if (result.status === "failed") {
            const errorInfo = errorToJson(result.error ?? driverTaskError);
            if (runOwnedByCurrentProcess) {
                await cancelPendingTimers(adapter, runId, eventBus, "run-failed");
                await Effect.runPromise(adapter.updateRun(runId, {
                    status: "failed",
                    finishedAtMs: nowMs(),
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                    hijackRequestedAtMs: null,
                    hijackTarget: null,
                    errorJson: JSON.stringify(errorInfo),
                }));
                await Effect.runPromise(eventBus.emitEventWithPersist({
                    type: "RunFailed",
                    runId,
                    error: errorInfo,
                    timestampMs: nowMs(),
                }));
            }
            await annotateRunSpan({ status: "failed" });
            return { runId, status: "failed", error: errorInfo };
        }
        await Effect.runPromise(adapter.updateRun(runId, {
            status: "finished",
            finishedAtMs: nowMs(),
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "RunFinished",
            runId,
            timestampMs: nowMs(),
        }));
        void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
        logInfo("workflow run finished", {
            runId,
        }, "engine:run");
        await annotateRunSpan({ status: "finished" });
        const outputTable = schema.output;
        let output = undefined;
        if (outputTable) {
            const cols = getTableColumns(outputTable);
            const runIdCol = cols.runId;
            if (runIdCol) {
                const rows = await db
                    .select()
                    .from(outputTable)
                    .where(eq(runIdCol, runId));
                output = rows;
            }
            else {
                output = await db.select().from(outputTable);
            }
        }
        return { runId, status: "finished", output };
    };
    try {
        const existingRun = await Effect.runPromise(adapter.getRun(runId));
        updateCurrentCorrelationContext({
            parentRunId: opts.parentRunId ?? existingRun?.parentRunId ?? undefined,
            workflowName: existingRun?.workflowName ?? "workflow",
        });
        logInfo("starting workflow run", {
            runId,
            workflowPath: resolvedWorkflowPath ?? null,
            rootDir,
            maxConcurrency,
            allowNetwork,
            hotReload: Boolean(opts.hot),
            resume: Boolean(opts.resume),
            engine: "react-driver",
        }, "engine:run");
        await annotateRunSpan({
            status: "running",
            workflowPath: resolvedWorkflowPath ?? null,
            engine: "react-driver",
        });
        const existingConfig = parseRunConfigJson(existingRun?.configJson);
        const runAuth = opts.auth ?? parseRunAuthContext(existingConfig.auth);
        const effectiveAlertPolicy = workflowRef.opts.alertPolicy ?? existingConfig.alertPolicy ?? undefined;
        const runConfig = buildDurabilityConfig({
            ...existingConfig,
            ...opts.config,
            maxConcurrency,
            rootDir,
            allowNetwork,
            maxOutputBytes,
            toolTimeoutMs,
            ...(opts.cliAgentToolsDefault
                ? { cliAgentToolsDefault: opts.cliAgentToolsDefault }
                : {}),
            ...(runAuth ? { auth: runAuth } : {}),
            ...(effectiveAlertPolicy ? { alertPolicy: effectiveAlertPolicy } : {}),
        }, runMetadata);
        const runConfigJson = JSON.stringify(runConfig);
        const workflowVersioning = createWorkflowVersioningRuntime({
            baseConfig: runConfig,
            initialDecisions: getWorkflowPatchDecisions(existingConfig),
            isNewRun: !existingRun,
            persist: async (config) => {
                await Effect.runPromise(adapter.updateRun(runId, {
                    configJson: JSON.stringify(config),
                }));
            },
            recordDecision: async (record) => {
                const timestampMs = nowMs();
                await Effect.runPromise(adapter.insertEventWithNextSeq({
                    runId,
                    timestampMs,
                    type: "WorkflowPatchRecorded",
                    payloadJson: JSON.stringify({
                        runId,
                        patchId: record.patchId,
                        decision: record.decision,
                        timestampMs,
                    }),
                }));
            },
        });
        if (opts.resume && existingRun) {
            assertResumeDurabilityMetadata(existingRun, existingConfig, runMetadata, resolvedWorkflowPath);
        }
        else if (opts.resume && !existingRun) {
            throw new SmithersError("RUN_NOT_FOUND", `Cannot resume run ${runId} because it does not exist.`, { runId });
        }
        if (!opts.resume) {
            assertInputObject(opts.input);
            if ("runId" in opts.input && opts.input.runId !== runId) {
                throw new SmithersError("INVALID_INPUT", "Input runId does not match provided runId");
            }
            const inputRow = buildInputRow(inputTable, runId, opts.input);
            const validation = validateInput(inputTable, inputRow);
            if (!validation.ok) {
                throw new SmithersError("INVALID_INPUT", "Input does not match schema", {
                    issues: validation.error?.issues,
                });
            }
            const insertQuery = db.insert(inputTable).values(inputRow);
            if (typeof insertQuery.onConflictDoNothing === "function") {
                await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow).onConflictDoNothing(), { label: "insert input row" });
            }
            else {
                await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow), {
                    label: "insert input row",
                });
            }
        }
        else {
            let existingInput = await loadInput(db, inputTable, runId);
            if (!existingInput) {
                const restored = await restoreDurableStateFromSnapshot(adapter, db, schema, inputTable, runId);
                if (restored) {
                    existingInput = await loadInput(db, inputTable, runId);
                }
            }
            if (!existingInput) {
                // Workflows without a user-defined input schema use a fallback
                // (run_id, payload) table. Insert an empty row so resume can proceed.
                const fallbackRow = buildInputRow(inputTable, runId, {});
                try {
                    await withSqliteWriteRetry(() => db.insert(inputTable).values(fallbackRow).onConflictDoNothing(), { label: "insert fallback input row for resume" });
                    existingInput = await loadInput(db, inputTable, runId);
                }
                catch {
                    // ignore — will fail below if still missing
                }
            }
            if (!existingInput) {
                throw new SmithersError("MISSING_INPUT", "Cannot resume without an existing input row");
            }
        }
        if (!existingRun) {
            await Effect.runPromise(adapter.insertRun({
                runId,
                parentRunId: opts.parentRunId ?? null,
                workflowName: "workflow",
                workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? null,
                workflowHash: runMetadata.workflowHash,
                status: "running",
                createdAtMs: nowMs(),
                startedAtMs: nowMs(),
                finishedAtMs: null,
                heartbeatAtMs: nowMs(),
                runtimeOwnerId,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                vcsType: runMetadata.vcsType,
                vcsRoot: runMetadata.vcsRoot,
                vcsRevision: runMetadata.vcsRevision,
                errorJson: null,
                configJson: runConfigJson,
            }));
            runOwnedByCurrentProcess = true;
        }
        else if (opts.resume) {
            await activateRunForResume(adapter, existingRun, opts, runtimeOwnerId, runConfigJson, runMetadata, resolvedWorkflowPath);
            runOwnedByCurrentProcess = true;
        }
        else {
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "running",
                startedAtMs: existingRun.startedAtMs ?? nowMs(),
                finishedAtMs: null,
                heartbeatAtMs: nowMs(),
                runtimeOwnerId,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                workflowPath: resolvedWorkflowPath ??
                    opts.workflowPath ??
                    existingRun.workflowPath ??
                    null,
                workflowHash: runMetadata.workflowHash ?? existingRun.workflowHash ?? null,
                vcsType: runMetadata.vcsType ?? existingRun.vcsType ?? null,
                vcsRoot: runMetadata.vcsRoot ?? existingRun.vcsRoot ?? null,
                vcsRevision: runMetadata.vcsRevision ?? existingRun.vcsRevision ?? null,
                errorJson: null,
                configJson: runConfigJson,
            }));
            runOwnedByCurrentProcess = true;
        }
        stopSupervisor = startRunSupervisor(adapter, runId, runtimeOwnerId, runAbortController, hijackState);
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "RunStarted",
            runId,
            timestampMs: nowMs(),
        }));
        if (effectiveAlertPolicy && effectiveAlertPolicy.rules && Object.keys(effectiveAlertPolicy.rules).length > 0) {
            alertRuntime = new AlertRuntime(effectiveAlertPolicy, {
                runId,
                adapter,
                eventBus,
                requestCancel: () => runAbortController.abort(),
                createHumanRequest: async (reqOpts) => {
                    await Effect.runPromise(adapter.insertHumanRequest({
                        requestId: `human:${reqOpts.runId}:${reqOpts.nodeId}:${reqOpts.iteration}`,
                        runId: reqOpts.runId,
                        nodeId: reqOpts.nodeId,
                        iteration: reqOpts.iteration,
                        kind: reqOpts.kind,
                        status: "pending",
                        prompt: reqOpts.prompt,
                        schemaJson: null,
                        optionsJson: reqOpts.linkedAlertId ? JSON.stringify({ linkedAlertId: reqOpts.linkedAlertId }) : null,
                        responseJson: null,
                        requestedAtMs: Date.now(),
                        answeredAtMs: null,
                        answeredBy: null,
                        timeoutAtMs: null,
                    }));
                },
                pauseScheduler: (_reason) => { },
            });
            alertRuntime.start();
        }
        const runStartPerformanceMs = performance.now();
        await cancelStaleAttempts(adapter, runId);
        if (opts.resume) {
            void Effect.runPromise(Metric.increment(runsResumedTotal));
            const staleInProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
            const now = nowMs();
            for (const attempt of staleInProgress) {
                const existingNode = await Effect.runPromise(adapter.getNode(runId, attempt.nodeId, attempt.iteration));
                await adapter.withTransaction("resume-cancel-stale-attempt", Effect.gen(function* () {
                    yield* adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                        state: "cancelled",
                        finishedAtMs: now,
                    });
                    yield* adapter.insertNode({
                        runId,
                        nodeId: attempt.nodeId,
                        iteration: attempt.iteration,
                        state: "pending",
                        lastAttempt: attempt.attempt,
                        updatedAtMs: now,
                        outputTable: existingNode?.outputTable ?? "",
                        label: existingNode?.label ?? null,
                    });
                }));
            }
        }
        if (opts.resume) {
            const nodes = await Effect.runPromise(adapter.listNodes(runId));
            defaultIteration = nodes.reduce((max, node) => Math.max(max, node.iteration ?? 0), 0);
        }
        ralphState = buildRalphStateMap(await Effect.runPromise(adapter.listRalph(runId)));
        if (opts.resume && ralphState.size > 0) {
            const maxRalphIteration = [...ralphState.values()].reduce((max, state) => Math.max(max, state.iteration), 0);
            defaultIteration = Math.max(defaultIteration, maxRalphIteration);
        }
        workflowSession = makeWorkflowSession({
            runId,
            nowMs,
            requireStableFinish: true,
            requireRerenderOnOutputChange: true,
            initialRalphState: ralphState,
        });
        const driverRenderer = {
            render: async (element, renderOpts) => {
                const graph = await withWorkflowVersioningRuntime(workflowVersioning, () => renderer.render(element, renderOpts));
                await workflowVersioning.flush();
                resolveTaskOutputs(graph.tasks, workflowRef);
                attachSubflowComputeFns(graph.tasks, workflowRef, {
                    rootDir,
                    workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
                });
                lastGraph = graph;
                descriptorMap = buildDescriptorMap(graph.tasks);
                workflowName = getWorkflowNameFromXml(graph.xml);
                updateCurrentCorrelationContext({ workflowName });
                cacheEnabled =
                    workflowRef.opts.cache ??
                        Boolean(graph.xml &&
                            graph.xml.kind === "element" &&
                            (graph.xml.props.cache === "true" || graph.xml.props.cache === "1"));
                await Effect.runPromise(adapter.updateRun(runId, { workflowName }));
                await annotateRunSpan({ workflowName });
                const renderIterations = iterationsToMap(renderOpts?.ralphIterations);
                for (const [ralphId, iteration] of renderIterations.entries()) {
                    const existing = ralphState.get(ralphId);
                    const nextState = {
                        iteration,
                        done: existing?.done ?? false,
                    };
                    ralphState.set(ralphId, nextState);
                    if (existing?.iteration !== nextState.iteration ||
                        existing?.done !== nextState.done) {
                        await Effect.runPromise(adapter.insertOrUpdateRalph({
                            runId,
                            ralphId,
                            iteration: nextState.iteration,
                            done: nextState.done,
                            updatedAtMs: nowMs(),
                        }));
                    }
                }
                if (typeof renderOpts?.defaultIteration === "number") {
                    defaultIteration = renderOpts.defaultIteration;
                }
                const { ralphs } = buildPlanTree(graph.xml, ralphState);
                for (const ralph of ralphs) {
                    if (!ralphState.has(ralph.id)) {
                        const iteration = renderIterations.get(ralph.id) ?? 0;
                        ralphState.set(ralph.id, { iteration, done: false });
                        await Effect.runPromise(adapter.insertOrUpdateRalph({
                            runId,
                            ralphId: ralph.id,
                            iteration,
                            done: false,
                            updatedAtMs: nowMs(),
                        }));
                    }
                }
                if (ralphs.length === 1) {
                    defaultIteration = ralphState.get(ralphs[0].id)?.iteration ?? 0;
                }
                else if (ralphs.length === 0) {
                    defaultIteration = 0;
                }
                await persistDriverGraphTaskStates(lastGraph);
                await persistDriverFrame(lastGraph);
                return lastGraph;
            },
        };
        const driverWorkflow = {
            ...workflowRef,
            build: (ctx) => withWorkflowVersioningRuntime(workflowVersioning, () => workflowRef.build(ctx)),
        };
        const activeInput = await loadInput(db, inputTable, runId);
        const driver = new ReactWorkflowDriver({
            workflow: driverWorkflow,
            runtime: { runPromise: Effect.runPromise },
            session: workflowSession,
            db,
            runId,
            rootDir,
            workflowPath: resolvedWorkflowPath,
            executeTask: (task) => executeDriverTask(task),
            onSchedulerWait: (durationMs) => Effect.runPromise(Metric.update(schedulerWaitDuration, durationMs)),
            onWait: (reason) => handleDriverWait(reason),
            continueAsNew: async (transition) => {
                let statePayload = transition?.statePayload;
                if (transition?.stateJson) {
                    try {
                        statePayload = JSON.parse(transition.stateJson);
                    }
                    catch (error) {
                        throw new SmithersError("INVALID_CONTINUATION_STATE", "Invalid JSON passed to continue-as-new state", {
                            stateJson: transition.stateJson,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                if (runAbortController.signal.aborted) {
                    return { runId, status: "cancelled" };
                }
                const latestRun = await Effect.runPromise(adapter.getRun(runId));
                if (latestRun?.cancelRequestedAtMs) {
                    runAbortController.abort();
                    return { runId, status: "cancelled" };
                }
                const nextRalphState = ralphStateFromDriverTransition(transition);
                const continuationIteration = typeof transition?.iteration === "number"
                    ? transition.iteration
                    : defaultIteration;
                const driverTransition = await continueRunAsNew({
                    db,
                    adapter,
                    schema,
                    inputTable,
                    runId,
                    workflowPath: resolvedWorkflowPath ??
                        opts.workflowPath ??
                        latestRun?.workflowPath ??
                        null,
                    runMetadata,
                    currentFrameNo: frameNo,
                    continuation: {
                        reason: transition?.reason === "loop-threshold"
                            ? "loop-threshold"
                            : "explicit",
                        iteration: continuationIteration,
                        statePayload,
                        nextRalphState,
                    },
                    ralphState,
                });
                const continuationEvent = {
                    type: "RunContinuedAsNew",
                    runId,
                    newRunId: driverTransition.newRunId,
                    iteration: continuationIteration,
                    carriedStateSize: driverTransition.carriedStateBytes,
                    ancestryDepth: driverTransition.ancestryDepth,
                    timestampMs: nowMs(),
                };
                eventBus.emit("event", continuationEvent);
                Effect.runSync(trackEvent(continuationEvent));
                logInfo(`Continuing run ${runId} as ${driverTransition.newRunId} at iteration ${continuationIteration}`, {
                    runId,
                    newRunId: driverTransition.newRunId,
                    iteration: continuationIteration,
                    carriedStateBytes: driverTransition.carriedStateBytes,
                    engine: "react-driver",
                }, "engine:continue-as-new");
                void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
                await annotateRunSpan({ status: "continued" });
                return {
                    runId,
                    status: "continued",
                    nextRunId: driverTransition.newRunId,
                };
            },
            renderer: driverRenderer,
        });
        const result = await driver.run({
            ...opts,
            runId,
            input: (activeInput ?? opts.input),
            initialOutputs: await loadOutputs(db, schema, runId),
            initialIteration: defaultIteration,
            initialIterations: ralphIterationsObject(ralphState),
            rootDir,
            workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
            auth: runAuth,
            signal: runAbortController.signal,
        });
        return finalizeDriverResult(result, runStartPerformanceMs);
    }
    catch (err) {
        if (runAbortController.signal.aborted || isAbortError(err)) {
            logInfo("workflow run cancelled while handling error", {
                runId,
                error: err instanceof Error ? err.message : String(err),
            }, "engine:run");
            const hijackError = hijackState.completion
                ? {
                    code: "RUN_HIJACKED",
                    ...hijackState.completion,
                }
                : errorToJson(err);
            await waitForAbortedTasksToSettle();
            await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "cancelled",
                finishedAtMs: nowMs(),
                heartbeatAtMs: null,
                runtimeOwnerId: null,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                errorJson: JSON.stringify(hijackError),
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "RunCancelled",
                runId,
                timestampMs: nowMs(),
            }));
            await annotateRunSpan({ status: "cancelled" });
            return { runId, status: "cancelled" };
        }
        logError("workflow run failed with unhandled error", {
            runId,
            error: err instanceof Error ? err.message : String(err),
        }, "engine:run");
        const errorInfo = errorToJson(err);
        if (runOwnedByCurrentProcess) {
            await cancelPendingTimers(adapter, runId, eventBus, "run-failed");
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "failed",
                finishedAtMs: nowMs(),
                heartbeatAtMs: null,
                runtimeOwnerId: null,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                errorJson: JSON.stringify(errorInfo),
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "RunFailed",
                runId,
                error: errorInfo,
                timestampMs: nowMs(),
            }));
        }
        await annotateRunSpan({ status: "failed" });
        return { runId, status: "failed", error: errorInfo };
    }
    finally {
        alertRuntime?.stop();
        await stopSupervisor();
        detachAbort();
        wakeLock.release();
    }
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Promise<RunBodyResult>}
 */
async function runWorkflowBodyLegacy(workflow, opts) {
    const db = workflow.db;
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = opts.runId ?? crypto.randomUUID();
    let workflowSessionShadow = null;
    try {
        workflowSessionShadow = makeWorkflowSession({
            runId,
            nowMs,
            requireStableFinish: true,
        });
    }
    catch (error) {
        logWarning("workflow session shadow initialization failed", {
            runId,
            error: error instanceof Error ? error.message : String(error),
        }, "engine:workflow-session");
    }
    const schema = resolveSchema(db);
    const inputTable = schema.input;
    if (!inputTable) {
        throw new SmithersError("MISSING_INPUT_TABLE", "Schema must include input table");
    }
    const resolvedWorkflowPath = opts.workflowPath
        ? resolve(opts.workflowPath)
        : null;
    const rootDir = resolveRootDir(opts, resolvedWorkflowPath);
    const logDir = resolveLogDir(rootDir, runId, opts.logDir);
    const maxConcurrency = coercePositiveInt("maxConcurrency", opts.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    const maxOutputBytes = coercePositiveInt("maxOutputBytes", opts.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    const toolTimeoutMs = coercePositiveInt("toolTimeoutMs", opts.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
    const allowNetwork = Boolean(opts.allowNetwork);
    const runtimeOwnerId = buildRuntimeOwnerId();
    const runAbortController = new AbortController();
    const hijackState = {
        request: null,
        completion: null,
    };
    const detachAbort = wireAbortSignal(runAbortController, opts.signal);
    let stopSupervisor = async () => { };
    const runMetadata = await getRunDurabilityMetadata(resolvedWorkflowPath, rootDir);
    const lastSeq = await Effect.runPromise(adapter.getLastEventSeq(runId));
    const eventBus = new EventBus({
        db: adapter,
        logDir,
        startSeq: (lastSeq ?? -1) + 1,
    });
    if (opts.onProgress) {
        eventBus.on("event", (e) => opts.onProgress?.(e));
    }
    const hotOpts = normalizeHotOptions(opts.hot);
    let hotController = null;
    let hotPendingFiles = null;
    let workflowRef = workflow;
    let onAbortWake = () => { };
    let armHotReloadWakeup = () => { };
    let waitForAbortedTasksToSettle = async () => { };
    let runOwnedByCurrentProcess = false;
    /**
   * @param {Readonly<Record<string, unknown>>} attributes
   */
    const annotateRunSpan = (attributes) => Effect.runPromise(annotateSmithersTrace({
        runId,
        ...attributes,
    }));
    const wakeLock = acquireCaffeinate();
    let alertRuntime = null;
    try {
        const existingRun = await Effect.runPromise(adapter.getRun(runId));
        updateCurrentCorrelationContext({
            parentRunId: opts.parentRunId ?? existingRun?.parentRunId ?? undefined,
            workflowName: existingRun?.workflowName ?? "workflow",
        });
        logInfo("starting workflow run", {
            runId,
            workflowPath: resolvedWorkflowPath ?? null,
            rootDir,
            maxConcurrency,
            allowNetwork,
            hotReload: hotOpts.enabled,
            resume: Boolean(opts.resume),
        }, "engine:run");
        await annotateRunSpan({
            status: "running",
            workflowPath: resolvedWorkflowPath ?? null,
        });
        const existingConfig = parseRunConfigJson(existingRun?.configJson);
        const runAuth = opts.auth ?? parseRunAuthContext(existingConfig.auth);
        const effectiveAlertPolicy = workflowRef.opts.alertPolicy ?? existingConfig.alertPolicy ?? undefined;
        const runConfig = buildDurabilityConfig({
            ...existingConfig,
            ...opts.config,
            maxConcurrency,
            rootDir,
            allowNetwork,
            maxOutputBytes,
            toolTimeoutMs,
            ...(opts.cliAgentToolsDefault
                ? { cliAgentToolsDefault: opts.cliAgentToolsDefault }
                : {}),
            ...(runAuth ? { auth: runAuth } : {}),
            ...(effectiveAlertPolicy ? { alertPolicy: effectiveAlertPolicy } : {}),
        }, runMetadata);
        const runConfigJson = JSON.stringify(runConfig);
        const workflowVersioning = createWorkflowVersioningRuntime({
            baseConfig: runConfig,
            initialDecisions: getWorkflowPatchDecisions(existingConfig),
            isNewRun: !existingRun,
            persist: async (config) => {
                await Effect.runPromise(adapter.updateRun(runId, {
                    configJson: JSON.stringify(config),
                }));
            },
            recordDecision: async (record) => {
                const timestampMs = nowMs();
                await Effect.runPromise(adapter.insertEventWithNextSeq({
                    runId,
                    timestampMs,
                    type: "WorkflowPatchRecorded",
                    payloadJson: JSON.stringify({
                        runId,
                        patchId: record.patchId,
                        decision: record.decision,
                        timestampMs,
                    }),
                }));
            },
        });
        if (opts.resume && existingRun) {
            assertResumeDurabilityMetadata(existingRun, existingConfig, runMetadata, resolvedWorkflowPath);
        }
        else if (opts.resume && !existingRun) {
            throw new SmithersError("RUN_NOT_FOUND", `Cannot resume run ${runId} because it does not exist.`, { runId });
        }
        if (!opts.resume) {
            assertInputObject(opts.input);
            if ("runId" in opts.input && opts.input.runId !== runId) {
                throw new SmithersError("INVALID_INPUT", "Input runId does not match provided runId");
            }
            const inputRow = buildInputRow(inputTable, runId, opts.input);
            const validation = validateInput(inputTable, inputRow);
            if (!validation.ok) {
                throw new SmithersError("INVALID_INPUT", "Input does not match schema", {
                    issues: validation.error?.issues,
                });
            }
            const insertQuery = db.insert(inputTable).values(inputRow);
            if (typeof insertQuery.onConflictDoNothing === "function") {
                await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow).onConflictDoNothing(), { label: "insert input row" });
            }
            else {
                await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow), {
                    label: "insert input row",
                });
            }
        }
        else {
            let existingInput = await loadInput(db, inputTable, runId);
            if (!existingInput) {
                const restored = await restoreDurableStateFromSnapshot(adapter, db, schema, inputTable, runId);
                if (restored) {
                    existingInput = await loadInput(db, inputTable, runId);
                }
            }
            if (!existingInput) {
                // Workflows without a user-defined input schema use a fallback
                // (run_id, payload) table. Insert an empty row so resume can proceed.
                const fallbackRow = buildInputRow(inputTable, runId, {});
                try {
                    await withSqliteWriteRetry(() => db.insert(inputTable).values(fallbackRow).onConflictDoNothing(), { label: "insert fallback input row for resume" });
                    existingInput = await loadInput(db, inputTable, runId);
                }
                catch {
                    // ignore — will fail below if still missing
                }
            }
            if (!existingInput) {
                throw new SmithersError("MISSING_INPUT", "Cannot resume without an existing input row");
            }
        }
        if (!existingRun) {
            await Effect.runPromise(adapter.insertRun({
                runId,
                parentRunId: opts.parentRunId ?? null,
                workflowName: "workflow",
                workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? null,
                workflowHash: runMetadata.workflowHash,
                status: "running",
                createdAtMs: nowMs(),
                startedAtMs: nowMs(),
                finishedAtMs: null,
                heartbeatAtMs: nowMs(),
                runtimeOwnerId,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                vcsType: runMetadata.vcsType,
                vcsRoot: runMetadata.vcsRoot,
                vcsRevision: runMetadata.vcsRevision,
                errorJson: null,
                configJson: runConfigJson,
            }));
            runOwnedByCurrentProcess = true;
        }
        else if (opts.resume) {
            await activateRunForResume(adapter, existingRun, opts, runtimeOwnerId, runConfigJson, runMetadata, resolvedWorkflowPath);
            runOwnedByCurrentProcess = true;
        }
        else {
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "running",
                startedAtMs: existingRun.startedAtMs ?? nowMs(),
                finishedAtMs: null,
                heartbeatAtMs: nowMs(),
                runtimeOwnerId,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                workflowPath: resolvedWorkflowPath ??
                    opts.workflowPath ??
                    existingRun.workflowPath ??
                    null,
                workflowHash: runMetadata.workflowHash ?? existingRun.workflowHash ?? null,
                vcsType: runMetadata.vcsType ?? existingRun.vcsType ?? null,
                vcsRoot: runMetadata.vcsRoot ?? existingRun.vcsRoot ?? null,
                vcsRevision: runMetadata.vcsRevision ?? existingRun.vcsRevision ?? null,
                errorJson: null,
                configJson: runConfigJson,
            }));
            runOwnedByCurrentProcess = true;
        }
        stopSupervisor = startRunSupervisor(adapter, runId, runtimeOwnerId, runAbortController, hijackState);
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "RunStarted",
            runId,
            timestampMs: nowMs(),
        }));
        // Start alert runtime if alertPolicy is configured
        if (effectiveAlertPolicy && effectiveAlertPolicy.rules && Object.keys(effectiveAlertPolicy.rules).length > 0) {
            alertRuntime = new AlertRuntime(effectiveAlertPolicy, {
                runId,
                adapter,
                eventBus,
                requestCancel: () => runAbortController.abort(),
                createHumanRequest: async (reqOpts) => {
                    await Effect.runPromise(adapter.insertHumanRequest({
                        requestId: `human:${reqOpts.runId}:${reqOpts.nodeId}:${reqOpts.iteration}`,
                        runId: reqOpts.runId,
                        nodeId: reqOpts.nodeId,
                        iteration: reqOpts.iteration,
                        kind: reqOpts.kind,
                        status: "pending",
                        prompt: reqOpts.prompt,
                        schemaJson: null,
                        optionsJson: reqOpts.linkedAlertId ? JSON.stringify({ linkedAlertId: reqOpts.linkedAlertId }) : null,
                        responseJson: null,
                        requestedAtMs: Date.now(),
                        answeredAtMs: null,
                        answeredBy: null,
                        timeoutAtMs: null,
                    }));
                },
                pauseScheduler: (_reason) => {
                    // The human request will cause the scheduler to enter waiting-event state
                },
            });
            alertRuntime.start();
        }
        const runStartPerformanceMs = performance.now();
        await cancelStaleAttempts(adapter, runId);
        if (opts.resume) {
            void Effect.runPromise(Metric.increment(runsResumedTotal));
            // On resume, cancel ALL in-progress attempts since the previous process is dead
            const staleInProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
            const now = nowMs();
            for (const attempt of staleInProgress) {
                const existingNode = await Effect.runPromise(adapter.getNode(runId, attempt.nodeId, attempt.iteration));
                await adapter.withTransaction("resume-cancel-stale-attempt", Effect.gen(function* () {
                    yield* adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                        state: "cancelled",
                        finishedAtMs: now,
                    });
                    yield* adapter.insertNode({
                        runId,
                        nodeId: attempt.nodeId,
                        iteration: attempt.iteration,
                        state: "pending",
                        lastAttempt: attempt.attempt,
                        updatedAtMs: now,
                        outputTable: existingNode?.outputTable ?? "",
                        label: existingNode?.label ?? null,
                    });
                }));
            }
        }
        const disabledAgents = new Set();
        const renderer = new SmithersRenderer();
        let frameNo = ((await adapter.getLastFrame(runId))?.frameNo ?? 0);
        let defaultIteration = 0;
        let prevMountedTaskIds = new Set();
        const triggerQueue = await Effect.runPromise(Queue.unbounded());
        const schedulerTaskKeys = new Set();
        let schedulerTaskError = null;
        let hotWaitInFlight = false;
        let scheduledRetryAtMs = null;
        let retryWakeFiber = null;
        const toolConfig = {
            rootDir,
            allowNetwork,
            maxOutputBytes,
            toolTimeoutMs,
        };
        const schedulerExecutionConcurrency = Math.max(1, maxConcurrency);
        /**
     * @param {ScheduleTrigger} trigger
     */
        const offerSchedulerTrigger = (trigger) => {
            triggerQueue.unsafeOffer(trigger);
        };
        /**
     * @param {Pick<TaskDescriptor, "nodeId" | "iteration">} task
     */
        const makeSchedulerTaskKey = (task) => buildStateKey(task.nodeId, task.iteration);
        const workflowSessionTaskNotifications = new Set();
        /**
     * @param {string} operation
     * @param {() => Effect.Effect<EngineDecision, unknown>} makeEffect
     * @param {Readonly<Record<string, unknown>>} [context]
     * @returns {Promise<EngineDecision | null>}
     */
        const runWorkflowSessionShadow = async (operation, makeEffect, context = {}) => {
            if (!workflowSessionShadow) {
                return null;
            }
            try {
                return await Effect.runPromise(makeEffect());
            }
            catch (error) {
                logWarning("workflow session shadow call failed", {
                    runId,
                    operation,
                    ...context,
                    error: error instanceof Error ? error.message : String(error),
                }, "engine:workflow-session");
                return null;
            }
        };
        /**
     * @param {string} operation
     * @param {EngineDecision | null} sessionDecision
     * @param {WorkflowSessionShadowDecisionSummary} legacyDecision
     * @param {Readonly<Record<string, unknown>>} [context]
     */
        const compareWorkflowSessionShadow = (operation, sessionDecision, legacyDecision, context = {}) => {
            if (!sessionDecision) {
                return;
            }
            try {
                const sessionSummary = summarizeWorkflowSessionDecision(sessionDecision);
                if (workflowSessionSummaryKey(sessionSummary) ===
                    workflowSessionSummaryKey(legacyDecision)) {
                    return;
                }
                logWarning("workflow session shadow divergence", {
                    runId,
                    operation,
                    sessionDecision: sessionSummary,
                    legacyDecision,
                    ...context,
                }, "engine:workflow-session");
            }
            catch (error) {
                logWarning("workflow session shadow comparison failed", {
                    runId,
                    operation,
                    ...context,
                    error: error instanceof Error ? error.message : String(error),
                }, "engine:workflow-session");
            }
        };
        /**
     * @param {TaskDescriptor} task
     * @param {unknown} [fallbackError]
     */
        const notifyWorkflowSessionTaskSettled = async (task, fallbackError) => {
            if (!workflowSessionShadow) {
                return;
            }
            try {
                const node = await Effect.runPromise(adapter.getNode(runId, task.nodeId, task.iteration));
                const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
                const latestAttempt = attempts[0];
                const state = node?.state ?? (fallbackError == null ? null : "failed");
                const notificationKey = [
                    task.nodeId,
                    task.iteration,
                    state ?? "unknown",
                    latestAttempt?.attempt ?? "unknown",
                ].join("::");
                if (workflowSessionTaskNotifications.has(notificationKey)) {
                    return;
                }
                if (state === "finished") {
                    workflowSessionTaskNotifications.add(notificationKey);
                    const outputRow = task.outputTable
                        ? await selectOutputRow(db, task.outputTable, {
                            runId,
                            nodeId: task.nodeId,
                            iteration: task.iteration,
                        })
                        : undefined;
                    await runWorkflowSessionShadow("taskCompleted", () => workflowSessionShadow.taskCompleted({
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                        output: outputRow ? stripAutoColumns(outputRow) : undefined,
                    }), {
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                    });
                    return;
                }
                if (state === "failed") {
                    workflowSessionTaskNotifications.add(notificationKey);
                    let errorPayload = fallbackError ?? "Task failed";
                    if (latestAttempt?.errorJson) {
                        try {
                            errorPayload = JSON.parse(latestAttempt.errorJson);
                        }
                        catch {
                            errorPayload = latestAttempt.errorJson;
                        }
                    }
                    await runWorkflowSessionShadow("taskFailed", () => workflowSessionShadow.taskFailed({
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                        error: errorPayload,
                    }), {
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                    });
                }
            }
            catch (error) {
                logWarning("workflow session shadow task settlement failed", {
                    runId,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                    error: error instanceof Error ? error.message : String(error),
                }, "engine:workflow-session");
            }
        };
        waitForAbortedTasksToSettle = async () => {
            const deadlineAt = nowMs() + RUN_ABORT_SETTLE_TIMEOUT_MS;
            while (true) {
                const inProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
                if (schedulerTaskKeys.size === 0 && inProgress.length === 0) {
                    return;
                }
                if (nowMs() >= deadlineAt) {
                    logWarning("timed out waiting for aborted tasks to settle", {
                        runId,
                        activeTaskCount: schedulerTaskKeys.size,
                        inProgressAttemptCount: inProgress.length,
                    }, "engine:run");
                    return;
                }
                await Bun.sleep(RUN_ABORT_SETTLE_POLL_MS);
            }
        };
        const readExternalSchedulerState = async () => {
            const pendingApprovals = await Effect.runPromise(adapter.listPendingApprovals(runId));
            const [latestSignal] = await Effect.runPromise(adapter.listSignals(runId, { limit: 1 }));
            return {
                latestSignalSeq: latestSignal?.seq ?? 0,
                pendingApprovalFingerprint: pendingApprovals
                    .map((approval) => `${approval.nodeId ?? ""}:${approval.iteration ?? 0}:${approval.requestedAtMs ?? 0}`)
                    .sort()
                    .join("|"),
            };
        };
        const takeSchedulerTriggerBatchEffect = Effect.gen(function* () {
            const waitStart = performance.now();
            const first = yield* triggerQueue.take;
            const rest = yield* triggerQueue.takeAll;
            yield* Metric.update(schedulerWaitDuration, performance.now() - waitStart);
            return [first, ...Chunk.toArray(rest)];
        });
        const clearRetryWakeEffect = () => Effect.gen(function* () {
            if (!retryWakeFiber) {
                scheduledRetryAtMs = null;
                return;
            }
            const fiber = retryWakeFiber;
            retryWakeFiber = null;
            scheduledRetryAtMs = null;
            yield* Fiber.interrupt(fiber);
        });
        /**
     * @param {number} waitMs
     */
        const scheduleRetryWakeEffect = (waitMs) => Effect.gen(function* () {
            if (waitMs <= 0) {
                offerSchedulerTrigger({
                    type: "external-event",
                    source: "retry",
                });
                return;
            }
            const retryAtMs = nowMs() + waitMs;
            if (retryWakeFiber && scheduledRetryAtMs === retryAtMs) {
                return;
            }
            yield* clearRetryWakeEffect();
            scheduledRetryAtMs = retryAtMs;
            retryWakeFiber = yield* Effect.forkScoped(Effect.sleep(Duration.millis(waitMs)).pipe(Effect.tap(() => Effect.sync(() => {
                if (scheduledRetryAtMs === retryAtMs) {
                    scheduledRetryAtMs = null;
                    retryWakeFiber = null;
                }
                offerSchedulerTrigger({
                    type: "external-event",
                    source: "retry",
                });
            })), Effect.asVoid));
        });
        const watchExternalSchedulerEventsEffect = Effect.gen(function* () {
            const initialState = yield* Effect.either(Effect.tryPromise({
                try: () => readExternalSchedulerState(),
                catch: (cause) => toSmithersError(cause, "read scheduler external event state"),
            }));
            let previous = initialState._tag === "Right"
                ? initialState.right
                : {
                    latestSignalSeq: 0,
                    pendingApprovalFingerprint: "",
                };
            if (initialState._tag === "Left") {
                yield* Effect.sync(() => {
                    logWarning("failed to initialize external scheduler watcher", {
                        runId,
                        error: initialState.left.message,
                    }, "engine:run");
                });
            }
            while (true) {
                yield* Effect.sleep(Duration.millis(SCHEDULER_EXTERNAL_EVENT_POLL_MS));
                const nextState = yield* Effect.either(Effect.tryPromise({
                    try: () => readExternalSchedulerState(),
                    catch: (cause) => toSmithersError(cause, "poll scheduler external event state"),
                }));
                if (nextState._tag === "Left") {
                    yield* Effect.sync(() => {
                        logWarning("scheduler external event poll failed", {
                            runId,
                            error: nextState.left.message,
                        }, "engine:run");
                    });
                    continue;
                }
                if (nextState.right.latestSignalSeq !== previous.latestSignalSeq) {
                    offerSchedulerTrigger({
                        type: "external-event",
                        source: "signal",
                    });
                }
                if (nextState.right.pendingApprovalFingerprint !==
                    previous.pendingApprovalFingerprint) {
                    offerSchedulerTrigger({
                        type: "external-event",
                        source: "approval",
                    });
                }
                previous = nextState.right;
            }
        }).pipe(Effect.interruptible);
        onAbortWake = () => offerSchedulerTrigger({
            type: "external-event",
            source: "abort",
        });
        runAbortController.signal.addEventListener("abort", onAbortWake);
        armHotReloadWakeup = () => {
            if (!hotController || hotWaitInFlight) {
                return;
            }
            hotWaitInFlight = true;
            void hotController
                .wait()
                .then((files) => {
                hotPendingFiles = files;
                offerSchedulerTrigger({
                    type: "external-event",
                    source: "hot-reload",
                });
            })
                .catch(() => undefined)
                .finally(() => {
                hotWaitInFlight = false;
            });
        };
        if (opts.resume) {
            const nodes = await Effect.runPromise(adapter.listNodes(runId));
            const maxIteration = nodes.reduce((max, node) => Math.max(max, node.iteration ?? 0), 0);
            defaultIteration = maxIteration;
        }
        const ralphState = buildRalphStateMap(await Effect.runPromise(adapter.listRalph(runId)));
        if (opts.resume && ralphState.size > 0) {
            const maxRalphIteration = [...ralphState.values()].reduce((max, state) => Math.max(max, state.iteration), 0);
            defaultIteration = Math.max(defaultIteration, maxRalphIteration);
        }
        if (hotOpts.enabled && (resolvedWorkflowPath ?? opts.workflowPath)) {
            process.env.SMITHERS_HOT = "1";
            hotController = new HotWorkflowController(resolvedWorkflowPath ?? opts.workflowPath, hotOpts);
            await hotController.init();
            armHotReloadWakeup();
        }
        /**
     * @returns {Promise<SchedulerIterationAction>}
     */
        const runSchedulerIteration = async () => {
            if (runAbortController.signal.aborted) {
                logInfo("run abort observed in scheduler loop", {
                    runId,
                }, "engine:run");
                const hijackError = hijackState.completion
                    ? {
                        code: "RUN_HIJACKED",
                        ...hijackState.completion,
                    }
                    : null;
                await waitForAbortedTasksToSettle();
                await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
                await Effect.runPromise(adapter.updateRun(runId, {
                    status: "cancelled",
                    finishedAtMs: nowMs(),
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                    hijackRequestedAtMs: null,
                    hijackTarget: null,
                    errorJson: hijackError ? JSON.stringify(hijackError) : null,
                }));
                await Effect.runPromise(eventBus.emitEventWithPersist({
                    type: "RunCancelled",
                    runId,
                    timestampMs: nowMs(),
                }));
                await annotateRunSpan({
                    status: "cancelled",
                });
                return {
                    type: "return",
                    result: { runId, status: "cancelled" },
                };
            }
            if (hijackState.request &&
                !hijackState.completion &&
                schedulerTaskKeys.size === 0) {
                const hijackAttempts = await Effect.runPromise(adapter.listAttemptsForRun(runId));
                const target = hijackState.request.target ?? null;
                const candidate = [...hijackAttempts].sort((a, b) => {
                    const aMs = a.startedAtMs ?? 0;
                    const bMs = b.startedAtMs ?? 0;
                    if (aMs !== bMs)
                        return bMs - aMs;
                    return (b.attempt ?? 0) - (a.attempt ?? 0);
                }).find((attempt) => {
                    const meta = parseAttemptMetaJson(attempt.metaJson);
                    const engine = typeof meta.agentEngine === "string" ? meta.agentEngine : null;
                    const continuation = engine ? extractHijackContinuation(meta, engine) : null;
                    if (!engine || !continuation) {
                        return false;
                    }
                    if (target && target !== engine) {
                        return false;
                    }
                    return true;
                });
                if (candidate) {
                    const meta = parseAttemptMetaJson(candidate.metaJson);
                    const continuation = extractHijackContinuation(meta, meta.agentEngine);
                    if (!continuation) {
                        return { type: "continue" };
                    }
                    hijackState.completion = {
                        requestedAtMs: hijackState.request.requestedAtMs,
                        nodeId: candidate.nodeId,
                        iteration: candidate.iteration,
                        attempt: candidate.attempt,
                        engine: meta.agentEngine,
                        mode: continuation.mode,
                        resume: continuation.mode === "native-cli" ? continuation.resume : undefined,
                        messages: continuation.mode === "conversation"
                            ? (cloneJsonValue(continuation.messages) ?? continuation.messages)
                            : undefined,
                        cwd: candidate.jjCwd ?? rootDir,
                    };
                    await Effect.runPromise(eventBus.emitEventWithPersist({
                        type: "RunHijacked",
                        runId,
                        nodeId: hijackState.completion.nodeId,
                        iteration: hijackState.completion.iteration,
                        attempt: hijackState.completion.attempt,
                        engine: hijackState.completion.engine,
                        mode: hijackState.completion.mode,
                        resume: hijackState.completion.resume ?? null,
                        cwd: hijackState.completion.cwd,
                        timestampMs: nowMs(),
                    }));
                    runAbortController.abort();
                    return { type: "continue" };
                }
            }
            // Process pending hot reload
            if (hotController && hotPendingFiles) {
                const result = await hotController.reload(hotPendingFiles);
                hotPendingFiles = null;
                switch (result.type) {
                    case "reloaded":
                        workflowRef = { ...workflowRef, build: result.newBuild };
                        await Effect.runPromise(eventBus.emitEventWithPersist({
                            type: "WorkflowReloaded",
                            runId,
                            generation: result.generation,
                            changedFiles: result.changedFiles,
                            timestampMs: nowMs(),
                        }));
                        logInfo("workflow hot reloaded", {
                            runId,
                            generation: result.generation,
                            changedFileCount: result.changedFiles.length,
                        }, "engine:hot");
                        opts.onProgress?.({
                            type: "WorkflowReloaded",
                            runId,
                            generation: result.generation,
                            changedFiles: result.changedFiles,
                            timestampMs: nowMs(),
                        });
                        break;
                    case "failed":
                        await Effect.runPromise(eventBus.emitEventWithPersist({
                            type: "WorkflowReloadFailed",
                            runId,
                            error: result.error instanceof Error ? result.error.message : String(result.error),
                            changedFiles: result.changedFiles,
                            timestampMs: nowMs(),
                        }));
                        logWarning("workflow hot reload failed", {
                            runId,
                            generation: result.generation,
                            changedFileCount: result.changedFiles.length,
                            error: result.error instanceof Error
                                ? result.error.message
                                : String(result.error),
                        }, "engine:hot");
                        opts.onProgress?.({
                            type: "WorkflowReloadFailed",
                            runId,
                            error: result.error instanceof Error ? result.error.message : String(result.error),
                            changedFiles: result.changedFiles,
                            timestampMs: nowMs(),
                        });
                        break;
                    case "unsafe":
                        await Effect.runPromise(eventBus.emitEventWithPersist({
                            type: "WorkflowReloadUnsafe",
                            runId,
                            reason: result.reason,
                            changedFiles: result.changedFiles,
                            timestampMs: nowMs(),
                        }));
                        logWarning("workflow hot reload marked unsafe", {
                            runId,
                            generation: result.generation,
                            changedFileCount: result.changedFiles.length,
                            reason: result.reason,
                        }, "engine:hot");
                        opts.onProgress?.({
                            type: "WorkflowReloadUnsafe",
                            runId,
                            reason: result.reason,
                            changedFiles: result.changedFiles,
                            timestampMs: nowMs(),
                        });
                        break;
                }
            }
            const inputRow = await loadInput(db, inputTable, runId);
            const outputs = await loadOutputs(db, schema, runId);
            const ralphIterations = ralphIterationsFromState(ralphState);
            const cliAgentToolsDefault = runConfig.cliAgentToolsDefault === "all" ||
                runConfig.cliAgentToolsDefault === "explicit-only"
                ? runConfig.cliAgentToolsDefault
                : undefined;
            const ctx = new SmithersCtx({
                runId,
                iteration: defaultIteration,
                iterations: ralphIterationsObject(ralphState),
                input: inputRow,
                auth: runAuth,
                outputs,
                zodToKeyName: workflow.zodToKeyName,
                runtimeConfig: cliAgentToolsDefault
                    ? {
                        cliAgentToolsDefault,
                    }
                    : undefined,
            });
            const renderedGraph = await withWorkflowVersioningRuntime(workflowVersioning, () => renderer.render(workflowRef.build(ctx), {
                ralphIterations,
                defaultIteration,
                baseRootDir: rootDir,
                workflowPath: resolvedWorkflowPath,
            }));
            const { xml, mountedTaskIds } = renderedGraph;
            const tasks = renderedGraph.tasks;
            await workflowVersioning.flush();
            const sessionGraphDecision = await runWorkflowSessionShadow("submitGraph", () => workflowSessionShadow.submitGraph({
                xml,
                tasks,
                mountedTaskIds,
            }), {
                frameNo: frameNo + 1,
                taskCount: tasks.length,
            });
            const xmlJson = canonicalizeXml(xml);
            const xmlHash = sha256Hex(xmlJson);
            // Resolve output tasks: ZodObject references via zodToKeyName, string keys via schemaRegistry
            resolveTaskOutputs(tasks, workflow);
            attachSubflowComputeFns(tasks, workflow, {
                rootDir,
                workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
            });
            const workflowName = getWorkflowNameFromXml(xml);
            updateCurrentCorrelationContext({ workflowName });
            const cacheEnabled = workflow.opts.cache ??
                Boolean(xml &&
                    xml.kind === "element" &&
                    (xml.props.cache === "true" || xml.props.cache === "1"));
            await Effect.runPromise(adapter.updateRun(runId, { workflowName }));
            await annotateRunSpan({
                workflowName,
            });
            frameNo += 1;
            const frameCreatedAtMs = nowMs();
            const frameRow = {
                runId,
                frameNo,
                createdAtMs: frameCreatedAtMs,
                xmlJson,
                xmlHash,
                mountedTaskIdsJson: JSON.stringify(mountedTaskIds),
                taskIndexJson: JSON.stringify(tasks.map((t) => ({
                    nodeId: t.nodeId,
                    ordinal: t.ordinal,
                    iteration: t.iteration,
                }))),
                note: null,
            };
            const snapNodes = await Effect.runPromise(adapter.listNodes(runId));
            const snapRalph = await Effect.runPromise(adapter.listRalph(runId));
            const snapInputRow = await loadInput(db, inputTable, runId);
            const snapOutputs = await loadOutputs(db, schema, runId);
            const snapshotData = {
                nodes: snapNodes.map((n) => ({
                    nodeId: n.nodeId,
                    iteration: n.iteration ?? 0,
                    state: n.state,
                    lastAttempt: n.lastAttempt ?? null,
                    outputTable: n.outputTable ?? "",
                    label: n.label ?? null,
                })),
                outputs: snapOutputs,
                ralph: snapRalph.map((r) => ({
                    ralphId: r.ralphId,
                    iteration: r.iteration ?? 0,
                    done: Boolean(r.done),
                })),
                input: snapInputRow ?? {},
                vcsPointer: runMetadata?.vcsRevision ?? null,
                workflowHash: workflowRef.opts.workflowHash ?? null,
            };
            // --- Time Travel: atomically commit frame + snapshot ---
            try {
                const snap = await adapter.withTransaction("frame-commit", Effect.gen(function* () {
                    yield* adapter.insertFrame(frameRow);
                    return yield* captureSnapshotEffect(adapter, runId, frameNo, snapshotData);
                }));
                const frameCommittedAtMs = nowMs();
                await Effect.runPromise(eventBus.emitEventWithPersist({
                    type: "FrameCommitted",
                    runId,
                    frameNo,
                    xmlHash,
                    timestampMs: frameCommittedAtMs,
                }));
                await Effect.runPromise(eventBus.emitEventWithPersist({
                    type: "SnapshotCaptured",
                    runId,
                    frameNo,
                    contentHash: snap.contentHash,
                    timestampMs: frameCommittedAtMs,
                }));
            }
            catch (snapErr) {
                // Snapshot capture is best-effort — don't fail the run.
                // Frame + snapshot are committed atomically, so on failure both are rolled back.
                logWarning("snapshot capture failed", {
                    runId,
                    frameNo,
                    error: snapErr instanceof Error ? snapErr.message : String(snapErr),
                }, "engine:snapshot");
            }
            const inProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
            const mountedSet = new Set(mountedTaskIds);
            if (!hotOpts.enabled &&
                inProgress.some((a) => !mountedSet.has(`${a.nodeId}::${a.iteration ?? 0}`))) {
                await cancelInProgress(adapter, runId, eventBus);
                return { type: "continue" };
            }
            const { plan, ralphs } = buildPlanTree(xml, ralphState);
            for (const ralph of ralphs) {
                if (!ralphState.has(ralph.id)) {
                    const iteration = 0;
                    ralphState.set(ralph.id, { iteration, done: false });
                    await Effect.runPromise(adapter.insertOrUpdateRalph({
                        runId,
                        ralphId: ralph.id,
                        iteration,
                        done: false,
                        updatedAtMs: nowMs(),
                    }));
                }
            }
            if (ralphs.length === 1) {
                defaultIteration = ralphState.get(ralphs[0].id)?.iteration ?? 0;
            }
            else if (ralphs.length === 0) {
                defaultIteration = 0;
            }
            const singleRalphId = ralphs.length === 1 ? ralphs[0].id : null;
            const ralphDoneMap = buildRalphDoneMap(ralphs, ralphState);
            const { stateMap, retryWait } = await computeTaskStates(adapter, db, runId, tasks, eventBus, ralphDoneMap);
            const descriptorMap = buildDescriptorMap(tasks);
            const schedule = scheduleTasks(plan, stateMap, descriptorMap, ralphState, retryWait, nowMs());
            compareWorkflowSessionShadow("submitGraph", sessionGraphDecision, summarizeLegacySchedulerDecision(schedule, stateMap, tasks, schedulerTaskKeys), {
                frameNo,
                taskCount: tasks.length,
                schedulerRunnableCount: schedule.runnable.length,
            });
            let dbInProgressCount = 0;
            for (const task of tasks) {
                const state = stateMap.get(buildStateKey(task.nodeId, task.iteration));
                if (state === "in-progress") {
                    dbInProgressCount += 1;
                }
            }
            const localCapacity = Math.max(0, maxConcurrency - Math.max(dbInProgressCount, schedulerTaskKeys.size));
            const runnable = applyConcurrencyLimits(schedule.runnable, stateMap, maxConcurrency, tasks)
                .filter((task) => !schedulerTaskKeys.has(makeSchedulerTaskKey(task)))
                .slice(0, localCapacity);
            void Effect.runPromise(Metric.set(schedulerQueueDepth, schedule.runnable.length - runnable.length));
            if (runnable.length === 0) {
                if (schedulerTaskKeys.size > 0) {
                    return { type: "await-trigger" };
                }
                // Detect orphaned in-progress tasks: tasks the DB thinks are running
                // but have no corresponding inflight promise (process died).
                // Cancel their attempts and reset to pending so they can be retried.
                const orphanedInProgress = [];
                for (const task of tasks) {
                    const state = stateMap.get(buildStateKey(task.nodeId, task.iteration));
                    if (state === "in-progress") {
                        orphanedInProgress.push(task);
                    }
                }
                if (orphanedInProgress.length > 0) {
                    const now = nowMs();
                    for (const task of orphanedInProgress) {
                        const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
                        await adapter.withTransaction("recover-orphaned-task", Effect.gen(function* () {
                            for (const attempt of attempts) {
                                if (attempt.state === "in-progress") {
                                    yield* adapter.updateAttempt(runId, task.nodeId, task.iteration, attempt.attempt, {
                                        state: "cancelled",
                                        finishedAtMs: now,
                                    });
                                }
                            }
                            yield* adapter.insertNode({
                                runId,
                                nodeId: task.nodeId,
                                iteration: task.iteration,
                                state: "pending",
                                lastAttempt: null,
                                updatedAtMs: now,
                                outputTable: task.outputTableName,
                                label: task.label ?? null,
                            });
                        }));
                        logWarning("recovered orphaned in-progress task", {
                            runId,
                            nodeId: task.nodeId,
                            iteration: task.iteration,
                        }, "engine:run");
                    }
                    return { type: "continue" };
                }
                if (schedule.waitingApprovalExists) {
                    await Effect.runPromise(adapter.updateRun(runId, {
                        status: "waiting-approval",
                        heartbeatAtMs: null,
                        runtimeOwnerId: null,
                        cancelRequestedAtMs: null,
                        hijackRequestedAtMs: null,
                        hijackTarget: null,
                    }));
                    await Effect.runPromise(eventBus.emitEventWithPersist({
                        type: "RunStatusChanged",
                        runId,
                        status: "waiting-approval",
                        timestampMs: nowMs(),
                    }));
                    await annotateRunSpan({
                        status: "waiting-approval",
                        waitReason: "approval",
                    });
                    return {
                        type: "return",
                        result: { runId, status: "waiting-approval" },
                    };
                }
                if (schedule.waitingEventExists) {
                    await Effect.runPromise(adapter.updateRun(runId, {
                        status: "waiting-event",
                        heartbeatAtMs: null,
                        runtimeOwnerId: null,
                        cancelRequestedAtMs: null,
                        hijackRequestedAtMs: null,
                        hijackTarget: null,
                    }));
                    await Effect.runPromise(eventBus.emitEventWithPersist({
                        type: "RunStatusChanged",
                        runId,
                        status: "waiting-event",
                        timestampMs: nowMs(),
                    }));
                    await annotateRunSpan({
                        status: "waiting-event",
                        waitReason: "event",
                    });
                    return {
                        type: "return",
                        result: { runId, status: "waiting-event" },
                    };
                }
                if (schedule.waitingTimerExists) {
                    await Effect.runPromise(adapter.updateRun(runId, {
                        status: "waiting-timer",
                        heartbeatAtMs: null,
                        runtimeOwnerId: null,
                        cancelRequestedAtMs: null,
                        hijackRequestedAtMs: null,
                        hijackTarget: null,
                    }));
                    await Effect.runPromise(eventBus.emitEventWithPersist({
                        type: "RunStatusChanged",
                        runId,
                        status: "waiting-timer",
                        timestampMs: nowMs(),
                    }));
                    await annotateRunSpan({
                        status: "waiting-timer",
                        waitReason: "timer",
                    });
                    return {
                        type: "return",
                        result: { runId, status: "waiting-timer" },
                    };
                }
                if (schedule.fatalError) {
                    logError("workflow failed due to control-flow boundary", {
                        runId,
                        error: schedule.fatalError,
                    }, "engine:run");
                    await cancelPendingTimers(adapter, runId, eventBus, "run-failed");
                    await Effect.runPromise(adapter.updateRun(runId, {
                        status: "failed",
                        finishedAtMs: nowMs(),
                        heartbeatAtMs: null,
                        runtimeOwnerId: null,
                        cancelRequestedAtMs: null,
                        hijackRequestedAtMs: null,
                        hijackTarget: null,
                    }));
                    await Effect.runPromise(eventBus.emitEventWithPersist({
                        type: "RunFailed",
                        runId,
                        error: schedule.fatalError,
                        timestampMs: nowMs(),
                    }));
                    await annotateRunSpan({
                        status: "failed",
                    });
                    return {
                        type: "return",
                        result: { runId, status: "failed", error: schedule.fatalError },
                    };
                }
                const failedTasks = tasks.filter((t) => {
                    const state = stateMap.get(buildStateKey(t.nodeId, t.iteration));
                    return state === "failed" && !t.continueOnFail;
                });
                if (failedTasks.length > 0) {
                    const failedIds = failedTasks.map((t) => t.nodeId);
                    const errorMsg = `Task(s) failed: ${failedIds.join(", ")}`;
                    logError("workflow failed due to task failures", {
                        runId,
                        failedTaskIds: failedIds.join(","),
                    }, "engine:run");
                    await cancelPendingTimers(adapter, runId, eventBus, "run-failed");
                    await Effect.runPromise(adapter.updateRun(runId, {
                        status: "failed",
                        finishedAtMs: nowMs(),
                        heartbeatAtMs: null,
                        runtimeOwnerId: null,
                        cancelRequestedAtMs: null,
                        hijackRequestedAtMs: null,
                        hijackTarget: null,
                    }));
                    await Effect.runPromise(eventBus.emitEventWithPersist({
                        type: "RunFailed",
                        runId,
                        error: errorMsg,
                        timestampMs: nowMs(),
                    }));
                    await annotateRunSpan({
                        status: "failed",
                    });
                    return {
                        type: "return",
                        result: { runId, status: "failed", error: errorMsg },
                    };
                }
                if (schedule.continuation) {
                    let statePayload = undefined;
                    if (schedule.continuation.stateJson) {
                        try {
                            statePayload = JSON.parse(schedule.continuation.stateJson);
                        }
                        catch (error) {
                            throw new SmithersError("INVALID_CONTINUATION_STATE", "Invalid JSON passed to continue-as-new state", {
                                stateJson: schedule.continuation.stateJson,
                                error: error instanceof Error ? error.message : String(error),
                            });
                        }
                    }
                    if (runAbortController.signal.aborted) {
                        return { type: "continue" };
                    }
                    const latestRun = await Effect.runPromise(adapter.getRun(runId));
                    if (latestRun?.cancelRequestedAtMs) {
                        runAbortController.abort();
                        return { type: "continue" };
                    }
                    const continuationIteration = defaultIteration;
                    let transition;
                    try {
                        transition = await Effect.runPromise(Effect.tryPromise({
                            try: () => continueRunAsNew({
                                db,
                                adapter,
                                schema,
                                inputTable,
                                runId,
                                workflowPath: resolvedWorkflowPath ??
                                    opts.workflowPath ??
                                    latestRun?.workflowPath ??
                                    null,
                                runMetadata,
                                currentFrameNo: frameNo,
                                continuation: {
                                    reason: "explicit",
                                    iteration: continuationIteration,
                                    statePayload,
                                },
                                ralphState,
                            }),
                            catch: (cause) => toSmithersError(cause, "continue-as-new explicit transition"),
                        }).pipe(Effect.annotateLogs({
                            runId,
                            iteration: continuationIteration,
                        }), Effect.withLogSpan("engine:continue-as-new")));
                    }
                    catch (error) {
                        if (error?.code === "RUN_CANCELLED") {
                            runAbortController.abort();
                            return { type: "continue" };
                        }
                        throw error;
                    }
                    const continuationEvent = {
                        type: "RunContinuedAsNew",
                        runId,
                        newRunId: transition.newRunId,
                        iteration: continuationIteration,
                        carriedStateSize: transition.carriedStateBytes,
                        ancestryDepth: transition.ancestryDepth,
                        timestampMs: nowMs(),
                    };
                    eventBus.emit("event", continuationEvent);
                    Effect.runSync(trackEvent(continuationEvent));
                    logInfo(`Continuing run ${runId} as ${transition.newRunId} at iteration ${continuationIteration}`, {
                        runId,
                        newRunId: transition.newRunId,
                        iteration: continuationIteration,
                        carriedStateBytes: transition.carriedStateBytes,
                    }, "engine:continue-as-new");
                    void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
                    await annotateRunSpan({
                        status: "continued",
                    });
                    return {
                        type: "return",
                        result: {
                            runId,
                            status: "continued",
                            nextRunId: transition.newRunId,
                        },
                    };
                }
                if (schedule.pendingExists) {
                    const waitMs = schedule.nextRetryAtMs != null
                        ? Math.max(0, schedule.nextRetryAtMs - nowMs())
                        : 100;
                    if (waitMs > 0) {
                        return {
                            type: "schedule-retry",
                            waitMs,
                        };
                    }
                    return { type: "continue" };
                }
                if (schedule.readyRalphs.length > 0) {
                    // Re-evaluate each ralph's `until` with the correct per-ralph
                    // iteration context.  The plan tree's `until` was rendered with
                    // `defaultIteration` which may not reflect each ralph's own
                    // iteration (especially with multiple parallel loops).  When
                    // there is a single ralph, `defaultIteration` already tracks
                    // it correctly, so skip the extra work.
                    const freshUntilMap = new Map();
                    if (!singleRalphId) {
                        const freshOutputs = await loadOutputs(db, schema, runId);
                        const evalRenderer = new SmithersRenderer();
                        for (const ralph of schedule.readyRalphs) {
                            const rState = ralphState.get(ralph.id);
                            const ralphIteration = rState?.iteration ?? 0;
                            const perRalphCtx = new SmithersCtx({
                                runId,
                                iteration: ralphIteration,
                                iterations: ralphIterationsObject(ralphState),
                                input: inputRow,
                                auth: runAuth,
                                outputs: freshOutputs,
                                zodToKeyName: workflow.zodToKeyName,
                            });
                            const { xml: freshXml } = await evalRenderer.render(workflowRef.build(perRalphCtx), {
                                ralphIterations: ralphIterationsFromState(ralphState),
                                defaultIteration: ralphIteration,
                                baseRootDir: rootDir,
                                workflowPath: resolvedWorkflowPath,
                            });
                            const { ralphs: freshRalphs } = buildPlanTree(freshXml, ralphState);
                            const freshRalph = freshRalphs.find((r) => r.id === ralph.id);
                            freshUntilMap.set(ralph.id, freshRalph?.until ?? ralph.until);
                        }
                    }
                    for (const ralph of schedule.readyRalphs) {
                        const state = ralphState.get(ralph.id) ?? {
                            iteration: defaultIteration,
                            done: false,
                        };
                        const freshUntil = freshUntilMap.get(ralph.id) ?? ralph.until;
                        if (state.done || freshUntil) {
                            // Fresh re-evaluation says the condition is now met — mark done.
                            if (freshUntil && !state.done) {
                                ralphState.set(ralph.id, { ...state, done: true });
                                await Effect.runPromise(adapter.insertOrUpdateRalph({
                                    runId,
                                    ralphId: ralph.id,
                                    iteration: state.iteration,
                                    done: true,
                                    updatedAtMs: nowMs(),
                                }));
                            }
                            continue;
                        }
                        const continueAsNewEvery = ralph.continueAsNewEvery;
                        const nextIteration = state.iteration + 1;
                        const shouldContinueAsNew = typeof continueAsNewEvery === "number" &&
                            continueAsNewEvery > 0 &&
                            nextIteration % continueAsNewEvery === 0;
                        if (shouldContinueAsNew) {
                            if (continueAsNewEvery === 1) {
                                logWarning("continue-as-new threshold is 1; this can create high handoff overhead", {
                                    runId,
                                    ralphId: ralph.id,
                                    continueAsNewEvery,
                                    iteration: state.iteration,
                                }, "engine:continue-as-new");
                            }
                            if (runAbortController.signal.aborted) {
                                continue;
                            }
                            const latestRun = await Effect.runPromise(adapter.getRun(runId));
                            if (latestRun?.cancelRequestedAtMs) {
                                runAbortController.abort();
                                continue;
                            }
                            const nextRalphState = cloneRalphStateMap(ralphState);
                            nextRalphState.set(ralph.id, {
                                iteration: nextIteration,
                                done: false,
                            });
                            const continuationIteration = state.iteration;
                            let transition;
                            try {
                                transition = await Effect.runPromise(Effect.tryPromise({
                                    try: () => continueRunAsNew({
                                        db,
                                        adapter,
                                        schema,
                                        inputTable,
                                        runId,
                                        workflowPath: resolvedWorkflowPath ??
                                            opts.workflowPath ??
                                            latestRun?.workflowPath ??
                                            null,
                                        runMetadata,
                                        currentFrameNo: frameNo,
                                        continuation: {
                                            reason: "loop-threshold",
                                            iteration: continuationIteration,
                                            loopId: ralph.id,
                                            continueAsNewEvery,
                                            statePayload: {
                                                loopId: ralph.id,
                                                continueAsNewEvery,
                                                nextIteration,
                                            },
                                            nextRalphState,
                                        },
                                        ralphState,
                                    }),
                                    catch: (cause) => toSmithersError(cause, "continue-as-new loop transition"),
                                }).pipe(Effect.annotateLogs({
                                    runId,
                                    ralphId: ralph.id,
                                    iteration: continuationIteration,
                                    continueAsNewEvery,
                                }), Effect.withLogSpan("engine:continue-as-new")));
                            }
                            catch (error) {
                                if (error?.code === "RUN_CANCELLED") {
                                    runAbortController.abort();
                                    continue;
                                }
                                throw error;
                            }
                            const continuationEvent = {
                                type: "RunContinuedAsNew",
                                runId,
                                newRunId: transition.newRunId,
                                iteration: continuationIteration,
                                carriedStateSize: transition.carriedStateBytes,
                                ancestryDepth: transition.ancestryDepth,
                                timestampMs: nowMs(),
                            };
                            eventBus.emit("event", continuationEvent);
                            Effect.runSync(trackEvent(continuationEvent));
                            logInfo(`Continuing run ${runId} as ${transition.newRunId} at iteration ${continuationIteration}`, {
                                runId,
                                newRunId: transition.newRunId,
                                iteration: continuationIteration,
                                carriedStateBytes: transition.carriedStateBytes,
                            }, "engine:continue-as-new");
                            void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
                            await annotateRunSpan({
                                status: "continued",
                            });
                            return {
                                type: "return",
                                result: {
                                    runId,
                                    status: "continued",
                                    nextRunId: transition.newRunId,
                                },
                            };
                        }
                        if (state.iteration + 1 < ralph.maxIterations) {
                            state.iteration += 1;
                            ralphState.set(ralph.id, { ...state, done: false });
                            if (singleRalphId && ralph.id === singleRalphId) {
                                defaultIteration = state.iteration;
                            }
                            await Effect.runPromise(adapter.insertOrUpdateRalph({
                                runId,
                                ralphId: ralph.id,
                                iteration: state.iteration,
                                done: false,
                                updatedAtMs: nowMs(),
                            }));
                            continue;
                        }
                        if (ralph.onMaxReached === "fail") {
                            await Effect.runPromise(adapter.updateRun(runId, {
                                status: "failed",
                                finishedAtMs: nowMs(),
                                heartbeatAtMs: null,
                                runtimeOwnerId: null,
                                cancelRequestedAtMs: null,
                                hijackRequestedAtMs: null,
                                hijackTarget: null,
                                errorJson: JSON.stringify({
                                    code: "RALPH_MAX_REACHED",
                                    ralphId: ralph.id,
                                }),
                            }));
                            await Effect.runPromise(eventBus.emitEventWithPersist({
                                type: "RunFailed",
                                runId,
                                error: { code: "RALPH_MAX_REACHED", ralphId: ralph.id },
                                timestampMs: nowMs(),
                            }));
                            await annotateRunSpan({
                                status: "failed",
                            });
                            return {
                                type: "return",
                                result: {
                                    runId,
                                    status: "failed",
                                    error: { code: "RALPH_MAX_REACHED", ralphId: ralph.id },
                                },
                            };
                        }
                        ralphState.set(ralph.id, { ...state, done: true });
                        await Effect.runPromise(adapter.insertOrUpdateRalph({
                            runId,
                            ralphId: ralph.id,
                            iteration: state.iteration,
                            done: true,
                            updatedAtMs: nowMs(),
                        }));
                    }
                    offerSchedulerTrigger({
                        type: "external-event",
                        source: "render",
                    });
                    return { type: "continue" };
                }
                // Guard against premature completion when conditional children
                // may mount new tasks after sibling outputs change.
                //
                // A workflow is truly finished only when two consecutive renders
                // produce the same mounted task set with nothing pending. If
                // this frame's mounted set differs from the previous frame's,
                // new tasks appeared and we must loop to schedule them.
                {
                    const currentMounted = new Set(mountedTaskIds);
                    const sameAsPrev = currentMounted.size === prevMountedTaskIds.size &&
                        [...currentMounted].every((id) => prevMountedTaskIds.has(id));
                    prevMountedTaskIds = currentMounted;
                    if (!sameAsPrev) {
                        // Mounted task set changed — re-render to pick up new tasks
                        offerSchedulerTrigger({
                            type: "external-event",
                            source: "render",
                        });
                        return { type: "continue" };
                    }
                }
                await Effect.runPromise(adapter.updateRun(runId, {
                    status: "finished",
                    finishedAtMs: nowMs(),
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                    hijackRequestedAtMs: null,
                    hijackTarget: null,
                }));
                await Effect.runPromise(eventBus.emitEventWithPersist({
                    type: "RunFinished",
                    runId,
                    timestampMs: nowMs(),
                }));
                void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
                logInfo("workflow run finished", {
                    runId,
                }, "engine:run");
                await annotateRunSpan({
                    status: "finished",
                });
                const outputTable = schema.output;
                let output = undefined;
                if (outputTable) {
                    const cols = getTableColumns(outputTable);
                    const runIdCol = cols.runId;
                    if (runIdCol) {
                        const rows = await db
                            .select()
                            .from(outputTable)
                            .where(eq(runIdCol, runId));
                        output = rows;
                    }
                    else {
                        output = await db.select().from(outputTable);
                    }
                }
                return {
                    type: "return",
                    result: { runId, status: "finished", output },
                };
            }
            return {
                type: "dispatch",
                runnable,
                descriptorMap,
                workflowName,
                cacheEnabled,
            };
        };
        const schedulerLoopEffect = Effect.scoped(Effect.gen(function* () {
            yield* Effect.forkScoped(watchExternalSchedulerEventsEffect);
            offerSchedulerTrigger({ type: "initial" });
            while (true) {
                const triggerBatch = yield* takeSchedulerTriggerBatchEffect;
                if (triggerBatch.length > 1) {
                    yield* Effect.sync(() => {
                        logDebug("scheduler trigger batch coalesced", {
                            runId,
                            triggerCount: triggerBatch.length,
                        }, "engine:run");
                    });
                }
                yield* clearRetryWakeEffect();
                if (schedulerTaskError) {
                    const error = schedulerTaskError;
                    schedulerTaskError = null;
                    throw error;
                }
                const action = yield* Effect.tryPromise({
                    try: () => runSchedulerIteration(),
                    catch: (cause) => toSmithersError(cause, "run scheduler iteration"),
                });
                if (action.type === "return") {
                    return action.result;
                }
                if (action.type === "continue") {
                    continue;
                }
                if (action.type === "schedule-retry") {
                    yield* scheduleRetryWakeEffect(action.waitMs);
                    armHotReloadWakeup();
                    continue;
                }
                if (action.type === "await-trigger") {
                    armHotReloadWakeup();
                    continue;
                }
                const batchKeys = action.runnable.map((task) => makeSchedulerTaskKey(task));
                yield* Effect.sync(() => {
                    for (const taskKey of batchKeys) {
                        schedulerTaskKeys.add(taskKey);
                    }
                });
                yield* Effect.forkScoped(Effect.all(action.runnable.map((task) => withCorrelationContext(withSmithersSpan(smithersSpanNames.task, executeTaskBridgeEffect(adapter, db, runId, task, action.descriptorMap, inputTable, eventBus, toolConfig, action.workflowName, action.cacheEnabled, runAbortController.signal, disabledAgents, runAbortController, hijackState, legacyExecuteTask).pipe(Effect.tap(() => Effect.tryPromise({
                    try: () => notifyWorkflowSessionTaskSettled(task),
                    catch: (cause) => toSmithersError(cause, "workflow session shadow task settled"),
                }))), {
                    runId,
                    workflowName: action.workflowName,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                    nodeLabel: task.label ?? null,
                    status: "running",
                }), {
                    workflowName: action.workflowName,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                }).pipe(Effect.catchAll((error) => Effect.gen(function* () {
                    yield* Effect.tryPromise({
                        try: () => notifyWorkflowSessionTaskSettled(task, error),
                        catch: (cause) => toSmithersError(cause, "workflow session shadow task failed"),
                    });
                    if (schedulerTaskError == null) {
                        schedulerTaskError = error;
                    }
                })), Effect.ensuring(Effect.sync(() => {
                    schedulerTaskKeys.delete(makeSchedulerTaskKey(task));
                    offerSchedulerTrigger({
                        type: "task-completed",
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                    });
                })))), {
                    concurrency: schedulerExecutionConcurrency,
                    discard: true,
                }).pipe(Effect.ensuring(Effect.sync(() => {
                    for (const taskKey of batchKeys) {
                        schedulerTaskKeys.delete(taskKey);
                    }
                }))));
                armHotReloadWakeup();
            }
        }).pipe(Effect.interruptible));
        return await Effect.runPromise(schedulerLoopEffect);
    }
    catch (err) {
        if (runAbortController.signal.aborted || isAbortError(err)) {
            logInfo("workflow run cancelled while handling error", {
                runId,
                error: err instanceof Error ? err.message : String(err),
            }, "engine:run");
            const hijackError = hijackState.completion
                ? {
                    code: "RUN_HIJACKED",
                    ...hijackState.completion,
                }
                : errorToJson(err);
            await waitForAbortedTasksToSettle();
            await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "cancelled",
                finishedAtMs: nowMs(),
                heartbeatAtMs: null,
                runtimeOwnerId: null,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                errorJson: JSON.stringify(hijackError),
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "RunCancelled",
                runId,
                timestampMs: nowMs(),
            }));
            await annotateRunSpan({
                status: "cancelled",
            });
            return { runId, status: "cancelled" };
        }
        logError("workflow run failed with unhandled error", {
            runId,
            error: err instanceof Error ? err.message : String(err),
        }, "engine:run");
        const errorInfo = errorToJson(err);
        if (runOwnedByCurrentProcess) {
            await cancelPendingTimers(adapter, runId, eventBus, "run-failed");
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "failed",
                finishedAtMs: nowMs(),
                heartbeatAtMs: null,
                runtimeOwnerId: null,
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                errorJson: JSON.stringify(errorInfo),
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "RunFailed",
                runId,
                error: errorInfo,
                timestampMs: nowMs(),
            }));
        }
        await annotateRunSpan({
            status: "failed",
        });
        return { runId, status: "failed", error: errorInfo };
    }
    finally {
        alertRuntime?.stop();
        await stopSupervisor();
        detachAbort();
        runAbortController.signal.removeEventListener("abort", onAbortWake);
        await hotController?.close();
        wakeLock.release();
    }
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Effect.Effect<RunResult, SmithersError>}
 */
export function runWorkflow(workflow, opts) {
    const runId = opts.runId ?? crypto.randomUUID();
    return withSmithersSpan(smithersSpanNames.run, Effect.tryPromise({
        try: () => runWorkflowAsync(workflow, {
            ...opts,
            runId,
        }),
        catch: (cause) => toSmithersError(cause, "run workflow"),
    }), {
        runId,
        status: "running",
        workflowPath: opts.workflowPath ?? "",
        maxConcurrency: opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        hot: Boolean(opts.hot),
        resume: Boolean(opts.resume),
    }, {
        root: true,
    });
}
