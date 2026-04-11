/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { SmithersDb } from "@smithers/db/adapter";
import { Sequence, Task, Workflow, runWorkflow } from "smithers";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers";
import { outputSchemas } from "../../smithers/tests/schema";

function nodeState(nodes: any[], nodeId: string) {
  return nodes.find((node) => node.nodeId === nodeId)?.state;
}

function readCounter(counterPath: string) {
  if (!existsSync(counterPath)) return 0;
  const raw = readFileSync(counterPath, "utf8").trim();
  return raw.length > 0 ? Number(raw) : 0;
}

function incrementCounter(counterPath: string) {
  const next = readCounter(counterPath) + 1;
  writeFileSync(counterPath, String(next));
  return next;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {}
    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function spawnHangingRun(
  params: {
    dbPath: string;
    counterPath: string;
    runId: string;
  },
) {
  const smithersPath = resolve(import.meta.dir, "../../smithers/src/index.ts");
  const schemaPath = resolve(import.meta.dir, "../../smithers/tests/schema.ts");
  const script = `
import React from "react";
import { createSmithers, Task, Workflow, runWorkflow } from ${JSON.stringify(smithersPath)};
import { outputSchemas } from ${JSON.stringify(schemaPath)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

const api = createSmithers(outputSchemas, { dbPath: ${JSON.stringify(params.dbPath)} });
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
    { name: "resume-force-running" },
    React.createElement(
      Task,
      {
        id: "stuck",
        output: api.outputs.outputA,
        agent,
      },
      "produce a value",
    ),
  ),
);

await runWorkflow(workflow, {
  input: {},
  runId: ${JSON.stringify(params.runId)},
});
`;

  const child = spawn(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => {
        resolveExit({ exitCode: code, signal });
      });
    },
  );

  return {
    child,
    exited,
    readStderr: () => stderr,
  };
}

describe("resume without time travel", () => {
  test("resume keeps exhausted failed task failed until retries increase", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);

    try {
      const adapter = new SmithersDb(db as any);
      const callsByNodeId: Record<string, number> = {};
      const makeAgent = (nodeId: string) => ({
        id: `agent-${nodeId}`,
        tools: {},
        async generate(args: any) {
          callsByNodeId[nodeId] = (callsByNodeId[nodeId] ?? 0) + 1;
          if (args?.nodeId) {
            expect(args.nodeId).toBe(nodeId);
          }
          if (nodeId === "implement" && callsByNodeId[nodeId] === 1) {
            throw new Error("implement failed");
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      });

      const workflow = smithers(() => (
        <Workflow name="resume-current-state">
          <Sequence>
            <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze")}>
              analyze the problem
            </Task>
            <Task id="implement" output={outputs.outputB} agent={makeAgent("implement")} retries={0}>
              implement the fix
            </Task>
            <Task id="test" output={outputs.outputC} agent={makeAgent("test")}>
              validate the result
            </Task>
          </Sequence>
        </Workflow>
      ));

      const first = await runWorkflow(workflow, {
        input: {},
        runId: "resume-no-time-travel-retry",
      });
      expect(first.status).toBe("failed");

      const firstNodes = await adapter.listNodes(first.runId);
      expect(nodeState(firstNodes as any[], "analyze")).toBe("finished");
      expect(nodeState(firstNodes as any[], "implement")).toBe("failed");

      const resumed = await runWorkflow(workflow, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("failed");

      const analyzeAttempts = await adapter.listAttempts(first.runId, "analyze", 0);
      const implementAttempts = await adapter.listAttempts(first.runId, "implement", 0);
      const testAttempts = await adapter.listAttempts(first.runId, "test", 0);

      expect(analyzeAttempts).toHaveLength(1);
      expect(implementAttempts).toHaveLength(1);
      expect(testAttempts).toHaveLength(0);
      expect(callsByNodeId.analyze).toBe(1);
      expect(callsByNodeId.implement).toBe(1);
      expect(callsByNodeId.test).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("resume retries failed task when workflow now allows more retries", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);

    try {
      const adapter = new SmithersDb(db as any);
      const callsByNodeId: Record<string, number> = {};
      const makeAgent = (nodeId: string) => ({
        id: `agent-${nodeId}`,
        tools: {},
        async generate(args: any) {
          callsByNodeId[nodeId] = (callsByNodeId[nodeId] ?? 0) + 1;
          if (args?.nodeId) {
            expect(args.nodeId).toBe(nodeId);
          }
          if (nodeId === "implement" && callsByNodeId[nodeId] === 1) {
            throw new Error("implement failed");
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      });

      const originalWorkflow = smithers(() => (
        <Workflow name="resume-current-state-upgrade">
          <Sequence>
            <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze")}>
              analyze the problem
            </Task>
            <Task id="implement" output={outputs.outputB} agent={makeAgent("implement")} retries={0}>
              implement the fix
            </Task>
            <Task id="test" output={outputs.outputC} agent={makeAgent("test")}>
              validate the result
            </Task>
          </Sequence>
        </Workflow>
      ));

      const upgradedWorkflow = smithers(() => (
        <Workflow name="resume-current-state-upgrade">
          <Sequence>
            <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze")}>
              analyze the problem
            </Task>
            <Task id="implement" output={outputs.outputB} agent={makeAgent("implement")} retries={1}>
              implement the fix
            </Task>
            <Task id="test" output={outputs.outputC} agent={makeAgent("test")}>
              validate the result
            </Task>
          </Sequence>
        </Workflow>
      ));

      const first = await runWorkflow(originalWorkflow, {
        input: {},
        runId: "resume-no-time-travel-retry-upgraded",
      });
      expect(first.status).toBe("failed");

      const resumed = await runWorkflow(upgradedWorkflow, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");

      const analyzeAttempts = await adapter.listAttempts(first.runId, "analyze", 0);
      const implementAttempts = await adapter.listAttempts(first.runId, "implement", 0);
      const testAttempts = await adapter.listAttempts(first.runId, "test", 0);

      expect(analyzeAttempts).toHaveLength(1);
      expect(implementAttempts).toHaveLength(2);
      expect(testAttempts).toHaveLength(1);
      expect(callsByNodeId.analyze).toBe(1);
      expect(callsByNodeId.implement).toBe(2);
      expect(callsByNodeId.test).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("resume is idempotent on already-finished run", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);

    try {
      const adapter = new SmithersDb(db as any);
      let callCount = 0;
      const agent = {
        id: "finished-agent",
        tools: {},
        async generate() {
          callCount += 1;
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      };

      const workflow = smithers(() => (
        <Workflow name="resume-idempotent-finished">
          <Task id="done" output={outputs.outputA} agent={agent}>
            complete the task
          </Task>
        </Workflow>
      ));

      const first = await runWorkflow(workflow, {
        input: {},
        runId: "resume-no-time-travel-idempotent",
      });
      expect(first.status).toBe("finished");
      expect(callCount).toBe(1);

      const resumed = await runWorkflow(workflow, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");
      expect(callCount).toBe(1);

      const attempts = await adapter.listAttempts(first.runId, "done", 0);
      expect(attempts).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("resume refuses to steal a run from a live owner process", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const runId = "resume-owner-alive";
    const counterPath = `${dbPath}.owner-alive.calls`;
    const child = spawnHangingRun({ dbPath, counterPath, runId });

    try {
      const adapter = new SmithersDb(db as any);
      await waitFor(async () => {
        const run = await adapter.getRun(runId);
        const attempts = await adapter.listAttempts(runId, "stuck", 0);
        return run?.status === "running" && attempts.some((attempt: any) => attempt.state === "in-progress");
      }, { timeoutMs: 10_000, intervalMs: 50 });
      await waitFor(
        async () => readCounter(counterPath) === 1,
        { timeoutMs: 10_000, intervalMs: 50 },
      );

      const agent = {
        id: "hang-on-first-call",
        tools: {},
        async generate() {
          const call = incrementCounter(counterPath);
          if (call === 1) {
            return new Promise(() => {});
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      };

      const workflow = smithers(() => (
        <Workflow name="resume-owner-alive">
          <Task id="stuck" output={outputs.outputA} agent={agent}>
            produce a value
          </Task>
        </Workflow>
      ));

      const resumed = await runWorkflow(workflow, {
        input: {},
        runId,
        resume: true,
        force: true,
      });
      expect(resumed.status).toBe("failed");
      expect((resumed as any).error?.code).toBe("RUN_OWNER_ALIVE");
      expect(readCounter(counterPath)).toBe(1);

      const run = await adapter.getRun(runId);
      expect(run?.status).toBe("running");
      expect(run?.runtimeOwnerId).toContain("pid:");

      const attempts = await adapter.listAttempts(runId, "stuck", 0);
      expect(attempts).toHaveLength(1);
      expect((attempts as any[])[0]?.state).toBe("in-progress");
    } finally {
      if (child.child.exitCode === null && !child.child.killed) {
        child.child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
      cleanup();
    }
  });

  test("resume with force flag overrides running status", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const runId = "resume-no-time-travel-force";
    const counterPath = `${dbPath}.calls`;
    const child = spawnHangingRun({ dbPath, counterPath, runId });

    try {
      const adapter = new SmithersDb(db as any);
      const firstWindow = await Promise.race([
        child.exited.then(() => "exited"),
        sleep(250).then(() => "timeout"),
      ]);
      expect(firstWindow).toBe("timeout");

      await waitFor(async () => {
        const run = await adapter.getRun(runId);
        const attempts = await adapter.listAttempts(runId, "stuck", 0);
        return run?.status === "running" && attempts.some((attempt: any) => attempt.state === "in-progress");
      }, { timeoutMs: 10_000, intervalMs: 50 });

      const runBeforeResume = await adapter.getRun(runId);
      expect(runBeforeResume?.status).toBe("running");
      await waitFor(
        async () => readCounter(counterPath) === 1,
        { timeoutMs: 10_000, intervalMs: 50 },
      );
      expect(readCounter(counterPath)).toBe(1);

      child.child.kill("SIGKILL");
      await child.exited;

      const agent = {
        id: "hang-on-first-call",
        tools: {},
        async generate() {
          const call = incrementCounter(counterPath);
          if (call === 1) {
            return new Promise(() => {});
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      };

      const workflow = smithers(() => (
        <Workflow name="resume-force-running">
          <Task id="stuck" output={outputs.outputA} agent={agent}>
            produce a value
          </Task>
        </Workflow>
      ));

      const resumed = await runWorkflow(workflow, {
        input: {},
        runId,
        resume: true,
        force: true,
      });
      expect(resumed.status).toBe("finished");
      expect(readCounter(counterPath)).toBe(2);

      const attempts = await adapter.listAttempts(runId, "stuck", 0);
      expect(attempts).toHaveLength(2);
      expect((attempts as any[])[0]?.state).toBe("finished");
      expect((attempts as any[])[1]?.state).toBe("cancelled");
    } finally {
      if (child.child.exitCode === null && !child.child.killed) {
        child.child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
      cleanup();
    }
  });
});
