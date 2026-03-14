/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Sequence,
  Task,
  Workflow,
  renderFrame,
  runWorkflow,
} from "../src/index";
import { createTestSmithers, sleep } from "./helpers";
import { outputSchemas } from "./schema";
import { z } from "zod";
import { approveNode } from "../src/engine/approvals";
import { SmithersDb } from "../src/db/adapter";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bash, read } from "../src/tools";

describe("docs: renderFrame", () => {
  test("renderFrame is pure and does not execute tasks", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    let computeCalls = 0;
    let agentCalls = 0;

    const agent: any = {
      id: "agent",
      tools: {},
      async generate() {
        agentCalls += 1;
        return { output: { value: 2 } };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="render-frame">
        <Task id="compute" output={outputs.outputA}>
          {() => {
            computeCalls += 1;
            return { value: 1 };
          }}
        </Task>
        <Task id="agent" output={outputs.outputB} agent={agent}>
          run agent
        </Task>
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "preview",
      iteration: 0,
      input: {},
      outputs: {},
    });

    expect(snapshot.frameNo).toBe(0);
    expect(snapshot.tasks.length).toBe(2);
    expect(computeCalls).toBe(0);
    expect(agentCalls).toBe(0);
    expect(snapshot.xml?.kind).toBe("element");

    cleanup();
  });

  test("task ordinals are assigned in execution order", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);

    const workflow = smithers(() => (
      <Workflow name="order">
        <Task id="first" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
        <Task id="second" output={outputs.outputB}>
          {{ value: 2 }}
        </Task>
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "order",
      iteration: 0,
      input: {},
      outputs: {},
    });

    expect(snapshot.tasks.map((t) => t.nodeId)).toEqual(["first", "second"]);
    expect(snapshot.tasks[0]?.ordinal).toBe(0);
    expect(snapshot.tasks[1]?.ordinal).toBe(1);

    cleanup();
  });
});

describe("docs: runWorkflow", () => {
  test("result.output is populated only for schema key named 'output'", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="result-output">
        <Task id="o" output={outputs.output}>
          {{ value: 5 }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    const rows = result.output as Array<{ value: number }>;
    expect(rows?.[0]?.value).toBe(5);
    cleanup();
  });

  test("result.output is undefined for other schema keys", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      analysis: z.object({ value: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="result-output-missing">
        <Task id="a" output={outputs.analysis}>
          {{ value: 9 }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(result.output).toBeUndefined();

    const rows = await (db as any).select().from(tables.analysis);
    expect(rows.length).toBe(1);
    cleanup();
  });

  test("resume loads the stored input when continuing", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      gate: z.object({ message: z.string() }),
      final: z.object({ message: z.string() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="resume-input">
        <Sequence>
          <Task id="gate" output={outputs.gate} needsApproval>
            {{ message: String(ctx.input.message) }}
          </Task>
          <Task id="final" output={outputs.final}>
            {{ message: String(ctx.input.message) }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const first = await runWorkflow(workflow, {
      input: { message: "hello" },
      runId: "resume-input",
    });
    expect(first.status).toBe("waiting-approval");

    const adapter = new SmithersDb(db as any);
    await approveNode(adapter, first.runId, "gate", 0, "ok", "test");

    const resumed = await runWorkflow(workflow, {
      input: {},
      runId: first.runId,
      resume: true,
    });
    expect(resumed.status).toBe("finished");

    const rows = await (db as any).select().from(tables.final);
    expect(rows[0]?.message).toBe("hello");
    cleanup();
  });

  test("logDir: null disables NDJSON log file output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-log-"));
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="no-logs">
        <Task id="t" output={outputs.output}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));

    const runId = "no-log-run";
    const result = await runWorkflow(workflow, {
      input: {},
      runId,
      rootDir: dir,
      logDir: null,
    });

    expect(result.status).toBe("finished");
    const logPath = join(
      dir,
      ".smithers",
      "executions",
      runId,
      "logs",
      "stream.ndjson",
    );
    expect(existsSync(logPath)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });

  test("default logDir writes NDJSON logs under rootDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-log-default-"));
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="default-logs">
        <Task id="t" output={outputs.output}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));

    const runId = "default-log-run";
    const result = await runWorkflow(workflow, {
      input: {},
      runId,
      rootDir: dir,
    });

    expect(result.status).toBe("finished");
    const logPath = join(
      dir,
      ".smithers",
      "executions",
      runId,
      "logs",
      "stream.ndjson",
    );
    expect(existsSync(logPath)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });

  test("allowNetwork=false blocks network commands in bash tool", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const agent: any = {
      id: "network-check",
      tools: { bash },
      async generate() {
        await bash.execute({ cmd: "curl", args: ["https://example.com"] });
        return { output: { value: 1 } };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="allow-network">
        <Task id="net" output={outputs.output} agent={agent}>
          Try network.
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {}, allowNetwork: false });
    expect(result.status).toBe("failed");
    cleanup();
  });

  test("maxOutputBytes propagates to tool execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-max-bytes-"));
    const bigPath = join(root, "big.txt");
    await Bun.write(bigPath, "x".repeat(64));

    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const agent: any = {
      id: "max-bytes",
      tools: { read },
      async generate() {
        await read.execute({ path: "big.txt" });
        return { output: { value: 1 } };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="max-bytes">
        <Task id="read" output={outputs.output} agent={agent}>
          Read file.
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, {
      input: {},
      rootDir: root,
      maxOutputBytes: 16,
    });
    expect(result.status).toBe("failed");

    rmSync(root, { recursive: true, force: true });
    cleanup();
  });

  test("AbortSignal cancels a running workflow", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const controller = new AbortController();
    const events: string[] = [];

    const workflow = smithers(() => (
      <Workflow name="abort">
        <Task id="slow" output={outputs.outputA}>
          {() => new Promise(() => {})}
        </Task>
      </Workflow>
    ));

    const runPromise = runWorkflow(workflow, {
      input: {},
      signal: controller.signal,
      onProgress: (event) => events.push(event.type),
    });

    await sleep(20);
    controller.abort();

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(events).toContain("RunCancelled");
    cleanup();
  });
});

describe("docs: events", () => {
  test("onProgress receives core run and node lifecycle events", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const events: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="events">
        <Task id="step" output={outputs.output}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, {
      input: {},
      onProgress: (event) => events.push(event.type),
    });
    expect(result.status).toBe("finished");
    expect(events).toContain("RunStarted");
    expect(events).toContain("NodeStarted");
    expect(events).toContain("NodeFinished");
    expect(events).toContain("RunFinished");
    cleanup();
  });

  test("needsApproval emits ApprovalRequested and waits", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const events: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="approval-events">
        <Task id="gate" output={outputs.output} needsApproval>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, {
      input: {},
      onProgress: (event) => events.push(event.type),
    });

    expect(result.status).toBe("waiting-approval");
    expect(events).toContain("ApprovalRequested");
    expect(events).toContain("NodeWaitingApproval");
    expect(events).toContain("RunStatusChanged");
    cleanup();
  });
});
