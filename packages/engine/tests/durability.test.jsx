/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/events.js";
import { runWorkflow, Task, Workflow } from "smithers";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import { nowMs } from "@smithers/scheduler/nowMs";
import { createTestDb, createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { ddl, outputSchemas, schema } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
describe("Durability", () => {
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
    test("persists streamed NodeOutput events to SQLite", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const runId = "durable-node-output";
        const noisyAgent = {
            id: "noisy",
            tools: {},
            generate: async (args) => {
                args.onStdout?.("hello stdout");
                args.onStderr?.("hello stderr");
                return { output: { value: 1 } };
            },
        };
        const workflow = smithers(() => (<Workflow name="durable-output">
        <Task id="task" output={outputs.outputA} agent={noisyAgent}>
          run noisy task
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(result.status).toBe("finished");
        const adapter = new SmithersDb(db);
        const events = await adapter.listEvents(runId, -1, 50);
        const nodeOutputs = events.filter((event) => event.type === "NodeOutput");
        expect(nodeOutputs.length).toBe(2);
        expect(JSON.parse(nodeOutputs[0].payloadJson).text).toContain("hello");
        expect(JSON.parse(nodeOutputs[1].payloadJson).text).toContain("hello");
        cleanup();
    });
    test("log file failures do not break SQLite event persistence", async () => {
        const { db, cleanup } = createTestDb(schema, ddl);
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        const dir = mkdtempSync(join(tmpdir(), "smithers-eventbus-"));
        const badLogDir = join(dir, "stream.ndjson");
        writeFileSync(badLogDir, "not a directory", "utf8");
        const bus = new EventBus({
            db: adapter,
            logDir: badLogDir,
        });
        await Effect.runPromise(bus.emitEventWithPersist({
            type: "RunStarted",
            runId: "eventbus-run",
            timestampMs: 1,
        }));
        const events = await adapter.listEvents("eventbus-run", -1, 10);
        expect(events.length).toBe(1);
        expect(events[0].type).toBe("RunStarted");
        rmSync(dir, { recursive: true, force: true });
        cleanup();
    });
    test("persistent cancel requests abort active runs", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const runId = "persistent-cancel";
        const slowAbortableAgent = {
            id: "slow-abortable",
            tools: {},
            generate: async (args) => {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 2_000);
                    const abort = () => {
                        clearTimeout(timer);
                        const err = new Error("aborted");
                        err.name = "AbortError";
                        reject(err);
                    };
                    if (args.abortSignal?.aborted) {
                        abort();
                        return;
                    }
                    args.abortSignal?.addEventListener("abort", abort, { once: true });
                });
                return { output: { value: 1 } };
            },
        };
        const workflow = smithers(() => (<Workflow name="persistent-cancel">
        <Task id="slow" output={outputs.outputA} agent={slowAbortableAgent}>
          run slow task
        </Task>
      </Workflow>));
        const runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        await waitFor(async () => {
            try {
                return Boolean(await adapter.getRun(runId));
            }
            catch {
                return false;
            }
        }, { timeoutMs: 5_000, intervalMs: 10 });
        await adapter.requestRunCancel(runId, nowMs());
        const result = await runPromise;
        expect(result.status).toBe("cancelled");
        const run = await adapter.getRun(runId);
        expect(run?.status).toBe("cancelled");
        expect(run?.runtimeOwnerId).toBeNull();
        cleanup();
    });
    test("resume fails when workflow file contents changed", async () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-resume-metadata-"));
        const workflowPath = join(dir, "workflow.tsx");
        writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const runId = "resume-metadata";
        const workflow = smithers(() => (<Workflow name="resume-metadata">
        <Task id="task" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
      </Workflow>));
        const first = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId,
            workflowPath,
        }));
        expect(first.status).toBe("finished");
        writeFileSync(workflowPath, "export default 'v2';\n", "utf8");
        const resumed = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId,
            resume: true,
            workflowPath,
        }));
        expect(resumed.status).toBe("failed");
        expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
        const adapter = new SmithersDb(db);
        const run = await adapter.getRun(runId);
        expect(run?.status).toBe("finished");
        rmSync(dir, { recursive: true, force: true });
        cleanup();
    });
    test("resume fails when an imported workflow module changed", async () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-resume-graph-"));
        const workflowPath = join(dir, "workflow.tsx");
        const helperPath = join(dir, "helper.ts");
        writeFileSync(helperPath, "export const version = 'v1';\n", "utf8");
        writeFileSync(workflowPath, "import { version } from './helper';\nexport default version;\n", "utf8");
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const runId = "resume-graph-metadata";
        const workflow = smithers(() => (<Workflow name="resume-graph-metadata">
        <Task id="task" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
      </Workflow>));
        const first = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId,
            workflowPath,
        }));
        expect(first.status).toBe("finished");
        writeFileSync(helperPath, "export const version = 'v2';\n", "utf8");
        const resumed = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId,
            resume: true,
            workflowPath,
        }));
        expect(resumed.status).toBe("failed");
        expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
        const adapter = new SmithersDb(db);
        const run = await adapter.getRun(runId);
        expect(run?.status).toBe("finished");
        rmSync(dir, { recursive: true, force: true });
        cleanup();
    });
});
