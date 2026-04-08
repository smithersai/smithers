/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb, Task, Workflow, runWorkflow } from "../src/index.ts";
import { smithersCache } from "../src/db/internal-schema.ts";
import { jsx } from "smithers/jsx-runtime";
import { createTestSmithers } from "./helpers";

const contractSchemas = {
  activity: z.object({ value: z.number() }),
  structured: z.object({ status: z.string(), count: z.number() }),
};

function buildContractSmithers() {
  return createTestSmithers(contractSchemas);
}

describe("legacy executeTask contract", () => {
  test("executes a task and persists the result", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "contract-static-persist",
          children: jsx(Task, {
            id: "static-task",
            output: outputs.activity,
            children: { value: 42 },
          }),
        }),
      );

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");

      const rows = await (db as any).select().from(tables.activity);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: result.runId,
        nodeId: "static-task",
        iteration: 0,
        value: 42,
      });

      const attempts = await new SmithersDb(db as any).listAttempts(
        result.runId,
        "static-task",
        0,
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.state).toBe("finished");
    } finally {
      cleanup();
    }
  }, 30_000);

  test("retries on transient failure up to N times", async () => {
    const { smithers, outputs, db, cleanup } = buildContractSmithers();
    const retries = 2;
    let calls = 0;
    const agent: any = {
      id: "retry-agent",
      tools: {},
      generate: async () => {
        calls += 1;
        if (calls <= retries) {
          throw new Error(`transient failure ${calls}`);
        }
        return { output: { value: calls } };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "contract-retries",
          children: jsx(Task, {
            id: "retry-task",
            output: outputs.activity,
            agent,
            retries,
            children: "Recover after transient failures",
          }),
        }),
      );

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");
      expect(calls).toBe(retries + 1);

      const attempts = await new SmithersDb(db as any).listAttempts(
        result.runId,
        "retry-task",
        0,
      );
      expect(attempts).toHaveLength(retries + 1);
      expect(attempts.filter((attempt) => attempt.state === "failed")).toHaveLength(
        retries,
      );
      expect(attempts.filter((attempt) => attempt.state === "finished")).toHaveLength(1);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("returns cached result on replay (idempotency)", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
    let calls = 0;
    const agent: any = {
      id: "cache-agent",
      tools: {},
      generate: async () => {
        calls += 1;
        return { output: { value: 7 } };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "contract-cache-replay",
          cache: true,
          children: jsx(Task, {
            id: "cache-task",
            output: outputs.activity,
            agent,
            children: "Use the cached result",
          }),
        }),
      );

      const first = await runWorkflow(workflow, { input: {}, runId: "contract-cache-r1" });
      const second = await runWorkflow(workflow, { input: {}, runId: "contract-cache-r2" });

      expect(first.status).toBe("finished");
      expect(second.status).toBe("finished");
      expect(calls).toBe(1);

      const rows = await (db as any).select().from(tables.activity);
      const firstRow = rows.find((row: any) => row.runId === first.runId);
      const secondRow = rows.find((row: any) => row.runId === second.runId);
      expect(firstRow?.value).toBe(7);
      expect(secondRow?.value).toBe(7);

      const secondAttempts = await new SmithersDb(db as any).listAttempts(
        second.runId,
        "cache-task",
        0,
      );
      expect(secondAttempts).toHaveLength(1);
      expect(secondAttempts[0]?.cached).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("generates deterministic idempotency key", async () => {
    const { smithers, outputs, db, cleanup } = buildContractSmithers();

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "contract-deterministic-cache-key",
          cache: true,
          children: jsx(Task, {
            id: "deterministic-cache-task",
            output: outputs.activity,
            children: { value: 11 },
          }),
        }),
      );

      const first = await runWorkflow(workflow, { input: {}, runId: "contract-key-r1" });
      expect(first.status).toBe("finished");

      const rowsAfterFirstRun = await (db as any).select().from(smithersCache);
      expect(rowsAfterFirstRun).toHaveLength(1);
      const firstCacheKey = rowsAfterFirstRun[0]?.cacheKey;
      expect(typeof firstCacheKey).toBe("string");

      const second = await runWorkflow(workflow, { input: {}, runId: "contract-key-r2" });
      expect(second.status).toBe("finished");

      const rowsAfterSecondRun = await (db as any).select().from(smithersCache);
      expect(rowsAfterSecondRun).toHaveLength(1);
      expect(rowsAfterSecondRun[0]?.cacheKey).toBe(firstCacheKey);
      expect(rowsAfterSecondRun[0]).toMatchObject({
        workflowName: "contract-deterministic-cache-key",
        nodeId: "deterministic-cache-task",
      });
    } finally {
      cleanup();
    }
  }, 30_000);

  test("tracks heartbeats during execution", async () => {
    const { smithers, outputs, db, cleanup } = buildContractSmithers();
    const agent: any = {
      id: "heartbeat-agent",
      tools: {},
      generate: async (args: any) => {
        args.onStdout?.("heartbeat-1");
        await Bun.sleep(25);
        args.onStdout?.("heartbeat-2");
        return { output: { value: 5 } };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "contract-heartbeats",
          children: jsx(Task, {
            id: "heartbeat-task",
            output: outputs.activity,
            agent,
            children: "Emit progress while working",
          }),
        }),
      );

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");

      const attempts = await new SmithersDb(db as any).listAttempts(
        result.runId,
        "heartbeat-task",
        0,
      );
      expect(attempts).toHaveLength(1);
      expect(typeof attempts[0]?.heartbeatAtMs).toBe("number");
      expect(attempts[0]?.heartbeatAtMs).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("pure computeFn tasks run inline without agent dispatch", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "contract-compute-inline",
          children: jsx(Task, {
            id: "compute-task",
            output: outputs.activity,
            children: () => ({ value: 13 }),
          }),
        }),
      );

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");

      const rows = await (db as any).select().from(tables.activity);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBe(13);

      const attempts = await new SmithersDb(db as any).listAttempts(
        result.runId,
        "compute-task",
        0,
      );
      expect(attempts).toHaveLength(1);

      const meta = JSON.parse(attempts[0]?.metaJson ?? "{}");
      expect(meta.kind).toBe("compute");
      expect(meta.agentId).toBeNull();
    } finally {
      cleanup();
    }
  }, 30_000);

  test("agent tasks dispatch to the agent and collect output", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
    let generateCalls = 0;
    const agent: any = {
      id: "structured-agent",
      tools: {},
      generate: async () => {
        generateCalls += 1;
        return { output: { status: "ok", count: 3 } };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "contract-agent-dispatch",
          children: jsx(Task, {
            id: "agent-task",
            output: outputs.structured,
            agent,
            children: "Return a structured activity result",
          }),
        }),
      );

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");
      expect(generateCalls).toBe(1);

      const rows = await (db as any).select().from(tables.structured);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: result.runId,
        nodeId: "agent-task",
        iteration: 0,
        status: "ok",
        count: 3,
      });

      const attempts = await new SmithersDb(db as any).listAttempts(
        result.runId,
        "agent-task",
        0,
      );
      const meta = JSON.parse(attempts[0]?.metaJson ?? "{}");
      expect(meta.kind).toBe("agent");
      expect(meta.agentId).toBe("structured-agent");
    } finally {
      cleanup();
    }
  }, 30_000);
});
