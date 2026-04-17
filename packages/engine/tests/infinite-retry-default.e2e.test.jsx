/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers/db/adapter";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
describe("default infinite retries e2e", () => {
    test("tasks retry indefinitely by default until they succeed", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let callCount = 0;
            const agent = {
                id: "default-infinite-retry-agent",
                tools: {},
                async generate() {
                    callCount += 1;
                    if (callCount < 6) {
                        throw new Error(`fail ${callCount}`);
                    }
                    return { output: { value: callCount } };
                },
            };
            const workflow = smithers(() => (<Workflow name="default-infinite-retry-success">
            <Task id="flaky" output={outputs.outputA} agent={agent}>
              Keep retrying until success.
            </Task>
          </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            expect(callCount).toBe(6);
            const attempts = await adapter.listAttempts(result.runId, "flaky", 0);
            expect(attempts).toHaveLength(6);
        }
        finally {
            cleanup();
        }
    }, 45_000);
    test("default exponential backoff delays increase", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let callCount = 0;
            const controller = new AbortController();
            const agent = {
                id: "default-infinite-backoff-agent",
                tools: {},
                async generate() {
                    callCount += 1;
                    if (callCount >= 3) {
                        controller.abort();
                    }
                    throw new Error(`backoff failure ${callCount}`);
                },
            };
            const workflow = smithers(() => (<Workflow name="default-infinite-retry-backoff">
            <Task id="backoff" output={outputs.outputA} agent={agent}>
              Measure default retry delays.
            </Task>
          </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                signal: controller.signal,
            }));
            expect(result.status).toBe("cancelled");
            const attempts = await adapter.listAttempts(result.runId, "backoff", 0);
            expect(attempts).toHaveLength(3);
            const startedAtMs = attempts
                .slice()
                .reverse()
                .map((attempt) => attempt.startedAtMs ?? 0);
            const delays = startedAtMs
                .slice(1)
                .map((time, index) => time - startedAtMs[index]);
            expect(delays).toHaveLength(2);
            expect(delays[0]).toBeGreaterThanOrEqual(900);
            expect(delays[1]).toBeGreaterThanOrEqual(1900);
            expect(delays[1]).toBeGreaterThan(delays[0]);
        }
        finally {
            cleanup();
        }
    }, 15_000);
    test("noRetry={true} disables retries", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let callCount = 0;
            const agent = {
                id: "no-retry-agent",
                tools: {},
                async generate() {
                    callCount += 1;
                    throw new Error("always fails");
                },
            };
            const workflow = smithers(() => (<Workflow name="no-retry-default-opt-out">
          <Task id="single-shot" output={outputs.outputA} agent={agent} noRetry>
            Fail once.
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("failed");
            expect(callCount).toBe(1);
            const attempts = await adapter.listAttempts(result.runId, "single-shot", 0);
            expect(attempts).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    });
    test("explicit retries={0} disables retries", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let callCount = 0;
            const agent = {
                id: "explicit-zero-retries-agent",
                tools: {},
                async generate() {
                    callCount += 1;
                    throw new Error("always fails");
                },
            };
            const workflow = smithers(() => (<Workflow name="explicit-zero-retries">
          <Task id="single-shot" output={outputs.outputA} agent={agent} retries={0}>
            Fail once.
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("failed");
            expect(callCount).toBe(1);
            const attempts = await adapter.listAttempts(result.runId, "single-shot", 0);
            expect(attempts).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    });
    test("explicit retries={2} still works as before", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let callCount = 0;
            const agent = {
                id: "explicit-retries-agent",
                tools: {},
                async generate() {
                    callCount += 1;
                    throw new Error(`always fails ${callCount}`);
                },
            };
            const workflow = smithers(() => (<Workflow name="explicit-two-retries">
          <Task id="three-attempts" output={outputs.outputA} agent={agent} retries={2}>
            Fail within explicit retry budget.
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("failed");
            expect(callCount).toBe(3);
            const attempts = await adapter.listAttempts(result.runId, "three-attempts", 0);
            expect(attempts).toHaveLength(3);
        }
        finally {
            cleanup();
        }
    });
});
