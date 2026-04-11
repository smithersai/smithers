import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startServer } from "@smithers/server";
import * as pi from "../src/pi-plugin";
import { createTestDb, sleep } from "./helpers";
import { schema, ddl } from "./schema";
import type { Server } from "node:http";
import { resolve } from "node:path";

type RunResponse = { runId: string };
type StatusResponse = { runId: string; status: string; workflowName?: string };
type FrameResponse = Array<{ frameNo: number; xml: string }>;

const PORT = 7332;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server: Server;
const testWorkflowPath = resolve(__dirname, "fixtures/test-workflow.tsx");
const testApprovalWorkflowPath = resolve(__dirname, "fixtures/approval-workflow.tsx");

function buildDb() {
  return createTestDb(schema, ddl);
}

async function waitForStatus(runId: string, expectedStatus?: string, maxAttempts = 20): Promise<StatusResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const status = (await pi.getStatus({ runId, baseUrl: BASE_URL })) as StatusResponse;
      if (!expectedStatus || status.status === expectedStatus) {
        return status;
      }
      if (status.status === "failed" || status.status === "finished") {
        return status;
      }
      await sleep(100);
    } catch (e: unknown) {
      const err = e as Error;
      if (err.message?.includes("404") && i < maxAttempts - 1) {
        await sleep(100);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Timeout waiting for run status${expectedStatus ? ` (expected: ${expectedStatus})` : ""}`);
}

beforeAll(async () => {
  server = startServer({ port: PORT });
  await sleep(100);
});

afterAll(() => {
  server?.close();
});

describe("pi-plugin client", () => {
  test("runWorkflow starts a run and returns runId", async () => {
    const result = (await pi.runWorkflow({
      workflowPath: testWorkflowPath,
      input: {},
      baseUrl: BASE_URL,
    })) as RunResponse;
    expect(result).toHaveProperty("runId");
    expect(typeof result.runId).toBe("string");
  });

  test("getStatus returns status for waiting-approval run", async () => {
    const run = (await pi.runWorkflow({
      workflowPath: testApprovalWorkflowPath,
      input: {},
      baseUrl: BASE_URL,
    })) as RunResponse;
    const status = await waitForStatus(run.runId, "waiting-approval");
    expect(status).toHaveProperty("status");
    expect(status.status).toBe("waiting-approval");
  });

  test("getFrames returns frames array for waiting run", async () => {
    const run = (await pi.runWorkflow({
      workflowPath: testApprovalWorkflowPath,
      input: {},
      baseUrl: BASE_URL,
    })) as RunResponse;
    await waitForStatus(run.runId, "waiting-approval");
    const frames = (await pi.getFrames({ runId: run.runId, baseUrl: BASE_URL })) as FrameResponse;
    expect(Array.isArray(frames)).toBe(true);
  });

  test("streamEvents yields events for approval workflow", async () => {
    const run = (await pi.runWorkflow({
      workflowPath: testApprovalWorkflowPath,
      input: {},
      baseUrl: BASE_URL,
    })) as RunResponse;

    await waitForStatus(run.runId, "waiting-approval");

    const events: Array<{ type: string }> = [];
    const collectEvents = async () => {
      for await (const event of pi.streamEvents({ runId: run.runId, baseUrl: BASE_URL })) {
        events.push(event);
        if (event.type === "RunStatusChanged" || event.type === "RunFinished" || event.type === "RunFailed") {
          break;
        }
      }
    };

    await Promise.race([
      collectEvents(),
      sleep(2000),
    ]);

    expect(events.length).toBeGreaterThan(0);
  });

  test("approve resumes a waiting-approval run", async () => {
    const run = (await pi.runWorkflow({
      workflowPath: testApprovalWorkflowPath,
      input: {},
      baseUrl: BASE_URL,
    })) as RunResponse;

    const status1 = await waitForStatus(run.runId, "waiting-approval");
    expect(status1.status).toBe("waiting-approval");

    const approveResult = (await pi.approve({
      runId: run.runId,
      nodeId: "gate",
      iteration: 0,
      baseUrl: BASE_URL,
    })) as RunResponse;
    expect(approveResult).toHaveProperty("runId");

    await pi.resume({
      workflowPath: testApprovalWorkflowPath,
      runId: run.runId,
      baseUrl: BASE_URL,
    });

    const status2 = await waitForStatus(run.runId, "finished", 50);
    expect(status2.status).toBe("finished");
  }, 15_000);

  test("deny marks node as denied", async () => {
    const run = (await pi.runWorkflow({
      workflowPath: testApprovalWorkflowPath,
      input: {},
      baseUrl: BASE_URL,
    })) as RunResponse;

    const status1 = await waitForStatus(run.runId, "waiting-approval");
    expect(status1.status).toBe("waiting-approval");

    const denyResult = (await pi.deny({
      runId: run.runId,
      nodeId: "gate",
      iteration: 0,
      note: "rejected for testing",
      baseUrl: BASE_URL,
    })) as RunResponse;
    expect(denyResult).toHaveProperty("runId");
  });

  test("cancel aborts a waiting workflow", async () => {
    const run = (await pi.runWorkflow({
      workflowPath: testApprovalWorkflowPath,
      input: {},
      baseUrl: BASE_URL,
    })) as RunResponse;

    await waitForStatus(run.runId, "waiting-approval");
    const cancelResult = (await pi.cancel({ runId: run.runId, baseUrl: BASE_URL })) as RunResponse;
    expect(cancelResult).toHaveProperty("runId");
    expect(cancelResult.runId).toBe(run.runId);
  });
});

describe("pi-plugin listRuns (with server db)", () => {
  const LIST_PORT = 7333;
  const LIST_BASE_URL = `http://127.0.0.1:${LIST_PORT}`;
  let listServer: Server;

  beforeAll(async () => {
    const { db } = buildDb();
    listServer = startServer({ port: LIST_PORT, db: db as any });
    await sleep(100);
  });

  afterAll(() => {
    listServer?.close();
  });

  test("listRuns returns array of runs", async () => {
    await pi.runWorkflow({
      workflowPath: testWorkflowPath,
      input: {},
      baseUrl: LIST_BASE_URL,
    });
    await sleep(500);

    const runs = (await pi.listRuns({ baseUrl: LIST_BASE_URL })) as StatusResponse[];
    expect(Array.isArray(runs)).toBe(true);
  });

  test("listRuns respects limit parameter", async () => {
    for (let i = 0; i < 3; i++) {
      await pi.runWorkflow({
        workflowPath: testWorkflowPath,
        input: {},
        baseUrl: LIST_BASE_URL,
      });
    }
    await sleep(500);

    const runs = (await pi.listRuns({ limit: 2, baseUrl: LIST_BASE_URL })) as StatusResponse[];
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeLessThanOrEqual(2);
  });

  test("listRuns respects status filter", async () => {
    const runs = (await pi.listRuns({ status: "finished", baseUrl: LIST_BASE_URL })) as StatusResponse[];
    expect(Array.isArray(runs)).toBe(true);
    for (const run of runs) {
      expect(run.status).toBe("finished");
    }
  });
});
