/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/events";
import { runWorkflow, Task, Workflow } from "../src/index";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import { nowMs } from "../src/utils/time";
import { createTestDb, createTestSmithers, sleep } from "./helpers";
import { ddl, outputSchemas, schema } from "./schema";

describe("Durability", () => {
  test("persists streamed NodeOutput events to SQLite", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const runId = "durable-node-output";
    const noisyAgent: any = {
      id: "noisy",
      tools: {},
      generate: async (args: {
        onStdout?: (text: string) => void;
        onStderr?: (text: string) => void;
      }) => {
        args.onStdout?.("hello stdout");
        args.onStderr?.("hello stderr");
        return { output: { value: 1 } };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="durable-output">
        <Task id="task" output={outputs.outputA} agent={noisyAgent}>
          run noisy task
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {}, runId });
    expect(result.status).toBe("finished");

    const adapter = new SmithersDb(db as any);
    const events = await adapter.listEvents(runId, -1, 50);
    const nodeOutputs = events.filter((event: any) => event.type === "NodeOutput");
    expect(nodeOutputs.length).toBe(2);
    expect(JSON.parse(nodeOutputs[0]!.payloadJson).text).toContain("hello");
    expect(JSON.parse(nodeOutputs[1]!.payloadJson).text).toContain("hello");

    cleanup();
  });

  test("log file failures do not break SQLite event persistence", async () => {
    const { db, cleanup } = createTestDb(schema, ddl);
    ensureSmithersTables(db as any);
    const adapter = new SmithersDb(db as any);
    const dir = mkdtempSync(join(tmpdir(), "smithers-eventbus-"));
    const badLogDir = join(dir, "stream.ndjson");
    writeFileSync(badLogDir, "not a directory", "utf8");

    const bus = new EventBus({
      db: adapter,
      logDir: badLogDir,
    });

    await bus.emitEventWithPersist({
      type: "RunStarted",
      runId: "eventbus-run",
      timestampMs: 1,
    });

    const events = await adapter.listEvents("eventbus-run", -1, 10);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("RunStarted");

    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });

  test("persistent cancel requests abort active runs", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db as any);
    const runId = "persistent-cancel";
    const slowAbortableAgent: any = {
      id: "slow-abortable",
      tools: {},
      generate: async (args: { abortSignal?: AbortSignal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2_000);
          const abort = () => {
            clearTimeout(timer);
            const err = new Error("aborted");
            (err as any).name = "AbortError";
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

    const workflow = smithers(() => (
      <Workflow name="persistent-cancel">
        <Task id="slow" output={outputs.outputA} agent={slowAbortableAgent}>
          run slow task
        </Task>
      </Workflow>
    ));

    const runPromise = runWorkflow(workflow, { input: {}, runId });

    for (let i = 0; i < 50; i++) {
      if (await adapter.getRun(runId)) break;
      await sleep(10);
    }

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

    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const runId = "resume-metadata";
    const workflow = smithers(() => (
      <Workflow name="resume-metadata">
        <Task id="task" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));

    const first = await runWorkflow(workflow, {
      input: {},
      runId,
      workflowPath,
    });
    expect(first.status).toBe("finished");

    writeFileSync(workflowPath, "export default 'v2';\n", "utf8");
    const resumed = await runWorkflow(workflow, {
      input: {},
      runId,
      resume: true,
      workflowPath,
    });
    expect(resumed.status).toBe("failed");
    expect((resumed as any).error?.code).toBe("RESUME_METADATA_MISMATCH");

    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });
});
