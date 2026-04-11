import type { SmithersWorkflow } from "@smithers/react/SmithersWorkflow";
import type { RunOptions } from "@smithers/driver/RunOptions";
import type { RunResult } from "@smithers/driver/RunResult";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { GraphSnapshot } from "@smithers/graph/GraphSnapshot";
import type { RunAuthContext } from "@smithers/driver/RunAuthContext";
import type { AgentCliEvent } from "@smithers/agents/BaseCliAgent";
import {
  makeWorkflowSession,
  type EngineDecision,
  type WaitReason,
} from "@smithers/scheduler";
import { ReactWorkflowDriver } from "@smithers/react/driver";
import type { WorkflowGraph } from "@smithers/graph/types";
import { SmithersRenderer } from "@smithers/react-reconciler/dom/renderer";
import { buildContext } from "@smithers/driver/buildContext";
import { loadInput, loadOutputs } from "@smithers/db/snapshot";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import {
  selectOutputRow,
  validateOutput,
  validateExistingOutput,
  getAgentOutputSchema,
  describeSchemaShape,
  buildOutputRow,
  stripAutoColumns,
} from "@smithers/db/output";
import { validateInput } from "@smithers/db/input";
import { schemaSignature } from "@smithers/db/schema-signature";
import { withSqliteWriteRetry } from "@smithers/db/write-retry";
import { canonicalizeXml } from "@smithers/graph/utils/xml";
import { sha256Hex } from "@smithers/driver/sha256Hex";
import { nowMs } from "@smithers/scheduler/nowMs";
import { newRunId } from "@smithers/driver/newRunId";
import { errorToJson } from "@smithers/errors/errorToJson";
import { SmithersError } from "@smithers/errors/SmithersError";
import {
  assertJsonPayloadWithinBounds,
  assertOptionalStringMaxLength,
  assertPositiveFiniteInteger,
} from "@smithers/db/input-bounds";
import { retryPolicyToSchedule } from "@smithers/scheduler/retryPolicyToSchedule";
import { retryScheduleDelayMs } from "@smithers/scheduler/retryScheduleDelayMs";
import {
  buildPlanTree,
  scheduleTasks,
  buildStateKey,
  type TaskState,
  type TaskStateMap,
  type RalphStateMap,
} from "./scheduler";
import { runWithToolContext } from "@smithers/tools/context";
import { getDefinedToolMetadata } from "@smithers/tools/defineTool";
import {
  captureSnapshotEffect,
  loadLatestSnapshot,
  parseSnapshot,
} from "@smithers/time-travel/snapshot";
import { EventBus } from "./events";
import { getJjPointer } from "@smithers/vcs/jj";
import { findVcsRoot } from "@smithers/vcs/find-root";
import { z } from "zod";
import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Chunk, Duration, Effect, Fiber, Metric, Queue, Schedule } from "effect";
import {
  attemptDuration,
  cacheHits,
  cacheMisses,
  nodeDuration,
  promptSizeBytes,
  responseSizeBytes,
  runDuration,
  runsResumedTotal,
  schedulerConcurrencyUtilization,
  schedulerQueueDepth,
  schedulerWaitDuration,
  trackEvent,
} from "@smithers/observability/metrics";
import { runScorersAsync } from "@smithers/scorers/run-scorers";
import type { ScorersMap as RuntimeScorersMap } from "@smithers/scorers/types";
import { dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fromPromise } from "@smithers/driver/interop";
import { logDebug, logError, logInfo, logWarning } from "@smithers/observability/logging";
import { isPidAlive, parseRuntimeOwnerPid } from "./runtime-owner";
import { HotWorkflowController } from "./hot";
import type { HotReloadOptions } from "@smithers/driver/RunOptions";
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import {
  annotateSmithersTrace,
  smithersSpanNames,
  withSmithersSpan,
} from "@smithers/observability";
import { withTaskRuntime } from "@smithers/driver/task-runtime";
import { hashCapabilityRegistry } from "@smithers/agents/capability-registry";
import {
  cancelPendingTimersBridge,
  executeTaskBridgeEffect,
  isBridgeManagedTimerTask as isTimerTask,
  resolveDeferredTaskStateBridge,
} from "./effect/workflow-bridge";
import { AlertRuntime } from "./alert-runtime";
import { executeChildWorkflow } from "./child-workflow";
import { runWorkflowWithMakeBridge } from "./effect/workflow-make-bridge";
import {
  createWorkflowVersioningRuntime,
  getWorkflowPatchDecisions,
  withWorkflowVersioningRuntime,
} from "./effect/versioning";
import {
  runWithCorrelationContext,
  updateCurrentCorrelationContext,
  withCorrelationContext,
} from "@smithers/observability/correlation";

/**
 * Track which worktree paths have already been created this run so we don't
 * re-create them for every task sharing the same worktree.
 */
const createdWorktrees = new Set<string>();
const gitBinary = typeof Bun !== "undefined" ? Bun.which("git") : null;
const caffeinateBinary =
  typeof Bun !== "undefined" ? Bun.which("caffeinate") : null;

export const RUN_WORKFLOW_RUN_ID_MAX_LENGTH = 256;
export const RUN_WORKFLOW_WORKFLOW_PATH_MAX_LENGTH = 4096;
export const RUN_WORKFLOW_INPUT_MAX_BYTES = 1024 * 1024;
export const RUN_WORKFLOW_INPUT_MAX_DEPTH = 32;
export const RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH = 512;
export const RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH = 64 * 1024;

type AgentCliActionKind = Extract<AgentCliEvent, { type: "action" }>["action"]["kind"];

function isBlockingAgentActionKind(kind: AgentCliActionKind): boolean {
  return (
    kind === "command" ||
    kind === "tool" ||
    kind === "file_change" ||
    kind === "web_search"
  );
}

function makeAbortError(message = "Task aborted"): SmithersError {
  return new SmithersError("TASK_ABORTED", message, undefined, {
    name: "AbortError",
  });
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if ((err as any).name === "AbortError") return true;
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  ) {
    return true;
  }
  if (err instanceof Error) {
    return /aborted|abort/i.test(err.message);
  }
  return false;
}

function abortPromise(signal?: AbortSignal): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(makeAbortError()), {
      once: true,
    });
  });
}

type HijackCompletion = {
  requestedAtMs: number;
  nodeId: string;
  iteration: number;
  attempt: number;
  engine: string;
  mode: "native-cli" | "conversation";
  resume?: string;
  messages?: unknown[];
  cwd: string;
};

export type HijackState = {
  request: { requestedAtMs: number; target?: string | null } | null;
  completion: HijackCompletion | null;
};

function parseAttemptMetaJson(metaJson?: string | null): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asConversationMessages(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function cloneJsonValue<T>(value: T): T | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined;
  }
}

function parseAttemptHeartbeatData(
  heartbeatDataJson?: string | null,
): unknown | null {
  if (typeof heartbeatDataJson !== "string" || heartbeatDataJson.length === 0) {
    return null;
  }
  try {
    return JSON.parse(heartbeatDataJson);
  } catch {
    return null;
  }
}

function validateHeartbeatValue(
  value: unknown,
  path: string,
  seen: Set<unknown>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SmithersError(
        "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
        `Heartbeat payload must contain only finite numbers (invalid at ${path}).`,
        { path, value },
      );
    }
    return;
  }
  if (value === undefined) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload cannot include undefined values (invalid at ${path}).`,
      { path },
    );
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload contains a non-JSON value (invalid at ${path}).`,
      { path, valueType: typeof value },
    );
  }
  if (typeof value !== "object") {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload contains an unsupported value at ${path}.`,
      { path },
    );
  }
  if (seen.has(value)) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload cannot contain circular references.",
      { path },
    );
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
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(value instanceof Date)
  ) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload must contain plain JSON objects.",
      { path },
    );
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    validateHeartbeatValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function serializeHeartbeatPayload(data: unknown): {
  heartbeatDataJson: string;
  dataSizeBytes: number;
} {
  validateHeartbeatValue(data, "$", new Set());
  const heartbeatDataJson = JSON.stringify(data);
  const dataSizeBytes = Buffer.byteLength(heartbeatDataJson, "utf8");
  if (dataSizeBytes > TASK_HEARTBEAT_MAX_PAYLOAD_BYTES) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_TOO_LARGE",
      `Heartbeat payload exceeds ${TASK_HEARTBEAT_MAX_PAYLOAD_BYTES} bytes.`,
      {
        dataSizeBytes,
        maxBytes: TASK_HEARTBEAT_MAX_PAYLOAD_BYTES,
      },
    );
  }
  return { heartbeatDataJson, dataSizeBytes };
}

function heartbeatTimeoutReasonFromAbort(
  signal: AbortSignal | undefined,
  err: unknown,
): SmithersError | null {
  const reason = signal?.aborted ? (signal as any).reason : undefined;
  const candidate = reason ?? err;
  if (
    candidate instanceof SmithersError &&
    candidate.code === "TASK_HEARTBEAT_TIMEOUT"
  ) {
    return candidate;
  }
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as any).code === "TASK_HEARTBEAT_TIMEOUT"
  ) {
    return new SmithersError(
      "TASK_HEARTBEAT_TIMEOUT",
      String((candidate as any).message ?? "Task heartbeat timed out."),
      (candidate as any).details as Record<string, unknown> | undefined,
      { cause: candidate },
    );
  }
  return null;
}

function isHeartbeatPayloadValidationError(err: unknown): boolean {
  if (err instanceof SmithersError) {
    return (
      err.code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" ||
      err.code === "HEARTBEAT_PAYLOAD_TOO_LARGE"
    );
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as any).code;
  return (
    code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" ||
    code === "HEARTBEAT_PAYLOAD_TOO_LARGE"
  );
}

function extractHijackContinuation(
  meta: Record<string, unknown>,
  engine: string,
): { mode: "native-cli"; resume: string } | { mode: "conversation"; messages: unknown[] } | null {
  const handoff = meta.hijackHandoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    const handoffEngine = typeof (handoff as any).engine === "string" ? (handoff as any).engine : undefined;
    const handoffMode = (handoff as any).mode === "conversation" ? "conversation" : "native-cli";
    if (handoffEngine === engine) {
      if (handoffMode === "native-cli") {
        const handoffResume = typeof (handoff as any).resume === "string" ? (handoff as any).resume : undefined;
        if (handoffResume) {
          return { mode: "native-cli", resume: handoffResume };
        }
      }
      const handoffMessages = asConversationMessages((handoff as any).messages);
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

function findHijackContinuation(
  attempts: Array<{ metaJson?: string | null }>,
  engine: string,
): { mode: "native-cli"; resume: string } | { mode: "conversation"; messages: unknown[] } | undefined {
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

type ToolResumeWarning = {
  toolName: string;
  attempt: number;
  seq: number;
  status: string;
};

function collectDefinedToolMetadata(agents: any[]): Map<string, ReturnType<typeof getDefinedToolMetadata>> {
  const metadataByName = new Map<string, ReturnType<typeof getDefinedToolMetadata>>();
  for (const agent of agents) {
    const tools =
      agent && typeof agent === "object" && (agent as any).tools && typeof (agent as any).tools === "object"
        ? Object.entries((agent as any).tools as Record<string, unknown>)
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

function collectToolResumeWarnings(
  toolCalls: Array<{ toolName?: string; attempt?: number; seq?: number; status?: string }>,
  agents: any[],
  currentAttempt: number,
): ToolResumeWarning[] {
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

function buildToolResumeWarningMessage(warnings: ToolResumeWarning[]): string | null {
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
    ...shownWarnings.map(
      (warning) =>
        `- ${warning.toolName} (attempt ${warning.attempt}, seq ${warning.seq}, status ${warning.status})`,
    ),
  ];
  if (warnings.length > shownWarnings.length) {
    lines.push(`- ...and ${warnings.length - shownWarnings.length} more`);
  }
  return lines.join("\n");
}

function hasToolResumeWarningMessage(messages: unknown[] | undefined): boolean {
  return Array.isArray(messages)
    && messages.some((message) => {
      try {
        return JSON.stringify(message).includes(TOOL_RESUME_WARNING_MARKER);
      } catch {
        return false;
      }
    });
}

function appendToolResumeWarningMessage(
  messages: unknown[] | undefined,
  warningMessage: string | null,
): unknown[] | undefined {
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

function prependToolResumeWarningMessage(
  prompt: string,
  warningMessage: string | null,
): string {
  if (!warningMessage || prompt.includes(TOOL_RESUME_WARNING_MARKER)) {
    return prompt;
  }
  return `${warningMessage}\n\n${prompt}`;
}

function buildHijackAbortError(completion: HijackCompletion): Error {
  const err = makeAbortError(`Hijack requested for ${completion.engine}`);
  (err as any).code = "RUN_HIJACKED";
  (err as any).hijack = completion;
  return err;
}

async function runGitCommand(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const child = nodeSpawn(gitBinary ?? "git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
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
async function ensureWorktree(
  rootDir: string,
  worktreePath: string,
  branch?: string,
  baseBranch?: string,
): Promise<void> {
  if (existsSync(worktreePath)) {
    // Worktree exists — rebase onto the configured base branch so work starts from tip.
    const vcs = findVcsRoot(rootDir);
    const base = baseBranch || "main";
    if (vcs?.type === "jj") {
      const { runJj } = await import("@smithers/vcs/jj");
      await runJj(["git", "fetch"], { cwd: worktreePath });
      const rebaseRes = await runJj(["rebase", "-d", base], { cwd: worktreePath });
      if (rebaseRes.code !== 0) {
        console.warn(
          `[smithers] worktree sync: jj rebase -d ${base} failed (exit ${rebaseRes.code}): ${rebaseRes.stderr || "unknown error"}`,
        );
      }
    } else if (vcs?.type === "git") {
      await runGitCommand(worktreePath, ["fetch", "origin"]);
      const rebaseRes = await runGitCommand(worktreePath, ["rebase", `origin/${base}`]);
      if (rebaseRes.code !== 0) {
        console.warn(
          `[smithers] worktree sync: git rebase origin/${base} failed (exit ${rebaseRes.code}): ${rebaseRes.stderr || "unknown error"}`,
        );
      }
    }
    createdWorktrees.add(worktreePath);
    return;
  }
  if (createdWorktrees.has(worktreePath)) {
    createdWorktrees.delete(worktreePath);
  }

  // Walk up from rootDir to find the actual VCS root
  const vcs = findVcsRoot(rootDir);
  if (!vcs) {
    throw new SmithersError(
      "VCS_NOT_FOUND",
      `Cannot create worktree: no git or jj repository found from ${rootDir}`,
      { rootDir },
    );
  }

  // Best effort: refresh remote refs for git so origin/main can be used as a
  // base when local main is absent.
  if (vcs.type === "git") {
    await runGitCommand(vcs.root, ["fetch", "origin"]);
  }

  if (vcs.type === "jj") {
    const { workspaceAdd, runJj } = await import("@smithers/vcs/jj");
    const name = worktreePath.split("/").pop() ?? "worktree";
    const wsResult = await workspaceAdd(name, worktreePath, { cwd: vcs.root, atRev: baseBranch });
    if (!wsResult.success) {
      throw new SmithersError(
        "WORKTREE_CREATE_FAILED",
        `Failed to create jj workspace at ${worktreePath}: ${wsResult.error}`,
        { worktreePath, vcsType: "jj" },
      );
    }
    // Create a bookmark pointing at the new workspace's working copy
    if (branch) {
      const setRes = await runJj(["bookmark", "set", branch, "-r", "@", "--allow-backwards"], {
        cwd: worktreePath,
      });
      if (setRes.code !== 0) {
        throw new SmithersError(
          "WORKTREE_CREATE_FAILED",
          `Failed to set jj bookmark ${branch} in ${worktreePath}: ${setRes.stderr || `exit ${setRes.code}`}`,
          { worktreePath, branch, vcsType: "jj" },
        );
      }
    }
  } else {
    const baseRefs = baseBranch
      ? [baseBranch, `origin/${baseBranch}`, "HEAD"] as const
      : ["main", "origin/main", "HEAD"] as const;
    if (branch) {
      // -B force-creates the branch (handles restarts gracefully)
      let created = false;
      const failures: string[] = [];
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
        throw new SmithersError(
          "WORKTREE_CREATE_FAILED",
          `Failed to create git worktree at ${worktreePath} on branch ${branch}. Tried ${baseRefs.join(", ")}. ${failures.join(" | ")}`,
          { worktreePath, branch, vcsType: "git" },
        );
      }
    } else {
      let created = false;
      const failures: string[] = [];
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
        throw new SmithersError(
          "WORKTREE_CREATE_FAILED",
          `Failed to create git worktree at ${worktreePath}. Tried ${baseRefs.join(", ")}. ${failures.join(" | ")}`,
          { worktreePath, vcsType: "git" },
        );
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

type ContinueAsNewReason = "explicit" | "loop-threshold";

type ContinueAsNewRequest = {
  reason: ContinueAsNewReason;
  iteration: number;
  statePayload?: unknown;
  loopId?: string;
  continueAsNewEvery?: number;
  nextRalphState?: RalphStateMap;
};

type ContinueAsNewTransition = {
  newRunId: string;
  ancestryDepth: number;
  carriedStateBytes: number;
};

type RunBodyResult = RunResult | (RunResult & { status: "continued"; nextRunId: string });

type WorkflowSessionShadowDecisionSummary =
  | { tag: "Execute"; tasks: string[] }
  | { tag: "Wait"; reason: string }
  | { tag: "ContinueAsNew"; reason?: string }
  | { tag: "Finished"; status: string }
  | { tag: "Failed"; code?: string }
  | { tag: "ReRender" };

function workflowSessionTaskId(
  task: Pick<TaskDescriptor, "nodeId" | "iteration">,
): string {
  return `${task.nodeId}::${task.iteration ?? 0}`;
}

function workflowSessionTaskIds(
  tasks: readonly Pick<TaskDescriptor, "nodeId" | "iteration">[],
): string[] {
  return tasks.map(workflowSessionTaskId).sort();
}

function summarizeWorkflowSessionDecision(
  decision: EngineDecision,
): WorkflowSessionShadowDecisionSummary {
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
        code:
          typeof (decision.error as any)?.code === "string"
            ? (decision.error as any).code
            : undefined,
      };
    case "ReRender":
      return { tag: "ReRender" };
  }
  return { tag: "Failed", code: "UNKNOWN_DECISION" };
}

function summarizeLegacySchedulerDecision(
  schedule: {
    runnable: TaskDescriptor[];
    pendingExists: boolean;
    waitingApprovalExists: boolean;
    waitingEventExists: boolean;
    waitingTimerExists: boolean;
    readyRalphs: unknown[];
    continuation?: unknown;
    nextRetryAtMs?: number;
    fatalError?: string;
  },
  stateMap: TaskStateMap,
  tasks: TaskDescriptor[],
  schedulerTaskKeys: ReadonlySet<string>,
): WorkflowSessionShadowDecisionSummary {
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
      reason:
        schedule.nextRetryAtMs == null ? "ExternalTrigger" : "RetryBackoff",
    };
  }
  if (schedule.readyRalphs.length > 0) {
    return { tag: "ReRender" };
  }
  return { tag: "Finished", status: "finished" };
}

function workflowSessionSummaryKey(
  summary: WorkflowSessionShadowDecisionSummary,
): string {
  return JSON.stringify(summary);
}

function buildRuntimeOwnerId() {
  return `pid:${process.pid}:${randomUUID()}`;
}

type RunDurabilityMetadata = {
  workflowHash: string | null;
  entryWorkflowHash: string | null;
  vcsType: "git" | "jj" | null;
  vcsRoot: string | null;
  vcsRevision: string | null;
};

const DURABILITY_CONFIG_KEY = "__smithersDurability";
const DURABILITY_METADATA_VERSION = 2;

/** Prevent macOS idle sleep while a workflow is running. No-op on other platforms. */
function acquireCaffeinate(): { release: () => void } {
  if (platform() !== "darwin") return { release: () => {} };
  if (!caffeinateBinary) return { release: () => {} };
  try {
    const child = nodeSpawn(caffeinateBinary, ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
    return {
      release: () => {
        try {
          child.kill();
        } catch {}
      },
    };
  } catch {
    return { release: () => {} };
  }
}

function coercePositiveInt(
  field: string,
  value: unknown,
  fallback: number,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Math.floor(assertPositiveFiniteInteger(field, Number(value)));
}

function buildInputRow(
  inputTable: any,
  runId: string,
  input: Record<string, unknown>,
) {
  const cols = getTableColumns(inputTable as any) as Record<string, any>;
  const keys = Object.keys(cols);
  const hasPayload = keys.includes("payload");
  const payloadOnly =
    hasPayload && keys.every((key) => key === "runId" || key === "payload");
  if (payloadOnly) {
    return { runId, payload: input };
  }
  return { runId, ...input };
}

function normalizeInputRow(row: any): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};
  if ("payload" in row) {
    const payload = (row as any).payload;
    const { runId: _runId, payload: _payload, ...rest } =
      row as Record<string, unknown>;
    if (payload && typeof payload === "object") {
      return { ...(payload as Record<string, unknown>), ...rest };
    }
    return rest;
  }
  const { runId: _runId, ...rest } = row as Record<string, unknown>;
  return rest;
}

function normalizeOutputRow(row: any): unknown {
  if (!row || typeof row !== "object") return row;
  const keys = Object.keys(row);
  const payloadOnly =
    "payload" in row &&
    keys.every(
      (key) =>
        key === "runId" ||
        key === "nodeId" ||
        key === "iteration" ||
        key === "payload",
    );
  if (payloadOnly) {
    return (row as any).payload ?? null;
  }
  return stripAutoColumns(row);
}

async function restoreDurableStateFromSnapshot(
  adapter: SmithersDb,
  db: any,
  schema: Record<string, any>,
  inputTable: any,
  runId: string,
): Promise<boolean> {
  const snapshot = await loadLatestSnapshot(adapter, runId);
  if (!snapshot) return false;

  const parsed = parseSnapshot(snapshot);
  const restoredAtMs = snapshot.createdAtMs ?? nowMs();
  const inputRow = buildInputRow(inputTable, runId, normalizeInputRow(parsed.input));
  const inputValidation = validateInput(inputTable as any, inputRow);
  if (!inputValidation.ok) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Snapshot input does not match schema",
      {
        issues: inputValidation.error?.issues,
        runId,
        frameNo: snapshot.frameNo,
      },
    );
  }

  const inputCols = getTableColumns(inputTable as any) as Record<string, any>;
  await withSqliteWriteRetry(
    () =>
      db
        .insert(inputTable)
        .values(inputRow)
        .onConflictDoUpdate({
          target: inputCols.runId,
          set: inputRow,
        }),
    { label: "restore input row from snapshot" },
  );

  for (const node of Object.values(parsed.nodes)) {
    await adapter.insertNode({
      runId,
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      state: node.state,
      lastAttempt: node.lastAttempt ?? null,
      updatedAtMs: restoredAtMs,
      outputTable: node.outputTable ?? "",
      label: node.label ?? null,
    });
  }

  for (const ralph of Object.values(parsed.ralph)) {
    await adapter.insertOrUpdateRalph({
      runId,
      ralphId: ralph.ralphId,
      iteration: ralph.iteration ?? 0,
      done: Boolean(ralph.done),
      updatedAtMs: restoredAtMs,
    });
  }

  for (const [schemaKey, table] of Object.entries(schema)) {
    if (!table || typeof table !== "object" || schemaKey === "input") continue;
    const tableName = getTableName(table as any);
    const rows =
      (parsed.outputs[tableName] as unknown[] | undefined) ??
      (parsed.outputs[schemaKey] as unknown[] | undefined) ??
      [];

    for (const rawRow of rows) {
      if (!rawRow || typeof rawRow !== "object") continue;
      const nodeId =
        typeof (rawRow as Record<string, unknown>).nodeId === "string"
          ? ((rawRow as Record<string, unknown>).nodeId as string)
          : null;
      if (!nodeId) continue;
      const iteration =
        typeof (rawRow as Record<string, unknown>).iteration === "number"
          ? ((rawRow as Record<string, unknown>).iteration as number)
          : 0;
      const nodeState = parsed.nodes[`${nodeId}::${iteration}`];
      if (nodeState?.state !== "finished") continue;

      const restoredRow = buildOutputRow(
        table as any,
        runId,
        nodeId,
        iteration,
        normalizeOutputRow(rawRow),
      );
      const outputValidation = validateOutput(table as any, restoredRow);
      if (!outputValidation.ok) {
        throw new SmithersError(
          "INVALID_OUTPUT",
          `Snapshot output does not match schema for ${tableName}`,
          {
            issues: outputValidation.error?.issues,
            nodeId,
            iteration,
            runId,
            frameNo: snapshot.frameNo,
            tableName,
          },
        );
      }

      const outputCols = getTableColumns(table as any) as Record<string, any>;
      const target = outputCols.iteration
        ? [outputCols.runId, outputCols.nodeId, outputCols.iteration]
        : [outputCols.runId, outputCols.nodeId];
      await withSqliteWriteRetry(
        () =>
          db
            .insert(table as any)
            .values(restoredRow)
            .onConflictDoUpdate({
              target: target as any,
              set: restoredRow,
            }),
        { label: `restore output ${tableName} from snapshot` },
      );
    }
  }

  return true;
}

function quoteSqlIdent(identifier: string): string {
  return `"${identifier.replaceAll(`"`, `""`)}"`;
}

function toSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Date)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function getTableColumnEntries(
  table: any,
): Array<{ key: string; sqlName: string }> {
  const cols = getTableColumns(table as any) as Record<string, any>;
  return Object.entries(cols).map(([key, col]) => ({
    key,
    sqlName: String((col as any)?.name ?? key),
  }));
}

function insertRowWithClient(
  client: any,
  tableName: string,
  row: Record<string, unknown>,
  columnEntries: Array<{ key: string; sqlName: string }>,
) {
  const columns = columnEntries.filter((entry) =>
    Object.prototype.hasOwnProperty.call(row, entry.key),
  );
  if (columns.length === 0) return;
  const sql = `INSERT INTO ${quoteSqlIdent(tableName)} (${columns
    .map((entry) => quoteSqlIdent(entry.sqlName))
    .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const values = columns.map((entry) => toSqlValue(row[entry.key]));
  client.query(sql).run(...values);
}

function copyRunScopedRowsWithClient(
  client: any,
  table: any,
  sourceRunId: string,
  targetRunId: string,
) {
  const tableName = getTableName(table as any);
  const columnEntries = getTableColumnEntries(table);
  const runIdColumn = columnEntries.find((entry) => entry.key === "runId");
  if (!runIdColumn) return;

  const insertColumnsSql = columnEntries
    .map((entry) => quoteSqlIdent(entry.sqlName))
    .join(", ");
  const selectColumnsSql = columnEntries
    .map((entry) =>
      entry.key === "runId" ? "?" : quoteSqlIdent(entry.sqlName),
    )
    .join(", ");
  const sql = `INSERT INTO ${quoteSqlIdent(tableName)} (${insertColumnsSql}) SELECT ${selectColumnsSql} FROM ${quoteSqlIdent(tableName)} WHERE ${quoteSqlIdent(runIdColumn.sqlName)} = ?`;
  client.query(sql).run(targetRunId, sourceRunId);
}

function ralphStateToObject(ralphState: RalphStateMap): Record<string, { iteration: number; done: boolean }> {
  const out: Record<string, { iteration: number; done: boolean }> = {};
  const entries = [...ralphState.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [ralphId, state] of entries) {
    out[ralphId] = {
      iteration: state.iteration,
      done: state.done,
    };
  }
  return out;
}

function cloneRalphStateMap(ralphState: RalphStateMap): RalphStateMap {
  const next: RalphStateMap = new Map();
  for (const [ralphId, state] of ralphState.entries()) {
    next.set(ralphId, { iteration: state.iteration, done: state.done });
  }
  return next;
}

function buildCarriedInputRow(
  inputTable: any,
  newRunId: string,
  sourceInputRow: Record<string, unknown>,
  continuationEnvelope: Record<string, unknown>,
): Record<string, unknown> {
  const columns = getTableColumns(inputTable as any) as Record<string, any>;
  if (!columns.runId) {
    throw new SmithersError(
      "DB_MISSING_COLUMNS",
      "schema.input must include runId column",
    );
  }

  const row: Record<string, unknown> = {};
  for (const key of Object.keys(columns)) {
    if (key === "runId") {
      row[key] = newRunId;
      continue;
    }
    if (key === "payload") {
      const sourcePayload = sourceInputRow.payload;
      const payloadBase: Record<string, unknown> =
        sourcePayload && typeof sourcePayload === "object" && !Array.isArray(sourcePayload)
          ? { ...(sourcePayload as Record<string, unknown>) }
          : { value: sourcePayload ?? null };
      payloadBase.__smithersContinuation = continuationEnvelope;
      row[key] = payloadBase;
      continue;
    }
    row[key] = sourceInputRow[key] ?? null;
  }

  return row;
}

async function continueRunAsNew(
  params: {
    db: any;
    adapter: SmithersDb;
    schema: Record<string, any>;
    inputTable: any;
    runId: string;
    workflowPath: string | null;
    runMetadata: RunDurabilityMetadata;
    currentFrameNo: number;
    continuation: ContinueAsNewRequest;
    ralphState: RalphStateMap;
  },
): Promise<ContinueAsNewTransition> {
  const {
    db,
    adapter,
    schema,
    inputTable,
    runId,
    workflowPath,
    runMetadata,
    currentFrameNo,
    continuation,
    ralphState,
  } = params;

  const sourceRun = await adapter.getRun(runId);
  if (!sourceRun) {
    throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, { runId });
  }
  if (sourceRun.cancelRequestedAtMs) {
    throw new SmithersError(
      "RUN_CANCELLED",
      `Run ${runId} was cancelled before continue-as-new handoff`,
      { runId },
    );
  }

  const sourceInputRow = await loadInput(db, inputTable, runId);
  if (!sourceInputRow) {
    throw new SmithersError(
      "MISSING_INPUT",
      `Cannot continue run ${runId} because no input row exists`,
      { runId },
    );
  }

  const ancestry = await adapter.listRunAncestry(runId, 10_000);
  const ancestryDepth = ancestry.length;
  const targetRunId = newRunId();
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
    throw new SmithersError(
      "CONTINUATION_STATE_TOO_LARGE",
      `Carried continuation state is ${carriedStateBytes} bytes (max ${MAX_CONTINUATION_STATE_BYTES}). Reduce continuation payload size or use external storage.`,
      {
        carriedStateBytes,
        maxBytes: MAX_CONTINUATION_STATE_BYTES,
      },
    );
  }

  const outputTables = Object.entries(schema)
    .filter(([key, table]) => key !== "input" && table && typeof table === "object")
    .map(([, table]) => table as any);
  const inputTableName = getTableName(inputTable as any);
  const inputRow = buildCarriedInputRow(
    inputTable,
    targetRunId,
    sourceInputRow as Record<string, unknown>,
    continuationEnvelope,
  );
  const inputColumnEntries = getTableColumnEntries(inputTable);
  const runConfigBase =
    sourceRun.configJson && sourceRun.configJson.trim().length > 0
      ? (() => {
          try {
            const parsed = JSON.parse(sourceRun.configJson);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed
              : {};
          } catch {
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
    type: "RunContinuedAsNew" as const,
    runId,
    newRunId: targetRunId,
    iteration: continuation.iteration,
    carriedStateSize: carriedStateBytes,
    ancestryDepth: ancestryDepth + 1,
    timestampMs: ts,
  };

  await withSqliteWriteRetry(
    async () => {
      const client: any = (db as any).$client;
      if (!client || typeof client.run !== "function" || typeof client.query !== "function") {
        throw new SmithersError(
          "DB_REQUIRES_BUN_SQLITE",
          "Continue-as-new requires Bun SQLite client transaction primitives.",
        );
      }
      client.run("BEGIN IMMEDIATE");
      try {
        const cancelState = client
          .query("SELECT cancel_requested_at_ms AS cancelRequestedAtMs FROM _smithers_runs WHERE run_id = ? LIMIT 1")
          .get(runId) as { cancelRequestedAtMs?: number | null } | undefined;
        if (cancelState?.cancelRequestedAtMs) {
          throw new SmithersError(
            "RUN_CANCELLED",
            `Run ${runId} was cancelled before continue-as-new handoff`,
            { runId },
          );
        }

        client
          .query(
            `INSERT INTO _smithers_runs (
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            targetRunId,
            runId,
            sourceRun.workflowName ?? "workflow",
            workflowPath ?? sourceRun.workflowPath ?? null,
            runMetadata.workflowHash ?? sourceRun.workflowHash ?? null,
            "running",
            ts,
            ts,
            null,
            null,
            null,
            null,
            null,
            null,
            runMetadata.vcsType ?? sourceRun.vcsType ?? null,
            runMetadata.vcsRoot ?? sourceRun.vcsRoot ?? null,
            runMetadata.vcsRevision ?? sourceRun.vcsRevision ?? null,
            null,
            nextConfigJson,
          );

        insertRowWithClient(client, inputTableName, inputRow, inputColumnEntries);

        for (const table of outputTables) {
          copyRunScopedRowsWithClient(client, table, runId, targetRunId);
        }

        for (const [ralphId, state] of carriedRalphState.entries()) {
          client
            .query(
              `INSERT INTO _smithers_ralph (run_id, ralph_id, iteration, done, updated_at_ms)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(run_id, ralph_id)
               DO UPDATE SET iteration = excluded.iteration, done = excluded.done, updated_at_ms = excluded.updated_at_ms`,
            )
            .run(
              targetRunId,
              ralphId,
              state.iteration,
              state.done ? 1 : 0,
              ts,
            );
        }

        client
          .query(
            `INSERT INTO _smithers_branches (
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
              created_at_ms = excluded.created_at_ms`,
          )
          .run(
            targetRunId,
            runId,
            currentFrameNo,
            "continue-as-new",
            `continue-as-new:${continuation.reason}`,
            ts,
          );

        client
          .query(
            `UPDATE _smithers_runs
             SET status = ?, finished_at_ms = ?, heartbeat_at_ms = NULL, runtime_owner_id = NULL,
                 cancel_requested_at_ms = NULL, hijack_requested_at_ms = NULL, hijack_target = NULL
             WHERE run_id = ?`,
          )
          .run("continued", ts, runId);

        const nextEventSeq = Number(
          (
            client
              .query(
                "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_events WHERE run_id = ?",
              )
              .get(runId) as { seq?: number } | undefined
          )?.seq ?? 0,
        );
        client
          .query(
            `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            nextEventSeq,
            ts,
            continuationEvent.type,
            JSON.stringify(continuationEvent),
          );

        client.run("COMMIT");
      } catch (error) {
        try {
          client.run("ROLLBACK");
        } catch {
          // ignore rollback failures
        }
        throw error;
      }
    },
    { label: "continue-as-new handoff" },
  );

  return {
    newRunId: targetRunId,
    ancestryDepth: ancestryDepth + 1,
    carriedStateBytes,
  };
}

async function buildCacheContext(
  db: any,
  inputTable: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  attempt: number,
): Promise<Record<string, unknown>> {
  const inputRow = await loadInput(db, inputTable, runId);
  const ctx: Record<string, unknown> = {
    input: normalizeInputRow(inputRow),
    executionId: runId,
    stepId: desc.nodeId,
    attempt,
    iteration: desc.iteration,
    loop: { iteration: desc.iteration + 1 },
  };
  const needs =
    desc.needs ??
    (desc.dependsOn
      ? Object.fromEntries(desc.dependsOn.map((id) => [id, id]))
      : undefined);
  if (needs) {
    for (const [key, depId] of Object.entries(needs)) {
      const dep = descriptorMap.get(depId);
      if (!dep?.outputTable) continue;
      const row = await selectOutputRow<any>(db, dep.outputTable as any, {
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

function resolveRootDir(
  opts: RunOptions,
  workflowPath?: string | null,
): string {
  if (opts.rootDir) return resolve(opts.rootDir);
  if (workflowPath) return resolve(dirname(workflowPath));
  return resolve(process.cwd());
}

function resolveLogDir(
  rootDir: string,
  runId: string,
  logDir?: string | null,
): string | undefined {
  if (logDir === null) return undefined;
  if (typeof logDir === "string") {
    return resolve(rootDir, logDir);
  }
  return resolve(rootDir, ".smithers", "executions", runId, "logs");
}

const STATIC_IMPORT_RE =
  /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']/g;
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

function getWorkflowImportScanLoader(sourcePath: string | null | undefined) {
  const lower = sourcePath?.toLowerCase() ?? "";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".jsx")) return "jsx";
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "ts";
  }
  return "js";
}

async function readWorkflowEntryHash(
  workflowPath: string | null,
): Promise<string | null> {
  if (!workflowPath) return null;
  try {
    const raw = await readFile(workflowPath, "utf8");
    return sha256Hex(raw);
  } catch {
    return null;
  }
}

function extractWorkflowImportSpecifiers(
  source: string,
  sourcePath?: string | null,
): string[] {
  if (typeof Bun !== "undefined" && typeof Bun.Transpiler === "function") {
    try {
      const scanned = new Bun.Transpiler({
        loader: getWorkflowImportScanLoader(sourcePath),
      } as any).scanImports(source) as Array<{
        path?: string;
      }>;
      const specifiers = new Set<string>();
      for (const entry of scanned) {
        const specifier = entry?.path?.trim();
        if (specifier?.startsWith(".")) {
          specifiers.add(specifier);
        }
      }
      return [...specifiers];
    } catch {
      // Fall back to regex scanning if Bun's parser cannot handle the source.
    }
  }

  const specifiers = new Set<string>();
  for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]?.trim();
      if (!specifier?.startsWith(".")) continue;
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveWorkflowImport(baseFile: string, specifier: string): string | null {
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

async function collectWorkflowModuleHashEntries(
  workflowPath: string,
  visited = new Set<string>(),
): Promise<string[]> {
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
      throw new SmithersError(
        "WORKFLOW_HASH_RESOLUTION_FAILED",
        `Unable to resolve workflow import "${specifier}" from ${resolvedPath}.`,
        { workflowPath: resolvedPath, specifier },
      );
    }
    entries.push(
      ...(await collectWorkflowModuleHashEntries(importedPath, visited)),
    );
  }
  return entries;
}

async function readWorkflowGraphHash(
  workflowPath: string | null,
): Promise<string | null> {
  if (!workflowPath) return null;
  try {
    const entries = await collectWorkflowModuleHashEntries(workflowPath);
    return sha256Hex(entries.sort().join("|"));
  } catch {
    return null;
  }
}

async function getGitPointer(cwd: string): Promise<string | null> {
  const res = await runGitCommand(cwd, ["rev-parse", "HEAD"]);
  if (res.code !== 0) return null;
  const out = res.stdout.trim();
  return out ? out : null;
}

async function getRunDurabilityMetadata(
  workflowPath: string | null,
  rootDir: string,
): Promise<RunDurabilityMetadata> {
  const entryWorkflowHash = await readWorkflowEntryHash(workflowPath);
  const workflowHash = await readWorkflowGraphHash(workflowPath);
  const vcs = findVcsRoot(rootDir);
  if (!vcs) {
    return {
      workflowHash,
      entryWorkflowHash,
      vcsType: null,
      vcsRoot: null,
      vcsRevision: null,
    };
  }

  const vcsRevision =
    vcs.type === "jj"
      ? await getJjPointer(rootDir)
      : await getGitPointer(rootDir);

  return {
    workflowHash,
    entryWorkflowHash,
    vcsType: vcs.type,
    vcsRoot: vcs.root,
    vcsRevision,
  };
}

function buildDurabilityConfig(
  config: Record<string, unknown>,
  metadata: RunDurabilityMetadata,
): Record<string, unknown> & {
  [DURABILITY_CONFIG_KEY]: {
    version: number;
    entryWorkflowHash: string | null;
  };
} {
  return {
    ...config,
    [DURABILITY_CONFIG_KEY]: {
      version: DURABILITY_METADATA_VERSION,
      entryWorkflowHash: metadata.entryWorkflowHash,
    },
  };
}

function getStoredDurabilityConfig(
  config: Record<string, unknown>,
): { version: number; entryWorkflowHash: string | null } | null {
  const raw = config[DURABILITY_CONFIG_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return {
    version:
      typeof (raw as any).version === "number"
        ? (raw as any).version
        : 0,
    entryWorkflowHash:
      typeof (raw as any).entryWorkflowHash === "string"
        ? (raw as any).entryWorkflowHash
        : null,
  };
}

function compareNullableString(
  left: string | null | undefined,
  right: string | null | undefined,
  mismatchLabel: string,
  mismatches: string[],
) {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft !== normalizedRight) {
    mismatches.push(mismatchLabel);
  }
}

function assertResumeDurabilityMetadata(
  existingRun: any,
  existingConfig: Record<string, unknown>,
  current: RunDurabilityMetadata,
  workflowPath: string | null,
) {
  const mismatches: string[] = [];
  const storedDurability = getStoredDurabilityConfig(existingConfig);
  const storedDurabilityVersion = storedDurability?.version ?? 0;
  const storedEntryWorkflowHash = storedDurability?.entryWorkflowHash ?? null;

  if (
    existingRun.workflowPath &&
    workflowPath &&
    resolve(existingRun.workflowPath) !== resolve(workflowPath)
  ) {
    mismatches.push("workflow path changed");
  }
  const shouldCheckWorkflowHashes = Boolean(
    existingRun.workflowPath ||
      workflowPath ||
      existingRun.workflowHash ||
      current.workflowHash ||
      storedDurability?.entryWorkflowHash ||
      current.entryWorkflowHash,
  );
  if (
    shouldCheckWorkflowHashes &&
    storedDurabilityVersion >= DURABILITY_METADATA_VERSION
  ) {
    if (!existingRun.workflowHash || !current.workflowHash) {
      mismatches.push("workflow module graph unavailable");
    } else {
      compareNullableString(
        existingRun.workflowHash,
        current.workflowHash,
        "workflow module graph changed",
        mismatches,
      );
    }
    if (!storedEntryWorkflowHash || !current.entryWorkflowHash) {
      mismatches.push("workflow entry hash unavailable");
    } else {
      compareNullableString(
        storedEntryWorkflowHash,
        current.entryWorkflowHash,
        "workflow entry file changed",
        mismatches,
      );
    }
  } else if (shouldCheckWorkflowHashes) {
    compareNullableString(
      existingRun.workflowHash,
      current.entryWorkflowHash,
      "workflow entry file changed",
      mismatches,
    );
  }
  compareNullableString(
    existingRun.vcsType,
    current.vcsType,
    "VCS type changed",
    mismatches,
  );
  if (
    (existingRun.vcsRoot && current.vcsRoot
      ? resolve(existingRun.vcsRoot) !== resolve(current.vcsRoot)
      : (existingRun.vcsRoot ?? null) !== (current.vcsRoot ?? null))
  ) {
    mismatches.push("VCS root changed");
  }
  compareNullableString(
    existingRun.vcsRevision,
    current.vcsRevision,
    "VCS revision changed",
    mismatches,
  );

  if (mismatches.length > 0) {
    throw new SmithersError(
      "RESUME_METADATA_MISMATCH",
      `Cannot resume run because durable metadata changed: ${mismatches.join(", ")}`,
      {
        existing: {
          workflowPath: existingRun.workflowPath ?? null,
          workflowHash: existingRun.workflowHash ?? null,
          vcsType: existingRun.vcsType ?? null,
          vcsRoot: existingRun.vcsRoot ?? null,
          vcsRevision: existingRun.vcsRevision ?? null,
        },
        current,
      },
    );
  }
}

function wireAbortSignal(controller: AbortController, signal?: AbortSignal) {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function startRunSupervisor(
  adapter: SmithersDb,
  runId: string,
  runtimeOwnerId: string,
  controller: AbortController,
  hijackState: HijackState,
) {
  let closed = false;

  const heartbeat = setInterval(() => {
    if (closed || controller.signal.aborted) return;
    void adapter.heartbeatRun(runId, runtimeOwnerId, nowMs()).catch((error) => {
      logWarning("failed to persist run heartbeat", {
        runId,
        runtimeOwnerId,
        error:
          error instanceof Error ? error.message : String(error),
      }, "engine:heartbeat");
    });
  }, RUN_HEARTBEAT_MS);

  const cancelWatcher = (async () => {
    while (!closed && !controller.signal.aborted) {
      try {
        const run = await adapter.getRun(runId);
        if (
          run?.hijackRequestedAtMs &&
          (!hijackState.request ||
            run.hijackRequestedAtMs > hijackState.request.requestedAtMs)
        ) {
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
      } catch (error) {
        logWarning("failed to poll run cancel state", {
          runId,
          runtimeOwnerId,
          error:
            error instanceof Error ? error.message : String(error),
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

export function isRunHeartbeatFresh(
  run: { status?: string | null; heartbeatAtMs?: number | null } | null | undefined,
  now = nowMs(),
): boolean {
  return Boolean(
    run &&
      run.status === "running" &&
      typeof run.heartbeatAtMs === "number" &&
      now - run.heartbeatAtMs <= RUN_HEARTBEAT_STALE_MS,
  );
}

function parseRunConfigJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseRunAuthContext(value: unknown): RunAuthContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.triggeredBy !== "string" ||
    !Array.isArray(record.scopes) ||
    typeof record.role !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }
  const scopes = record.scopes.filter((entry): entry is string => typeof entry === "string");
  return {
    triggeredBy: record.triggeredBy,
    scopes,
    role: record.role,
    createdAt: record.createdAt,
  };
}

type ResumeClaimCleanup = {
  claimOwnerId: string;
  restoreRuntimeOwnerId: string | null;
  restoreHeartbeatAtMs: number | null;
};

const RESUMABLE_RUN_STATUSES = new Set([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "cancelled",
  "finished",
  "failed",
]);

function isResumableRunStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && RESUMABLE_RUN_STATUSES.has(status);
}

function normalizeHotOptions(hot: boolean | HotReloadOptions | undefined): HotReloadOptions & { enabled: boolean } {
  if (!hot) return { enabled: false };
  if (hot === true) return { enabled: true };
  return { enabled: true, ...hot };
}

function assertInputObject(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SmithersError("INVALID_INPUT", "Run input must be a JSON object");
  }
}

function validateRunOptions(opts: RunOptions) {
  assertOptionalStringMaxLength(
    "runId",
    opts.runId,
    RUN_WORKFLOW_RUN_ID_MAX_LENGTH,
  );
  assertOptionalStringMaxLength(
    "workflowPath",
    opts.workflowPath,
    RUN_WORKFLOW_WORKFLOW_PATH_MAX_LENGTH,
  );
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
    assertOptionalStringMaxLength(
      "resumeClaim.claimOwnerId",
      opts.resumeClaim.claimOwnerId,
      RUN_WORKFLOW_RUN_ID_MAX_LENGTH,
    );
    assertPositiveFiniteInteger(
      "resumeClaim.claimHeartbeatAtMs",
      Number(opts.resumeClaim.claimHeartbeatAtMs),
    );
    if (opts.resumeClaim.restoreHeartbeatAtMs !== undefined && opts.resumeClaim.restoreHeartbeatAtMs !== null) {
      assertPositiveFiniteInteger(
        "resumeClaim.restoreHeartbeatAtMs",
        Number(opts.resumeClaim.restoreHeartbeatAtMs),
      );
    }
  }
}

export function resolveSchema(db: any): Record<string, any> {
  const candidates = [db?._?.fullSchema, db?._?.schema, db?.schema];
  let schema: Record<string, any> = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if ((candidate as any).input) {
      try {
        getTableName((candidate as any).input);
        schema = candidate as Record<string, any>;
        break;
      } catch {
        continue;
      }
    } else {
      schema = candidate as Record<string, any>;
      break;
    }
  }
  const filtered: Record<string, any> = {};
  for (const [key, table] of Object.entries(schema)) {
    if (key.startsWith("_smithers")) continue;
    if (table && typeof table === "object") {
      try {
        const name = getTableName(table as any);
        if (name.startsWith("_smithers")) continue;
      } catch {
        continue; // Skip non-table entries (e.g. Drizzle relations/metadata)
      }
    } else {
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
function resolveTaskOutputs(tasks: TaskDescriptor[], workflow: SmithersWorkflow<any>) {
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
          if (!task.outputSchema) task.outputSchema = entry.zodSchema;
        }
      }
      if (!task.outputTable) {
        throw new SmithersError(
          "UNKNOWN_OUTPUT_SCHEMA",
          `Task "${task.nodeId}" uses an output ZodObject that is not registered in createSmithers()`,
        );
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
          if (!task.outputSchema) task.outputSchema = entry.zodSchema;
        }
      }
      if (!task.outputTable) {
        throw new SmithersError(
          "UNKNOWN_OUTPUT_SCHEMA",
          `Task "${task.nodeId}" uses an output ZodObject that is not registered in createSmithers()`,
        );
      }
    }

    if (!task.outputTable) {
      const keyName =
        typeof task.outputTableName === "string" && task.outputTableName.length > 0
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
      throw new SmithersError(
        "UNKNOWN_OUTPUT_SCHEMA",
        `Task "${task.nodeId}" uses an output schema key that is not registered in createSmithers()`,
        {
          output: task.outputTableName ?? (typeof raw === "string" ? raw : undefined),
        },
      );
    }
  }
}

function attachSubflowComputeFns(
  tasks: TaskDescriptor[],
  workflow: SmithersWorkflow<any>,
  opts: { rootDir?: string; workflowPath?: string | null } = {},
) {
  for (const task of tasks) {
    if (!task.meta?.__subflow || task.computeFn) continue;
    const subflowWorkflow = task.meta.__subflowWorkflow;
    if (!subflowWorkflow) continue;
    const subflowInput = task.meta.__subflowInput;
    task.computeFn = async () => {
      const result = await executeChildWorkflow(workflow, {
        workflow: subflowWorkflow as any,
        input: subflowInput,
        rootDir: opts.rootDir,
        workflowPath: opts.workflowPath ?? undefined,
      });
      if (result.status !== "finished") {
        throw new SmithersError(
          "WORKFLOW_EXECUTION_FAILED",
          `Subflow ${task.nodeId} failed with status ${result.status}.`,
          { nodeId: task.nodeId, status: result.status },
        );
      }
      return result.output;
    };

    const { __subflowWorkflow: _workflow, ...persistableMeta } = task.meta;
    task.meta = persistableMeta;
  }
}

function getWorkflowNameFromXml(xml: any): string {
  if (!xml || xml.kind !== "element") return "workflow";
  if (xml.tag !== "smithers:workflow") return "workflow";
  return xml.props?.name ?? "workflow";
}

function buildDescriptorMap(
  tasks: TaskDescriptor[],
): Map<string, TaskDescriptor> {
  const map = new Map<string, TaskDescriptor>();
  for (const task of tasks) map.set(task.nodeId, task);
  return map;
}

function buildRalphStateMap(rows: any[]): RalphStateMap {
  const map: RalphStateMap = new Map();
  for (const row of rows) {
    map.set(row.ralphId, {
      iteration: row.iteration ?? 0,
      done: Boolean(row.done),
    });
  }
  return map;
}

function ralphIterationsFromState(state: RalphStateMap): Map<string, number> {
  const map = new Map<string, number>();
  for (const [id, value] of state.entries()) {
    map.set(id, value.iteration ?? 0);
  }
  return map;
}

function ralphIterationsObject(state: RalphStateMap): Record<string, number> {
  const obj: Record<string, number> = {};

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
  const logicalIdsWithScope = new Set<string>();
  for (const id of state.keys()) {
    const atIdx = id.indexOf("@@");
    if (atIdx >= 0) logicalIdsWithScope.add(id.slice(0, atIdx));
  }

  // Initialize logical shortcuts to 0 (for when current scope variant hasn't
  // been created yet, e.g. outer just advanced but inner hasn't been initialized).
  for (const logicalId of logicalIdsWithScope) {
    obj[logicalId] = 0;
  }

  for (const [id, value] of state.entries()) {
    const atIdx = id.indexOf("@@");
    if (atIdx < 0) continue;
    const logicalId = id.slice(0, atIdx);
    const scopeSuffix = id.slice(atIdx + 2);
    const parts = scopeSuffix.split(",");
    let isCurrent = true;
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) { isCurrent = false; break; }
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

function buildRalphDoneMap(
  ralphs: { id: string; until: boolean }[],
  state: RalphStateMap,
): Map<string, boolean> {
  const done = new Map<string, boolean>();
  for (const ralph of ralphs) {
    const st = state.get(ralph.id);
    done.set(ralph.id, Boolean(ralph.until || st?.done));
  }
  return done;
}

function parseAttemptErrorCode(errorJson?: string | null): string | null {
  if (!errorJson) return null;
  try {
    const parsed = JSON.parse(errorJson);
    return typeof parsed?.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

function isRetryableTaskFailure(
  attempt?: { errorJson?: string | null; metaJson?: string | null } | null,
) {
  const meta = parseAttemptMetaJson(attempt?.metaJson);
  if (meta?.failureRetryable === false) {
    return false;
  }
  const kind = typeof meta?.kind === "string" ? meta.kind : null;
  return !(kind !== "agent" && parseAttemptErrorCode(attempt?.errorJson) === "INVALID_OUTPUT");
}

async function computeTaskStates(
  adapter: SmithersDb,
  db: any,
  runId: string,
  tasks: TaskDescriptor[],
  eventBus: EventBus,
  ralphDone: Map<string, boolean>,
): Promise<{ stateMap: TaskStateMap; retryWait: Map<string, number> }> {
  const stateMap: TaskStateMap = new Map();
  const retryWait = new Map<string, number>();
  const existing = await adapter.listNodes(runId);
  const existingState = new Map<string, TaskState>();
  for (const node of existing) {
    existingState.set(
      buildStateKey(node.nodeId, node.iteration ?? 0),
      node.state as TaskState,
    );
  }

  const maybeEmitStateEvent = async (state: TaskState, desc: TaskDescriptor) => {
    const key = buildStateKey(desc.nodeId, desc.iteration);
    const prev = existingState.get(key);
    if (state === "pending" && prev !== "pending") {
      await eventBus.emitEventWithPersist({
        type: "NodePending",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        timestampMs: nowMs(),
      });
      existingState.set(key, state);
    }
    if (state === "skipped" && prev !== "skipped") {
      await eventBus.emitEventWithPersist({
        type: "NodeSkipped",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        timestampMs: nowMs(),
      });
      existingState.set(key, state);
    }
  };

  for (const desc of tasks) {
    const key = buildStateKey(desc.nodeId, desc.iteration);

    if (desc.skipIf) {
      stateMap.set(key, "skipped");
      await adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "skipped",
        lastAttempt: null,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
      await maybeEmitStateEvent("skipped", desc);
      continue;
    }

    const deferredState = await resolveDeferredTaskStateBridge(
      adapter,
      db,
      runId,
      desc,
      eventBus,
      (state) => maybeEmitStateEvent(state, desc),
    );
    if (deferredState.handled) {
      stateMap.set(key, deferredState.state as TaskState);
      continue;
    }

    const attempts = await adapter.listAttempts(
      runId,
      desc.nodeId,
      desc.iteration,
    );

    // Check for a valid output row BEFORE checking attempt state.
    // After hot reload (or resume/restart), a task may have a stale
    // "in-progress" attempt in the DB even though its output was already
    // written.  By checking the output first we let the Sequence
    // fast-forward through already-completed children in the same render
    // cycle instead of waiting for a completion event that will never fire.
    if (desc.outputTable) {
      const outputRow = await selectOutputRow<any>(db, desc.outputTable as any, {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
      });

      if (outputRow) {
        const valid = validateExistingOutput(desc.outputTable as any, outputRow);
        if (valid.ok) {
          stateMap.set(key, "finished");
          await adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "finished",
            lastAttempt: attempts[0]?.attempt ?? null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
          continue;
        }
      }
    }

    const inProgress = attempts.find((a: any) => a.state === "in-progress");
    if (inProgress) {
      stateMap.set(key, "in-progress");
      await adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "in-progress",
        lastAttempt: inProgress.attempt,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
      continue;
    }

    if (desc.ralphId && ralphDone.get(desc.ralphId)) {
      stateMap.set(key, "skipped");
      await adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "skipped",
        lastAttempt: attempts[0]?.attempt ?? null,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
      await maybeEmitStateEvent("skipped", desc);
      continue;
    }

    const maxAttempts = desc.retries + 1;
    const failedAttempts = attempts.filter((a: any) => a.state === "failed");
    const hasNonRetryableFailure = failedAttempts.some(
      (attempt) => !isRetryableTaskFailure(attempt),
    );
    if (hasNonRetryableFailure || failedAttempts.length >= maxAttempts) {
      stateMap.set(key, "failed");
      await adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "failed",
        lastAttempt: attempts[0]?.attempt ?? null,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
      continue;
    }

    let waitingForRetry = false;
    if (failedAttempts.length > 0 && desc.retryPolicy && !hasNonRetryableFailure) {
      const lastFailed = failedAttempts[0];
      const retrySchedule = retryPolicyToSchedule(desc.retryPolicy);
      const delayMs = retryScheduleDelayMs(
        retrySchedule,
        lastFailed?.attempt ?? failedAttempts.length,
      );
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
    await adapter.insertNode({
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      state: "pending",
      lastAttempt: attempts[0]?.attempt ?? null,
      updatedAtMs: nowMs(),
      outputTable: desc.outputTableName,
      label: desc.label ?? null,
    });
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
 */
export function applyConcurrencyLimits(
  runnable: TaskDescriptor[],
  stateMap: TaskStateMap,
  maxConcurrency: number,
  allTasks: TaskDescriptor[],
): TaskDescriptor[] {
  const selected: TaskDescriptor[] = [];
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
    if (selected.length >= capacity) break;
    selected.push(desc);
  }
  return selected;
}

async function cancelInProgress(
  adapter: SmithersDb,
  runId: string,
  eventBus: EventBus,
) {
  const inProgress = await adapter.listInProgressAttempts(runId);
  for (const attempt of inProgress) {
    const existingNode = await adapter.getNode(
      runId,
      attempt.nodeId,
      attempt.iteration,
    );
    const cancelledAtMs = nowMs();
    await adapter.withTransaction(
      "cancel-in-progress",
      Effect.gen(function* () {
        yield* adapter.updateAttemptEffect(
          runId,
          attempt.nodeId,
          attempt.iteration,
          attempt.attempt,
          {
            state: "cancelled",
            finishedAtMs: cancelledAtMs,
          },
        );
        yield* adapter.insertNodeEffect({
          runId,
          nodeId: attempt.nodeId,
          iteration: attempt.iteration,
          state: "cancelled",
          lastAttempt: attempt.attempt,
          updatedAtMs: cancelledAtMs,
          outputTable: existingNode?.outputTable ?? "",
          label: existingNode?.label ?? null,
        });
      }),
    );
    await eventBus.emitEventWithPersist({
      type: "NodeCancelled",
      runId,
      nodeId: attempt.nodeId,
      iteration: attempt.iteration,
      attempt: attempt.attempt,
      reason: "unmounted",
      timestampMs: nowMs(),
    });
  }
}

async function cancelPendingTimers(
  adapter: SmithersDb,
  runId: string,
  eventBus: EventBus,
  reason: string,
) {
  await cancelPendingTimersBridge(adapter, runId, eventBus, reason);
}

async function cancelStaleAttempts(adapter: SmithersDb, runId: string) {
  const inProgress = await adapter.listInProgressAttempts(runId);
  const now = nowMs();
  for (const attempt of inProgress) {
    if (attempt.startedAtMs && now - attempt.startedAtMs > STALE_ATTEMPT_MS) {
      const existingNode = await adapter.getNode(
        runId,
        attempt.nodeId,
        attempt.iteration,
      );
      await adapter.withTransaction(
        "cancel-stale-attempt",
        Effect.gen(function* () {
          yield* adapter.updateAttemptEffect(
            runId,
            attempt.nodeId,
            attempt.iteration,
            attempt.attempt,
            {
              state: "cancelled",
              finishedAtMs: now,
            },
          );
          yield* adapter.insertNodeEffect({
            runId,
            nodeId: attempt.nodeId,
            iteration: attempt.iteration,
            state: "pending",
            lastAttempt: attempt.attempt,
            updatedAtMs: now,
            outputTable: existingNode?.outputTable ?? "",
            label: existingNode?.label ?? null,
          });
        }),
      );
    }
  }
}

export async function legacyExecuteTask(
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  inputTable: any,
  eventBus: EventBus,
  toolConfig: {
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
  },
  workflowName: string,
  cacheEnabled: boolean,
  signal?: AbortSignal,
  disabledAgents?: Set<any>,
  runAbortController?: AbortController,
  hijackState?: HijackState,
) {
  // Legacy execution goes here (renamed function)
  const taskStartMs = performance.now();
  const attempts = await adapter.listAttempts(
    runId,
    desc.nodeId,
    desc.iteration,
  );
  const previousHeartbeat = (() => {
    for (const attempt of attempts) {
      const parsed = parseAttemptHeartbeatData(attempt.heartbeatDataJson);
      if (parsed !== null) return parsed;
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
  } as const;
  const annotateTaskSpan = (
    attributes: Readonly<Record<string, unknown>>,
  ) =>
    Effect.runPromise(
      annotateSmithersTrace({
        ...taskSpanContext,
        ...attributes,
      }),
    );
  const taskAbortController = new AbortController();
  const removeAbortForwarder = wireAbortSignal(taskAbortController, signal);
  const taskSignal = taskAbortController.signal;
  const startedAtMs = nowMs();
  let taskCompleted = false;
  let taskExecutionReturned = false;
  let heartbeatClosed = false;
  let heartbeatWriteInFlight = false;
  let heartbeatPendingDataJson: string | null = null;
  let heartbeatPendingDataSizeBytes = 0;
  let heartbeatPendingAtMs = startedAtMs;
  let heartbeatHasPendingWrite = false;
  let heartbeatLastPersistedWriteAtMs = 0;
  let heartbeatLastReceivedAtMs: number | null = null;
  let heartbeatWriteTimer: ReturnType<typeof setTimeout> | undefined;

  const flushHeartbeat = async (force = false): Promise<void> => {
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
    const intervalMs =
      heartbeatLastReceivedAtMs == null
        ? null
        : Math.max(0, heartbeatAtMs - heartbeatLastReceivedAtMs);
    heartbeatLastReceivedAtMs = heartbeatAtMs;

    try {
      await adapter.heartbeatAttempt(
        runId,
        desc.nodeId,
        desc.iteration,
        attemptNo,
        heartbeatAtMs,
        heartbeatDataJson,
      );
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
    } catch (error) {
      logWarning("failed to persist task heartbeat", {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        error: error instanceof Error ? error.message : String(error),
      }, "heartbeat:record");
    } finally {
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

  const queueHeartbeat = (
    data: unknown,
    opts?: { internal?: boolean },
  ) => {
    if (
      taskCompleted ||
      heartbeatClosed ||
      (!opts?.internal && taskExecutionReturned)
    ) {
      return;
    }
    const heartbeatAtMs = nowMs();
    let heartbeatDataJson: string | null = null;
    let dataSizeBytes = 0;
    try {
      if (data !== undefined) {
        const serialized = serializeHeartbeatPayload(data);
        heartbeatDataJson = serialized.heartbeatDataJson;
        dataSizeBytes = serialized.dataSizeBytes;
      }
    } catch (error) {
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

  const recordInternalHeartbeat = (data?: unknown) => {
    queueHeartbeat(data, { internal: true });
  };

  const waitForHeartbeatWriteDrain = async () => {
    while (heartbeatWriteInFlight) {
      await Bun.sleep(5);
    }
  };

  const attemptMeta: Record<string, unknown> = {
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

  await adapter.withTransaction(
    "task-start",
    Effect.gen(function* () {
      yield* adapter.insertAttemptEffect({
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
      yield* adapter.insertNodeEffect({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "in-progress",
        lastAttempt: attemptNo,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
    }),
  );

  await eventBus.emitEventWithPersist({
    type: "NodeStarted",
    runId,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    attempt: attemptNo,
    timestampMs: nowMs(),
  });

  let payload: any = null;
  let cached = false;
  let cacheKey: string | null = null;
  let cacheJjBase: string | null = null;
  let responseText: string | null = null;
  let effectiveAgent: any = null;
  // Resolve effective root once so both caching and execution share it.
  const taskRoot = desc.worktreePath ?? toolConfig.rootDir;
  const stepCacheEnabled = cacheEnabled || Boolean(desc.cachePolicy);

  const cacheAgent = Array.isArray(desc.agent) ? desc.agent[0] : desc.agent;
  let heartbeatWatchdogFiber: ReturnType<typeof Effect.runFork> | null = null;

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
      heartbeatWatchdogFiber = Effect.runFork(
        Effect.repeat(
          Effect.suspend(() => {
            const lastHeartbeatAtMs = Math.max(startedAtMs, heartbeatPendingAtMs);
            const staleForMs = nowMs() - lastHeartbeatAtMs;
            if (staleForMs <= desc.heartbeatTimeoutMs!) {
              return Effect.void;
            }

            const timeoutError = new SmithersError(
              "TASK_HEARTBEAT_TIMEOUT",
              `Task ${desc.nodeId} has not heartbeated in ${staleForMs}ms (timeout: ${desc.heartbeatTimeoutMs}ms).`,
              {
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                timeoutMs: desc.heartbeatTimeoutMs,
                staleForMs,
                lastHeartbeatAtMs,
              },
            );
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
              timeoutMs: desc.heartbeatTimeoutMs!,
              timestampMs: nowMs(),
            });
            taskAbortController.abort(timeoutError);
            return Effect.fail(timeoutError);
          }),
          Schedule.spaced(Duration.millis(TASK_HEARTBEAT_TIMEOUT_CHECK_MS)),
        ).pipe(Effect.flatMap(() => Effect.never)),
      );
    }
    if (desc.worktreePath) {
      await ensureWorktree(
        toolConfig.rootDir,
        desc.worktreePath,
        desc.worktreeBranch,
        desc.worktreeBaseBranch,
      );
    }
    if (stepCacheEnabled) {
      const schemaSig = schemaSignature(desc.outputTable as any);
      const outputSchemaSig = desc.outputSchema
        ? sha256Hex(describeSchemaShape(desc.outputTable as any, desc.outputSchema))
        : null;
      const agentSig = cacheAgent?.id ?? "agent";
      const toolsSig = hashCapabilityRegistry(cacheAgent?.capabilities ?? null);
      // Incorporate JJ state so workspace changes invalidate cache as documented.
      const jjBase = await getJjPointer(taskRoot);
      cacheJjBase = jjBase ?? null;

      let cacheBase: Record<string, unknown>;
      let cacheKeyDisabled = false;
      if (desc.cachePolicy) {
        let cachePayload: unknown = null;
        let cacheByOk = true;
        try {
          const ctx = await buildCacheContext(
            db,
            inputTable,
            runId,
            desc,
            descriptorMap,
            attemptNo,
          );
          if (desc.cachePolicy.by) {
            cachePayload = desc.cachePolicy.by(ctx);
          }
        } catch (err) {
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
      } else {
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
      } catch (err) {
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
        const cachedRow = await adapter.getCache(cacheKey);
        if (cachedRow) {
          const parsed = JSON.parse(cachedRow.payloadJson);
          const valid = validateOutput(desc.outputTable as any, parsed);
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
          } else {
            void Effect.runPromise(Metric.increment(cacheMisses));
          }
        } else {
          void Effect.runPromise(Metric.increment(cacheMisses));
        }
      }
    }

    let agentResult: any;
    let emitOutput = (_text: string, _stream: "stdout" | "stderr") => {};
    if (!payload) {
      const allAgents = Array.isArray(desc.agent) ? desc.agent : (desc.agent ? [desc.agent] : []);
      const agents = disabledAgents ? allAgents.filter((a: any) => !disabledAgents.has(a)) : allAgents;
      effectiveAgent = agents.length > 0
        ? agents[Math.min(attemptNo - 1, agents.length - 1)]
        : allAgents[Math.min(attemptNo - 1, allAgents.length - 1)]; // fallback to disabled agent if all disabled
      const priorToolCalls =
        attemptNo > 1
          ? await adapter.listToolCalls(runId, desc.nodeId, desc.iteration)
          : [];
      const toolResumeWarnings = collectToolResumeWarnings(
        priorToolCalls as any[],
        allAgents,
        attemptNo,
      );
      const toolResumeWarningMessage = buildToolResumeWarningMessage(toolResumeWarnings);
      emitOutput = (text: string, stream: "stdout" | "stderr") => {
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
          (effectiveAgent as any).id ??
          (effectiveAgent as any).constructor?.name ??
          null;
        attemptMeta.agentModel =
          (effectiveAgent as any).model ??
          (effectiveAgent as any).modelId ??
          null;
        const currentAgentEngine =
          typeof (effectiveAgent as any).cliEngine === "string"
            ? (effectiveAgent as any).cliEngine
            : typeof (effectiveAgent as any).hijackEngine === "string"
              ? (effectiveAgent as any).hijackEngine
              : (typeof (effectiveAgent as any).constructor?.name === "string"
                  ? (effectiveAgent as any).constructor.name
                  : null);
        attemptMeta.agentEngine = currentAgentEngine;
        const heartbeatCheckpoint =
          previousHeartbeat &&
          typeof previousHeartbeat === "object" &&
          !Array.isArray(previousHeartbeat)
            ? (previousHeartbeat as Record<string, unknown>)
            : null;
        const heartbeatCheckpointEngine =
          typeof heartbeatCheckpoint?.agentEngine === "string"
            ? heartbeatCheckpoint.agentEngine
            : null;
        const heartbeatCheckpointUsable =
          !currentAgentEngine ||
          !heartbeatCheckpointEngine ||
          heartbeatCheckpointEngine === currentAgentEngine;
        const checkpointResumeSession =
          heartbeatCheckpointUsable &&
          typeof heartbeatCheckpoint?.agentResume === "string"
            ? heartbeatCheckpoint.agentResume
            : undefined;
        const checkpointResumeMessages =
          heartbeatCheckpointUsable
            ? asConversationMessages(heartbeatCheckpoint?.agentConversation)
            : undefined;
        const priorContinuation =
          currentAgentEngine
            ? findHijackContinuation(attempts as any[], currentAgentEngine)
            : undefined;
        const resumeSession =
          priorContinuation?.mode === "native-cli"
            ? priorContinuation.resume
            : checkpointResumeSession;
        const resumeMessages =
          priorContinuation?.mode === "conversation"
            ? (cloneJsonValue(priorContinuation.messages) ?? priorContinuation.messages)
            : (cloneJsonValue(checkpointResumeMessages) ??
              checkpointResumeMessages);
        const guidedResumeMessages = appendToolResumeWarningMessage(
          resumeMessages,
          toolResumeWarningMessage,
        );
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
        await adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
          metaJson: JSON.stringify(attemptMeta),
        });

        const activeCliActions = new Set<string>();
        let conversationMessages = guidedResumeMessages ? [...guidedResumeMessages] : null;

        const updateConversation = (messages: unknown[] | undefined) => {
          const cloned = cloneJsonValue(messages);
          if (!cloned?.length) {
            return;
          }
          conversationMessages = cloned;
          attemptMeta.agentConversation = cloned;
          recordInternalHeartbeat({
            agentEngine:
              typeof attemptMeta.agentEngine === "string"
                ? attemptMeta.agentEngine
                : null,
            agentConversation: cloned,
          });
          maybeCompleteHijack();
        };

        let effectivePrompt = desc.prompt ?? "";
        if (desc.outputTable) {
          const schemaDesc = describeSchemaShape(desc.outputTable as any, desc.outputSchema);
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
        effectivePrompt = prependToolResumeWarningMessage(
          effectivePrompt,
          toolResumeWarningMessage,
        );

        const maybeCompleteHijack = () => {
          if (!hijackState?.request || hijackState.completion || !runAbortController) {
            return;
          }
          const target = hijackState.request.target ?? null;
          const engine =
            typeof attemptMeta.agentEngine === "string" ? attemptMeta.agentEngine : null;
          const resume =
            typeof attemptMeta.agentResume === "string" ? attemptMeta.agentResume : undefined;
          const messages = asConversationMessages(attemptMeta.agentConversation);
          const handoffMode =
            resume
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
          const completion: HijackCompletion = {
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

        const handleAgentEvent = (event: AgentCliEvent) => {
          attemptMeta.agentEngine = event.engine ?? attemptMeta.agentEngine;
          if ("resume" in event && typeof event.resume === "string") {
            attemptMeta.agentResume = event.resume;
            recordInternalHeartbeat({
              agentEngine: event.engine,
              agentResume: event.resume,
            });
          } else {
            recordInternalHeartbeat();
          }
          if (event.type === "completed" && !responseText && event.answer) {
            responseText = event.answer;
          }
          if (
            event.type === "action" &&
            isBlockingAgentActionKind(event.action.kind)
          ) {
            if (event.phase === "started") {
              activeCliActions.add(event.action.id);
            } else if (event.phase === "completed") {
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

        const handleSdkStepFinish = (stepResult: any) => {
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
              } catch {
                // Best-effort only; the normal event hooks still drive hijack.
              }
            }, 100)
          : undefined;

        // Use fallback agent on retry attempts when available
        let result: any;
        try {
          result = await Effect.runPromise(
            withSmithersSpan(
              smithersSpanNames.agent,
              Effect.promise(() =>
                runWithToolContext(
                  {
                    db: adapter,
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    rootDir: taskRoot,
                    allowNetwork: toolConfig.allowNetwork,
                    maxOutputBytes: toolConfig.maxOutputBytes,
                    timeoutMs: desc.timeoutMs ?? toolConfig.toolTimeoutMs,
                    seq: 0,
                    emitEvent: (event) => eventBus.emitEventQueued(event),
                  },
                  async () => {
                    const agentCall = guidedResumeMessages?.length
                      ? {
                          messages: guidedResumeMessages,
                        }
                      : {
                          prompt: effectivePrompt,
                        };
                    return (effectiveAgent as any).generate({
                      options: undefined as any,
                      abortSignal: taskSignal,
                      ...agentCall,
                      resumeSession,
                      lastHeartbeat: previousHeartbeat,
                      timeout: desc.timeoutMs
                        ? { totalMs: desc.timeoutMs }
                        : undefined,
                      onStdout: (text: string) => {
                        recordInternalHeartbeat();
                        emitOutput(text, "stdout");
                      },
                      onStderr: (text: string) => {
                        recordInternalHeartbeat();
                        emitOutput(text, "stderr");
                      },
                      onEvent: handleAgentEvent,
                      onStepFinish: handleSdkStepFinish,
                      outputSchema: desc.outputSchema,
                    });
                  },
                ),
              ),
              {
                ...taskSpanContext,
                agent:
                  attemptMeta.agentId ??
                  attemptMeta.agentEngine ??
                  "unknown",
                model: attemptMeta.agentModel,
              },
            ),
          );
        } finally {
          if (hijackPollingInterval) {
            clearInterval(hijackPollingInterval);
          }
        }

        agentResult = result;
        if (!conversationMessages) {
          const responseMessages = Array.isArray((result as any)?.response?.messages)
            ? (cloneJsonValue((result as any).response.messages) ?? (result as any).response.messages)
            : [];
          if (responseMessages.length > 0) {
            updateConversation([
              ...(resumeMessages?.length ? resumeMessages : [{ role: "user", content: effectivePrompt }]),
              ...responseMessages,
            ]);
          }
        } else {
          updateConversation(conversationMessages);
        }
        maybeCompleteHijack();

        // --- Track prompt/response sizes ---
        const promptBytes = Buffer.byteLength(desc.prompt ?? "", "utf8");
        void Effect.runPromise(Metric.update(promptSizeBytes, promptBytes));

        responseText = (result as any).text ?? null;
        if (responseText) {
          void Effect.runPromise(Metric.update(responseSizeBytes, Buffer.byteLength(responseText, "utf8")));
        }

        // --- Track token usage ---
        const usage = (result as any).usage ?? (result as any).totalUsage;
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
              model: (effectiveAgent as any).model ?? (effectiveAgent as any).id ?? "unknown",
              agent: (effectiveAgent as any).id ?? (effectiveAgent as any).constructor?.name ?? "unknown",
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              reasoningTokens,
              timestampMs: nowMs(),
            });
          }
        }
        let output: any;

        // Try structured output first (wrapping in try/catch since getters may throw)
        try {
          if (
            (result as any)._output !== undefined &&
            (result as any)._output !== null
          ) {
            output = (result as any)._output;
          } else if (
            (result as any).output !== undefined &&
            (result as any).output !== null
          ) {
            output = (result as any).output;
          }
        } catch {
          // Structured output access threw
        }

        // Fall back to parsing text/steps for JSON
        if (output === undefined) {
          const text = (result as any).text ?? "";

          // Try to parse the whole text as JSON first
          try {
            const trimmed = text.trim();
            if (trimmed.startsWith("{")) {
              output = JSON.parse(trimmed);
            }
          } catch {
            // Not valid JSON, try extraction
          }

          // Helper to extract balanced JSON from text (first occurrence)
          function extractBalancedJson(str: string): string | null {
            const start = str.indexOf("{");
            if (start === -1) return null;
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
              if (inString) continue;
              if (c === "{") depth++;
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
          function extractLastBalancedJson(str: string): string | null {
            let pos = str.lastIndexOf("{");
            while (pos >= 0) {
              const json = extractBalancedJson(str.slice(pos));
              if (json !== null) return json;
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
                } catch {
                  // Not valid JSON in code fence
                }
              }
            }

            // Check all steps for code fences with balanced JSON
            if (output === undefined) {
              const steps = (result as any).steps ?? [];
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
                    } catch {
                      // Not valid JSON
                    }
                  }
                }
              }
            }
          }

          // Extract JSON object using balanced brace matching
          if (output === undefined) {
            const steps = (result as any).steps ?? [];
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
                } catch {
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
              } catch {
                // Not valid JSON
              }
            }
          }

          // If no JSON found, send a follow-up prompt asking for just the JSON with schema info
          if (output === undefined && desc.agent) {
            const schemaDesc = describeSchemaShape(desc.outputTable as any, desc.outputSchema);
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
            const retryResult = await (effectiveAgent as any).generate({
              options: undefined as any,
              abortSignal: taskSignal,
              prompt: jsonPrompt,
              timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
              onStdout: (text: string) => {
                recordInternalHeartbeat();
                emitOutput(text, "stdout");
              },
              onStderr: (text: string) => {
                recordInternalHeartbeat();
                emitOutput(text, "stderr");
              },
            });
            const retryText = (retryResult as any).text ?? "";
            responseText = retryText || responseText;
            try {
              const trimmed = retryText.trim();
              if (trimmed.startsWith("{")) {
                output = JSON.parse(trimmed);
              }
            } catch {
              // Still not valid JSON
            }
            if (output === undefined) {
              // Try extracting balanced JSON from retry text
              const jsonStr = extractBalancedJson(retryText);
              if (jsonStr) {
                try {
                  output = JSON.parse(jsonStr);
                } catch {
                  // Not valid JSON
                }
              }
            }
          }

          if (output === undefined) {
            // Debug: log what we have
            const debugSteps = (result as any).steps ?? [];
            const stepTexts = debugSteps.map(
              (s: any, i: number) =>
                `Step ${i}: ${(s?.text ?? "").slice(0, 200)}`,
            );
            const finishReason = (result as any).finishReason ?? "unknown";
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
              lastStepText:
                debugSteps[debugSteps.length - 1]?.text?.slice(0, 500) ??
                "none",
            }, "engine:task-json");
            throw new SmithersError("INVALID_OUTPUT", "No valid JSON output found in agent response");
          }
        }

        // Output should already be parsed, but handle string case
        if (typeof output === "string") {
          try {
            payload = JSON.parse(output);
          } catch (e) {
            throw new SmithersError(
              "INVALID_OUTPUT",
              `Failed to parse agent output as JSON. Output starts with: "${output.slice(0, 100)}"`,
            );
          }
        } else {
          payload = output;
        }
      } else if (desc.computeFn) {
        const computePromise = Promise.resolve().then(() =>
          withTaskRuntime(
            {
              runId,
              stepId: desc.nodeId,
              attempt: attemptNo,
              iteration: desc.iteration,
              signal: taskSignal,
              db,
              heartbeat: (data?: unknown) => {
                queueHeartbeat(data);
              },
              lastHeartbeat: previousHeartbeat,
            },
            () => desc.computeFn!(),
          ),
        );
        const races: Array<Promise<unknown>> = [computePromise];
        if (desc.timeoutMs) {
          races.push(
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new SmithersError(
                      "TASK_TIMEOUT",
                      `Compute callback timed out after ${desc.timeoutMs}ms`,
                      {
                        attempt: attemptNo,
                        nodeId: desc.nodeId,
                        timeoutMs: desc.timeoutMs,
                      },
                    ),
                  ),
                desc.timeoutMs!,
              ),
            ),
          );
        }
        const abort = abortPromise(taskSignal);
        if (abort) races.push(abort);
        payload = await Promise.race(races);
      } else {
        payload = desc.staticPayload;
      }
    }

    payload = stripAutoColumns(payload);
    const payloadWithKeys = buildOutputRow(
      desc.outputTable as any,
      runId,
      desc.nodeId,
      desc.iteration,
      payload,
    );
    let validation = validateOutput(desc.outputTable as any, payloadWithKeys);

    // If the Drizzle insert schema passed but we have a stricter Zod schema
    // from the user, validate against that too. This catches cases where e.g.
    // a JSON text column accepts any valid JSON but the Zod schema requires
    // a specific shape (array vs string, enum values, etc).
    if (validation.ok && desc.outputSchema) {
      const zodResult = (desc.outputSchema as z.ZodType).safeParse(payload);
      if (!zodResult.success) {
        validation = { ok: false, error: zodResult.error };
      }
    }

    const toInvalidOutputError = (
      cause: unknown,
      schemaRetryAttempts: number,
    ) =>
      new SmithersError(
        "INVALID_OUTPUT",
        `Task output failed validation for ${desc.outputTableName}`,
        {
          attempt: attemptNo,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          outputTable: desc.outputTableName,
          schemaRetryAttempts,
          issues:
            cause && typeof cause === "object" && "issues" in (cause as any)
              ? (cause as any).issues
              : undefined,
        },
        { cause },
      );

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
    let schemaRetryMessages: Array<{ role: string; content: string }> = [];
    if (!validation.ok && desc.agent && effectiveAgent) {
      // Seed from the original result when available
      const originalResponseMessages = agentResult?.response?.messages;
      if (Array.isArray(originalResponseMessages) && originalResponseMessages.length > 0) {
        // Start with the original prompt as a user message
        schemaRetryMessages = [
          { role: "user", content: desc.prompt ?? "" },
          ...originalResponseMessages,
        ];
      } else {
        // Fallback: reconstruct from the text we captured
        schemaRetryMessages = [
          { role: "user", content: desc.prompt ?? "" },
          { role: "assistant", content: responseText ?? "" },
        ];
      }
    }

    while (!validation.ok && desc.agent && schemaRetry < MAX_SCHEMA_RETRIES) {
        schemaRetry++;
        const schemaDesc = describeSchemaShape(desc.outputTable as any, desc.outputSchema);
        const zodIssues =
          validation.error?.issues
            ?.map(
              (iss: any) => `  - ${(iss.path ?? []).join(".")}: ${iss.message}`,
            )
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

        const schemaRetryResult = await runWithToolContext(
          {
            db: adapter,
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            rootDir: taskRoot,
            allowNetwork: toolConfig.allowNetwork,
            maxOutputBytes: toolConfig.maxOutputBytes,
            timeoutMs: desc.timeoutMs ?? toolConfig.toolTimeoutMs,
            seq: 0,
            emitEvent: (event) => eventBus.emitEventQueued(event),
          },
          async () => (effectiveAgent as any).generate({
            options: undefined as any,
            abortSignal: taskSignal,
            messages: retryMessages,
            timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
            onStdout: (text: string) => {
              recordInternalHeartbeat();
              emitOutput(text, "stdout");
            },
            onStderr: (text: string) => {
              recordInternalHeartbeat();
              emitOutput(text, "stderr");
            },
          }),
        );
        const retryText = ((schemaRetryResult as any).text ?? "").trim();
        responseText = retryText || responseText;

        // Update conversation history for the next iteration
        const retryResponseMessages = (schemaRetryResult as any)?.response?.messages;
        if (Array.isArray(retryResponseMessages) && retryResponseMessages.length > 0) {
          schemaRetryMessages = [
            ...retryMessages,
            ...retryResponseMessages,
          ];
        } else {
          schemaRetryMessages = [
            ...retryMessages,
            { role: "assistant", content: retryText },
          ];
        }
        attemptMeta.agentConversation =
          cloneJsonValue(schemaRetryMessages) ?? schemaRetryMessages;

        // Try to parse the retry response
        let retryOutput: any;
        try {
          if (retryText.startsWith("{") || retryText.startsWith("[")) {
            retryOutput = JSON.parse(retryText);
          }
        } catch {
          // Not valid JSON directly, try extraction
        }
        if (retryOutput === undefined) {
          // Try code-fence extraction
          const fenceMatch = retryText.match(
            /```(?:json)?\s*(\{[\s\S]*?\})\s*```/,
          );
          if (fenceMatch) {
            try {
              retryOutput = JSON.parse(fenceMatch[1]!);
            } catch {}
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
              if (esc) { esc = false; continue; }
              if (c === "\\") { esc = true; continue; }
              if (c === '"' && !esc) { inStr = !inStr; continue; }
              if (inStr) continue;
              if (c === "{") depth++;
              else if (c === "}") {
                depth--;
                if (depth === 0) {
                  try {
                    retryOutput = JSON.parse(retryText.slice(jsonStart, i + 1));
                  } catch {}
                  break;
                }
              }
            }
          }
        }

        if (retryOutput && typeof retryOutput === "object") {
          payload = stripAutoColumns(retryOutput);
          const retryPayload = buildOutputRow(
            desc.outputTable as any,
            runId,
            desc.nodeId,
            desc.iteration,
            payload,
          );
          validation = validateOutput(desc.outputTable as any, retryPayload);
          if (validation.ok && desc.outputSchema) {
            const zodCheck = (desc.outputSchema as z.ZodType).safeParse(payload);
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
    await eventBus.flush();
    // Reuse the resolved taskRoot for JJ pointer capture to avoid recomputing.
    const jjPointer = await getJjPointer(taskRoot);

    await waitForHeartbeatWriteDrain();
    await flushHeartbeat(true);
    taskCompleted = true;
    const completedAtMs = nowMs();
    await adapter.withTransaction(
      "task-completion",
      Effect.gen(function* () {
        yield* adapter.upsertOutputRowEffect(
          desc.outputTable as any,
          { runId, nodeId: desc.nodeId, iteration: desc.iteration },
          payload,
        );
        if (stepCacheEnabled && cacheKey && !cached) {
          yield* adapter.insertCacheEffect({
            cacheKey,
            createdAtMs: completedAtMs,
            workflowName,
            nodeId: desc.nodeId,
            outputTable: desc.outputTableName,
            schemaSig: schemaSignature(desc.outputTable as any),
            outputSchemaSig: desc.outputSchema
              ? sha256Hex(
                  describeSchemaShape(desc.outputTable as any, desc.outputSchema),
                )
              : null,
            agentSig: cacheAgent?.id ?? "agent",
            toolsSig: hashCapabilityRegistry(cacheAgent?.capabilities ?? null),
            jjPointer: cacheJjBase,
            payloadJson: JSON.stringify(payload),
          });
        }
        yield* adapter.updateAttemptEffect(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          {
            state: "finished",
            finishedAtMs: completedAtMs,
            jjPointer,
            cached,
            metaJson: JSON.stringify(attemptMeta),
            responseText,
          },
        );
        yield* adapter.insertNodeEffect({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "finished",
          lastAttempt: attemptNo,
          updatedAtMs: completedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
      }),
    );

    await eventBus.emitEventWithPersist({
      type: "NodeFinished",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      timestampMs: nowMs(),
    });
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
      runScorersAsync(
        desc.scorers as RuntimeScorersMap,
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          input: desc.prompt ?? desc.staticPayload ?? null,
          output: payload,
          latencyMs: taskElapsedMs,
          outputSchema: desc.outputSchema,
        },
        adapter,
        eventBus,
      );
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
  } catch (err) {
    try {
      await eventBus.flush();
    } catch (flushError) {
      logError("failed to flush queued task events", {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        error:
          flushError instanceof Error
            ? flushError.message
            : String(flushError),
      }, "engine:task-events");
    }
    const heartbeatTimeoutError = heartbeatTimeoutReasonFromAbort(
      taskSignal,
      err,
    );
    const effectiveError = heartbeatTimeoutError ?? err;
    if (isHeartbeatPayloadValidationError(effectiveError)) {
      attemptMeta.failureRetryable = false;
    }
    if (!heartbeatTimeoutError && (taskSignal.aborted || isAbortError(err))) {
      await waitForHeartbeatWriteDrain();
      await flushHeartbeat(true);
      taskCompleted = true;
      const cancelledAtMs = nowMs();
      await adapter.withTransaction(
        "task-cancel",
        Effect.gen(function* () {
          yield* adapter.updateAttemptEffect(
            runId,
            desc.nodeId,
            desc.iteration,
            attemptNo,
            {
              state: "cancelled",
              finishedAtMs: cancelledAtMs,
              errorJson: JSON.stringify(errorToJson(effectiveError)),
              metaJson: JSON.stringify(attemptMeta),
              responseText,
            },
          );
          yield* adapter.insertNodeEffect({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "cancelled",
            lastAttempt: attemptNo,
            updatedAtMs: cancelledAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
        }),
      );
      await eventBus.emitEventWithPersist({
        type: "NodeCancelled",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        reason: "aborted",
        timestampMs: nowMs(),
      });
      await annotateTaskSpan({
        status: "cancelled",
      });
      logInfo("task execution cancelled", {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        error:
          effectiveError instanceof Error
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
      error:
        effectiveError instanceof Error
          ? effectiveError.message
          : String(effectiveError),
    }, "engine:task");
    const failedAtMs = nowMs();
    await adapter.withTransaction(
      "task-fail",
      Effect.gen(function* () {
        yield* adapter.updateAttemptEffect(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          {
            state: "failed",
            finishedAtMs: failedAtMs,
            errorJson: JSON.stringify(errorToJson(effectiveError)),
            metaJson: JSON.stringify(attemptMeta),
            responseText,
          },
        );
        yield* adapter.insertNodeEffect({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "failed",
          lastAttempt: attemptNo,
          updatedAtMs: failedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
      }),
    );

    // Circuit-breaker: disable agents that fail with auth errors
    if (disabledAgents && effectiveAgent) {
      const errStr =
        String(
          (effectiveError as any)?.message ??
            effectiveError ??
            "",
        ) + (responseText ?? "");
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

    await eventBus.emitEventWithPersist({
      type: "NodeFailed",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      error: errorToJson(effectiveError),
      timestampMs: nowMs(),
    });
    await annotateTaskSpan({
      status: "failed",
    });

    const attempts = await adapter.listAttempts(
      runId,
      desc.nodeId,
      desc.iteration,
    );
    if (
      attempts.filter((a: any) => a.state === "failed").length <= desc.retries
    ) {
      await eventBus.emitEventWithPersist({
        type: "NodeRetrying",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo + 1,
        timestampMs: nowMs(),
      });
      logInfo("task scheduled for retry", {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        failedAttempt: attemptNo,
        nextAttempt: attemptNo + 1,
      }, "engine:task");
    }
  } finally {
    taskCompleted = true;
    heartbeatClosed = true;
    if (heartbeatWatchdogFiber) {
      await Effect.runPromise(Fiber.interrupt(heartbeatWatchdogFiber)).catch(() => {});
      heartbeatWatchdogFiber = null;
    }
    if (heartbeatWriteTimer) {
      clearTimeout(heartbeatWriteTimer);
      heartbeatWriteTimer = undefined;
    }
    removeAbortForwarder();
  }
}

async function renderFrameAsync<Schema>(
  workflow: SmithersWorkflow<Schema>,
  ctx: any,
  opts?: { baseRootDir?: string; workflowPath?: string | null },
): Promise<GraphSnapshot> {
  const renderer = new SmithersRenderer();
  const result = await renderer.render(workflow.build(ctx), {
    ralphIterations: ctx?.iterations,
    baseRootDir: opts?.baseRootDir,
    workflowPath: opts?.workflowPath,
    defaultIteration: ctx?.iteration,
  });
  const tasks = result.tasks as unknown as TaskDescriptor[];

  // Resolve output tasks: ZodObject references via zodToKeyName, string keys via schemaRegistry
  resolveTaskOutputs(tasks, workflow);
  attachSubflowComputeFns(tasks, workflow, {
    rootDir: opts?.baseRootDir,
    workflowPath: opts?.workflowPath,
  });

  return { runId: ctx.runId, frameNo: 0, xml: result.xml, tasks };
}

export function renderFrameEffect<Schema>(
  workflow: SmithersWorkflow<Schema>,
  ctx: any,
  opts?: { baseRootDir?: string; workflowPath?: string | null },
) {
  return fromPromise("render frame", () => renderFrameAsync(workflow, ctx, opts)).pipe(
    Effect.annotateLogs({
      runId: ctx?.runId ?? "",
      iteration: ctx?.iteration ?? 0,
    }),
    Effect.withLogSpan("engine:render-frame"),
  );
}

export async function renderFrame<Schema>(
  workflow: SmithersWorkflow<Schema>,
  ctx: any,
  opts?: { baseRootDir?: string; workflowPath?: string | null },
): Promise<GraphSnapshot> {
  return Effect.runPromise(renderFrameEffect(workflow, ctx, opts));
}

async function releaseResumeClaimQuietly(
  adapter: SmithersDb,
  runId: string,
  cleanup: ResumeClaimCleanup,
) {
  try {
    await adapter.releaseRunResumeClaim({
      runId,
      claimOwnerId: cleanup.claimOwnerId,
      restoreRuntimeOwnerId: cleanup.restoreRuntimeOwnerId,
      restoreHeartbeatAtMs: cleanup.restoreHeartbeatAtMs,
    });
  } catch (error) {
    logWarning("failed to release resume claim", {
      runId,
      claimOwnerId: cleanup.claimOwnerId,
      error: error instanceof Error ? error.message : String(error),
    }, "engine:resume");
  }
}

async function activateRunForResume(
  adapter: SmithersDb,
  existingRun: any,
  opts: RunOptions,
  runtimeOwnerId: string,
  runConfigJson: string,
  runMetadata: RunDurabilityMetadata,
  workflowPath: string | null,
) {
  if (!isResumableRunStatus(existingRun?.status)) {
    throw new SmithersError(
      "RUN_NOT_RESUMABLE",
      `Run ${existingRun?.runId ?? opts.runId ?? "unknown"} cannot be resumed from status ${existingRun?.status ?? "unknown"}.`,
      {
        runId: existingRun?.runId ?? opts.runId ?? null,
        status: existingRun?.status ?? null,
      },
    );
  }

  const ownerPid = parseRuntimeOwnerPid(existingRun.runtimeOwnerId);
  if (
    existingRun.status === "running" &&
    ownerPid !== null &&
    isPidAlive(ownerPid)
  ) {
    throw new SmithersError(
      "RUN_OWNER_ALIVE",
      `Run ${existingRun.runId} still belongs to live process ${ownerPid}.`,
      {
        runId: existingRun.runId,
        runtimeOwnerId: existingRun.runtimeOwnerId ?? null,
        ownerPid,
      },
    );
  }

  const claimOwnerId = opts.resumeClaim?.claimOwnerId ?? runtimeOwnerId;
  const claimHeartbeatAtMs =
    opts.resumeClaim?.claimHeartbeatAtMs ?? nowMs();
  const cleanup: ResumeClaimCleanup = {
    claimOwnerId,
    restoreRuntimeOwnerId:
      opts.resumeClaim?.restoreRuntimeOwnerId ??
      existingRun.runtimeOwnerId ??
      null,
    restoreHeartbeatAtMs:
      opts.resumeClaim?.restoreHeartbeatAtMs ??
      existingRun.heartbeatAtMs ??
      null,
  };

  let claimHeld = false;
  try {
    if (opts.resumeClaim) {
      const claimedRun = await adapter.getRun(existingRun.runId);
      if (
        !claimedRun ||
        claimedRun.runtimeOwnerId !== claimOwnerId ||
        (claimedRun.heartbeatAtMs ?? null) !== claimHeartbeatAtMs
      ) {
        throw new SmithersError(
          "RUN_RESUME_CLAIM_LOST",
          `Resume claim for run ${existingRun.runId} is no longer held.`,
          {
            runId: existingRun.runId,
            claimOwnerId,
            claimHeartbeatAtMs,
          },
        );
      }
      claimHeld = true;
    } else {
      if (existingRun.status === "running") {
        const fresh = isRunHeartbeatFresh(existingRun);
        if (fresh && !opts.force) {
          throw new SmithersError(
            "RUN_STILL_RUNNING",
            `Run ${existingRun.runId} is still actively running.`,
            {
              runId: existingRun.runId,
              heartbeatAtMs: existingRun.heartbeatAtMs ?? null,
            },
          );
        }
      }

      const claimed = await adapter.claimRunForResume({
        runId: existingRun.runId,
        expectedStatus: existingRun.status,
        expectedRuntimeOwnerId: existingRun.runtimeOwnerId ?? null,
        expectedHeartbeatAtMs: existingRun.heartbeatAtMs ?? null,
        staleBeforeMs: nowMs() - RUN_HEARTBEAT_STALE_MS,
        claimOwnerId,
        claimHeartbeatAtMs,
        requireStale: existingRun.status === "running" ? !opts.force : false,
      });
      if (!claimed) {
        throw new SmithersError(
          "RUN_RESUME_CLAIM_FAILED",
          `Failed to acquire durable resume claim for run ${existingRun.runId}.`,
          {
            runId: existingRun.runId,
            status: existingRun.status,
          },
        );
      }
      claimHeld = true;
    }

    const activatedAtMs = nowMs();
    const activated = await adapter.updateClaimedRun({
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
        workflowPath:
          workflowPath ??
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
    });
    if (!activated) {
      throw new SmithersError(
        "RUN_RESUME_ACTIVATION_FAILED",
        `Run ${existingRun.runId} changed before the resume claim could be activated.`,
        {
          runId: existingRun.runId,
          claimOwnerId,
          claimHeartbeatAtMs,
        },
      );
    }
  } catch (error) {
    if (claimHeld) {
      await releaseResumeClaimQuietly(adapter, existingRun.runId, cleanup);
    }
    throw error;
  }
}

async function runWorkflowAsync<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunResult> {
  validateRunOptions(opts);
  const runId = opts.runId ?? newRunId();
  return runWithCorrelationContext(
    {
      runId,
      parentRunId: opts.parentRunId ?? undefined,
      workflowName: "workflow",
    },
    () =>
      runWorkflowWithMakeBridge(
        workflow,
        {
          ...opts,
          runId,
        },
        runWorkflowBody,
      ),
  );
}

async function runWorkflowBody<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunBodyResult> {
  if (process.env.SMITHERS_LEGACY_ENGINE === "1") {
    return runWorkflowBodyLegacy(workflow, opts);
  }
  return runWorkflowBodyDriver(workflow, opts);
}

function iterationsToMap(
  iterations?: ReadonlyMap<string, number> | Record<string, number> | null,
): Map<string, number> {
  if (!iterations) return new Map();
  if (typeof (iterations as ReadonlyMap<string, number>).entries === "function") {
    return new Map(iterations as ReadonlyMap<string, number>);
  }
  return new Map(Object.entries(iterations as Record<string, number>));
}

function ralphStateFromDriverTransition(
  transition: unknown,
): RalphStateMap | undefined {
  const payload =
    transition &&
    typeof transition === "object" &&
    "statePayload" in transition
      ? (transition as { statePayload?: unknown }).statePayload
      : undefined;
  const raw =
    payload &&
    typeof payload === "object" &&
    "ralphState" in payload
      ? (payload as { ralphState?: unknown }).ralphState
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const state: RalphStateMap = new Map();
  for (const [ralphId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const iteration = Number((value as any).iteration);
    state.set(ralphId, {
      iteration: Number.isFinite(iteration) ? iteration : 0,
      done: Boolean((value as any).done),
    });
  }
  return state;
}

async function runWorkflowBodyDriver<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunBodyResult> {
  const db = workflow.db as any;
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  const runId = opts.runId ?? newRunId();
  const schema = resolveSchema(db);
  const inputTable = schema.input;
  if (!inputTable) {
    throw new SmithersError(
      "MISSING_INPUT_TABLE",
      "Schema must include input table",
    );
  }

  const resolvedWorkflowPath = opts.workflowPath
    ? resolve(opts.workflowPath)
    : null;
  const rootDir = resolveRootDir(opts, resolvedWorkflowPath);
  const logDir = resolveLogDir(rootDir, runId, opts.logDir);
  const maxConcurrency = coercePositiveInt(
    "maxConcurrency",
    opts.maxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
  );
  const maxOutputBytes = coercePositiveInt(
    "maxOutputBytes",
    opts.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const toolTimeoutMs = coercePositiveInt(
    "toolTimeoutMs",
    opts.toolTimeoutMs,
    DEFAULT_TOOL_TIMEOUT_MS,
  );
  const allowNetwork = Boolean(opts.allowNetwork);
  const runtimeOwnerId = buildRuntimeOwnerId();
  const runAbortController = new AbortController();
  const hijackState: HijackState = {
    request: null,
    completion: null,
  };
  const detachAbort = wireAbortSignal(runAbortController, opts.signal);
  let stopSupervisor = async () => {};
  const runMetadata = await getRunDurabilityMetadata(
    resolvedWorkflowPath,
    rootDir,
  );

  const lastSeq = await adapter.getLastEventSeq(runId);
  const eventBus = new EventBus({
    db: adapter,
    logDir,
    startSeq: (lastSeq ?? -1) + 1,
  });
  if (opts.onProgress) {
    eventBus.on("event", (e: SmithersEvent) => opts.onProgress?.(e));
  }

  const wakeLock = acquireCaffeinate();
  let alertRuntime: AlertRuntime | null = null;
  let runOwnedByCurrentProcess = false;
  let driverTaskError: unknown = null;
  const activeDriverTaskKeys = new Set<string>();
  const annotateRunSpan = (
    attributes: Readonly<Record<string, unknown>>,
  ) =>
    Effect.runPromise(
      annotateSmithersTrace({
        runId,
        ...attributes,
      }),
    );

  let workflowSession: ReturnType<typeof makeWorkflowSession>;
  const renderer = new SmithersRenderer();
  const disabledAgents = new Set<any>();
  const toolConfig = {
    rootDir,
    allowNetwork,
    maxOutputBytes,
    toolTimeoutMs,
  };
  let frameNo = (await adapter.getLastFrame(runId))?.frameNo ?? 0;
  let defaultIteration = 0;
  let workflowRef = workflow;
  let lastGraph: WorkflowGraph | null = null;
  let descriptorMap = new Map<string, TaskDescriptor>();
  let workflowName = "workflow";
  let cacheEnabled = Boolean(workflow.opts.cache);
  let ralphState: RalphStateMap = new Map();

  let activeTaskCount = 0;
  const taskWaiters: Array<() => void> = [];
  const acquireTaskSlot = async () => {
    if (activeTaskCount < maxConcurrency) {
      activeTaskCount += 1;
      return;
    }
    await new Promise<void>((resolveWaiter) => {
      taskWaiters.push(resolveWaiter);
    });
    activeTaskCount += 1;
  };
  const releaseTaskSlot = () => {
    activeTaskCount = Math.max(0, activeTaskCount - 1);
    const next = taskWaiters.shift();
    next?.();
  };
  const withTaskSlot = async <A>(execute: () => Promise<A>): Promise<A> => {
    await acquireTaskSlot();
    try {
      return await execute();
    } finally {
      releaseTaskSlot();
    }
  };

  const waitForAbortedTasksToSettle = async () => {
    const deadlineAt = nowMs() + RUN_ABORT_SETTLE_TIMEOUT_MS;
    while (true) {
      const inProgress = await adapter.listInProgressAttempts(runId);
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

  const readTaskOutput = async (task: TaskDescriptor): Promise<unknown> => {
    if (!task.outputTable) return undefined;
    const outputRow = await selectOutputRow<any>(db, task.outputTable as any, {
      runId,
      nodeId: task.nodeId,
      iteration: task.iteration,
    });
    return outputRow ? stripAutoColumns(outputRow) : undefined;
  };

  const readTaskFailure = async (task: TaskDescriptor): Promise<unknown> => {
    const attempts = await adapter.listAttempts(
      runId,
      task.nodeId,
      task.iteration,
    );
    const latest = attempts[0] as { errorJson?: string | null } | undefined;
    if (latest?.errorJson) {
      try {
        return JSON.parse(latest.errorJson);
      } catch {
        return latest.errorJson;
      }
    }
    return new SmithersError(
      "TASK_FAILED",
      `Task ${task.nodeId} failed.`,
      { nodeId: task.nodeId, iteration: task.iteration },
    );
  };

  const completeSessionTask = async (task: TaskDescriptor) =>
    Effect.runPromise(
      workflowSession.taskCompleted({
        nodeId: task.nodeId,
        iteration: task.iteration,
        output: await readTaskOutput(task),
      }),
    );

  const failSessionTask = async (task: TaskDescriptor) =>
    Effect.runPromise(
      workflowSession.taskFailed({
        nodeId: task.nodeId,
        iteration: task.iteration,
        error: await readTaskFailure(task),
      }),
    );

  const submitLastGraph = async () => {
    if (!lastGraph) {
      return {
        _tag: "Wait",
        reason: { _tag: "ExternalTrigger" },
      } satisfies EngineDecision;
    }
    return Effect.runPromise(workflowSession.submitGraph(lastGraph));
  };

  const markRunWaiting = async (
    status: "waiting-approval" | "waiting-event" | "waiting-timer",
    waitReason: "approval" | "event" | "timer",
  ): Promise<RunResult> => {
    await adapter.updateRun(runId, {
      status,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
    });
    await eventBus.emitEventWithPersist({
      type: "RunStatusChanged",
      runId,
      status,
      timestampMs: nowMs(),
    });
    await annotateRunSpan({
      status,
      waitReason,
    });
    return { runId, status };
  };

  const reconcileApprovalWait = async (nodeId: string) => {
    const task = lastGraph?.tasks.find((candidate) => candidate.nodeId === nodeId);
    if (!task) {
      return markRunWaiting("waiting-approval", "approval");
    }
    const approvalResolutionPayload = (approval: {
      note?: string | null;
      decidedBy?: string | null;
      decisionJson?: string | null;
    }) => ({
      note: approval.note ?? undefined,
      decidedBy: approval.decidedBy ?? undefined,
      payload: approval.decisionJson
        ? JSON.parse(approval.decisionJson)
        : undefined,
    });
    const resolveSessionApproval = async (
      approval: {
        status?: string | null;
        note?: string | null;
        decidedBy?: string | null;
        decisionJson?: string | null;
      },
      approved: boolean,
    ) =>
      Effect.runPromise(
        workflowSession.approvalResolved(task.nodeId, {
          approved,
          ...approvalResolutionPayload(approval),
        }),
      );
    const shouldExecuteDeniedApprovalTask = (approval: { status?: string | null }) =>
      approval.status === "denied" &&
      task.approvalMode !== "gate" &&
      task.approvalOnDeny !== "fail";
    const resolved = await resolveDeferredTaskStateBridge(
      adapter,
      db,
      runId,
      task as TaskDescriptor,
      eventBus,
    );
    if (resolved.handled) {
      if (resolved.state === "finished" || resolved.state === "skipped") {
        return completeSessionTask(task as TaskDescriptor);
      }
      if (resolved.state === "failed") {
        const approval = await adapter.getApproval(
          runId,
          task.nodeId,
          task.iteration,
        );
        if (approval?.status === "denied") {
          return resolveSessionApproval(approval, false);
        }
        return failSessionTask(task as TaskDescriptor);
      }
      if (resolved.state === "pending") {
        const approval = await adapter.getApproval(
          runId,
          task.nodeId,
          task.iteration,
        );
        if (approval && shouldExecuteDeniedApprovalTask(approval)) {
          return resolveSessionApproval(approval, true);
        }
        return submitLastGraph();
      }
      return markRunWaiting("waiting-approval", "approval");
    }

    const approval = await adapter.getApproval(runId, task.nodeId, task.iteration);
    if (approval?.status === "approved" || approval?.status === "denied") {
      return resolveSessionApproval(approval, approval.status === "approved");
    }
    return markRunWaiting("waiting-approval", "approval");
  };

  const reconcileEventWait = async (eventName: string) => {
    const tasks =
      lastGraph?.tasks.filter(
        (candidate) =>
          candidate.meta?.__waitForEvent &&
          (eventName.length === 0 ||
            candidate.meta?.__eventName === eventName),
      ) ?? [];
    for (const task of tasks) {
      const resolved = await resolveDeferredTaskStateBridge(
        adapter,
        db,
        runId,
        task as TaskDescriptor,
        eventBus,
      );
      if (!resolved.handled) continue;
      if (resolved.state === "finished" || resolved.state === "skipped") {
        return completeSessionTask(task as TaskDescriptor);
      }
      if (resolved.state === "failed") {
        return failSessionTask(task as TaskDescriptor);
      }
      if (resolved.state === "pending") {
        return submitLastGraph();
      }
    }
    return markRunWaiting("waiting-event", "event");
  };

  const reconcileTimerWait = async (resumeAtMs: number) => {
    const sessionStates = await Effect.runPromise(workflowSession.getTaskStates());
    const tasks =
      lastGraph?.tasks.filter((candidate) => {
        if (!candidate.meta?.__timer) return false;
        const state = sessionStates.get(
          buildStateKey(candidate.nodeId, candidate.iteration),
        );
        return (
          state !== "finished" &&
          state !== "skipped" &&
          state !== "failed" &&
          state !== "cancelled"
        );
      }) ?? [];
    for (const task of tasks) {
      const resolved = await resolveDeferredTaskStateBridge(
        adapter,
        db,
        runId,
        task as TaskDescriptor,
        eventBus,
      );
      if (!resolved.handled) continue;
      if (resolved.state === "finished") {
        return Effect.runPromise(workflowSession.timerFired(task.nodeId, nowMs()));
      }
      if (resolved.state === "failed") {
        return failSessionTask(task as TaskDescriptor);
      }
      if (resolved.state === "skipped") {
        return completeSessionTask(task as TaskDescriptor);
      }
    }
    const waitMs = Math.max(0, resumeAtMs - nowMs());
    if (waitMs <= 0) {
      return submitLastGraph();
    }
    return markRunWaiting("waiting-timer", "timer");
  };

  const handleDriverWait = async (
    reason: WaitReason,
  ): Promise<EngineDecision | RunResult> => {
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

  const executeDriverTask = async (task: TaskDescriptor): Promise<unknown> =>
    withTaskSlot(async () => {
      const taskKey = buildStateKey(task.nodeId, task.iteration);
      activeDriverTaskKeys.add(taskKey);
      try {
        const existingOutput = await readTaskOutput(task);
        if (existingOutput !== undefined) {
          await adapter.insertNode({
            runId,
            nodeId: task.nodeId,
            iteration: task.iteration,
            state: "finished",
            lastAttempt: null,
            updatedAtMs: nowMs(),
            outputTable: task.outputTableName,
            label: task.label ?? null,
          });
          return existingOutput;
        }

        const attempts = await adapter.listAttempts(
          runId,
          task.nodeId,
          task.iteration,
        );
        const failedAttempts = attempts.filter((attempt: any) => attempt.state === "failed");
        const hasNonRetryableFailure = failedAttempts.some(
          (attempt) => !isRetryableTaskFailure(attempt),
        );
        if (
          hasNonRetryableFailure ||
          failedAttempts.length >= task.retries + 1
        ) {
          await adapter.insertNode({
            runId,
            nodeId: task.nodeId,
            iteration: task.iteration,
            state: "failed",
            lastAttempt: attempts[0]?.attempt ?? null,
            updatedAtMs: nowMs(),
            outputTable: task.outputTableName,
            label: task.label ?? null,
          });
          throw await readTaskFailure(task);
        }

        await Effect.runPromise(
          withCorrelationContext(
            withSmithersSpan(
              smithersSpanNames.task,
              executeTaskBridgeEffect(
                adapter,
                db,
                runId,
                task,
                descriptorMap,
                inputTable,
                eventBus,
                toolConfig,
                workflowName,
                cacheEnabled,
                runAbortController.signal,
                disabledAgents,
                runAbortController,
                hijackState,
                legacyExecuteTask,
              ),
              {
                runId,
                workflowName,
                nodeId: task.nodeId,
                iteration: task.iteration,
                nodeLabel: task.label ?? null,
                status: "running",
              },
            ),
            {
              workflowName,
              nodeId: task.nodeId,
              iteration: task.iteration,
            },
          ),
        );

        const node = await adapter.getNode(runId, task.nodeId, task.iteration);
        if (node?.state === "failed") {
          throw await readTaskFailure(task);
        }
        if (node?.state === "cancelled") {
          throw makeAbortError();
        }
        return readTaskOutput(task);
      } catch (error) {
        if (driverTaskError == null) {
          driverTaskError = error;
        }
        throw error;
      } finally {
        activeDriverTaskKeys.delete(taskKey);
      }
    });

  const persistDriverFrame = async (graph: WorkflowGraph) => {
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
      taskIndexJson: JSON.stringify(
        graph.tasks.map((task) => ({
          nodeId: task.nodeId,
          ordinal: task.ordinal,
          iteration: task.iteration,
        })),
      ),
      note: "react-driver",
    };

    const snapNodes = await adapter.listNodes(runId);
    const snapRalph = await adapter.listRalph(runId);
    const snapInputRow = await loadInput(db, inputTable, runId);
    const snapOutputs = await loadOutputs(db, schema, runId);
    const snapshotData = {
      nodes: (snapNodes as any[]).map((node: any) => ({
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
        state: node.state,
        lastAttempt: node.lastAttempt ?? null,
        outputTable: node.outputTable ?? "",
        label: node.label ?? null,
      })),
      outputs: snapOutputs,
      ralph: (snapRalph as any[]).map((row: any) => ({
        ralphId: row.ralphId,
        iteration: row.iteration ?? 0,
        done: Boolean(row.done),
      })),
      input: snapInputRow ?? {},
      vcsPointer: runMetadata?.vcsRevision ?? null,
      workflowHash: workflowRef.opts.workflowHash ?? null,
    };

    try {
      const snap = await adapter.withTransaction(
        "frame-commit",
        Effect.gen(function* () {
          yield* adapter.insertFrameEffect(frameRow);
          return yield* captureSnapshotEffect(
            adapter,
            runId,
            frameNo,
            snapshotData,
          ) as any;
        }) as any,
      );
      const frameCommittedAtMs = nowMs();
      await eventBus.emitEventWithPersist({
        type: "FrameCommitted",
        runId,
        frameNo,
        xmlHash,
        timestampMs: frameCommittedAtMs,
      });
      await eventBus.emitEventWithPersist({
        type: "SnapshotCaptured",
        runId,
        frameNo,
        contentHash: (snap as any).contentHash,
        timestampMs: frameCommittedAtMs,
      });
    } catch (snapErr) {
      logWarning("snapshot capture failed", {
        runId,
        frameNo,
        error: snapErr instanceof Error ? snapErr.message : String(snapErr),
      }, "engine:snapshot");
    }
  };

  const persistDriverGraphTaskStates = async (graph: WorkflowGraph) => {
    const existingRows = await adapter.listNodes(runId);
    const existingState = new Map<string, TaskState>();
    for (const node of existingRows) {
      existingState.set(
        buildStateKey(node.nodeId, node.iteration ?? 0),
        node.state as TaskState,
      );
    }

    for (const task of graph.tasks as TaskDescriptor[]) {
      if (task.meta?.__timer || task.needsApproval || task.meta?.__waitForEvent) {
        continue;
      }
      const key = buildStateKey(task.nodeId, task.iteration);
      const previous = existingState.get(key);

      if (task.skipIf) {
        if (previous === "skipped") continue;
        await adapter.insertNode({
          runId,
          nodeId: task.nodeId,
          iteration: task.iteration,
          state: "skipped",
          lastAttempt: null,
          updatedAtMs: nowMs(),
          outputTable: task.outputTableName,
          label: task.label ?? null,
        });
        await eventBus.emitEventWithPersist({
          type: "NodeSkipped",
          runId,
          nodeId: task.nodeId,
          iteration: task.iteration,
          timestampMs: nowMs(),
        });
        existingState.set(key, "skipped");
        continue;
      }

      if (previous != null) continue;
      await adapter.insertNode({
        runId,
        nodeId: task.nodeId,
        iteration: task.iteration,
        state: "pending",
        lastAttempt: null,
        updatedAtMs: nowMs(),
        outputTable: task.outputTableName,
        label: task.label ?? null,
      });
      await eventBus.emitEventWithPersist({
        type: "NodePending",
        runId,
        nodeId: task.nodeId,
        iteration: task.iteration,
        timestampMs: nowMs(),
      });
      existingState.set(key, "pending");
    }
  };

  const finalizeDriverResult = async (
    result: RunResult,
    runStartPerformanceMs: number,
  ): Promise<RunBodyResult> => {
    if (result.status === "continued") {
      return result as RunBodyResult;
    }
    if (
      result.status === "waiting-approval" ||
      result.status === "waiting-event" ||
      result.status === "waiting-timer"
    ) {
      return result;
    }
    if (result.status === "cancelled") {
      const hijackError =
        hijackState.completion
          ? {
              code: "RUN_HIJACKED",
              ...hijackState.completion,
            }
          : null;
      await waitForAbortedTasksToSettle();
      await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
      await adapter.updateRun(runId, {
        status: "cancelled",
        finishedAtMs: nowMs(),
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        errorJson: hijackError ? JSON.stringify(hijackError) : null,
      });
      await eventBus.emitEventWithPersist({
        type: "RunCancelled",
        runId,
        timestampMs: nowMs(),
      });
      await annotateRunSpan({ status: "cancelled" });
      return { runId, status: "cancelled" };
    }
    if (result.status === "failed") {
      const errorInfo = errorToJson(result.error ?? driverTaskError);
      if (runOwnedByCurrentProcess) {
        await cancelPendingTimers(adapter, runId, eventBus, "run-failed");
        await adapter.updateRun(runId, {
          status: "failed",
          finishedAtMs: nowMs(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          errorJson: JSON.stringify(errorInfo),
        });
        await eventBus.emitEventWithPersist({
          type: "RunFailed",
          runId,
          error: errorInfo,
          timestampMs: nowMs(),
        });
      }
      await annotateRunSpan({ status: "failed" });
      return { runId, status: "failed", error: errorInfo };
    }

    await adapter.updateRun(runId, {
      status: "finished",
      finishedAtMs: nowMs(),
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
    });
    await eventBus.emitEventWithPersist({
      type: "RunFinished",
      runId,
      timestampMs: nowMs(),
    });
    void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
    logInfo("workflow run finished", {
      runId,
    }, "engine:run");
    await annotateRunSpan({ status: "finished" });

    const outputTable = schema.output;
    let output: unknown = undefined;
    if (outputTable) {
      const cols = getTableColumns(outputTable as any) as Record<string, any>;
      const runIdCol = cols.runId;
      if (runIdCol) {
        const rows = await db
          .select()
          .from(outputTable)
          .where(eq(runIdCol, runId));
        output = rows;
      } else {
        output = await db.select().from(outputTable);
      }
    }
    return { runId, status: "finished", output };
  };

  try {
    const existingRun = await adapter.getRun(runId);
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
    const effectiveAlertPolicy = workflowRef.opts.alertPolicy ?? (existingConfig as any).alertPolicy ?? undefined;
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
        await adapter.updateRun(runId, {
          configJson: JSON.stringify(config),
        });
      },
      recordDecision: async (record) => {
        const timestampMs = nowMs();
        await adapter.insertEventWithNextSeq({
          runId,
          timestampMs,
          type: "WorkflowPatchRecorded",
          payloadJson: JSON.stringify({
            runId,
            patchId: record.patchId,
            decision: record.decision,
            timestampMs,
          }),
        });
      },
    });
    if (opts.resume && existingRun) {
      assertResumeDurabilityMetadata(
        existingRun,
        existingConfig,
        runMetadata,
        resolvedWorkflowPath,
      );
    } else if (opts.resume && !existingRun) {
      throw new SmithersError(
        "RUN_NOT_FOUND",
        `Cannot resume run ${runId} because it does not exist.`,
        { runId },
      );
    }
    if (!opts.resume) {
      assertInputObject(opts.input);
      if ("runId" in opts.input && (opts.input as any).runId !== runId) {
        throw new SmithersError(
          "INVALID_INPUT",
          "Input runId does not match provided runId",
        );
      }
      const inputRow = buildInputRow(inputTable as any, runId, opts.input);
      const validation = validateInput(inputTable as any, inputRow);
      if (!validation.ok) {
        throw new SmithersError(
          "INVALID_INPUT",
          "Input does not match schema",
          {
            issues: validation.error?.issues,
          },
        );
      }
      const insertQuery = db.insert(inputTable).values(inputRow);
      if (typeof insertQuery.onConflictDoNothing === "function") {
        await withSqliteWriteRetry(
          () => db.insert(inputTable).values(inputRow).onConflictDoNothing(),
          { label: "insert input row" },
        );
      } else {
        await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow), {
          label: "insert input row",
        });
      }
    } else {
      let existingInput = await loadInput(db, inputTable, runId);
      if (!existingInput) {
        const restored = await restoreDurableStateFromSnapshot(
          adapter,
          db,
          schema,
          inputTable,
          runId,
        );
        if (restored) {
          existingInput = await loadInput(db, inputTable, runId);
        }
      }
      if (!existingInput) {
        throw new SmithersError(
          "MISSING_INPUT",
          "Cannot resume without an existing input row",
        );
      }
    }

    if (!existingRun) {
      await adapter.insertRun({
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
      });
      runOwnedByCurrentProcess = true;
    } else if (opts.resume) {
      await activateRunForResume(
        adapter,
        existingRun,
        opts,
        runtimeOwnerId,
        runConfigJson,
        runMetadata,
        resolvedWorkflowPath,
      );
      runOwnedByCurrentProcess = true;
    } else {
      await adapter.updateRun(runId, {
        status: "running",
        startedAtMs: existingRun.startedAtMs ?? nowMs(),
        finishedAtMs: null,
        heartbeatAtMs: nowMs(),
        runtimeOwnerId,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        workflowPath:
          resolvedWorkflowPath ??
          opts.workflowPath ??
          existingRun.workflowPath ??
          null,
        workflowHash: runMetadata.workflowHash ?? existingRun.workflowHash ?? null,
        vcsType: runMetadata.vcsType ?? existingRun.vcsType ?? null,
        vcsRoot: runMetadata.vcsRoot ?? existingRun.vcsRoot ?? null,
        vcsRevision: runMetadata.vcsRevision ?? existingRun.vcsRevision ?? null,
        errorJson: null,
        configJson: runConfigJson,
      });
      runOwnedByCurrentProcess = true;
    }
    stopSupervisor = startRunSupervisor(
      adapter,
      runId,
      runtimeOwnerId,
      runAbortController,
      hijackState,
    );

    await eventBus.emitEventWithPersist({
      type: "RunStarted",
      runId,
      timestampMs: nowMs(),
    });

    if (effectiveAlertPolicy && (effectiveAlertPolicy as any).rules && Object.keys((effectiveAlertPolicy as any).rules).length > 0) {
      alertRuntime = new AlertRuntime(effectiveAlertPolicy, {
        runId,
        adapter,
        eventBus,
        requestCancel: () => runAbortController.abort(),
        createHumanRequest: async (reqOpts) => {
          await adapter.insertHumanRequest({
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
          });
        },
        pauseScheduler: (_reason: string) => {},
      });
      alertRuntime.start();
    }

    const runStartPerformanceMs = performance.now();
    await cancelStaleAttempts(adapter, runId);

    if (opts.resume) {
      void Effect.runPromise(Metric.increment(runsResumedTotal));
      const staleInProgress = await adapter.listInProgressAttempts(runId);
      const now = nowMs();
      for (const attempt of staleInProgress) {
        const existingNode = await adapter.getNode(
          runId,
          attempt.nodeId,
          attempt.iteration,
        );
        await adapter.withTransaction(
          "resume-cancel-stale-attempt",
          Effect.gen(function* () {
            yield* adapter.updateAttemptEffect(
              runId,
              attempt.nodeId,
              attempt.iteration,
              attempt.attempt,
              {
                state: "cancelled",
                finishedAtMs: now,
              },
            );
            yield* adapter.insertNodeEffect({
              runId,
              nodeId: attempt.nodeId,
              iteration: attempt.iteration,
              state: "pending",
              lastAttempt: attempt.attempt,
              updatedAtMs: now,
              outputTable: existingNode?.outputTable ?? "",
              label: existingNode?.label ?? null,
            });
          }),
        );
      }
    }

    if (opts.resume) {
      const nodes = await adapter.listNodes(runId);
      defaultIteration = nodes.reduce(
        (max, node) => Math.max(max, node.iteration ?? 0),
        0,
      );
    }
    ralphState = buildRalphStateMap(await adapter.listRalph(runId));
    if (opts.resume && ralphState.size > 0) {
      const maxRalphIteration = [...ralphState.values()].reduce(
        (max, state) => Math.max(max, state.iteration),
        0,
      );
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
      render: async (element: any, renderOpts?: any) => {
        const graph = await withWorkflowVersioningRuntime(workflowVersioning, () =>
          renderer.render(element, renderOpts),
        );
        await workflowVersioning.flush();
        resolveTaskOutputs(graph.tasks as TaskDescriptor[], workflowRef);
        attachSubflowComputeFns(graph.tasks as TaskDescriptor[], workflowRef, {
          rootDir,
          workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
        });
        lastGraph = graph as unknown as WorkflowGraph;
        descriptorMap = buildDescriptorMap(graph.tasks as TaskDescriptor[]);
        workflowName = getWorkflowNameFromXml(graph.xml);
        updateCurrentCorrelationContext({ workflowName });
        cacheEnabled =
          workflowRef.opts.cache ??
          Boolean(
            graph.xml &&
            graph.xml.kind === "element" &&
            (graph.xml.props.cache === "true" || graph.xml.props.cache === "1"),
          );
        await adapter.updateRun(runId, { workflowName });
        await annotateRunSpan({ workflowName });

        const renderIterations = iterationsToMap(renderOpts?.ralphIterations);
        for (const [ralphId, iteration] of renderIterations.entries()) {
          const existing = ralphState.get(ralphId);
          const nextState = {
            iteration,
            done: existing?.done ?? false,
          };
          ralphState.set(ralphId, nextState);
          if (
            existing?.iteration !== nextState.iteration ||
            existing?.done !== nextState.done
          ) {
            await adapter.insertOrUpdateRalph({
              runId,
              ralphId,
              iteration: nextState.iteration,
              done: nextState.done,
              updatedAtMs: nowMs(),
            });
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
            await adapter.insertOrUpdateRalph({
              runId,
              ralphId: ralph.id,
              iteration,
              done: false,
              updatedAtMs: nowMs(),
            });
          }
        }
        if (ralphs.length === 1) {
          defaultIteration = ralphState.get(ralphs[0]!.id)?.iteration ?? 0;
        } else if (ralphs.length === 0) {
          defaultIteration = 0;
        }

        await persistDriverGraphTaskStates(lastGraph);
        await persistDriverFrame(lastGraph);
        return lastGraph;
      },
    };

    const driverWorkflow = {
      ...workflowRef,
      build: (ctx: any) =>
        withWorkflowVersioningRuntime(workflowVersioning, () =>
          workflowRef.build(ctx),
        ),
    };

    const activeInput = await loadInput(db, inputTable, runId);
    const driver = new ReactWorkflowDriver<Schema>({
      workflow: driverWorkflow as any,
      runtime: { runPromise: Effect.runPromise as any },
      session: workflowSession as any,
      db,
      runId,
      rootDir,
      workflowPath: resolvedWorkflowPath,
      executeTask: (task) => executeDriverTask(task as TaskDescriptor),
      onSchedulerWait: (durationMs) =>
        Effect.runPromise(Metric.update(schedulerWaitDuration, durationMs)),
      onWait: (reason) => handleDriverWait(reason as WaitReason) as any,
      continueAsNew: async (transition) => {
        let statePayload: unknown = (transition as any)?.statePayload;
        if ((transition as any)?.stateJson) {
          try {
            statePayload = JSON.parse((transition as any).stateJson);
          } catch (error) {
            throw new SmithersError(
              "INVALID_CONTINUATION_STATE",
              "Invalid JSON passed to continue-as-new state",
              {
                stateJson: (transition as any).stateJson,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        if (runAbortController.signal.aborted) {
          return { runId, status: "cancelled" };
        }
        const latestRun = await adapter.getRun(runId);
        if (latestRun?.cancelRequestedAtMs) {
          runAbortController.abort();
          return { runId, status: "cancelled" };
        }

        const nextRalphState = ralphStateFromDriverTransition(transition);
        const continuationIteration =
          typeof (transition as any)?.iteration === "number"
            ? (transition as any).iteration
            : defaultIteration;
        const driverTransition = await continueRunAsNew({
          db,
          adapter,
          schema,
          inputTable,
          runId,
          workflowPath:
            resolvedWorkflowPath ??
            opts.workflowPath ??
            latestRun?.workflowPath ??
            null,
          runMetadata,
          currentFrameNo: frameNo,
          continuation: {
            reason:
              (transition as any)?.reason === "loop-threshold"
                ? "loop-threshold"
                : "explicit",
            iteration: continuationIteration,
            statePayload,
            nextRalphState,
          },
          ralphState,
        });
        const continuationEvent: SmithersEvent = {
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
        logInfo(
          `Continuing run ${runId} as ${driverTransition.newRunId} at iteration ${continuationIteration}`,
          {
            runId,
            newRunId: driverTransition.newRunId,
            iteration: continuationIteration,
            carriedStateBytes: driverTransition.carriedStateBytes,
            engine: "react-driver",
          },
          "engine:continue-as-new",
        );
        void Effect.runPromise(
          Metric.update(runDuration, performance.now() - runStartPerformanceMs),
        );
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
      input: (activeInput ?? opts.input) as Record<string, unknown>,
      initialOutputs: await loadOutputs(db, schema, runId),
      initialIteration: defaultIteration,
      initialIterations: ralphIterationsObject(ralphState),
      rootDir,
      workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
      auth: runAuth,
      signal: runAbortController.signal,
    } as any);
    return finalizeDriverResult(result as RunResult, runStartPerformanceMs);
  } catch (err) {
    if (runAbortController.signal.aborted || isAbortError(err)) {
      logInfo("workflow run cancelled while handling error", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      }, "engine:run");
      const hijackError =
        hijackState.completion
          ? {
              code: "RUN_HIJACKED",
              ...hijackState.completion,
            }
          : errorToJson(err);
      await waitForAbortedTasksToSettle();
      await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
      await adapter.updateRun(runId, {
        status: "cancelled",
        finishedAtMs: nowMs(),
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        errorJson: JSON.stringify(hijackError),
      });
      await eventBus.emitEventWithPersist({
        type: "RunCancelled",
        runId,
        timestampMs: nowMs(),
      });
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
      await adapter.updateRun(runId, {
        status: "failed",
        finishedAtMs: nowMs(),
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        errorJson: JSON.stringify(errorInfo),
      });
      await eventBus.emitEventWithPersist({
        type: "RunFailed",
        runId,
        error: errorInfo,
        timestampMs: nowMs(),
      });
    }
    await annotateRunSpan({ status: "failed" });
    return { runId, status: "failed", error: errorInfo };
  } finally {
    alertRuntime?.stop();
    await stopSupervisor();
    detachAbort();
    wakeLock.release();
  }
}

async function runWorkflowBodyLegacy<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunBodyResult> {
  const db = workflow.db as any;
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  const runId = opts.runId ?? newRunId();
  let workflowSessionShadow: ReturnType<typeof makeWorkflowSession> | null = null;
  try {
    workflowSessionShadow = makeWorkflowSession({
      runId,
      nowMs,
      requireStableFinish: true,
    });
  } catch (error) {
    logWarning("workflow session shadow initialization failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    }, "engine:workflow-session");
  }
  const schema = resolveSchema(db);
  const inputTable = schema.input;
  if (!inputTable) {
    throw new SmithersError(
      "MISSING_INPUT_TABLE",
      "Schema must include input table",
    );
  }

  const resolvedWorkflowPath = opts.workflowPath
    ? resolve(opts.workflowPath)
    : null;
  const rootDir = resolveRootDir(opts, resolvedWorkflowPath);
  const logDir = resolveLogDir(rootDir, runId, opts.logDir);
  const maxConcurrency = coercePositiveInt(
    "maxConcurrency",
    opts.maxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
  );
  const maxOutputBytes = coercePositiveInt(
    "maxOutputBytes",
    opts.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const toolTimeoutMs = coercePositiveInt(
    "toolTimeoutMs",
    opts.toolTimeoutMs,
    DEFAULT_TOOL_TIMEOUT_MS,
  );
  const allowNetwork = Boolean(opts.allowNetwork);
  const runtimeOwnerId = buildRuntimeOwnerId();
  const runAbortController = new AbortController();
  const hijackState: HijackState = {
    request: null,
    completion: null,
  };
  const detachAbort = wireAbortSignal(runAbortController, opts.signal);
  let stopSupervisor = async () => {};
  const runMetadata = await getRunDurabilityMetadata(
    resolvedWorkflowPath,
    rootDir,
  );

  const lastSeq = await adapter.getLastEventSeq(runId);
  const eventBus = new EventBus({
    db: adapter,
    logDir,
    startSeq: (lastSeq ?? -1) + 1,
  });
  if (opts.onProgress) {
    eventBus.on("event", (e: SmithersEvent) => opts.onProgress?.(e));
  }

  const hotOpts = normalizeHotOptions(opts.hot);
  let hotController: HotWorkflowController | null = null;
  let hotPendingFiles: string[] | null = null;
  let workflowRef = workflow;
  let onAbortWake = () => {};
  let armHotReloadWakeup = () => {};
  let waitForAbortedTasksToSettle = async () => {};
  let runOwnedByCurrentProcess = false;
  const annotateRunSpan = (
    attributes: Readonly<Record<string, unknown>>,
  ) =>
    Effect.runPromise(
      annotateSmithersTrace({
        runId,
        ...attributes,
      }),
    );

  const wakeLock = acquireCaffeinate();
  let alertRuntime: AlertRuntime | null = null;
  try {
    const existingRun = await adapter.getRun(runId);
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
    const effectiveAlertPolicy = workflowRef.opts.alertPolicy ?? (existingConfig as any).alertPolicy ?? undefined;
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
        await adapter.updateRun(runId, {
          configJson: JSON.stringify(config),
        });
      },
      recordDecision: async (record) => {
        const timestampMs = nowMs();
        await adapter.insertEventWithNextSeq({
          runId,
          timestampMs,
          type: "WorkflowPatchRecorded",
          payloadJson: JSON.stringify({
            runId,
            patchId: record.patchId,
            decision: record.decision,
            timestampMs,
          }),
        });
      },
    });
    if (opts.resume && existingRun) {
      assertResumeDurabilityMetadata(
        existingRun,
        existingConfig,
        runMetadata,
        resolvedWorkflowPath,
      );
    } else if (opts.resume && !existingRun) {
      throw new SmithersError(
        "RUN_NOT_FOUND",
        `Cannot resume run ${runId} because it does not exist.`,
        { runId },
      );
    }
    if (!opts.resume) {
      assertInputObject(opts.input);
      if ("runId" in opts.input && (opts.input as any).runId !== runId) {
        throw new SmithersError(
          "INVALID_INPUT",
          "Input runId does not match provided runId",
        );
      }
      const inputRow = buildInputRow(inputTable as any, runId, opts.input);
      const validation = validateInput(inputTable as any, inputRow);
      if (!validation.ok) {
        throw new SmithersError(
          "INVALID_INPUT",
          "Input does not match schema",
          {
            issues: validation.error?.issues,
          },
        );
      }
      const insertQuery = db.insert(inputTable).values(inputRow);
      if (typeof insertQuery.onConflictDoNothing === "function") {
        await withSqliteWriteRetry(
          () => db.insert(inputTable).values(inputRow).onConflictDoNothing(),
          { label: "insert input row" },
        );
      } else {
        await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow), {
          label: "insert input row",
        });
      }
    } else {
      let existingInput = await loadInput(db, inputTable, runId);
      if (!existingInput) {
        const restored = await restoreDurableStateFromSnapshot(
          adapter,
          db,
          schema,
          inputTable,
          runId,
        );
        if (restored) {
          existingInput = await loadInput(db, inputTable, runId);
        }
      }
      if (!existingInput) {
        throw new SmithersError(
          "MISSING_INPUT",
          "Cannot resume without an existing input row",
        );
      }
    }

    if (!existingRun) {
      await adapter.insertRun({
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
      });
      runOwnedByCurrentProcess = true;
    } else if (opts.resume) {
      await activateRunForResume(
        adapter,
        existingRun,
        opts,
        runtimeOwnerId,
        runConfigJson,
        runMetadata,
        resolvedWorkflowPath,
      );
      runOwnedByCurrentProcess = true;
    } else {
      await adapter.updateRun(runId, {
        status: "running",
        startedAtMs: existingRun.startedAtMs ?? nowMs(),
        finishedAtMs: null,
        heartbeatAtMs: nowMs(),
        runtimeOwnerId,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        workflowPath:
          resolvedWorkflowPath ??
          opts.workflowPath ??
          existingRun.workflowPath ??
          null,
        workflowHash: runMetadata.workflowHash ?? existingRun.workflowHash ?? null,
        vcsType: runMetadata.vcsType ?? existingRun.vcsType ?? null,
        vcsRoot: runMetadata.vcsRoot ?? existingRun.vcsRoot ?? null,
        vcsRevision: runMetadata.vcsRevision ?? existingRun.vcsRevision ?? null,
        errorJson: null,
        configJson: runConfigJson,
      });
      runOwnedByCurrentProcess = true;
    }
    stopSupervisor = startRunSupervisor(
      adapter,
      runId,
      runtimeOwnerId,
      runAbortController,
      hijackState,
    );

    await eventBus.emitEventWithPersist({
      type: "RunStarted",
      runId,
      timestampMs: nowMs(),
    });

    // Start alert runtime if alertPolicy is configured
    if (effectiveAlertPolicy && (effectiveAlertPolicy as any).rules && Object.keys((effectiveAlertPolicy as any).rules).length > 0) {
      alertRuntime = new AlertRuntime(effectiveAlertPolicy, {
        runId,
        adapter,
        eventBus,
        requestCancel: () => runAbortController.abort(),
        createHumanRequest: async (reqOpts) => {
          await adapter.insertHumanRequest({
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
          });
        },
        pauseScheduler: (_reason: string) => {
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
      const staleInProgress = await adapter.listInProgressAttempts(runId);
      const now = nowMs();
      for (const attempt of staleInProgress) {
        const existingNode = await adapter.getNode(
          runId,
          attempt.nodeId,
          attempt.iteration,
        );
        await adapter.withTransaction(
          "resume-cancel-stale-attempt",
          Effect.gen(function* () {
            yield* adapter.updateAttemptEffect(
              runId,
              attempt.nodeId,
              attempt.iteration,
              attempt.attempt,
              {
                state: "cancelled",
                finishedAtMs: now,
              },
            );
            yield* adapter.insertNodeEffect({
              runId,
              nodeId: attempt.nodeId,
              iteration: attempt.iteration,
              state: "pending",
              lastAttempt: attempt.attempt,
              updatedAtMs: now,
              outputTable: existingNode?.outputTable ?? "",
              label: existingNode?.label ?? null,
            });
          }),
        );
      }
    }

    const disabledAgents = new Set<any>();
    const renderer = new SmithersRenderer();
    let frameNo = (await adapter.getLastFrame(runId))?.frameNo ?? 0;
    let defaultIteration = 0;
    let prevMountedTaskIds: Set<string> = new Set();

    type ScheduleTrigger =
      | { type: "initial" }
      | { type: "task-completed"; nodeId: string; iteration: number }
      | {
          type: "external-event";
          source: "abort" | "approval" | "hot-reload" | "render" | "retry" | "signal";
        };
    type SchedulerIterationAction =
      | { type: "await-trigger" }
      | { type: "continue" }
      | {
          type: "dispatch";
          runnable: TaskDescriptor[];
          descriptorMap: Map<string, TaskDescriptor>;
          workflowName: string;
          cacheEnabled: boolean;
        }
      | { type: "schedule-retry"; waitMs: number }
      | { type: "return"; result: RunBodyResult };

    const triggerQueue = await Effect.runPromise(Queue.unbounded<ScheduleTrigger>());
    const schedulerTaskKeys = new Set<string>();
    let schedulerTaskError: unknown = null;
    let hotWaitInFlight = false;
    let scheduledRetryAtMs: number | null = null;
    let retryWakeFiber: Fiber.RuntimeFiber<void, never> | null = null;
    const toolConfig = {
      rootDir,
      allowNetwork,
      maxOutputBytes,
      toolTimeoutMs,
    };
    const schedulerExecutionConcurrency = Math.max(1, maxConcurrency);
    const offerSchedulerTrigger = (trigger: ScheduleTrigger) => {
      triggerQueue.unsafeOffer(trigger);
    };
    const makeSchedulerTaskKey = (
      task: Pick<TaskDescriptor, "nodeId" | "iteration">,
    ) => buildStateKey(task.nodeId, task.iteration);
    const workflowSessionTaskNotifications = new Set<string>();
    const runWorkflowSessionShadow = async (
      operation: string,
      makeEffect: () => Effect.Effect<EngineDecision, unknown, unknown>,
      context: Readonly<Record<string, unknown>> = {},
    ): Promise<EngineDecision | null> => {
      if (!workflowSessionShadow) {
        return null;
      }
      try {
        return await Effect.runPromise(makeEffect());
      } catch (error) {
        logWarning("workflow session shadow call failed", {
          runId,
          operation,
          ...context,
          error: error instanceof Error ? error.message : String(error),
        }, "engine:workflow-session");
        return null;
      }
    };
    const compareWorkflowSessionShadow = (
      operation: string,
      sessionDecision: EngineDecision | null,
      legacyDecision: WorkflowSessionShadowDecisionSummary,
      context: Readonly<Record<string, unknown>> = {},
    ) => {
      if (!sessionDecision) {
        return;
      }
      try {
        const sessionSummary = summarizeWorkflowSessionDecision(sessionDecision);
        if (
          workflowSessionSummaryKey(sessionSummary) ===
          workflowSessionSummaryKey(legacyDecision)
        ) {
          return;
        }
        logWarning("workflow session shadow divergence", {
          runId,
          operation,
          sessionDecision: sessionSummary,
          legacyDecision,
          ...context,
        }, "engine:workflow-session");
      } catch (error) {
        logWarning("workflow session shadow comparison failed", {
          runId,
          operation,
          ...context,
          error: error instanceof Error ? error.message : String(error),
        }, "engine:workflow-session");
      }
    };
    const notifyWorkflowSessionTaskSettled = async (
      task: TaskDescriptor,
      fallbackError?: unknown,
    ) => {
      if (!workflowSessionShadow) {
        return;
      }
      try {
        const node = await adapter.getNode(runId, task.nodeId, task.iteration);
        const attempts = await adapter.listAttempts(
          runId,
          task.nodeId,
          task.iteration,
        );
        const latestAttempt = attempts[0] as
          | { attempt?: number | null; errorJson?: string | null }
          | undefined;
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
            ? await selectOutputRow<any>(db, task.outputTable as any, {
                runId,
                nodeId: task.nodeId,
                iteration: task.iteration,
              })
            : undefined;
          await runWorkflowSessionShadow(
            "taskCompleted",
            () =>
              workflowSessionShadow!.taskCompleted({
                nodeId: task.nodeId,
                iteration: task.iteration,
                output: outputRow ? stripAutoColumns(outputRow) : undefined,
              }),
            {
              nodeId: task.nodeId,
              iteration: task.iteration,
            },
          );
          return;
        }
        if (state === "failed") {
          workflowSessionTaskNotifications.add(notificationKey);
          let errorPayload = fallbackError ?? "Task failed";
          if (latestAttempt?.errorJson) {
            try {
              errorPayload = JSON.parse(latestAttempt.errorJson);
            } catch {
              errorPayload = latestAttempt.errorJson;
            }
          }
          await runWorkflowSessionShadow(
            "taskFailed",
            () =>
              workflowSessionShadow!.taskFailed({
                nodeId: task.nodeId,
                iteration: task.iteration,
                error: errorPayload,
              }),
            {
              nodeId: task.nodeId,
              iteration: task.iteration,
            },
          );
        }
      } catch (error) {
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
        const inProgress = await adapter.listInProgressAttempts(runId);
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
      const pendingApprovals = await adapter.listPendingApprovals(runId);
      const [latestSignal] = await adapter.listSignals(runId, { limit: 1 });
      return {
        latestSignalSeq: latestSignal?.seq ?? 0,
        pendingApprovalFingerprint: pendingApprovals
          .map(
            (approval: any) =>
              `${approval.nodeId ?? ""}:${approval.iteration ?? 0}:${approval.requestedAtMs ?? 0}`,
          )
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
    const scheduleRetryWakeEffect = (waitMs: number) =>
      Effect.gen(function* () {
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
        retryWakeFiber = yield* Effect.forkScoped(
          Effect.sleep(Duration.millis(waitMs)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (scheduledRetryAtMs === retryAtMs) {
                  scheduledRetryAtMs = null;
                  retryWakeFiber = null;
                }
                offerSchedulerTrigger({
                  type: "external-event",
                  source: "retry",
                });
              }),
            ),
            Effect.asVoid,
          ),
        );
      });
    const watchExternalSchedulerEventsEffect = Effect.gen(function* () {
      const initialState = yield* Effect.either(
        fromPromise(
          "read scheduler external event state",
          readExternalSchedulerState,
        ),
      );
      let previous =
        initialState._tag === "Right"
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
        const nextState = yield* Effect.either(
          fromPromise(
            "poll scheduler external event state",
            readExternalSchedulerState,
          ),
        );
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
        if (
          nextState.right.pendingApprovalFingerprint !==
          previous.pendingApprovalFingerprint
        ) {
          offerSchedulerTrigger({
            type: "external-event",
            source: "approval",
          });
        }
        previous = nextState.right;
      }
    }).pipe(Effect.interruptible);

    onAbortWake = () =>
      offerSchedulerTrigger({
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
      const nodes = await adapter.listNodes(runId);
      const maxIteration = nodes.reduce(
        (max, node) => Math.max(max, node.iteration ?? 0),
        0,
      );
      defaultIteration = maxIteration;
    }
    const ralphState: RalphStateMap = buildRalphStateMap(
      await adapter.listRalph(runId),
    );
    if (opts.resume && ralphState.size > 0) {
      const maxRalphIteration = [...ralphState.values()].reduce(
        (max, state) => Math.max(max, state.iteration),
        0,
      );
      defaultIteration = Math.max(defaultIteration, maxRalphIteration);
    }

    if (hotOpts.enabled && (resolvedWorkflowPath ?? opts.workflowPath)) {
      process.env.SMITHERS_HOT = "1";
      hotController = new HotWorkflowController(
        resolvedWorkflowPath ?? opts.workflowPath!,
        hotOpts,
      );
      await hotController.init();
      armHotReloadWakeup();
    }

    const runSchedulerIteration = async (): Promise<SchedulerIterationAction> => {
      if (runAbortController.signal.aborted) {
        logInfo("run abort observed in scheduler loop", {
          runId,
        }, "engine:run");
        const hijackError =
          hijackState.completion
            ? {
                code: "RUN_HIJACKED",
                ...hijackState.completion,
              }
            : null;
        await waitForAbortedTasksToSettle();
        await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
        await adapter.updateRun(runId, {
          status: "cancelled",
          finishedAtMs: nowMs(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          errorJson: hijackError ? JSON.stringify(hijackError) : null,
        });
        await eventBus.emitEventWithPersist({
          type: "RunCancelled",
          runId,
          timestampMs: nowMs(),
        });
        await annotateRunSpan({
          status: "cancelled",
        });
        return {
          type: "return",
          result: { runId, status: "cancelled" },
        };
      }

      if (
        hijackState.request &&
        !hijackState.completion &&
        schedulerTaskKeys.size === 0
      ) {
        const hijackAttempts = await adapter.listAttemptsForRun(runId);
        const target = hijackState.request.target ?? null;
        const candidate = [...(hijackAttempts as any[])].sort((a, b) => {
          const aMs = a.startedAtMs ?? 0;
          const bMs = b.startedAtMs ?? 0;
          if (aMs !== bMs) return bMs - aMs;
          return (b.attempt ?? 0) - (a.attempt ?? 0);
        }).find((attempt) => {
          const meta = parseAttemptMetaJson(attempt.metaJson);
          const engine = typeof meta.agentEngine === "string" ? meta.agentEngine : null;
          const continuation =
            engine ? extractHijackContinuation(meta, engine) : null;
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
          const continuation = extractHijackContinuation(meta, meta.agentEngine as string);
          if (!continuation) {
            return { type: "continue" };
          }
          hijackState.completion = {
            requestedAtMs: hijackState.request.requestedAtMs,
            nodeId: candidate.nodeId,
            iteration: candidate.iteration,
            attempt: candidate.attempt,
            engine: meta.agentEngine as string,
            mode: continuation.mode,
            resume: continuation.mode === "native-cli" ? continuation.resume : undefined,
            messages: continuation.mode === "conversation"
              ? (cloneJsonValue(continuation.messages) ?? continuation.messages)
              : undefined,
            cwd: candidate.jjCwd ?? rootDir,
          };
          await eventBus.emitEventWithPersist({
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
          });
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
            await eventBus.emitEventWithPersist({
              type: "WorkflowReloaded",
              runId,
              generation: result.generation,
              changedFiles: result.changedFiles,
              timestampMs: nowMs(),
            });
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
            await eventBus.emitEventWithPersist({
              type: "WorkflowReloadFailed",
              runId,
              error: result.error instanceof Error ? result.error.message : String(result.error),
              changedFiles: result.changedFiles,
              timestampMs: nowMs(),
            });
            logWarning("workflow hot reload failed", {
              runId,
              generation: result.generation,
              changedFileCount: result.changedFiles.length,
              error:
                result.error instanceof Error
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
            await eventBus.emitEventWithPersist({
              type: "WorkflowReloadUnsafe",
              runId,
              reason: result.reason,
              changedFiles: result.changedFiles,
              timestampMs: nowMs(),
            });
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
      const cliAgentToolsDefault =
        runConfig.cliAgentToolsDefault === "all" ||
        runConfig.cliAgentToolsDefault === "explicit-only"
          ? runConfig.cliAgentToolsDefault
          : undefined;

      const ctx = buildContext<Schema>({
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

      const renderedGraph =
        await withWorkflowVersioningRuntime(workflowVersioning, () =>
          renderer.render(workflowRef.build(ctx), {
            ralphIterations,
            defaultIteration,
            baseRootDir: rootDir,
            workflowPath: resolvedWorkflowPath,
          }),
        );
      const { xml, mountedTaskIds } = renderedGraph;
      const tasks = renderedGraph.tasks as unknown as TaskDescriptor[];
      await workflowVersioning.flush();
      const sessionGraphDecision = await runWorkflowSessionShadow(
        "submitGraph",
        () =>
          workflowSessionShadow!.submitGraph({
            xml,
            tasks,
            mountedTaskIds,
          } as unknown as WorkflowGraph),
        {
          frameNo: frameNo + 1,
          taskCount: tasks.length,
        },
      );
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
      const cacheEnabled =
        workflow.opts.cache ??
        Boolean(
          xml &&
          xml.kind === "element" &&
          (xml.props.cache === "true" || xml.props.cache === "1"),
        );
      await adapter.updateRun(runId, { workflowName });
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
        taskIndexJson: JSON.stringify(
          tasks.map((t) => ({
            nodeId: t.nodeId,
            ordinal: t.ordinal,
            iteration: t.iteration,
          })),
        ),
        note: null,
      };

      const snapNodes = await adapter.listNodes(runId);
      const snapRalph = await adapter.listRalph(runId);
      const snapInputRow = await loadInput(db, inputTable, runId);
      const snapOutputs = await loadOutputs(db, schema, runId);
      const snapshotData = {
        nodes: (snapNodes as any[]).map((n: any) => ({
          nodeId: n.nodeId,
          iteration: n.iteration ?? 0,
          state: n.state,
          lastAttempt: n.lastAttempt ?? null,
          outputTable: n.outputTable ?? "",
          label: n.label ?? null,
        })),
        outputs: snapOutputs,
        ralph: (snapRalph as any[]).map((r: any) => ({
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
        const snap = await adapter.withTransaction(
          "frame-commit",
          Effect.gen(function* () {
            yield* adapter.insertFrameEffect(frameRow);
            return yield* captureSnapshotEffect(
              adapter,
              runId,
              frameNo,
              snapshotData,
            );
          }),
        );
        const frameCommittedAtMs = nowMs();
        await eventBus.emitEventWithPersist({
          type: "FrameCommitted",
          runId,
          frameNo,
          xmlHash,
          timestampMs: frameCommittedAtMs,
        });
        await eventBus.emitEventWithPersist({
          type: "SnapshotCaptured",
          runId,
          frameNo,
          contentHash: snap.contentHash,
          timestampMs: frameCommittedAtMs,
        });
      } catch (snapErr) {
        // Snapshot capture is best-effort — don't fail the run.
        // Frame + snapshot are committed atomically, so on failure both are rolled back.
        logWarning("snapshot capture failed", {
          runId,
          frameNo,
          error: snapErr instanceof Error ? snapErr.message : String(snapErr),
        }, "engine:snapshot");
      }

      const inProgress = await adapter.listInProgressAttempts(runId);
      const mountedSet = new Set(mountedTaskIds);
      if (
        !hotOpts.enabled &&
        inProgress.some(
          (a: any) => !mountedSet.has(`${a.nodeId}::${a.iteration ?? 0}`),
        )
      ) {
        await cancelInProgress(adapter, runId, eventBus);
        return { type: "continue" };
      }

      const { plan, ralphs } = buildPlanTree(xml, ralphState);
      for (const ralph of ralphs) {
        if (!ralphState.has(ralph.id)) {
          const iteration = 0;
          ralphState.set(ralph.id, { iteration, done: false });
          await adapter.insertOrUpdateRalph({
            runId,
            ralphId: ralph.id,
            iteration,
            done: false,
            updatedAtMs: nowMs(),
          });
        }
      }
      if (ralphs.length === 1) {
        defaultIteration = ralphState.get(ralphs[0]!.id)?.iteration ?? 0;
      } else if (ralphs.length === 0) {
        defaultIteration = 0;
      }
      const singleRalphId = ralphs.length === 1 ? ralphs[0]!.id : null;

      const ralphDoneMap = buildRalphDoneMap(ralphs, ralphState);
      const { stateMap, retryWait } = await computeTaskStates(
        adapter,
        db,
        runId,
        tasks,
        eventBus,
        ralphDoneMap,
      );
      const descriptorMap = buildDescriptorMap(tasks);
      const schedule = scheduleTasks(
        plan,
        stateMap,
        descriptorMap,
        ralphState,
        retryWait,
        nowMs(),
      );
      compareWorkflowSessionShadow(
        "submitGraph",
        sessionGraphDecision,
        summarizeLegacySchedulerDecision(
          schedule,
          stateMap,
          tasks,
          schedulerTaskKeys,
        ),
        {
          frameNo,
          taskCount: tasks.length,
          schedulerRunnableCount: schedule.runnable.length,
        },
      );

      let dbInProgressCount = 0;
      for (const task of tasks) {
        const state = stateMap.get(buildStateKey(task.nodeId, task.iteration));
        if (state === "in-progress") {
          dbInProgressCount += 1;
        }
      }
      const localCapacity = Math.max(
        0,
        maxConcurrency - Math.max(dbInProgressCount, schedulerTaskKeys.size),
      );
      const runnable = applyConcurrencyLimits(
        schedule.runnable,
        stateMap,
        maxConcurrency,
        tasks,
      )
        .filter((task) => !schedulerTaskKeys.has(makeSchedulerTaskKey(task)))
        .slice(0, localCapacity);
      void Effect.runPromise(
        Metric.set(
          schedulerQueueDepth,
          schedule.runnable.length - runnable.length,
        ),
      );

      if (runnable.length === 0) {
        if (schedulerTaskKeys.size > 0) {
          return { type: "await-trigger" };
        }

        // Detect orphaned in-progress tasks: tasks the DB thinks are running
        // but have no corresponding inflight promise (process died).
        // Cancel their attempts and reset to pending so they can be retried.
        const orphanedInProgress: TaskDescriptor[] = [];
        for (const task of tasks) {
          const state = stateMap.get(buildStateKey(task.nodeId, task.iteration));
          if (state === "in-progress") {
            orphanedInProgress.push(task);
          }
        }
        if (orphanedInProgress.length > 0) {
          const now = nowMs();
          for (const task of orphanedInProgress) {
            const attempts = await adapter.listAttempts(runId, task.nodeId, task.iteration);
            await adapter.withTransaction(
              "recover-orphaned-task",
              Effect.gen(function* () {
                for (const attempt of attempts) {
                  if (attempt.state === "in-progress") {
                    yield* adapter.updateAttemptEffect(
                      runId,
                      task.nodeId,
                      task.iteration,
                      attempt.attempt,
                      {
                        state: "cancelled",
                        finishedAtMs: now,
                      },
                    );
                  }
                }
                yield* adapter.insertNodeEffect({
                  runId,
                  nodeId: task.nodeId,
                  iteration: task.iteration,
                  state: "pending",
                  lastAttempt: null,
                  updatedAtMs: now,
                  outputTable: task.outputTableName,
                  label: task.label ?? null,
                });
              }),
            );
            logWarning("recovered orphaned in-progress task", {
              runId,
              nodeId: task.nodeId,
              iteration: task.iteration,
            }, "engine:run");
          }
          return { type: "continue" };
        }

        if (schedule.waitingApprovalExists) {
          await adapter.updateRun(runId, {
            status: "waiting-approval",
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
          });
          await eventBus.emitEventWithPersist({
            type: "RunStatusChanged",
            runId,
            status: "waiting-approval",
            timestampMs: nowMs(),
          });
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
          await adapter.updateRun(runId, {
            status: "waiting-event",
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
          });
          await eventBus.emitEventWithPersist({
            type: "RunStatusChanged",
            runId,
            status: "waiting-event",
            timestampMs: nowMs(),
          });
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
          await adapter.updateRun(runId, {
            status: "waiting-timer",
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
          });
          await eventBus.emitEventWithPersist({
            type: "RunStatusChanged",
            runId,
            status: "waiting-timer",
            timestampMs: nowMs(),
          });
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
          await adapter.updateRun(runId, {
            status: "failed",
            finishedAtMs: nowMs(),
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
          });
          await eventBus.emitEventWithPersist({
            type: "RunFailed",
            runId,
            error: schedule.fatalError,
            timestampMs: nowMs(),
          });
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
          await adapter.updateRun(runId, {
            status: "failed",
            finishedAtMs: nowMs(),
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
          });
          await eventBus.emitEventWithPersist({
            type: "RunFailed",
            runId,
            error: errorMsg,
            timestampMs: nowMs(),
          });
          await annotateRunSpan({
            status: "failed",
          });
          return {
            type: "return",
            result: { runId, status: "failed", error: errorMsg },
          };
        }

        if (schedule.continuation) {
          let statePayload: unknown = undefined;
          if (schedule.continuation.stateJson) {
            try {
              statePayload = JSON.parse(schedule.continuation.stateJson);
            } catch (error) {
              throw new SmithersError(
                "INVALID_CONTINUATION_STATE",
                "Invalid JSON passed to continue-as-new state",
                {
                  stateJson: schedule.continuation.stateJson,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
          }

          if (runAbortController.signal.aborted) {
            return { type: "continue" };
          }
          const latestRun = await adapter.getRun(runId);
          if (latestRun?.cancelRequestedAtMs) {
            runAbortController.abort();
            return { type: "continue" };
          }

          const continuationIteration = defaultIteration;
          let transition: ContinueAsNewTransition;
          try {
            transition = await Effect.runPromise(
              fromPromise(
                "continue-as-new explicit transition",
                () =>
                  continueRunAsNew({
                    db,
                    adapter,
                    schema,
                    inputTable,
                    runId,
                    workflowPath:
                      resolvedWorkflowPath ??
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
              ).pipe(
                Effect.annotateLogs({
                  runId,
                  iteration: continuationIteration,
                }),
                Effect.withLogSpan("engine:continue-as-new"),
              ),
            );
          } catch (error: any) {
            if (error?.code === "RUN_CANCELLED") {
              runAbortController.abort();
              return { type: "continue" };
            }
            throw error;
          }

          const continuationEvent: SmithersEvent = {
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
          logInfo(
            `Continuing run ${runId} as ${transition.newRunId} at iteration ${continuationIteration}`,
            {
              runId,
              newRunId: transition.newRunId,
              iteration: continuationIteration,
              carriedStateBytes: transition.carriedStateBytes,
            },
            "engine:continue-as-new",
          );
          void Effect.runPromise(
            Metric.update(runDuration, performance.now() - runStartPerformanceMs),
          );
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
          const waitMs =
            schedule.nextRetryAtMs != null
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
          const freshUntilMap = new Map<string, boolean>();
          if (!singleRalphId) {
            const freshOutputs = await loadOutputs(db, schema, runId);
            const evalRenderer = new SmithersRenderer();
            for (const ralph of schedule.readyRalphs) {
              const rState = ralphState.get(ralph.id);
              const ralphIteration = rState?.iteration ?? 0;
              const perRalphCtx = buildContext<Schema>({
                runId,
                iteration: ralphIteration,
                iterations: ralphIterationsObject(ralphState),
                input: inputRow,
                auth: runAuth,
                outputs: freshOutputs,
                zodToKeyName: workflow.zodToKeyName,
              });
              const { xml: freshXml } = await evalRenderer.render(
                workflowRef.build(perRalphCtx),
                {
                  ralphIterations: ralphIterationsFromState(ralphState),
                  defaultIteration: ralphIteration,
                  baseRootDir: rootDir,
                  workflowPath: resolvedWorkflowPath,
                },
              );
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
                await adapter.insertOrUpdateRalph({
                  runId,
                  ralphId: ralph.id,
                  iteration: state.iteration,
                  done: true,
                  updatedAtMs: nowMs(),
                });
              }
              continue;
            }
            const continueAsNewEvery = ralph.continueAsNewEvery;
            const nextIteration = state.iteration + 1;
            const shouldContinueAsNew =
              typeof continueAsNewEvery === "number" &&
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
              const latestRun = await adapter.getRun(runId);
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
              let transition: ContinueAsNewTransition;
              try {
                transition = await Effect.runPromise(
                  fromPromise(
                    "continue-as-new loop transition",
                    () =>
                      continueRunAsNew({
                        db,
                        adapter,
                        schema,
                        inputTable,
                        runId,
                        workflowPath:
                          resolvedWorkflowPath ??
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
                  ).pipe(
                    Effect.annotateLogs({
                      runId,
                      ralphId: ralph.id,
                      iteration: continuationIteration,
                      continueAsNewEvery,
                    }),
                    Effect.withLogSpan("engine:continue-as-new"),
                  ),
                );
              } catch (error: any) {
                if (error?.code === "RUN_CANCELLED") {
                  runAbortController.abort();
                  continue;
                }
                throw error;
              }

              const continuationEvent: SmithersEvent = {
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
              logInfo(
                `Continuing run ${runId} as ${transition.newRunId} at iteration ${continuationIteration}`,
                {
                  runId,
                  newRunId: transition.newRunId,
                  iteration: continuationIteration,
                  carriedStateBytes: transition.carriedStateBytes,
                },
                "engine:continue-as-new",
              );
              void Effect.runPromise(
                Metric.update(runDuration, performance.now() - runStartPerformanceMs),
              );
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
              await adapter.insertOrUpdateRalph({
                runId,
                ralphId: ralph.id,
                iteration: state.iteration,
                done: false,
                updatedAtMs: nowMs(),
              });
              continue;
            }
            if (ralph.onMaxReached === "fail") {
              await adapter.updateRun(runId, {
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
              });
              await eventBus.emitEventWithPersist({
                type: "RunFailed",
                runId,
                error: { code: "RALPH_MAX_REACHED", ralphId: ralph.id },
                timestampMs: nowMs(),
              });
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
            await adapter.insertOrUpdateRalph({
              runId,
              ralphId: ralph.id,
              iteration: state.iteration,
              done: true,
              updatedAtMs: nowMs(),
            });
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
          const sameAsPrev =
            currentMounted.size === prevMountedTaskIds.size &&
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

        await adapter.updateRun(runId, {
          status: "finished",
          finishedAtMs: nowMs(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
        });
        await eventBus.emitEventWithPersist({
          type: "RunFinished",
          runId,
          timestampMs: nowMs(),
        });
        void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
        logInfo("workflow run finished", {
          runId,
        }, "engine:run");
        await annotateRunSpan({
          status: "finished",
        });

        const outputTable = schema.output;
        let output: unknown = undefined;
        if (outputTable) {
          const cols = getTableColumns(outputTable as any) as Record<
            string,
            any
          >;
          const runIdCol = cols.runId;
          if (runIdCol) {
            const rows = await db
              .select()
              .from(outputTable)
              .where(eq(runIdCol, runId));
            output = rows;
          } else {
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

    const schedulerLoopEffect = Effect.scoped(
      Effect.gen(function* () {
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

          const action = yield* fromPromise(
            "run scheduler iteration",
            runSchedulerIteration,
          );

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

          const batchKeys = action.runnable.map((task) =>
            makeSchedulerTaskKey(task),
          );
          yield* Effect.sync(() => {
            for (const taskKey of batchKeys) {
              schedulerTaskKeys.add(taskKey);
            }
          });
          yield* Effect.forkScoped(
            Effect.all(
              action.runnable.map((task) =>
                withCorrelationContext(
                  withSmithersSpan(
                    smithersSpanNames.task,
                    executeTaskBridgeEffect(
                      adapter,
                      db,
                      runId,
                      task,
                      action.descriptorMap,
                      inputTable,
                      eventBus,
                      toolConfig,
                      action.workflowName,
                      action.cacheEnabled,
                      runAbortController.signal,
                      disabledAgents,
                      runAbortController,
                      hijackState,
                      legacyExecuteTask,
                    ).pipe(
                      Effect.tap(() =>
                        fromPromise(
                          "workflow session shadow task settled",
                          () => notifyWorkflowSessionTaskSettled(task),
                        ),
                      ),
                    ),
                    {
                      runId,
                      workflowName: action.workflowName,
                      nodeId: task.nodeId,
                      iteration: task.iteration,
                      nodeLabel: task.label ?? null,
                      status: "running",
                    },
                  ),
                  {
                    workflowName: action.workflowName,
                    nodeId: task.nodeId,
                    iteration: task.iteration,
                  },
                ).pipe(
                  Effect.catchAll((error) =>
                    Effect.gen(function* () {
                      yield* fromPromise(
                        "workflow session shadow task failed",
                        () => notifyWorkflowSessionTaskSettled(task, error),
                      );
                      if (schedulerTaskError == null) {
                        schedulerTaskError = error;
                      }
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      schedulerTaskKeys.delete(makeSchedulerTaskKey(task));
                      offerSchedulerTrigger({
                        type: "task-completed",
                        nodeId: task.nodeId,
                        iteration: task.iteration,
                      });
                    }),
                  ),
                )
              ),
              {
                concurrency: schedulerExecutionConcurrency,
                discard: true,
              },
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  for (const taskKey of batchKeys) {
                    schedulerTaskKeys.delete(taskKey);
                  }
                }),
              ),
            ),
          );
          armHotReloadWakeup();
        }
      }).pipe(Effect.interruptible),
    );

    return await Effect.runPromise(schedulerLoopEffect);
  } catch (err) {
    if (runAbortController.signal.aborted || isAbortError(err)) {
      logInfo("workflow run cancelled while handling error", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      }, "engine:run");
      const hijackError =
        hijackState.completion
          ? {
              code: "RUN_HIJACKED",
              ...hijackState.completion,
            }
          : errorToJson(err);
      await waitForAbortedTasksToSettle();
      await cancelPendingTimers(adapter, runId, eventBus, "run-cancelled");
      await adapter.updateRun(runId, {
        status: "cancelled",
        finishedAtMs: nowMs(),
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        errorJson: JSON.stringify(hijackError),
      });
      await eventBus.emitEventWithPersist({
        type: "RunCancelled",
        runId,
        timestampMs: nowMs(),
      });
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
      await adapter.updateRun(runId, {
        status: "failed",
        finishedAtMs: nowMs(),
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        errorJson: JSON.stringify(errorInfo),
      });
      await eventBus.emitEventWithPersist({
        type: "RunFailed",
        runId,
        error: errorInfo,
        timestampMs: nowMs(),
      });
    }
    await annotateRunSpan({
      status: "failed",
    });
    return { runId, status: "failed", error: errorInfo };
  } finally {
    alertRuntime?.stop();
    await stopSupervisor();
    detachAbort();
    runAbortController.signal.removeEventListener("abort", onAbortWake);
    await hotController?.close();
    wakeLock.release();
  }
}

export function runWorkflowEffect<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
) {
  const runId = opts.runId ?? newRunId();
  return withSmithersSpan(
    smithersSpanNames.run,
    fromPromise("run workflow", () =>
      runWorkflowAsync(workflow, {
        ...opts,
        runId,
      }),
    ),
    {
      runId,
      status: "running",
      workflowPath: opts.workflowPath ?? "",
      maxConcurrency: opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      hot: Boolean(opts.hot),
      resume: Boolean(opts.resume),
    },
    {
      root: true,
    },
  );
}

export async function runWorkflow<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunResult> {
  return Effect.runPromise(runWorkflowEffect(workflow, opts));
}
