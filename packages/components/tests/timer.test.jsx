/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Parallel, Ralph, Sequence, Task, Timer, Workflow, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers/db/adapter";
import { createTestSmithers, sleep } from "./helpers.js";
import { z } from "zod";
import { dirname } from "node:path";
/**
 * @param {any} workflow
 * @param {string} dbPath
 * @param {any} opts
 */
function runInTestRoot(workflow, dbPath, opts) {
    return Effect.runPromise(runWorkflow(workflow, {
        ...opts,
        rootDir: dirname(dbPath),
    }));
}
/**
 * @param {any} workflow
 * @param {string} dbPath
 * @param {string} runId
 * @param {{ maxAttempts?: number; intervalMs?: number }} [options]
 */
async function resumeUntilDone(workflow, dbPath, runId, options) {
    const maxAttempts = options?.maxAttempts ?? 12;
    const intervalMs = options?.intervalMs ?? 75;
    let result = { runId, status: "waiting-timer" };
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(intervalMs);
        result = await runInTestRoot(workflow, dbPath, { input: {}, runId, resume: true });
        if (result.status !== "waiting-timer")
            return result;
    }
    return result;
}
describe("timer runtime", () => {
    test("duration timer waits, then resumes and finishes", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="timer-duration">
        <Sequence>
          <Timer id="cooldown" duration="120ms"/>
          <Task id="after" output={outputs.out}>{{ v: 1 }}</Task>
        </Sequence>
      </Workflow>));
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-timer");
        await sleep(180);
        const resumed = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
        });
        expect(resumed.status).toBe("finished");
        const rows = await db.select().from(tables.out);
        expect(rows).toHaveLength(1);
        const adapter = new SmithersDb(db);
        const events = await adapter.listEvents(first.runId, -1, 500);
        const types = events.map((event) => event.type);
        expect(types).toContain("TimerCreated");
        expect(types).toContain("TimerFired");
        expect(types).toContain("NodeWaitingTimer");
        cleanup();
    });
    test("absolute timer waits, then resumes", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        // Leave enough slack for engine startup so the first run still observes a
        // future absolute deadline on slower machines.
        const until = new Date(Date.now() + 900).toISOString();
        const workflow = smithers(() => (<Workflow name="timer-absolute">
        <Sequence>
          <Timer id="market-open" until={until}/>
          <Task id="after" output={outputs.out}>{{ v: 2 }}</Task>
        </Sequence>
      </Workflow>));
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-timer");
        await sleep(980);
        const resumed = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
        });
        expect(resumed.status).toBe("finished");
        const rows = await db.select().from(tables.out);
        expect(rows).toHaveLength(1);
        cleanup();
    });
    test("zero duration and past-until timers fire immediately", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="timer-immediate">
        <Sequence>
          <Timer id="zero" duration="0s"/>
          <Timer id="past" until="2020-01-01T00:00:00Z"/>
          <Task id="after" output={outputs.out}>{{ v: 3 }}</Task>
        </Sequence>
      </Workflow>));
        const result = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.out);
        expect(rows).toHaveLength(1);
        cleanup();
    });
    test("timer cancellation marks pending timer attempt cancelled", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="timer-cancel">
        <Sequence>
          <Timer id="hold" duration="10s"/>
          <Task id="after" output={outputs.out}>{{ v: 4 }}</Task>
        </Sequence>
      </Workflow>));
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-timer");
        const controller = new AbortController();
        controller.abort();
        const cancelled = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
            signal: controller.signal,
        });
        expect(cancelled.status).toBe("cancelled");
        const adapter = new SmithersDb(db);
        const attempts = await Effect.runPromise(adapter.listAttempts(first.runId, "hold", 0));
        expect(attempts[0]?.state).toBe("cancelled");
        cleanup();
    });
    test("timer in loop gates each iteration", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const workflow = smithers((ctx) => (<Workflow name="timer-loop">
        <Ralph id="loop" until={ctx.outputs("out").length >= 2}>
          <Sequence>
            <Timer id="tick" duration="40ms"/>
            <Task id="step" output={outputs.out}>
              {{ v: ctx.outputs("out").length }}
            </Task>
          </Sequence>
        </Ralph>
      </Workflow>));
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-timer");
        const done = await resumeUntilDone(workflow, dbPath, first.runId, {
            maxAttempts: 16,
            intervalMs: 70,
        });
        expect(done.status).toBe("finished");
        const rows = await db.select().from(tables.out);
        expect(rows).toHaveLength(2);
        const adapter = new SmithersDb(db);
        const events = await adapter.listEvents(first.runId, -1, 1_000);
        const timerCreatedCount = events.filter((event) => event.type === "TimerCreated").length;
        const timerFiredCount = events.filter((event) => event.type === "TimerFired").length;
        expect(timerCreatedCount).toBeGreaterThanOrEqual(2);
        expect(timerFiredCount).toBeGreaterThanOrEqual(2);
        cleanup();
    });
    test("multiple timers in parallel fire independently", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            left: z.object({ v: z.number() }),
            right: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="parallel-timers">
        <Parallel>
          <Sequence>
            <Timer id="left-timer" duration="80ms"/>
            <Task id="left-task" output={outputs.left}>{{ v: 1 }}</Task>
          </Sequence>
          <Sequence>
            <Timer id="right-timer" duration="1600ms"/>
            <Task id="right-task" output={outputs.right}>{{ v: 2 }}</Task>
          </Sequence>
        </Parallel>
      </Workflow>));
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-timer");
        await sleep(140);
        const second = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
        });
        expect(second.status).toBe("waiting-timer");
        const leftRowsAfterSecond = await db.select().from(tables.left);
        const rightRowsAfterSecond = await db.select().from(tables.right);
        expect(leftRowsAfterSecond).toHaveLength(1);
        expect(rightRowsAfterSecond).toHaveLength(0);
        const third = await resumeUntilDone(workflow, dbPath, first.runId, {
            maxAttempts: 20,
            intervalMs: 120,
        });
        expect(third.status).toBe("finished");
        const leftRows = await db.select().from(tables.left);
        const rightRows = await db.select().from(tables.right);
        expect(leftRows).toHaveLength(1);
        expect(rightRows).toHaveLength(1);
        cleanup();
    });
});
describe("timer validation", () => {
    test("duplicate timer ids fail extraction", async () => {
        const { smithers, dbPath, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="dup-timer">
        <Sequence>
          <Timer id="same" duration="1s"/>
          <Timer id="same" duration="1s"/>
        </Sequence>
      </Workflow>));
        const result = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(result.status).toBe("failed");
        cleanup();
    });
    test("timer id longer than 256 chars is rejected", async () => {
        const { smithers, dbPath, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const id = "t".repeat(257);
        const workflow = smithers(() => (<Workflow name="timer-long-id">
        <Timer id={id} duration="1s"/>
      </Workflow>));
        const result = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(result.status).toBe("failed");
        cleanup();
    });
});
