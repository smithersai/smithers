/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Parallel, Task, Timer, Workflow, runWorkflow, } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { approveNode } from "../src/approvals.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
function buildSmithers() {
    return createTestSmithers(outputSchemas);
}
/**
 * @param {any} db
 */
function queryClient(db) {
    return db.$client ?? db.session?.client;
}
describe("transactional state writes", () => {
    test("task completion writes output/attempt/node consistently", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-task-complete">
          <Task id="work" output={outputs.outputA}>
            {{ value: 7 }}
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                runId: "txn-task-complete",
                input: {},
            }));
            expect(result.status).toBe("finished");
            const client = queryClient(db);
            const row = client
                .query(`SELECT
             n.state AS nodeState,
             a.state AS attemptState,
             o.value AS outputValue
           FROM _smithers_nodes n
           JOIN _smithers_attempts a
             ON a.run_id = n.run_id
            AND a.node_id = n.node_id
            AND a.iteration = n.iteration
           JOIN output_a o
             ON o.run_id = n.run_id
            AND o.node_id = n.node_id
            AND o.iteration = n.iteration
          WHERE n.run_id = ?
            AND n.node_id = ?
            AND n.iteration = 0
          ORDER BY a.attempt DESC
          LIMIT 1`)
                .get("txn-task-complete", "work");
            expect(row?.nodeState).toBe("finished");
            expect(row?.attemptState).toBe("finished");
            expect(row?.outputValue).toBe(7);
        }
        finally {
            cleanup();
        }
    });
    test("task start keeps attempt and node in-progress together", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-task-start">
          <Task id="slow" output={outputs.outputA}>
            {async () => {
                    await sleep(800);
                    return { value: 1 };
                }}
          </Task>
        </Workflow>));
            const runId = "txn-task-start";
            const runPromise = Effect.runPromise(runWorkflow(workflow, { runId, input: {} }));
            const client = queryClient(db);
            const deadline = Date.now() + 3_000;
            let observed;
            while (Date.now() < deadline) {
                try {
                    observed = client
                        .query(`SELECT
                 a.state AS attemptState,
                 n.state AS nodeState
               FROM _smithers_attempts a
               LEFT JOIN _smithers_nodes n
                 ON n.run_id = a.run_id
                AND n.node_id = a.node_id
                AND n.iteration = a.iteration
              WHERE a.run_id = ?
                AND a.node_id = ?
                AND a.iteration = 0
                AND a.attempt = 1`)
                        .get(runId, "slow");
                }
                catch (error) {
                    if (!(error instanceof Error) ||
                        !error.message.includes("no such table: _smithers_attempts")) {
                        throw error;
                    }
                }
                if (observed?.attemptState === "in-progress") {
                    break;
                }
                await sleep(10);
            }
            expect(observed?.attemptState).toBe("in-progress");
            expect(observed?.nodeState).toBe("in-progress");
            const result = await runPromise;
            expect(result.status).toBe("finished");
        }
        finally {
            cleanup();
        }
    });
    test("approval decision updates approval/node/run consistently", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-approval">
          <Task id="gate" output={outputs.outputA} needsApproval>
            {{ value: 3 }}
          </Task>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, {
                runId: "txn-approval",
                input: {},
            }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(approveNode(new SmithersDb(db), first.runId, "gate", 0, "ok", "tester"));
            const client = queryClient(db);
            const row = client
                .query(`SELECT
             a.status AS approvalStatus,
             n.state AS nodeState,
             r.status AS runStatus
           FROM _smithers_approvals a
           JOIN _smithers_nodes n
             ON n.run_id = a.run_id
            AND n.node_id = a.node_id
            AND n.iteration = a.iteration
           JOIN _smithers_runs r
             ON r.run_id = a.run_id
          WHERE a.run_id = ?
            AND a.node_id = ?
            AND a.iteration = 0
          LIMIT 1`)
                .get(first.runId, "gate");
            expect(row?.approvalStatus).toBe("approved");
            expect(row?.nodeState).toBe("pending");
            expect(row?.runStatus).toBe("waiting-event");
        }
        finally {
            cleanup();
        }
    });
    test("frame and snapshot commit atomically", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-frame-commit">
          <Task id="frame-task" output={outputs.outputA}>
            {{ value: 11 }}
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                runId: "txn-frame-commit",
                input: {},
            }));
            expect(result.status).toBe("finished");
            const client = queryClient(db);
            const orphanFrames = client
                .query(`SELECT COUNT(*) AS count
             FROM _smithers_frames f
             LEFT JOIN _smithers_snapshots s
               ON s.run_id = f.run_id
              AND s.frame_no = f.frame_no
            WHERE f.run_id = ?
              AND s.run_id IS NULL`)
                .get("txn-frame-commit");
            const orphanSnapshots = client
                .query(`SELECT COUNT(*) AS count
             FROM _smithers_snapshots s
             LEFT JOIN _smithers_frames f
               ON f.run_id = s.run_id
              AND f.frame_no = s.frame_no
            WHERE s.run_id = ?
              AND f.run_id IS NULL`)
                .get("txn-frame-commit");
            expect(Number(orphanFrames?.count ?? 0)).toBe(0);
            expect(Number(orphanSnapshots?.count ?? 0)).toBe(0);
        }
        finally {
            cleanup();
        }
    });
    test("rollback after post-output failure forces clean retry", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        const runId = "txn-rollback-retry";
        let calls = 0;
        let injected = false;
        const originalInsertNodeEffect = SmithersDb.prototype.insertNodeEffect;
        SmithersDb.prototype.insertNodeEffect = function patched(row) {
            if (!injected &&
                row?.runId === runId &&
                row?.nodeId === "flaky" &&
                row?.state === "finished") {
                injected = true;
                throw new Error("injected insertNode failure");
            }
            return originalInsertNodeEffect.call(this, row);
        };
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-rollback-retry">
          <Task id="flaky" output={outputs.outputA} retries={1}>
            {() => {
                    calls += 1;
                    return { value: calls };
                }}
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                runId,
                input: {},
            }));
            expect(result.status).toBe("finished");
            expect(calls).toBe(2);
            const client = queryClient(db);
            const outputRow = client
                .query(`SELECT value
             FROM output_a
            WHERE run_id = ?
              AND node_id = ?
              AND iteration = 0
            LIMIT 1`)
                .get(runId, "flaky");
            const attempts = client
                .query(`SELECT attempt, state
             FROM _smithers_attempts
            WHERE run_id = ?
              AND node_id = ?
              AND iteration = 0
            ORDER BY attempt`)
                .all(runId, "flaky");
            expect(outputRow?.value).toBe(2);
            expect(attempts).toEqual([
                { attempt: 1, state: "failed" },
                { attempt: 2, state: "finished" },
            ]);
        }
        finally {
            SmithersDb.prototype.insertNodeEffect = originalInsertNodeEffect;
            cleanup();
        }
    });
    test("timer start rolls back attempt and node writes on failure", async () => {
        const { smithers, db, cleanup } = buildSmithers();
        const runId = "txn-timer-start-rollback";
        let injected = false;
        const originalInsertNodeEffect = SmithersDb.prototype.insertNodeEffect;
        SmithersDb.prototype.insertNodeEffect = function patched(row) {
            if (!injected &&
                row?.runId === runId &&
                row?.nodeId === "hold" &&
                row?.state === "waiting-timer") {
                injected = true;
                throw new Error("injected timer-start insertNode failure");
            }
            return originalInsertNodeEffect.call(this, row);
        };
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-timer-start-rollback">
          <Timer id="hold" duration="5s"/>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                runId,
                input: {},
            }));
            expect(result.status).toBe("failed");
            const adapter = new SmithersDb(db);
            const attempts = await adapter.listAttempts(runId, "hold", 0);
            const node = await adapter.getNode(runId, "hold", 0);
            const events = await adapter.listEvents(runId, -1, 200);
            const timerCreatedCount = events.filter((event) => event.type === "TimerCreated").length;
            expect(attempts).toHaveLength(0);
            expect(node).toBeUndefined();
            expect(timerCreatedCount).toBe(0);
        }
        finally {
            SmithersDb.prototype.insertNodeEffect = originalInsertNodeEffect;
            cleanup();
        }
    });
    test("timer fire rolls back attempt and suppresses events on failure", async () => {
        const { smithers, db, cleanup } = buildSmithers();
        const runId = "txn-timer-fire-rollback";
        let injected = false;
        const originalInsertNodeEffect = SmithersDb.prototype.insertNodeEffect;
        SmithersDb.prototype.insertNodeEffect = function patched(row) {
            if (!injected &&
                row?.runId === runId &&
                row?.nodeId === "hold" &&
                row?.state === "finished") {
                injected = true;
                throw new Error("injected timer-fire insertNode failure");
            }
            return originalInsertNodeEffect.call(this, row);
        };
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-timer-fire-rollback">
          <Timer id="hold" duration="80ms"/>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, {
                runId,
                input: {},
            }));
            expect(first.status).toBe("waiting-timer");
            await sleep(120);
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                runId,
                input: {},
                resume: true,
            }));
            expect(resumed.status).toBe("failed");
            const adapter = new SmithersDb(db);
            const attempts = await adapter.listAttempts(runId, "hold", 0);
            const latest = attempts[0];
            const events = await adapter.listEvents(runId, -1, 500);
            const timerFiredCount = events.filter((event) => event.type === "TimerFired").length;
            const nodeFinishedCount = events.filter((event) => event.type === "NodeFinished").length;
            const finishedAttempts = attempts.filter((attempt) => attempt.state === "finished");
            expect(["waiting-timer", "cancelled"]).toContain(latest?.state);
            expect(finishedAttempts).toHaveLength(0);
            expect(timerFiredCount).toBe(0);
            expect(nodeFinishedCount).toBe(0);
        }
        finally {
            SmithersDb.prototype.insertNodeEffect = originalInsertNodeEffect;
            cleanup();
        }
    });
    test("parallel completions finish without surfaced SQLITE_BUSY failures", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (<Workflow name="txn-parallel">
          <Parallel>
            <Task id="p1" output={outputs.outputC}>{async () => ({ value: 1 })}</Task>
            <Task id="p2" output={outputs.outputC}>{async () => ({ value: 2 })}</Task>
            <Task id="p3" output={outputs.outputC}>{async () => ({ value: 3 })}</Task>
            <Task id="p4" output={outputs.outputC}>{async () => ({ value: 4 })}</Task>
          </Parallel>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                runId: "txn-parallel",
                input: {},
                maxConcurrency: 4,
            }));
            expect(result.status).toBe("finished");
            const client = queryClient(db);
            const finished = client
                .query(`SELECT COUNT(*) AS count
             FROM _smithers_nodes
            WHERE run_id = ?
              AND state = 'finished'`)
                .get("txn-parallel");
            expect(Number(finished?.count ?? 0)).toBe(4);
        }
        finally {
            cleanup();
        }
    });
});
