import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

function makeDbPath(name: string) {
  return join(
    tmpdir(),
    `smithers-get-node-output-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createConnectionContext() {
  return {
    connectionId: "test-connection",
    transport: "test",
    authenticated: true,
    sessionToken: "test-session",
    role: "operator",
    scopes: ["*"],
    userId: "user:test",
    subscribedRuns: new Set<string>(),
    heartbeatTimer: null,
  };
}

async function request(
  gateway: Gateway,
  connection: ReturnType<typeof createConnectionContext>,
  method: string,
  params?: Record<string, unknown>,
) {
  return (gateway as any).routeRequest(connection, {
    type: "req",
    id: `${method}-${Math.random().toString(36).slice(2)}`,
    method,
    params,
  });
}

async function waitForRunStatus(
  gateway: Gateway,
  connection: ReturnType<typeof createConnectionContext>,
  runId: string,
  statuses: string[],
  timeoutMs = 8_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await request(gateway, connection, "runs.get", { runId });
    if (response.ok && statuses.includes(String(response.payload.status))) {
      return response.payload;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join(", ")}`);
}

async function waitForNodeOutputStatus(
  gateway: Gateway,
  connection: ReturnType<typeof createConnectionContext>,
  runId: string,
  nodeId: string,
  statuses: Array<"produced" | "pending" | "failed">,
  timeoutMs = 8_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await request(gateway, connection, "getNodeOutput", {
      runId,
      nodeId,
      iteration: 0,
    });
    if (response.ok && statuses.includes(response.payload.status)) {
      return response.payload;
    }
    if (!response.ok && response.error?.code !== "NodeNotFound") {
      throw new Error(`Unexpected getNodeOutput error: ${response.error?.code}`);
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for node output status ${statuses.join(", ")}`);
}

describe("getNodeOutput integration", () => {
  const dbPaths: string[] = [];
  let gateway: Gateway | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("finished task returns output row and schema descriptor", async () => {
    const dbPath = makeDbPath("finished");
    dbPaths.push(dbPath);

    const api = createSmithers(
      {
        result: z.object({
          value: z.number(),
          note: z.string().describe("Helpful note"),
        }),
      },
      { dbPath },
    );

    const workflow = api.smithers((ctx) => (
      React.createElement(
        api.Workflow,
        { name: "get-node-output-finished" },
        React.createElement(
          api.Task,
          { id: "task:finished:0", output: api.outputs.result },
          { value: Number(ctx.input.value ?? 1), note: "done" },
        ),
      )
    ));

    gateway = new Gateway();
    gateway.register("finished", workflow);

    const connection = createConnectionContext();
    const created = await request(gateway, connection, "runs.create", {
      workflow: "finished",
      input: { value: 7 },
    });

    expect(created.ok).toBe(true);
    const runId = String(created.payload.runId);
    await waitForRunStatus(gateway, connection, runId, ["finished"]);

    const output = await request(gateway, connection, "getNodeOutput", {
      runId,
      nodeId: "task:finished:0",
      iteration: 0,
    });

    expect(output.ok).toBe(true);
    expect(output.payload.status).toBe("produced");
    expect(output.payload.row).toEqual({ value: 7, note: "done" });
    expect(output.payload.schema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "note",
          description: "Helpful note",
        }),
      ]),
    );
  }, 20_000);

  test("running task before output returns pending", async () => {
    const dbPath = makeDbPath("pending");
    dbPaths.push(dbPath);

    const api = createSmithers(
      {
        result: z.object({ value: z.number() }),
      },
      { dbPath },
    );

    const workflow = api.smithers((ctx) => (
      React.createElement(
        api.Workflow,
        { name: "get-node-output-pending" },
        React.createElement(
          api.Task,
          { id: "task:pending:0", output: api.outputs.result },
          async () => {
            await sleep(400);
            return { value: Number(ctx.input.value ?? 1) };
          },
        ),
      )
    ));

    gateway = new Gateway();
    gateway.register("pending", workflow);

    const connection = createConnectionContext();
    const created = await request(gateway, connection, "runs.create", {
      workflow: "pending",
      input: { value: 3 },
    });

    expect(created.ok).toBe(true);
    const runId = String(created.payload.runId);

    const pendingOutput = await waitForNodeOutputStatus(
      gateway,
      connection,
      runId,
      "task:pending:0",
      ["pending"],
    );

    expect(pendingOutput.status).toBe("pending");
    await waitForRunStatus(gateway, connection, runId, ["finished"]);
  }, 20_000);

  test("failed task returns failed status with partial heartbeat payload", async () => {
    const dbPath = makeDbPath("failed");
    dbPaths.push(dbPath);

    const api = createSmithers(
      {
        result: z.object({ value: z.string() }),
      },
      { dbPath },
    );

    const workflow = api.smithers(() => (
      React.createElement(
        api.Workflow,
        { name: "get-node-output-failed" },
        React.createElement(
          api.Task,
          { id: "task:failed:0", output: api.outputs.result, retries: 0 },
          () => {
            const runtime = requireTaskRuntime();
            runtime.heartbeat({ progress: 50, partial: "halfway" });
            throw new Error("boom");
          },
        ),
      )
    ));

    gateway = new Gateway();
    gateway.register("failed", workflow);

    const connection = createConnectionContext();
    const created = await request(gateway, connection, "runs.create", {
      workflow: "failed",
      input: {},
    });

    expect(created.ok).toBe(true);
    const runId = String(created.payload.runId);
    await waitForRunStatus(gateway, connection, runId, ["failed"]);

    const output = await request(gateway, connection, "getNodeOutput", {
      runId,
      nodeId: "task:failed:0",
      iteration: 0,
    });

    expect(output.ok).toBe(true);
    expect(output.payload.status).toBe("failed");
    expect(output.payload.row).toBeNull();
    expect(output.payload.partial).toEqual({ progress: 50, partial: "halfway" });
  }, 20_000);
});
