import type {
  SmithersWorkflow,
  RunOptions,
  RunResult,
  SmithersEvent,
  TaskDescriptor,
} from "../types";
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
import { canonicalizeXml } from "../utils/xml";
import { sha256Hex } from "../utils/hash";
import { nowMs } from "../utils/time";
import { newRunId } from "../utils/ids";
import { errorToJson, SmithersError } from "../utils/errors";
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
import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { dirname, resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { platform } from "node:os";

const DEFAULT_MAX_CONCURRENCY = 4;
const STALE_ATTEMPT_MS = 15 * 60 * 1000;
const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — agents need time for builds/tests
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

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
 * - ZodObject on outputSchema with empty outputTableName → look up via zodToKeyName
 * - String key on outputTableName → look up via schemaRegistry
 * Both paths set outputTable, outputTableName, and outputSchema on the descriptor.
 */
function resolveTaskOutputs(tasks: TaskDescriptor[], workflow: SmithersWorkflow<any>) {
  for (const task of tasks) {
    // Already resolved (has a table)
    if (task.outputTable) continue;

    // ZodObject reference: outputSchema is set but outputTableName is empty
    if (task.outputSchema && !task.outputTableName && workflow.zodToKeyName) {
      const keyName = workflow.zodToKeyName.get(task.outputSchema);
      if (keyName && workflow.schemaRegistry) {
        const entry = workflow.schemaRegistry.get(keyName);
        if (entry) {
          task.outputTable = entry.table;
          task.outputTableName = keyName;
        }
      }
      if (!task.outputTable) {
        throw new SmithersError(
          "UNKNOWN_OUTPUT_SCHEMA",
          `Task "${task.nodeId}" uses an output ZodObject that is not registered in createSmithers()`,
        );
      }
      continue;
    }

    // String key: outputTableName is set
    if (task.outputTableName && workflow.schemaRegistry) {
      const entry = workflow.schemaRegistry.get(task.outputTableName);
      if (entry) {
        task.outputTable = entry.table;
        if (!task.outputSchema) {
          task.outputSchema = entry.zodSchema;
        }
      } else {
        throw new SmithersError(
          "UNKNOWN_OUTPUT_KEY",
          `Task "${task.nodeId}" uses output key "${task.outputTableName}" which is not in the schema registry`,
        );
      }
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
): Promise<TaskStateMap> {
  const stateMap: TaskStateMap = new Map();

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
      continue;
    }

    if (desc.needsApproval) {
      const approval = await adapter.getApproval(
        runId,
        desc.nodeId,
        desc.iteration,
      );
      if (approval?.status === "denied") {
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
        continue;
      }
      if (!approval || approval.status !== "approved") {
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
  }

  return stateMap;
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
  eventBus: EventBus,
  toolConfig: {
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
  },
  workflowName: string,
  cacheEnabled: boolean,
) {
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
  // Resolve effective root once so both caching and execution share it.
  const taskRoot = desc.worktreePath ?? toolConfig.rootDir;

  try {
    if (cacheEnabled) {
      const schemaSig = schemaSignature(desc.outputTable as any);
      const agentSig = desc.agent?.id ?? "agent";
      const toolsSig = desc.agent?.tools
        ? Object.keys(desc.agent.tools).sort().join(",")
        : "";
      // Incorporate JJ state so workspace changes invalidate cache as documented.
      const jjBase = await getJjPointer(taskRoot);
      cacheJjBase = jjBase ?? null;
      const cacheBase = {
        workflowName,
        nodeId: desc.nodeId,
        outputTableName: desc.outputTableName,
        schemaSig,
        agentSig,
        toolsSig,
        jjPointer: cacheJjBase,
        prompt: desc.prompt ?? null,
        payload: desc.staticPayload ?? null,
      };
      cacheKey = sha256Hex(JSON.stringify(cacheBase));
      const cachedRow = await adapter.getCache(cacheKey);
      if (cachedRow) {
        const parsed = JSON.parse(cachedRow.payloadJson);
        const valid = validateOutput(desc.outputTable as any, parsed);
        if (valid.ok) {
          payload = valid.data;
          cached = true;
        }
      }
    }

    if (!payload) {
      if (desc.agent) {
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
          },
          async () => {
            // Auto-append structured output instructions when an output table is defined.
            // This prevents agents from needing manual "REQUIRED OUTPUT" blocks in every prompt
            // and avoids costly retry round-trips when the agent forgets to output JSON.
            let effectivePrompt = desc.prompt ?? "";
            if (desc.outputTable) {
              const schemaDesc = describeSchemaShape(desc.outputTable as any);
              effectivePrompt += [
                "",
                "",
                "**REQUIRED OUTPUT** — You MUST end your response with a JSON object in a code fence matching this schema:",
                "```json",
                schemaDesc,
                "```",
                "Output the JSON at the END of your response. The workflow will fail without it.",
              ].join("\n");
            }
            const emitOutput = (text: string, stream: "stdout" | "stderr") => {
              eventBus.emit("event", {
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
            return (desc.agent as any).generate({
              options: undefined as any,
              prompt: effectivePrompt,
              timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
              onStdout: (text: string) => emitOutput(text, "stdout"),
              onStderr: (text: string) => emitOutput(text, "stderr"),
              outputSchema: desc.outputSchema,
            });
          },
        );
        responseText = (result as any).text ?? null;
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

          // Helper to extract balanced JSON from text
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

          // Try to extract JSON from code fence (```json ... ```)
          if (output === undefined) {
            // Check text first - look for code fence with balanced JSON
            const codeFenceStart = text.search(/```(?:json)?\s*\{/);
            if (codeFenceStart !== -1) {
              const afterFence = text
                .slice(codeFenceStart)
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

          // Try text itself
          if (output === undefined) {
            const jsonStr = extractBalancedJson(text);
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
            const schemaDesc = describeSchemaShape(desc.outputTable as any);
            const jsonPrompt = [
              `You have completed your task. Now you MUST output ONLY a valid JSON object (no other text) with exactly these fields and types:`,
              schemaDesc,
              ``,
              `Output ONLY the JSON object, nothing else.`,
            ].join("\n");
            const retryResult = await desc.agent.generate({
              options: undefined as any,
              prompt: jsonPrompt,
              timeout: { totalMs: Math.max(desc.timeoutMs ?? 300000, 300000) },
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
            console.log(
              `[JSON Debug] finishReason=${finishReason}, text.length=${text.length}, steps.count=${debugSteps.length}`,
            );
            console.log(`[JSON Debug] text preview: ${text.slice(0, 300)}`);
            console.log(
              `[JSON Debug] last step text: ${debugSteps[debugSteps.length - 1]?.text?.slice(0, 500) ?? "none"}`,
            );
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
        const computePromise = Promise.resolve(desc.computeFn());
        if (desc.timeoutMs) {
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Compute callback timed out after ${desc.timeoutMs}ms`)), desc.timeoutMs!),
          );
          payload = await Promise.race([computePromise, timeout]);
        } else {
          payload = await computePromise;
        }
      } else {
        payload = desc.staticPayload;
      }

      if (payload && typeof payload === "object") {
        if ("runId" in payload && (payload as any).runId !== runId) {
          throw new Error("Payload runId does not match current run");
        }
        if ("nodeId" in payload && (payload as any).nodeId !== desc.nodeId) {
          throw new Error("Payload nodeId does not match task id");
        }
        if (
          "iteration" in payload &&
          (payload as any).iteration !== desc.iteration
        ) {
          throw new Error("Payload iteration does not match task iteration");
        }
      }
      const payloadWithKeys = {
        ...(payload ?? {}),
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
      };
      let validation = validateOutput(desc.outputTable as any, payloadWithKeys);

      // Schema-validation retry: if the agent returned parseable JSON but it
      // doesn't match the Zod schema, re-prompt with the error and expected
      // shape up to 2 times before giving up.
      const MAX_SCHEMA_RETRIES = 2;
      let schemaRetry = 0;
      while (!validation.ok && desc.agent && schemaRetry < MAX_SCHEMA_RETRIES) {
        schemaRetry++;
        const schemaDesc = describeSchemaShape(desc.outputTable as any);
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

        const schemaRetryResult = await (desc.agent as any).generate({
          options: undefined as any,
          prompt: schemaRetryPrompt,
          timeout: { totalMs: Math.max(desc.timeoutMs ?? 300000, 300000) },
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
          payload = retryOutput;
          const retryPayload = {
            ...retryOutput,
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
          };
          validation = validateOutput(desc.outputTable as any, retryPayload);
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

    await upsertOutputRow(
      db,
      desc.outputTable as any,
      { runId, nodeId: desc.nodeId, iteration: desc.iteration },
      payload,
    );
    if (cacheEnabled && cacheKey && !cached) {
      await adapter.insertCache({
        cacheKey,
        createdAtMs: nowMs(),
        workflowName,
        nodeId: desc.nodeId,
        outputTable: desc.outputTableName,
        schemaSig: schemaSignature(desc.outputTable as any),
        agentSig: desc.agent?.id ?? "agent",
        toolsSig: desc.agent?.tools
          ? Object.keys(desc.agent.tools).sort().join(",")
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
  } catch (err) {
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
    }
  }
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

export async function runWorkflow<Schema>(
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
  try {
    const existingRun = await adapter.getRun(runId);
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
        await insertQuery.onConflictDoNothing();
      } else {
        await insertQuery;
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
        status: "running",
        createdAtMs: nowMs(),
        startedAtMs: nowMs(),
        finishedAtMs: null,
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
        workflowPath:
          resolvedWorkflowPath ??
          opts.workflowPath ??
          existingRun.workflowPath ??
          null,
      });
    }

    await eventBus.emitEventWithPersist({
      type: "RunStarted",
      runId,
      timestampMs: nowMs(),
    });

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

    const renderer = new SmithersRenderer();
    let frameNo = (await adapter.getLastFrame(runId))?.frameNo ?? 0;
    let defaultIteration = 0;
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

    while (true) {
      if (opts.signal?.aborted) {
        await adapter.updateRun(runId, {
          status: "cancelled",
          finishedAtMs: nowMs(),
        });
        await eventBus.emitEventWithPersist({
          type: "RunCancelled",
          runId,
          timestampMs: nowMs(),
        });
        return { runId, status: "cancelled" };
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
      });

      const { xml, tasks, mountedTaskIds } = await renderer.render(
        workflow.build(ctx),
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
      const stateMap = await computeTaskStates(
        adapter,
        db,
        runId,
        tasks,
        eventBus,
        ralphDoneMap,
      );
      const descriptorMap = buildDescriptorMap(tasks);
      const schedule = scheduleTasks(plan, stateMap, descriptorMap, ralphState);

      const runnable = applyConcurrencyLimits(
        schedule.runnable,
        stateMap,
        maxConcurrency,
        tasks,
      );

      if (runnable.length === 0) {
        if (schedule.waitingApprovalExists) {
          await adapter.updateRun(runId, { status: "waiting-approval" });
          await eventBus.emitEventWithPersist({
            type: "RunStatusChanged",
            runId,
            status: "waiting-approval",
            timestampMs: nowMs(),
          });
          return { runId, status: "waiting-approval" };
        }

        const blockingFailed = tasks.some((t) => {
          const state = stateMap.get(buildStateKey(t.nodeId, t.iteration));
          return state === "failed" && !t.continueOnFail;
        });

        if (blockingFailed) {
          await adapter.updateRun(runId, {
            status: "failed",
            finishedAtMs: nowMs(),
          });
          await eventBus.emitEventWithPersist({
            type: "RunFailed",
            runId,
            error: "Task failed",
            timestampMs: nowMs(),
          });
          return { runId, status: "failed", error: "Task failed" };
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
        });
        await eventBus.emitEventWithPersist({
          type: "RunFinished",
          runId,
          timestampMs: nowMs(),
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
        return { runId, status: "finished", output };
      }

      const toolConfig = {
        rootDir,
        allowNetwork,
        maxOutputBytes,
        toolTimeoutMs,
      };

      await Promise.all(
        runnable.map((task) =>
          executeTask(
            adapter,
            db,
            runId,
            task,
            eventBus,
            toolConfig,
            workflowName,
            cacheEnabled,
          ),
        ),
      );
    }
  } catch (err) {
    if (process.env.SMITHERS_DEBUG) {
      console.error("[smithers] runWorkflow error", err);
    }
    const errorInfo = errorToJson(err);
    await adapter.updateRun(runId, {
      status: "failed",
      finishedAtMs: nowMs(),
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
    wakeLock.release();
  }
}
