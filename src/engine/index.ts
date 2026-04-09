import type { SmithersWorkflow } from "../SmithersWorkflow";
import type { RunOptions } from "../RunOptions";
import type { RunResult } from "../RunResult";
import type { SmithersEvent } from "../SmithersEvent";
import type { TaskDescriptor } from "../TaskDescriptor";
import type { GraphSnapshot } from "../GraphSnapshot";
import type { RunAuthContext } from "../RunAuthContext";
import type { AgentCliEvent } from "../agents/BaseCliAgent";
import { isBlockingAgentActionKind } from "../agents/BaseCliAgent";
import { SmithersRenderer } from "../dom/renderer";
import { buildContext } from "../context";
import { loadInput, loadOutputs } from "../db/snapshot";
import { ensureSmithersTables } from "../db/ensure";
import { SmithersDb } from "../db/adapter";
import {
  selectOutputRow,
  validateOutput,
  validateExistingOutput,
  getAgentOutputSchema,
  describeSchemaShape,
  buildOutputRow,
  stripAutoColumns,
} from "../db/output";
import { validateInput } from "../db/input";
import { schemaSignature } from "../db/schema-signature";
import { withSqliteWriteRetry } from "../db/write-retry";
import { canonicalizeXml } from "../utils/xml";
import { sha256Hex } from "../utils/hash";
import { nowMs } from "../utils/time";
import { newRunId } from "../utils/ids";
import { errorToJson, SmithersError } from "../utils/errors";
import { computeRetryDelayMs } from "../utils/retry";
import {
  buildPlanTree,
  scheduleTasks,
  buildStateKey,
  type TaskState,
  type TaskStateMap,
  type RalphStateMap,
} from "./scheduler";
import { runWithToolContext } from "../tools/context";
import { getDefinedToolMetadata } from "../tools/defineTool";
import {
  captureSnapshotEffect,
  loadLatestSnapshot,
  parseSnapshot,
} from "../time-travel/snapshot";
import { EventBus } from "../events";
import { getJjPointer } from "../vcs/jj";
import { findVcsRoot } from "../vcs/find-root";
import { z } from "zod";
import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect, Metric } from "effect";
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
} from "../effect/metrics";
import { runScorersAsync } from "../scorers/run-scorers";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fromPromise } from "../effect/interop";
import { logDebug, logError, logInfo, logWarning } from "../effect/logging";
import { runPromise, runSync } from "../effect/runtime";
import { HotWorkflowController } from "../hot";
import type { HotReloadOptions } from "../RunOptions";
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { withTaskRuntime } from "../effect/task-runtime";
import { hashCapabilityRegistry } from "../agents/capability-registry";
import {
  cancelPendingTimersBridge,
  executeTaskBridge,
  isBridgeManagedTimerTask as isTimerTask,
  resolveDeferredTaskStateBridge,
} from "../effect/workflow-bridge";
import { createSchedulerWakeQueue, runWorkflowWithMakeBridge } from "../effect/workflow-make-bridge";
import {
  createWorkflowVersioningRuntime,
  getWorkflowPatchDecisions,
  withWorkflowVersioningRuntime,
} from "../effect/versioning";

/**
 * Track which worktree paths have already been created this run so we don't
 * re-create them for every task sharing the same worktree.
 */
const createdWorktrees = new Set<string>();
const gitBinary = typeof Bun !== "undefined" ? Bun.which("git") : null;
const caffeinateBinary =
  typeof Bun !== "undefined" ? Bun.which("caffeinate") : null;

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
      const { runJj } = await import("../vcs/jj");
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
    const { workspaceAdd, runJj } = await import("../vcs/jj");
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
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const RUN_HEARTBEAT_MS = 1_000;
const RUN_HEARTBEAT_STALE_MS = 5_000;
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

function buildRuntimeOwnerId() {
  return `pid:${process.pid}:${randomUUID()}`;
}

type RunDurabilityMetadata = {
  workflowHash: string | null;
  vcsType: "git" | "jj" | null;
  vcsRoot: string | null;
  vcsRevision: string | null;
};

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

function coercePositiveInt(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
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

async function readWorkflowHash(
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
  const workflowHash = await readWorkflowHash(workflowPath);
  const vcs = findVcsRoot(rootDir);
  if (!vcs) {
    return {
      workflowHash,
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
    vcsType: vcs.type,
    vcsRoot: vcs.root,
    vcsRevision,
  };
}

function assertResumeDurabilityMetadata(
  existingRun: any,
  current: RunDurabilityMetadata,
  workflowPath: string | null,
) {
  const mismatches: string[] = [];

  if (
    existingRun.workflowPath &&
    workflowPath &&
    resolve(existingRun.workflowPath) !== resolve(workflowPath)
  ) {
    mismatches.push("workflow path changed");
  }
  if (
    existingRun.workflowHash &&
    current.workflowHash &&
    existingRun.workflowHash !== current.workflowHash
  ) {
    mismatches.push("workflow file contents changed");
  }
  if (
    existingRun.vcsType &&
    current.vcsType &&
    existingRun.vcsType !== current.vcsType
  ) {
    mismatches.push("VCS type changed");
  }
  if (
    existingRun.vcsRoot &&
    current.vcsRoot &&
    resolve(existingRun.vcsRoot) !== resolve(current.vcsRoot)
  ) {
    mismatches.push("VCS root changed");
  }
  if (
    existingRun.vcsRevision &&
    current.vcsRevision &&
    existingRun.vcsRevision !== current.vcsRevision
  ) {
    mismatches.push("VCS revision changed");
  }

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

async function computeTaskStates(
  adapter: SmithersDb,
  db: any,
  runId: string,
  tasks: TaskDescriptor[],
  eventBus: EventBus,
  ralphDone: Map<string, boolean>,
  retryFailedOnResume = false,
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
    if (failedAttempts.length >= maxAttempts) {
      if (retryFailedOnResume && failedAttempts.length > 0) {
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
        await maybeEmitStateEvent("pending", desc);
        continue;
      }
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
    if (failedAttempts.length > 0 && desc.retryPolicy) {
      const lastFailed = failedAttempts[0];
      const delayMs = computeRetryDelayMs(
        desc.retryPolicy,
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
  void runPromise(Metric.set(schedulerConcurrencyUtilization, maxConcurrency > 0 ? inProgressTotal / maxConcurrency : 0));

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
  let heartbeatTimeoutTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimeoutTriggered = false;

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

  if (desc.heartbeatTimeoutMs) {
    heartbeatTimeoutTimer = setInterval(() => {
      if (
        heartbeatClosed ||
        taskCompleted ||
        taskExecutionReturned ||
        heartbeatTimeoutTriggered ||
        taskSignal.aborted
      ) {
        return;
      }
      const lastHeartbeatAtMs = Math.max(startedAtMs, heartbeatPendingAtMs);
      const staleForMs = nowMs() - lastHeartbeatAtMs;
      if (staleForMs <= desc.heartbeatTimeoutMs!) {
        return;
      }
      heartbeatTimeoutTriggered = true;
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
    }, TASK_HEARTBEAT_TIMEOUT_CHECK_MS);
  }

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

  // Ensure the worktree directory exists on disk before running the task.
  if (desc.worktreePath) {
    await ensureWorktree(toolConfig.rootDir, desc.worktreePath, desc.worktreeBranch, desc.worktreeBaseBranch);
  }
  const cacheAgent = Array.isArray(desc.agent) ? desc.agent[0] : desc.agent;

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
            void runPromise(Metric.increment(cacheHits));
            logInfo("cache hit for task output", {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              cacheKey,
            }, "engine:task-cache");
          } else {
            void runPromise(Metric.increment(cacheMisses));
          }
        } else {
          void runPromise(Metric.increment(cacheMisses));
        }
      }
    }

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
      const emitOutput = (text: string, stream: "stdout" | "stderr") => {
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
      let agentResult: any;
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
          result = await runWithToolContext(
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
                timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
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
        void runPromise(Metric.update(promptSizeBytes, promptBytes));

        responseText = (result as any).text ?? null;
        if (responseText) {
          void runPromise(Metric.update(responseSizeBytes, Buffer.byteLength(responseText, "utf8")));
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
            const fs = await import("node:fs");
            fs.appendFileSync(
              "/tmp/smithers_debug.log",
              `[JSON Debug] output is string, length=${output.length}, preview: ${output.slice(0, 500)}\n`,
            );
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

      // Schema-validation retry: if the agent returned parseable JSON but it
      // doesn't match the Zod schema, resume the SAME agent conversation with
      // the validation error up to 3 times before giving up.  These attempts
      // are NOT counted as normal task retries — the agent did the work, it
      // just formatted the output wrong.
      const MAX_SCHEMA_RETRIES = 3;
      let schemaRetry = 0;

      // Build a conversation history so each schema-fix attempt resumes the
      // same conversation instead of starting fresh.  For SDK-based agents
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

        const schemaRetryResult = await (effectiveAgent as any).generate({
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
        });
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

      if (!validation.ok) {
        throw validation.error;
      }
      payload = validation.data;
    }

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
    void runPromise(Effect.all([
      Metric.update(nodeDuration, taskElapsedMs),
      Metric.update(attemptDuration, taskElapsedMs),
    ], { discard: true }));

    // Fire async scorers if the task has any attached
    if (desc.scorers && Object.keys(desc.scorers).length > 0) {
      runScorersAsync(
        desc.scorers,
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
    if (heartbeatWriteTimer) {
      clearTimeout(heartbeatWriteTimer);
      heartbeatWriteTimer = undefined;
    }
    if (heartbeatTimeoutTimer) {
      clearInterval(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = undefined;
    }
    removeAbortForwarder();
  }
}

async function renderFrameAsync<Schema>(
  workflow: SmithersWorkflow<Schema>,
  ctx: any,
  opts?: { baseRootDir?: string },
): Promise<GraphSnapshot> {
  const renderer = new SmithersRenderer();
  const result = await renderer.render(workflow.build(ctx), {
    ralphIterations: ctx?.iterations,
    baseRootDir: opts?.baseRootDir,
    defaultIteration: ctx?.iteration,
  });

  // Resolve output tasks: ZodObject references via zodToKeyName, string keys via schemaRegistry
  resolveTaskOutputs(result.tasks, workflow);

  return { runId: ctx.runId, frameNo: 0, xml: result.xml, tasks: result.tasks };
}

export function renderFrameEffect<Schema>(
  workflow: SmithersWorkflow<Schema>,
  ctx: any,
  opts?: { baseRootDir?: string },
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
  opts?: { baseRootDir?: string },
): Promise<GraphSnapshot> {
  return runPromise(renderFrameEffect(workflow, ctx, opts));
}

async function runWorkflowAsync<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunResult> {
  const runId = opts.runId ?? newRunId();
  return runWorkflowWithMakeBridge(
    workflow,
    {
      ...opts,
      runId,
    },
    runWorkflowBody,
  );
}

async function runWorkflowBody<Schema>(
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
    opts.maxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
  );
  const maxOutputBytes = coercePositiveInt(
    opts.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const toolTimeoutMs = coercePositiveInt(
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

  const wakeLock = acquireCaffeinate();
  try {
    logInfo("starting workflow run", {
      runId,
      workflowPath: resolvedWorkflowPath ?? null,
      rootDir,
      maxConcurrency,
      allowNetwork,
      hotReload: hotOpts.enabled,
      resume: Boolean(opts.resume),
    }, "engine:run");
    const existingRun = await adapter.getRun(runId);
    const existingConfig = parseRunConfigJson(existingRun?.configJson);
    const runAuth = opts.auth ?? parseRunAuthContext(existingConfig.auth);
    const runConfig = {
      ...existingConfig,
      ...(opts.config ?? {}),
      maxConcurrency,
      rootDir,
      allowNetwork,
      maxOutputBytes,
      toolTimeoutMs,
      ...(opts.cliAgentToolsDefault
        ? { cliAgentToolsDefault: opts.cliAgentToolsDefault }
        : {}),
      ...(runAuth ? { auth: runAuth } : {}),
    };
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
      assertResumeDurabilityMetadata(existingRun, runMetadata, resolvedWorkflowPath);
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
        configJson: JSON.stringify(runConfig),
      });
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
        configJson: JSON.stringify(runConfig),
      });
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

    const runStartPerformanceMs = performance.now();

    await cancelStaleAttempts(adapter, runId);

    if (opts.resume) {
      void runPromise(Metric.increment(runsResumedTotal));
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
    // Track in-flight task promises across loop iterations so we
    // wait for them before declaring the run finished.
    const inflight = new Set<Promise<void>>();
    // Track mounted task IDs from the previous frame to detect newly
    // mounted tasks. When a conditional child mounts new tasks after
    // outputs change, we must re-render instead of finishing.
    let prevMountedTaskIds: Set<string> = new Set();
    const schedulerWakeQueue = createSchedulerWakeQueue();
    const notifyScheduler = () => schedulerWakeQueue.notify();
    let hotWaitInFlight = false;
    onAbortWake = () => notifyScheduler();
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
          notifyScheduler();
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

    while (true) {
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
        return { runId, status: "cancelled" };
      }

      if (hijackState.request && !hijackState.completion && inflight.size === 0) {
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
            continue;
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
          continue;
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

      const { xml, tasks, mountedTaskIds } =
        await withWorkflowVersioningRuntime(workflowVersioning, () =>
          renderer.render(workflowRef.build(ctx), {
            ralphIterations,
            defaultIteration,
            baseRootDir: rootDir,
          }),
        );
      await workflowVersioning.flush();
      const xmlJson = canonicalizeXml(xml);
      const xmlHash = sha256Hex(xmlJson);

      // Resolve output tasks: ZodObject references via zodToKeyName, string keys via schemaRegistry
      resolveTaskOutputs(tasks, workflow);

      const workflowName = getWorkflowNameFromXml(xml);
      const cacheEnabled =
        workflow.opts.cache ??
        Boolean(
          xml &&
          xml.kind === "element" &&
          (xml.props.cache === "true" || xml.props.cache === "1"),
        );
      await adapter.updateRun(runId, { workflowName });

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
        continue;
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
      const retryFailedOnResume =
        opts.resume && existingRun?.status === "failed";
      const { stateMap, retryWait } = await computeTaskStates(
        adapter,
        db,
        runId,
        tasks,
        eventBus,
        ralphDoneMap,
        retryFailedOnResume,
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

      const runnable = applyConcurrencyLimits(
        schedule.runnable,
        stateMap,
        maxConcurrency,
        tasks,
      );
      void runPromise(Metric.set(schedulerQueueDepth, schedule.runnable.length - runnable.length));

      if (runnable.length === 0) {
        // If tasks are still in-flight, wait for one to finish then
        // loop back to re-evaluate instead of declaring the run done.
        if (inflight.size > 0) {
          armHotReloadWakeup();
          await schedulerWakeQueue.wait();
          continue;
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
          continue;
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
          return { runId, status: "waiting-approval" };
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
          return { runId, status: "waiting-event" };
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
          return { runId, status: "waiting-timer" };
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
          return { runId, status: "failed", error: errorMsg };
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
            continue;
          }
          const latestRun = await adapter.getRun(runId);
          if (latestRun?.cancelRequestedAtMs) {
            runAbortController.abort();
            continue;
          }

          const continuationIteration = defaultIteration;
          let transition: ContinueAsNewTransition;
          try {
            transition = await runPromise(
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
          runSync(trackEvent(continuationEvent));
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
          void runPromise(
            Metric.update(runDuration, performance.now() - runStartPerformanceMs),
          );

          return {
            runId,
            status: "continued",
            nextRunId: transition.newRunId,
          };
        }

        if (schedule.pendingExists) {
          const waitMs =
            schedule.nextRetryAtMs != null
              ? Math.max(0, schedule.nextRetryAtMs - nowMs())
              : 100;
          if (waitMs > 0) {
            await Bun.sleep(waitMs);
          }
          continue;
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
                transition = await runPromise(
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
              runSync(trackEvent(continuationEvent));
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
              void runPromise(
                Metric.update(runDuration, performance.now() - runStartPerformanceMs),
              );

              return {
                runId,
                status: "continued",
                nextRunId: transition.newRunId,
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
              return {
                runId,
                status: "failed",
                error: { code: "RALPH_MAX_REACHED", ralphId: ralph.id },
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
          continue;
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
            continue;
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
        void runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
        logInfo("workflow run finished", {
          runId,
        }, "engine:run");

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
        return { runId, status: "finished", output };
      }

      const toolConfig = {
        rootDir,
        allowNetwork,
        maxOutputBytes,
        toolTimeoutMs,
      };

      // Launch new tasks and track them in the persistent inflight set.
      for (const task of runnable) {
        const p = executeTaskBridge(
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
        ).finally(() => {
          inflight.delete(p);
          notifyScheduler();
        });
        inflight.add(p);
      }
      // Wait for at least one task to finish, then loop back to
      // re-render and schedule newly runnable tasks.
      {
        if (inflight.size > 0 || hotController) {
          armHotReloadWakeup();
          const waitStart = performance.now();
          await schedulerWakeQueue.wait();
          void runPromise(
            Metric.update(
              schedulerWaitDuration,
              performance.now() - waitStart,
            ),
          );
        }
      }
    }
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
      return { runId, status: "cancelled" };
    }
    logError("workflow run failed with unhandled error", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    }, "engine:run");
    const errorInfo = errorToJson(err);
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
    return { runId, status: "failed", error: errorInfo };
  } finally {
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
  return fromPromise("run workflow", () => runWorkflowAsync(workflow, opts)).pipe(
    Effect.annotateLogs({
      runId: opts.runId ?? "",
      workflowPath: opts.workflowPath ?? "",
      maxConcurrency: opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      hot: Boolean(opts.hot),
    }),
    Effect.withLogSpan("engine:run-workflow"),
  );
}

export async function runWorkflow<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunResult> {
  return runPromise(runWorkflowEffect(workflow, opts));
}
