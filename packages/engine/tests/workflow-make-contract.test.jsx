/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { z } from "zod";
import { Approval, Sequence, SmithersDb, Task, Workflow, runWorkflow, usePatched, } from "smithers-orchestrator";
import { Subflow } from "@smithers-orchestrator/components/components/index";
import { approveNode } from "../src/approvals.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
const contractSchemas = {
    decision: z.object({
        approved: z.boolean(),
        note: z.string().nullable().optional(),
        decidedBy: z.string().nullable().optional(),
        decisionJson: z.string().nullable().optional(),
        autoApproved: z.boolean().optional(),
    }),
    output: z.object({ value: z.number() }),
    phase: z.object({ value: z.number() }),
    result: z.object({ value: z.number() }),
};
function buildContractSmithers() {
    return createTestSmithers(contractSchemas);
}
/**
 * @param {string} counterPath
 */
function readCounter(counterPath) {
    if (!existsSync(counterPath))
        return 0;
    const raw = readFileSync(counterPath, "utf8").trim();
    return raw.length > 0 ? Number(raw) : 0;
}
/**
 * @param {string} counterPath
 */
function incrementCounter(counterPath) {
    const next = readCounter(counterPath) + 1;
    writeFileSync(counterPath, String(next));
    return next;
}
/**
 * @param {() => Promise<boolean>} predicate
 * @param {{ timeoutMs?: number; intervalMs?: number }} [options]
 */
async function waitFor(predicate, options) {
    const timeoutMs = options?.timeoutMs ?? 5_000;
    const intervalMs = options?.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            if (await predicate())
                return;
        }
        catch { }
        await sleep(intervalMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}
/**
 * @param {{ dbPath: string; counterPath: string; runId: string; }} params
 */
function spawnHangingRun(params) {
    const smithersPath = resolve(import.meta.dir, "../../smithers/src/index.js");
    const script = `
import React from "react";
import { createSmithers, Task, Workflow, runWorkflow } from ${JSON.stringify(smithersPath)};
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";

function readCounter(path) {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf8").trim();
  return raw.length > 0 ? Number(raw) : 0;
}

function incrementCounter(path) {
  const next = readCounter(path) + 1;
  writeFileSync(path, String(next));
  return next;
}

const api = createSmithers(
  {
    result: z.object({ value: z.number() }),
  },
  { dbPath: ${JSON.stringify(params.dbPath)} },
);

const agent = {
  id: "hang-on-first-call",
  tools: {},
  async generate() {
    const call = incrementCounter(${JSON.stringify(params.counterPath)});
    if (call === 1) {
      return new Promise(() => {});
    }
    return {
      text: '{"value":7}',
      output: { value: 7 },
    };
  },
};

const workflow = api.smithers(() =>
  React.createElement(
    Workflow,
    { name: "workflow-make-crash-child" },
    React.createElement(
      Task,
      {
        id: "stuck",
        output: api.outputs.result,
        agent,
      },
      "produce a value",
    ),
  ),
);

await Effect.runPromise(runWorkflow(workflow, {
  input: {},
  runId: ${JSON.stringify(params.runId)},
}));
`;
    const child = spawn(process.execPath, ["-e", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code, signal) => {
            resolveExit({ exitCode: code, signal });
        });
    });
    return {
        child,
        exited,
    };
}
describe("workflow make contract", () => {
    test("wraps a full workflow run without changing scheduler semantics", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers((ctx) => (<Workflow name="workflow-make-full">
          <Sequence>
            <Task id="start" output={outputs.phase}>
              {{ value: 2 }}
            </Task>
            <Task id="finish" output={outputs.result}>
              {() => ({
                    value: (ctx.latest(outputs.phase, "start")?.value ?? 0) + 3,
                })}
            </Task>
          </Sequence>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const rows = await db.select().from(tables.result);
            expect(rows).toEqual([
                expect.objectContaining({
                    nodeId: "finish",
                    value: 5,
                }),
            ]);
        }
        finally {
            cleanup();
        }
    }, 30_000);
    test("executes child workflows and preserves parent linkage", async () => {
        const { smithers, outputs, db, cleanup } = buildContractSmithers();
        try {
            const childWorkflow = smithers(() => (<Workflow name="workflow-make-child">
          <Task id="child-task" output={outputs.output}>
            {{ value: 9 }}
          </Task>
        </Workflow>));
            const parentWorkflow = smithers(() => (<Workflow name="workflow-make-parent">
          <Subflow id="child-run" output={outputs.result} workflow={childWorkflow}/>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const childRun = await adapter.getLatestChildRun(result.runId);
            expect(childRun?.parentRunId).toBe(result.runId);
            expect(childRun?.status).toBe("finished");
        }
        finally {
            cleanup();
        }
    }, 30_000);
    test("uses persisted patch decisions so old runs stay on old behavior and new runs see the patch", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        /**
     * @param {boolean} enablePatch
     */
        function buildWorkflow(enablePatch) {
            function PatchedValue() {
                const patched = enablePatch ? usePatched("add-validation") : false;
                return (<Task id="after" output={outputs.result}>
            {{ value: patched ? 2 : 1 }}
          </Task>);
            }
            return smithers(() => (<Workflow name="workflow-make-versioning">
          <Sequence>
            <Approval id="gate" output={outputs.decision} request={{ title: "Approve rollout" }}/>
            <PatchedValue />
          </Sequence>
        </Workflow>));
        }
        try {
            const initialWorkflow = buildWorkflow(false);
            const first = await Effect.runPromise(runWorkflow(initialWorkflow, {
                input: {},
                runId: "workflow-make-versioning-old",
            }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(approveNode(new SmithersDb(db), first.runId, "gate", 0, "ship it", "reviewer"));
            const resumed = await Effect.runPromise(runWorkflow(buildWorkflow(true), {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const resumedRows = await db.select().from(tables.result);
            const resumedRow = resumedRows.find((row) => row.runId === first.runId);
            expect(resumedRow?.value).toBe(1);
            const resumedRun = await new SmithersDb(db).getRun(first.runId);
            const resumedConfig = JSON.parse(resumedRun?.configJson ?? "{}");
            expect(resumedConfig.workflowPatches?.["add-validation"]).toBe(false);
            const second = await Effect.runPromise(runWorkflow(buildWorkflow(true), {
                input: {},
                runId: "workflow-make-versioning-new",
            }));
            expect(second.status).toBe("waiting-approval");
            await Effect.runPromise(approveNode(new SmithersDb(db), second.runId, "gate", 0, "ship it", "reviewer"));
            const secondResumed = await Effect.runPromise(runWorkflow(buildWorkflow(true), {
                input: {},
                runId: second.runId,
                resume: true,
            }));
            expect(secondResumed.status).toBe("finished");
            const newRunRows = await db.select().from(tables.result);
            const newRunRow = newRunRows.find((row) => row.runId === second.runId);
            expect(newRunRow?.value).toBe(2);
            const newRun = await new SmithersDb(db).getRun(second.runId);
            const newConfig = JSON.parse(newRun?.configJson ?? "{}");
            expect(newConfig.workflowPatches?.["add-validation"]).toBe(true);
        }
        finally {
            cleanup();
        }
    }, 30_000);
    test("recovers after a crash and resumes the same run", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = buildContractSmithers();
        const runId = "workflow-make-crash";
        const counterPath = `${dbPath}.calls`;
        const spawned = spawnHangingRun({ dbPath, counterPath, runId });
        try {
            const adapter = new SmithersDb(db);
            await waitFor(async () => {
                const run = await adapter.getRun(runId);
                const attempts = await adapter.listAttempts(runId, "stuck", 0);
                return (run?.status === "running" &&
                    attempts.some((attempt) => attempt.state === "in-progress") &&
                    readCounter(counterPath) === 1);
            }, { timeoutMs: 10_000, intervalMs: 50 });
            spawned.child.kill("SIGKILL");
            await spawned.exited;
            const agent = {
                id: "hang-on-first-call",
                tools: {},
                async generate() {
                    const call = incrementCounter(counterPath);
                    if (call === 1) {
                        return new Promise(() => { });
                    }
                    return {
                        text: '{"value":7}',
                        output: { value: 7 },
                    };
                },
            };
            const workflow = smithers(() => (<Workflow name="workflow-make-crash-child">
          <Task id="stuck" output={outputs.result} agent={agent}>
            produce a value
          </Task>
        </Workflow>));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
                force: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(readCounter(counterPath)).toBe(2);
            const attempts = await adapter.listAttempts(runId, "stuck", 0);
            expect(attempts).toHaveLength(2);
            expect(attempts[0]?.state).toBe("finished");
            expect(attempts[1]?.state).toBe("cancelled");
        }
        finally {
            if (spawned.child.exitCode === null && !spawned.child.killed) {
                spawned.child.kill("SIGKILL");
                await spawned.exited.catch(() => undefined);
            }
            cleanup();
        }
    }, 30_000);
});
