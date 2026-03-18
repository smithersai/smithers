import type { SmithersWorkflow } from "../SmithersWorkflow";
import type { RunOptions } from "../RunOptions";
import type { RunResult } from "../RunResult";
import type { SmithersEvent } from "../SmithersEvent";
import type { TaskDescriptor } from "../TaskDescriptor";
import { SmithersRenderer } from "../dom/renderer";
import { buildContext } from "../context";
import { loadInput, loadOutputs } from "../db/snapshot";
import { ensureSmithersTables } from "../db/ensure";
import { SmithersDb } from "../db/adapter";
import {
  selectOutputRow,
  upsertOutputRow,
  validateOutput,
  validateExistingOutput,
  getAgentOutputSchema,
  describeSchemaShape,
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
import { EventBus } from "../events";
import { getJjPointer } from "../vcs/jj";
import { findVcsRoot } from "../vcs/find-root";
import { z } from "zod";
import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect, Metric } from "effect";
import { cacheHits, cacheMisses, nodeDuration, attemptDuration, schedulerQueueDepth, promptSizeBytes, responseSizeBytes, runDuration, runsResumedTotal } from "../effect/metrics";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fromPromise } from "../effect/interop";
import { logDebug, logError, logInfo, logWarning } from "../effect/logging";
import { runPromise } from "../effect/runtime";
import { HotWorkflowController } from "../hot/HotWorkflowController";
import type { HotReloadOptions } from "../RunOptions";
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { withTaskRuntime } from "../effect/task-runtime";

/**
 * Track which worktree paths have already been created this run so we don't
 * re-create them for every task sharing the same worktree.
 */
const createdWorktrees = new Set<string>();

function makeAbortError(message = "Task aborted"): Error {
  const err = new Error(message);
  (err as any).name = "AbortError";
  return err;
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

async function runGitCommand(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const child = nodeSpawn("git", args, {
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
    throw new Error(
      `Cannot create worktree: no git or jj repository found from ${rootDir}`,
    );
  }

  // Best effort: refresh remote refs for git so origin/main can be used as a
  // base when local main is absent.
  if (vcs.type === "git") {
    await new Promise<void>((res) => {
      const child = nodeSpawn("git", ["fetch", "origin"], {
        cwd: vcs.root,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("close", () => res());
      child.on("error", () => res());
    });
  }

  if (vcs.type === "jj") {
    const { workspaceAdd, runJj } = await import("../vcs/jj");
    const name = worktreePath.split("/").pop() ?? "worktree";
    const wsResult = await workspaceAdd(name, worktreePath, { cwd: vcs.root, atRev: baseBranch });
    if (!wsResult.success) {
      throw new Error(
        `Failed to create jj workspace at ${worktreePath}: ${wsResult.error}`,
      );
    }
    // Create a bookmark pointing at the new workspace's working copy
    if (branch) {
      const setRes = await runJj(["bookmark", "set", branch, "-r", "@"], {
        cwd: worktreePath,
      });
      if (setRes.code !== 0) {
        throw new Error(
          `Failed to set jj bookmark ${branch} in ${worktreePath}: ${setRes.stderr || `exit ${setRes.code}`}`,
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
        throw new Error(
          `Failed to create git worktree at ${worktreePath} on branch ${branch}. Tried main, origin/main, and HEAD. ${failures.join(" | ")}`,
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
        throw new Error(
          `Failed to create git worktree at ${worktreePath}. Tried main, origin/main, and HEAD. ${failures.join(" | ")}`,
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

type RunDurabilityMetadata = {
  workflowHash: string | null;
  vcsType: "git" | "jj" | null;
  vcsRoot: string | null;
  vcsRevision: string | null;
};

/** Prevent macOS idle sleep while a workflow is running. No-op on other platforms. */
function acquireCaffeinate(): { release: () => void } {
  if (platform() !== "darwin") return { release: () => {} };
  try {
    const child = nodeSpawn("caffeinate", ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: true,
    });
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

function buildOutputRow(
  outputTable: any,
  runId: string,
  nodeId: string,
  iteration: number,
  payload: unknown,
) {
  const cols = getTableColumns(outputTable as any) as Record<string, any>;
  const keys = Object.keys(cols);
  const hasPayload = keys.includes("payload");
  const payloadOnly =
    hasPayload &&
    keys.every(
      (key) =>
        key === "runId" ||
        key === "nodeId" ||
        key === "iteration" ||
        key === "payload",
    );
  if (payloadOnly) {
    return {
      runId,
      nodeId,
      iteration,
      payload: (payload ?? null) as any,
    };
  }
  return {
    ...((payload ?? {}) as Record<string, unknown>),
    runId,
    nodeId,
    iteration,
  };
}

function stripAutoColumns(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { runId: _runId, nodeId: _nodeId, iteration: _iteration, ...rest } =
    payload as Record<string, unknown>;
  return rest;
}

function normalizeInputRow(row: any): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};
  if ("payload" in row) {
    const payload = (row as any).payload;
    if (payload && typeof payload === "object") {
      return payload as Record<string, unknown>;
    }
    return {};
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
  for (const [id, value] of state.entries()) {
    obj[id] = value.iteration ?? 0;
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

    if (desc.needsApproval) {
      const approval = await adapter.getApproval(
        runId,
        desc.nodeId,
        desc.iteration,
      );
      if (approval?.status === "denied") {
        if (desc.approvalMode === "decision" && desc.approvalOnDeny !== "fail") {
          // Decision-mode denial with onDeny=continue|skip: check whether the
          // computeFn has already run and written an output row. If so, the
          // task is finished; otherwise it is still pending (scheduled to run).
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
                lastAttempt: null,
                updatedAtMs: nowMs(),
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
              });
              continue;
            }
          }
          stateMap.set(key, "pending");
          await adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "pending",
            lastAttempt: null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
          await maybeEmitStateEvent("pending", desc);
          continue;
        }
        const state: TaskState = desc.continueOnFail ? "skipped" : "failed";
        stateMap.set(key, state);
        await adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state,
          lastAttempt: null,
          updatedAtMs: nowMs(),
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
        await maybeEmitStateEvent(state, desc);
        continue;
      }
      if (!approval || approval.status !== "approved") {
        if (
          desc.approvalMode === "decision" &&
          approval?.status === "denied" &&
          desc.approvalOnDeny !== "fail"
        ) {
          stateMap.set(key, "pending");
          await adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "pending",
            lastAttempt: null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
          await maybeEmitStateEvent("pending", desc);
          continue;
        }
        if (!approval) {
          await adapter.insertOrUpdateApproval({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            status: "requested",
            requestedAtMs: nowMs(),
            decidedAtMs: null,
            note: null,
            decidedBy: null,
          });
          await eventBus.emitEventWithPersist({
            type: "ApprovalRequested",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            timestampMs: nowMs(),
          });
          await eventBus.emitEventWithPersist({
            type: "NodeWaitingApproval",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            timestampMs: nowMs(),
          });
        }
        stateMap.set(key, "waiting-approval");
        await adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "waiting-approval",
          lastAttempt: null,
          updatedAtMs: nowMs(),
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
        continue;
      }
    }

    const attempts = await adapter.listAttempts(
      runId,
      desc.nodeId,
      desc.iteration,
    );
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
    await adapter.updateAttempt(
      runId,
      attempt.nodeId,
      attempt.iteration,
      attempt.attempt,
      {
        state: "cancelled",
        finishedAtMs: nowMs(),
      },
    );
    await adapter.insertNode({
      runId,
      nodeId: attempt.nodeId,
      iteration: attempt.iteration,
      state: "cancelled",
      lastAttempt: attempt.attempt,
      updatedAtMs: nowMs(),
      outputTable: "",
      label: null,
    });
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

async function cancelStaleAttempts(adapter: SmithersDb, runId: string) {
  const inProgress = await adapter.listInProgressAttempts(runId);
  const now = nowMs();
  for (const attempt of inProgress) {
    if (attempt.startedAtMs && now - attempt.startedAtMs > STALE_ATTEMPT_MS) {
      await adapter.updateAttempt(
        runId,
        attempt.nodeId,
        attempt.iteration,
        attempt.attempt,
        {
          state: "cancelled",
          finishedAtMs: now,
        },
      );
      await adapter.insertNode({
        runId,
        nodeId: attempt.nodeId,
        iteration: attempt.iteration,
        state: "pending",
        lastAttempt: attempt.attempt,
        updatedAtMs: now,
        outputTable: "",
        label: null,
      });
    }
  }
}

async function executeTask(
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
) {
  const taskStartMs = performance.now();
  const attempts = await adapter.listAttempts(
    runId,
    desc.nodeId,
    desc.iteration,
  );
  const attemptNo = (attempts[0]?.attempt ?? 0) + 1;

  await adapter.insertAttempt({
    runId,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    attempt: attemptNo,
    state: "in-progress",
    startedAtMs: nowMs(),
    finishedAtMs: null,
    errorJson: null,
    jjPointer: null,
    jjCwd: desc.worktreePath ?? toolConfig.rootDir,
    cached: false,
    metaJson: JSON.stringify({
      prompt: desc.prompt ?? null,
      staticPayload: desc.staticPayload ?? null,
      label: desc.label ?? null,
      outputTable: desc.outputTableName,
      needsApproval: desc.needsApproval,
      retries: desc.retries,
      timeoutMs: desc.timeoutMs,
    }),
  });
  await adapter.insertNode({
    runId,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    state: "in-progress",
    lastAttempt: attemptNo,
    updatedAtMs: nowMs(),
    outputTable: desc.outputTableName,
    label: desc.label ?? null,
  });

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
    if (signal?.aborted) {
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
      const toolsSig = cacheAgent?.tools
        ? Object.keys(cacheAgent.tools).sort().join(",")
        : "";
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
      if (effectiveAgent) {
        // Use fallback agent on retry attempts when available
        const result = await runWithToolContext(
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
            // Auto-append structured output instructions when an output table is defined.
            // This prevents agents from needing manual "REQUIRED OUTPUT" blocks in every prompt
            // and avoids costly retry round-trips when the agent forgets to output JSON.
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
              // Prepend a brief reminder at the top AND append full instructions at the end.
              // This ensures models with long outputs don't lose track of the JSON requirement.
              effectivePrompt = [
                "IMPORTANT: After completing the task below, you MUST output a JSON object in a ```json code fence at the very end of your response. Do NOT forget this — the workflow fails without it.",
                "",
                effectivePrompt,
                "",
                "",
                jsonInstructions,
              ].join("\n");
            }
            const emitOutput = (text: string, stream: "stdout" | "stderr") => {
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
            return (effectiveAgent as any).generate({
              options: undefined as any,
              abortSignal: signal,
              prompt: effectivePrompt,
              timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
              onStdout: (text: string) => emitOutput(text, "stdout"),
              onStderr: (text: string) => emitOutput(text, "stderr"),
              outputSchema: desc.outputSchema,
            });
          },
        );

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
              abortSignal: signal,
              prompt: jsonPrompt,
              timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
            });
            const retryText = (retryResult as any).text ?? "";
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
            throw new Error("No valid JSON output found in agent response");
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
            throw new Error(
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
              signal: signal ?? new AbortController().signal,
              db,
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
                    new Error(
                      `Compute callback timed out after ${desc.timeoutMs}ms`,
                    ),
                  ),
                desc.timeoutMs!,
              ),
            ),
          );
        }
        const abort = abortPromise(signal);
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
      // doesn't match the Zod schema, re-prompt with the error and expected
      // shape up to 2 times before giving up.
      const MAX_SCHEMA_RETRIES = 2;
      let schemaRetry = 0;
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
          `Your previous output did not match the required schema. Validation errors:`,
          zodIssues,
          ``,
          `You MUST output ONLY a valid JSON object with exactly these fields and types:`,
          schemaDesc,
          ``,
          `Output ONLY the JSON object, no other text.`,
        ].join("\n");

        const schemaRetryResult = await (effectiveAgent as any).generate({
          options: undefined as any,
          abortSignal: signal,
          prompt: schemaRetryPrompt,
          timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
        });
        const retryText = ((schemaRetryResult as any).text ?? "").trim();

        // Try to parse the retry response
        let retryOutput: any;
        try {
          if (retryText.startsWith("{")) {
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
          }
        }
      }

      if (!validation.ok) {
        throw validation.error;
      }
      payload = validation.data;
    }

    await eventBus.flush();
    await upsertOutputRow(
      db,
      desc.outputTable as any,
      { runId, nodeId: desc.nodeId, iteration: desc.iteration },
      payload,
    );
    if (stepCacheEnabled && cacheKey && !cached) {
      await adapter.insertCache({
        cacheKey,
        createdAtMs: nowMs(),
        workflowName,
        nodeId: desc.nodeId,
        outputTable: desc.outputTableName,
        schemaSig: schemaSignature(desc.outputTable as any),
        outputSchemaSig: desc.outputSchema
          ? sha256Hex(describeSchemaShape(desc.outputTable as any, desc.outputSchema))
          : null,
        agentSig: cacheAgent?.id ?? "agent",
        toolsSig: cacheAgent?.tools
          ? Object.keys(cacheAgent.tools).sort().join(",")
          : null,
        jjPointer: cacheJjBase,
        payloadJson: JSON.stringify(payload),
      });
    }
    // Reuse the resolved taskRoot for JJ pointer capture to avoid recomputing.
    const jjPointer = await getJjPointer(taskRoot);

    await adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
      state: "finished",
      finishedAtMs: nowMs(),
      jjPointer,
      cached,
      responseText,
    });
    await adapter.insertNode({
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      state: "finished",
      lastAttempt: attemptNo,
      updatedAtMs: nowMs(),
      outputTable: desc.outputTableName,
      label: desc.label ?? null,
    });

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
    if (signal?.aborted || isAbortError(err)) {
      await adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
        state: "cancelled",
        finishedAtMs: nowMs(),
        errorJson: JSON.stringify(errorToJson(err)),
        responseText,
      });
      await adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "cancelled",
        lastAttempt: attemptNo,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
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
        error: err instanceof Error ? err.message : String(err),
      }, "engine:task");
      return;
    }
    logError("task execution failed", {
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      maxAttempts: desc.retries + 1,
      error: err instanceof Error ? err.message : String(err),
    }, "engine:task");
    await adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
      state: "failed",
      finishedAtMs: nowMs(),
      errorJson: JSON.stringify(errorToJson(err)),
      responseText,
    });
    await adapter.insertNode({
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      state: "failed",
      lastAttempt: attemptNo,
      updatedAtMs: nowMs(),
      outputTable: desc.outputTableName,
      label: desc.label ?? null,
    });

    // Circuit-breaker: disable agents that fail with auth errors
    if (disabledAgents && effectiveAgent) {
      const errStr = String((err as any)?.message ?? err ?? "") + (responseText ?? "");
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
      error: errorToJson(err),
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
  }
}

async function renderFrameAsync<Schema>(
  workflow: SmithersWorkflow<Schema>,
  ctx: any,
  opts?: { baseRootDir?: string },
): Promise<{
  runId: string;
  frameNo: number;
  xml: any;
  tasks: TaskDescriptor[];
}> {
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
): Promise<{
  runId: string;
  frameNo: number;
  xml: any;
  tasks: TaskDescriptor[];
}> {
  return runPromise(renderFrameEffect(workflow, ctx, opts));
}

async function runWorkflowAsync<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunResult> {
  return await runWorkflowBody(workflow, opts);
}

async function runWorkflowBody<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunResult> {
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
  const runtimeOwnerId = randomUUID();
  const runAbortController = new AbortController();
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
      const existingInput = await loadInput(db, inputTable, runId);
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
        vcsType: runMetadata.vcsType,
        vcsRoot: runMetadata.vcsRoot,
        vcsRevision: runMetadata.vcsRevision,
        errorJson: null,
        configJson: JSON.stringify({
          maxConcurrency,
          rootDir,
          allowNetwork,
          maxOutputBytes,
          toolTimeoutMs,
        }),
      });
    } else {
      await adapter.updateRun(runId, {
        status: "running",
        startedAtMs: existingRun.startedAtMs ?? nowMs(),
        finishedAtMs: null,
        heartbeatAtMs: nowMs(),
        runtimeOwnerId,
        cancelRequestedAtMs: null,
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
        configJson: JSON.stringify({
          maxConcurrency,
          rootDir,
          allowNetwork,
          maxOutputBytes,
          toolTimeoutMs,
        }),
      });
    }
    stopSupervisor = startRunSupervisor(
      adapter,
      runId,
      runtimeOwnerId,
      runAbortController,
    );

    await eventBus.emitEventWithPersist({
      type: "RunStarted",
      runId,
      timestampMs: nowMs(),
    });

    const runStartPerformanceMs = performance.now();

    await cancelStaleAttempts(adapter, runId);

    if (opts.resume) {
      // On resume, cancel ALL in-progress attempts since the previous process is dead
      const staleInProgress = await adapter.listInProgressAttempts(runId);
      const now = nowMs();
      for (const attempt of staleInProgress) {
        await adapter.updateAttempt(
          runId,
          attempt.nodeId,
          attempt.iteration,
          attempt.attempt,
          {
            state: "cancelled",
            finishedAtMs: now,
          },
        );
        await adapter.insertNode({
          runId,
          nodeId: attempt.nodeId,
          iteration: attempt.iteration,
          state: "pending",
          lastAttempt: attempt.attempt,
          updatedAtMs: now,
          outputTable: "",
          label: null,
        });
      }
    }

    const disabledAgents = new Set<any>();
    const renderer = new SmithersRenderer();
    let frameNo = (await adapter.getLastFrame(runId))?.frameNo ?? 0;
    let defaultIteration = 0;
    // Track in-flight task promises across loop iterations so we
    // wait for them before declaring the run finished.
    const inflight = new Set<Promise<void>>();
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

    if (hotOpts.enabled && (resolvedWorkflowPath ?? opts.workflowPath)) {
      process.env.SMITHERS_HOT = "1";
      hotController = new HotWorkflowController(
        resolvedWorkflowPath ?? opts.workflowPath!,
        hotOpts,
      );
      await hotController.init();
    }

    while (true) {
      if (runAbortController.signal.aborted) {
        logInfo("run abort observed in scheduler loop", {
          runId,
        }, "engine:run");
        await adapter.updateRun(runId, {
          status: "cancelled",
          finishedAtMs: nowMs(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
        });
        await eventBus.emitEventWithPersist({
          type: "RunCancelled",
          runId,
          timestampMs: nowMs(),
        });
        return { runId, status: "cancelled" };
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

      const ctx = buildContext<Schema>({
        runId,
        iteration: defaultIteration,
        iterations: ralphIterationsObject(ralphState),
        input: inputRow,
        outputs,
        zodToKeyName: workflow.zodToKeyName,
      });

      const { xml, tasks, mountedTaskIds } = await renderer.render(
        workflowRef.build(ctx),
        {
          ralphIterations,
          defaultIteration,
          baseRootDir: rootDir,
        },
      );
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
      await adapter.insertFrame({
        runId,
        frameNo,
        createdAtMs: nowMs(),
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
      });
      await eventBus.emitEventWithPersist({
        type: "FrameCommitted",
        runId,
        frameNo,
        xmlHash,
        timestampMs: nowMs(),
      });

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

      const { plan, ralphs } = buildPlanTree(xml);
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

      const runnable = applyConcurrencyLimits(
        schedule.runnable,
        stateMap,
        maxConcurrency,
        tasks,
      );

      if (runnable.length === 0) {
        // If tasks are still in-flight, wait for one to finish then
        // loop back to re-evaluate instead of declaring the run done.
        if (inflight.size > 0) {
          {
            const waitables: Promise<any>[] = [...inflight];
            if (hotController) {
              waitables.push(
                hotController.wait().then((files) => {
                  hotPendingFiles = files;
                }),
              );
            }
            if (waitables.length > 0) {
              await Promise.race(waitables);
            }
          }
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
            for (const attempt of attempts) {
              if (attempt.state === "in-progress") {
                await adapter.updateAttempt(runId, task.nodeId, task.iteration, attempt.attempt, {
                  state: "cancelled",
                  finishedAtMs: now,
                });
              }
            }
            await adapter.insertNode({
              runId,
              nodeId: task.nodeId,
              iteration: task.iteration,
              state: "pending",
              lastAttempt: null,
              updatedAtMs: now,
              outputTable: task.outputTableName,
              label: task.label ?? null,
            });
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
          });
          await eventBus.emitEventWithPersist({
            type: "RunStatusChanged",
            runId,
            status: "waiting-approval",
            timestampMs: nowMs(),
          });
          return { runId, status: "waiting-approval" };
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
          await adapter.updateRun(runId, {
            status: "failed",
            finishedAtMs: nowMs(),
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
          });
          await eventBus.emitEventWithPersist({
            type: "RunFailed",
            runId,
            error: errorMsg,
            timestampMs: nowMs(),
          });
          return { runId, status: "failed", error: errorMsg };
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
          for (const ralph of schedule.readyRalphs) {
            const state = ralphState.get(ralph.id) ?? {
              iteration: defaultIteration,
              done: false,
            };
            if (state.done || ralph.until) continue;
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

        await adapter.updateRun(runId, {
          status: "finished",
          finishedAtMs: nowMs(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
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
        const p = executeTask(
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
        ).finally(() => inflight.delete(p));
        inflight.add(p);
      }
      // Wait for at least one task to finish, then loop back to
      // re-render and schedule newly runnable tasks.
      {
        const waitables: Promise<any>[] = [...inflight];
        if (hotController) {
          waitables.push(
            hotController.wait().then((files) => {
              hotPendingFiles = files;
            }),
          );
        }
        if (waitables.length > 0) {
          await Promise.race(waitables);
        }
      }
    }
  } catch (err) {
    if (runAbortController.signal.aborted || isAbortError(err)) {
      logInfo("workflow run cancelled while handling error", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      }, "engine:run");
      await adapter.updateRun(runId, {
        status: "cancelled",
        finishedAtMs: nowMs(),
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        cancelRequestedAtMs: null,
        errorJson: JSON.stringify(errorToJson(err)),
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
    await adapter.updateRun(runId, {
      status: "failed",
      finishedAtMs: nowMs(),
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
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
