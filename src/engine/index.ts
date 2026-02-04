import type { SmithersWorkflow, RunOptions, RunResult, SmithersEvent, TaskDescriptor } from "../types";
import { SmithersRenderer } from "../dom/renderer";
import { buildContext } from "../context";
import { loadInput, loadOutputs } from "../db/snapshot";
import { ensureSmithersTables } from "../db/ensure";
import { SmithersDb } from "../db/adapter";
import { selectOutputRow, upsertOutputRow, validateOutput, validateExistingOutput } from "../db/output";
import { schemaSignature } from "../db/schema-signature";
import { canonicalizeXml } from "../utils/xml";
import { sha256Hex } from "../utils/hash";
import { nowMs } from "../utils/time";
import { newRunId } from "../utils/ids";
import { buildPlanTree, scheduleTasks, buildStateKey, type TaskState, type TaskStateMap, type RalphStateMap } from "./scheduler";
import { runWithToolContext } from "../tools/context";
import { EventBus } from "../events";
import { getJjPointer } from "../vcs/jj";
import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";

const DEFAULT_MAX_CONCURRENCY = 4;
const STALE_ATTEMPT_MS = 15 * 60 * 1000;

function resolveSchema(db: any): Record<string, any> {
  return db?._?.fullSchema ?? db?._?.schema ?? db?.schema ?? {};
}

function getWorkflowNameFromXml(xml: any): string {
  if (!xml || xml.kind !== "element") return "workflow";
  if (xml.tag !== "smithers:workflow") return "workflow";
  return xml.props?.name ?? "workflow";
}

function buildDescriptorMap(tasks: TaskDescriptor[]): Map<string, TaskDescriptor> {
  const map = new Map<string, TaskDescriptor>();
  for (const task of tasks) map.set(task.nodeId, task);
  return map;
}

function buildRalphStateMap(rows: any[]): RalphStateMap {
  const map: RalphStateMap = new Map();
  for (const row of rows) {
    map.set(row.ralphId, { iteration: row.iteration ?? 0, done: Boolean(row.done) });
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

function buildRalphDoneMap(ralphs: { id: string; until: boolean }[], state: RalphStateMap): Map<string, boolean> {
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
      const approval = await adapter.getApproval(runId, desc.nodeId, desc.iteration);
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
        await eventBus.emitEventWithPersist({
          type: "ApprovalDenied",
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          timestampMs: nowMs(),
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
        await eventBus.emitEventWithPersist({
          type: "NodeWaitingApproval",
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          timestampMs: nowMs(),
        });
        continue;
      }
      await eventBus.emitEventWithPersist({
        type: "ApprovalGranted",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        timestampMs: nowMs(),
      });
    }

    const attempts = await adapter.listAttempts(runId, desc.nodeId, desc.iteration);
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

function applyConcurrencyLimits(
  runnable: TaskDescriptor[],
  stateMap: TaskStateMap,
  maxConcurrency: number,
  allTasks: TaskDescriptor[],
): TaskDescriptor[] {
  const selected: TaskDescriptor[] = [];
  const inProgressByGroup = new Map<string, number>();
  let inProgressTotal = 0;

  for (const desc of allTasks) {
    const state = stateMap.get(buildStateKey(desc.nodeId, desc.iteration));
    if (state === "in-progress") {
      inProgressTotal += 1;
      if (desc.parallelGroupId) {
        inProgressByGroup.set(desc.parallelGroupId, (inProgressByGroup.get(desc.parallelGroupId) ?? 0) + 1);
      }
    }
  }

  const capacity = Math.max(0, maxConcurrency - inProgressTotal);

  for (const desc of runnable) {
    if (selected.length >= capacity) break;
    if (desc.parallelGroupId && desc.parallelMaxConcurrency) {
      const used = inProgressByGroup.get(desc.parallelGroupId) ?? 0;
      if (used >= desc.parallelMaxConcurrency) {
        continue;
      }
      inProgressByGroup.set(desc.parallelGroupId, used + 1);
    }
    selected.push(desc);
  }

  return selected;
}

async function cancelInProgress(adapter: SmithersDb, runId: string, eventBus: EventBus) {
  const inProgress = await adapter.listInProgressAttempts(runId);
  for (const attempt of inProgress) {
    await adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
      state: "cancelled",
      finishedAtMs: nowMs(),
    });
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
      await adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
        state: "cancelled",
        finishedAtMs: now,
      });
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
  rootDir: string,
  workflowName: string,
  cacheEnabled: boolean,
) {
  const attempts = await adapter.listAttempts(runId, desc.nodeId, desc.iteration);
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
    cached: false,
    metaJson: null,
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

  try {
    if (cacheEnabled) {
      const schemaSig = schemaSignature(desc.outputTable as any);
      const agentSig = desc.agent?.id ?? "agent";
      const toolsSig = desc.agent?.tools ? Object.keys(desc.agent.tools).sort().join(",") : "";
      const cacheBase = {
        workflowName,
        nodeId: desc.nodeId,
        outputTableName: desc.outputTableName,
        schemaSig,
        agentSig,
        toolsSig,
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
            rootDir,
            allowNetwork: false,
            maxOutputBytes: 200_000,
            timeoutMs: desc.timeoutMs ?? 60_000,
            seq: 0,
          },
          async () =>
            desc.agent!.generate({
              options: undefined as any,
              prompt: desc.prompt ?? "",
              timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
            }),
        );
        const output = (result as any).output ?? (result as any).text;
        payload = typeof output === "string" ? JSON.parse(output) : output;
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
        if ("iteration" in payload && (payload as any).iteration !== desc.iteration) {
          throw new Error("Payload iteration does not match task iteration");
        }
      }
      const payloadWithKeys = { ...(payload ?? {}), runId, nodeId: desc.nodeId, iteration: desc.iteration };
      const validation = validateOutput(desc.outputTable as any, payloadWithKeys);
      if (!validation.ok) {
        throw validation.error;
      }
      payload = validation.data;
    }

    await upsertOutputRow(db, desc.outputTable as any, { runId, nodeId: desc.nodeId, iteration: desc.iteration }, payload);
    if (cacheEnabled && cacheKey && !cached) {
      await adapter.insertCache({
        cacheKey,
        createdAtMs: nowMs(),
        workflowName,
        nodeId: desc.nodeId,
        outputTable: desc.outputTableName,
        schemaSig: schemaSignature(desc.outputTable as any),
        agentSig: desc.agent?.id ?? "agent",
        toolsSig: desc.agent?.tools ? Object.keys(desc.agent.tools).sort().join(",") : null,
        jjPointer: null,
        payloadJson: JSON.stringify(payload),
      });
    }
    const jjPointer = await getJjPointer();

    await adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
      state: "finished",
      finishedAtMs: nowMs(),
      jjPointer,
      cached: cached ? 1 : 0,
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
      errorJson: JSON.stringify(err),
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
      error: err,
      timestampMs: nowMs(),
    });

    const attempts = await adapter.listAttempts(runId, desc.nodeId, desc.iteration);
    if (attempts.filter((a: any) => a.state === "failed").length <= desc.retries) {
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

export async function renderFrame<Schema>(workflow: SmithersWorkflow<Schema>, ctx: any): Promise<{ runId: string; frameNo: number; xml: any; tasks: TaskDescriptor[] }> {
  const renderer = new SmithersRenderer();
  const result = await renderer.render(workflow.build(ctx), { ralphIterations: ctx?.iterations, defaultIteration: ctx?.iteration });
  return { runId: ctx.runId, frameNo: 0, xml: result.xml, tasks: result.tasks };
}

export async function runWorkflow<Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions): Promise<RunResult> {
  const db = workflow.db as any;
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  const runId = opts.runId ?? newRunId();
  const schema = resolveSchema(db);
  const inputTable = schema.input;
  if (!inputTable) {
    throw new Error("Schema must include input table");
  }

  const lastSeq = await adapter.getLastEventSeq(runId);
  const eventBus = new EventBus({ db: adapter, logDir: `.smithers/executions/${runId}/logs`, startSeq: (lastSeq ?? -1) + 1 });
  if (opts.onProgress) {
    eventBus.on("event", (e: SmithersEvent) => opts.onProgress?.(e));
  }

  try {
    const existingRun = await adapter.getRun(runId);
    if (!opts.resume) {
      const inputRow = { runId, ...opts.input };
      const insertQuery = db.insert(inputTable).values(inputRow);
      if (typeof insertQuery.onConflictDoNothing === "function") {
        await insertQuery.onConflictDoNothing();
      } else {
        await insertQuery;
      }
    }

    if (!existingRun) {
      await adapter.insertRun({
        runId,
        workflowName: "workflow",
        workflowPath: opts.workflowPath ?? null,
        status: "running",
        createdAtMs: nowMs(),
        startedAtMs: nowMs(),
        finishedAtMs: null,
        errorJson: null,
        configJson: JSON.stringify({ maxConcurrency: opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY }),
      });
    } else {
      await adapter.updateRun(runId, {
        status: "running",
        startedAtMs: existingRun.startedAtMs ?? nowMs(),
        workflowPath: opts.workflowPath ?? existingRun.workflowPath ?? null,
      });
    }

    await eventBus.emitEventWithPersist({ type: "RunStarted", runId, timestampMs: nowMs() });

    await cancelStaleAttempts(adapter, runId);

    const renderer = new SmithersRenderer();
    let frameNo = (await adapter.getLastFrame(runId))?.frameNo ?? 0;
    let defaultIteration = 0;
    if (opts.resume) {
      const nodes = await adapter.listNodes(runId);
      const maxIteration = nodes.reduce((max, node) => Math.max(max, node.iteration ?? 0), 0);
      defaultIteration = maxIteration;
    }
    const ralphState: RalphStateMap = buildRalphStateMap(await adapter.listRalph(runId));

    while (true) {
      if (opts.signal?.aborted) {
        await adapter.updateRun(runId, { status: "cancelled", finishedAtMs: nowMs() });
        await eventBus.emitEventWithPersist({ type: "RunCancelled", runId, timestampMs: nowMs() });
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

      const { xml, tasks, mountedTaskIds } = await renderer.render(workflow.build(ctx), {
        ralphIterations,
        defaultIteration,
      });
      const xmlJson = canonicalizeXml(xml);
      const xmlHash = sha256Hex(xmlJson);

      const workflowName = getWorkflowNameFromXml(xml);
      const cacheEnabled =
        workflow.opts.cache ??
        Boolean(xml && xml.kind === "element" && (xml.props.cache === "true" || xml.props.cache === "1"));
      await adapter.updateRun(runId, { workflowName });

      frameNo += 1;
      await adapter.insertFrame({
        runId,
        frameNo,
        createdAtMs: nowMs(),
        xmlJson,
        xmlHash,
        mountedTaskIdsJson: JSON.stringify(mountedTaskIds),
        taskIndexJson: JSON.stringify(tasks.map((t) => ({ nodeId: t.nodeId, ordinal: t.ordinal, iteration: t.iteration }))),
        note: null,
      });
      await eventBus.emitEventWithPersist({ type: "FrameCommitted", runId, frameNo, xmlHash, timestampMs: nowMs() });

      const inProgress = await adapter.listInProgressAttempts(runId);
      const mountedSet = new Set(mountedTaskIds);
      if (inProgress.some((a: any) => !mountedSet.has(a.nodeId))) {
        await cancelInProgress(adapter, runId, eventBus);
        continue;
      }

      const { plan, ralphs } = buildPlanTree(xml);
      for (const ralph of ralphs) {
        if (!ralphState.has(ralph.id)) {
          const iteration = defaultIteration;
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
      const stateMap = await computeTaskStates(adapter, db, runId, tasks, eventBus, ralphDoneMap);
      const descriptorMap = buildDescriptorMap(tasks);
      const schedule = scheduleTasks(plan, stateMap, descriptorMap, ralphState);

      const maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
      const runnable = applyConcurrencyLimits(schedule.runnable, stateMap, maxConcurrency, tasks);

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
          await adapter.updateRun(runId, { status: "failed", finishedAtMs: nowMs() });
          await eventBus.emitEventWithPersist({ type: "RunFailed", runId, error: "Task failed", timestampMs: nowMs() });
          return { runId, status: "failed" };
        }

        if (schedule.readyRalphs.length > 0) {
          for (const ralph of schedule.readyRalphs) {
            const state = ralphState.get(ralph.id) ?? { iteration: defaultIteration, done: false };
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
              await adapter.updateRun(runId, { status: "failed", finishedAtMs: nowMs(), errorJson: JSON.stringify({ code: "RALPH_MAX_REACHED", ralphId: ralph.id }) });
              await eventBus.emitEventWithPersist({ type: "RunFailed", runId, error: { code: "RALPH_MAX_REACHED", ralphId: ralph.id }, timestampMs: nowMs() });
              return { runId, status: "failed" };
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

        await adapter.updateRun(runId, { status: "finished", finishedAtMs: nowMs() });
        await eventBus.emitEventWithPersist({ type: "RunFinished", runId, timestampMs: nowMs() });

        const outputTable = schema.output;
        let output: unknown = undefined;
        if (outputTable) {
          const cols = getTableColumns(outputTable as any) as Record<string, any>;
          const runIdCol = cols.runId;
          if (runIdCol) {
            const rows = await db.select().from(outputTable).where(eq(runIdCol, runId));
            output = rows;
          } else {
            output = await db.select().from(outputTable);
          }
        }
        return { runId, status: "finished", output };
      }

      await Promise.all(
        runnable.map((task) =>
          executeTask(adapter, db, runId, task, eventBus, process.cwd(), workflowName, cacheEnabled),
        ),
      );
    }
  } catch (err) {
    if (process.env.SMITHERS_DEBUG) {
      console.error("[smithers] runWorkflow error", err);
    }
    await adapter.updateRun(runId, { status: "failed", finishedAtMs: nowMs(), errorJson: JSON.stringify(err) });
    await eventBus.emitEventWithPersist({ type: "RunFailed", runId, error: err, timestampMs: nowMs() });
    return { runId, status: "failed" };
  }
}
