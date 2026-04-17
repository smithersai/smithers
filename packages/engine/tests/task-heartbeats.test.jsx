/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { requireTaskRuntime } from "@smithers/driver/task-runtime";
import { SmithersDb } from "@smithers/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
function buildSmithers() {
    return createTestSmithers(outputSchemas);
}
describe("task heartbeats", () => {
    test("heartbeat persists and is readable", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        const workflow = smithers(() => (<Workflow name="heartbeat-persists">
        <Task id="hb" output={outputs.outputA}>
          {() => {
                const runtime = requireTaskRuntime();
                runtime.heartbeat({ progress: 50 });
                return { value: 1 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const adapter = new SmithersDb(db);
        const attempts = await adapter.listAttempts(result.runId, "hb", 0);
        expect(typeof attempts[0]?.heartbeatAtMs).toBe("number");
        expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({
            progress: 50,
        });
        cleanup();
    });
    test("checkpoint is passed to retry attempt via runtime.lastHeartbeat", async () => {
        const { smithers, outputs, cleanup } = buildSmithers();
        let calls = 0;
        const checkpoints = [];
        const workflow = smithers(() => (<Workflow name="heartbeat-retry-checkpoint">
        <Task id="retry" output={outputs.outputA} retries={1}>
          {() => {
                calls += 1;
                const runtime = requireTaskRuntime();
                checkpoints.push(runtime.lastHeartbeat);
                if (calls === 1) {
                    runtime.heartbeat({ cursor: "page-5" });
                    throw new Error("fail first attempt");
                }
                const checkpoint = runtime.lastHeartbeat;
                if (checkpoint?.cursor !== "page-5") {
                    throw new Error("missing retry checkpoint");
                }
                return { value: 2 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls).toBe(2);
        expect(checkpoints[0]).toBeNull();
        expect(checkpoints[1]).toEqual({ cursor: "page-5" });
        cleanup();
    });
    test("multiple heartbeats overwrite and persist only latest payload", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        const workflow = smithers(() => (<Workflow name="heartbeat-overwrite">
        <Task id="overwrite" output={outputs.outputA}>
          {() => {
                const runtime = requireTaskRuntime();
                runtime.heartbeat({ progress: 25 });
                runtime.heartbeat({ progress: 50 });
                runtime.heartbeat({ progress: 75 });
                return { value: 1 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const adapter = new SmithersDb(db);
        const attempts = await adapter.listAttempts(result.runId, "overwrite", 0);
        expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({
            progress: 75,
        });
        cleanup();
    });
    test("heartbeat timeout marks attempt failed and retries", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        let calls = 0;
        const workflow = smithers(() => (<Workflow name="heartbeat-timeout-retry">
        <Task id="timeout" output={outputs.outputA} retries={1} heartbeatTimeoutMs={200}>
          {async () => {
                calls += 1;
                const runtime = requireTaskRuntime();
                if (calls === 1) {
                    await sleep(350);
                    return { value: 1 };
                }
                runtime.heartbeat({ progress: 1 });
                await sleep(40);
                runtime.heartbeat({ progress: 2 });
                return { value: 2 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls).toBe(2);
        const adapter = new SmithersDb(db);
        const attempts = await adapter.listAttempts(result.runId, "timeout", 0);
        expect(attempts.some((attempt) => attempt.state === "failed")).toBe(true);
        expect(attempts.some((attempt) => attempt.state === "finished")).toBe(true);
        cleanup();
    });
    test("task without heartbeat timeout can run without heartbeats", async () => {
        const { smithers, outputs, cleanup } = buildSmithers();
        const workflow = smithers(() => (<Workflow name="heartbeat-no-timeout">
        <Task id="no-timeout" output={outputs.outputA}>
          {async () => {
                await sleep(300);
                return { value: 1 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        cleanup();
    });
    test("frequent heartbeats keep task alive beyond timeout window", async () => {
        const { smithers, outputs, cleanup } = buildSmithers();
        const workflow = smithers(() => (<Workflow name="heartbeat-keeps-alive">
        <Task id="alive" output={outputs.outputA} heartbeatTimeoutMs={120}>
          {async () => {
                const runtime = requireTaskRuntime();
                for (let i = 0; i < 6; i++) {
                    runtime.heartbeat({ tick: i });
                    await sleep(60);
                }
                return { value: 1 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        cleanup();
    });
    test("non-JSON heartbeat payload fails at heartbeat call time", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        const workflow = smithers(() => (<Workflow name="heartbeat-invalid-json">
        <Task id="invalid" output={outputs.outputA}>
          {() => {
                const runtime = requireTaskRuntime();
                runtime.heartbeat({ fn: () => { } });
                return { value: 1 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        const adapter = new SmithersDb(db);
        const attempts = await adapter.listAttempts(result.runId, "invalid", 0);
        const errorJson = JSON.parse(attempts[0]?.errorJson ?? "{}");
        expect(errorJson.code).toBe("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE");
        cleanup();
    });
    test("oversized heartbeat payload fails with HEARTBEAT_PAYLOAD_TOO_LARGE", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        const workflow = smithers(() => (<Workflow name="heartbeat-too-large">
        <Task id="too-large" output={outputs.outputA}>
          {() => {
                const runtime = requireTaskRuntime();
                runtime.heartbeat({ data: "x".repeat(1_100_000) });
                return { value: 1 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        const adapter = new SmithersDb(db);
        const attempts = await adapter.listAttempts(result.runId, "too-large", 0);
        const errorJson = JSON.parse(attempts[0]?.errorJson ?? "{}");
        expect(errorJson.code).toBe("HEARTBEAT_PAYLOAD_TOO_LARGE");
        cleanup();
    });
    test("heartbeat calls after task completion are ignored", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        const workflow = smithers(() => (<Workflow name="heartbeat-after-complete">
        <Task id="after" output={outputs.outputA}>
          {() => {
                const runtime = requireTaskRuntime();
                setTimeout(() => {
                    runtime.heartbeat({ late: true });
                }, 40);
                return { value: 1 };
            }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        await sleep(120);
        const adapter = new SmithersDb(db);
        const attempts = await adapter.listAttempts(result.runId, "after", 0);
        expect(attempts[0]?.heartbeatDataJson).toBeNull();
        cleanup();
    });
});
