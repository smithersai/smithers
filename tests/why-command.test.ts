import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/db/adapter";
import { ensureSmithersTables } from "../src/db/ensure";
import { createTempRepo, runSmithers } from "./e2e-helpers";

function openRepoDb(repo: ReturnType<typeof createTempRepo>) {
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db as any);
  return {
    sqlite,
    adapter: new SmithersDb(db as any),
  };
}

async function insertRun(
  adapter: SmithersDb,
  runId: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "why-fixture",
    workflowPath: "workflow.tsx",
    status,
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: null,
    heartbeatAtMs: status === "running" ? now : null,
    ...overrides,
  });
}

function workflowFrame(children: unknown[]) {
  return JSON.stringify({
    kind: "element",
    tag: "smithers:workflow",
    props: { name: "why-fixture" },
    children,
  });
}

async function insertFrame(
  adapter: SmithersDb,
  runId: string,
  xmlJson: string,
  frameNo = 1,
) {
  await adapter.insertFrame({
    runId,
    frameNo,
    createdAtMs: Date.now(),
    xmlJson,
    xmlHash: `hash-${frameNo}`,
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: null,
  });
}

describe("smithers why", () => {
  test("waiting-approval diagnosis includes blocker, reason, waiting time, and approve command", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "approval-run", "waiting-approval", {
        startedAtMs: now - 12 * 60_000,
      });
      await adapter.insertNode({
        runId: "approval-run",
        nodeId: "review-gate",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 2,
        updatedAtMs: now - 11 * 60_000,
        outputTable: "approval_output",
        label: "Review gate",
      });
      await adapter.insertOrUpdateApproval({
        runId: "approval-run",
        nodeId: "review-gate",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 11 * 60_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
      });

      const result = runSmithers(["why", "approval-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("review-gate");
      expect(result.stdout).toContain("Approval requested");
      expect(result.stdout).toContain("Waiting since:");
      expect(result.stdout).toContain("smithers approve approval-run");
    } finally {
      sqlite.close();
    }
  });

  test("waiting-signal diagnosis includes signal metadata and signal command", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "signal-run", "waiting-event", {
        startedAtMs: now - 6_000,
      });
      await adapter.insertNode({
        runId: "signal-run",
        nodeId: "await-signal",
        iteration: 0,
        state: "waiting-event",
        lastAttempt: 1,
        updatedAtMs: now - 5_000,
        outputTable: "signal_output",
        label: "Await signal",
      });
      await insertFrame(
        adapter,
        "signal-run",
        workflowFrame([
          {
            kind: "element",
            tag: "smithers:wait-for-event",
            props: {
              id: "await-signal",
              event: "deploy.ready",
              correlationId: "ticket-42",
            },
            children: [],
          },
        ]),
      );

      const result = runSmithers(["why", "signal-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("deploy.ready");
      expect(result.stdout).toContain("waiting for signal");
      expect(result.stdout).toContain("smithers signal signal-run deploy.ready --data '{}'");
    } finally {
      sqlite.close();
    }
  });

  test("waiting-timer diagnosis includes timer details and remaining time", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();
    const firesAtMs = now + 60 * 60_000;

    try {
      await insertRun(adapter, "timer-run", "waiting-timer", {
        startedAtMs: now - 8_000,
      });
      await adapter.insertNode({
        runId: "timer-run",
        nodeId: "cooldown",
        iteration: 0,
        state: "waiting-timer",
        lastAttempt: 1,
        updatedAtMs: now - 7_000,
        outputTable: "timer_output",
        label: "Cooldown",
      });
      await adapter.insertAttempt({
        runId: "timer-run",
        nodeId: "cooldown",
        iteration: 0,
        attempt: 1,
        state: "waiting-timer",
        startedAtMs: now - 7_000,
        finishedAtMs: null,
        errorJson: null,
        metaJson: JSON.stringify({
          timer: {
            timerId: "cooldown",
            timerType: "duration",
            createdAtMs: now - 7_000,
            firesAtMs,
          },
        }),
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: repo.dir,
      });

      const result = runSmithers(["why", "timer-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("cooldown");
      expect(result.stdout).toContain("waiting for timer");
      expect(result.stdout).toContain("Fires at:");
      expect(result.stdout).toContain("Time remaining:");
    } finally {
      sqlite.close();
    }
  });

  test("failed run diagnosis reports exhausted retries and resume command", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "failed-run", "failed", {
        finishedAtMs: now - 1_000,
        errorJson: JSON.stringify({ message: "Task(s) failed: validate-output" }),
      });
      await adapter.insertNode({
        runId: "failed-run",
        nodeId: "validate-output",
        iteration: 0,
        state: "failed",
        lastAttempt: 3,
        updatedAtMs: now - 1_500,
        outputTable: "failed_output",
        label: "Validate output",
      });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await adapter.insertAttempt({
          runId: "failed-run",
          nodeId: "validate-output",
          iteration: 0,
          attempt,
          state: "failed",
          startedAtMs: now - 10_000 + attempt * 500,
          finishedAtMs: now - 9_000 + attempt * 500,
          errorJson: JSON.stringify({
            name: "SchemaValidationError",
            message: "output.score must be >= 0",
          }),
          metaJson: JSON.stringify({
            retries: 2,
          }),
          responseText: null,
          cached: false,
          jjPointer: null,
          jjCwd: repo.dir,
        });
      }

      const result = runSmithers(["why", "failed-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("validate-output");
      expect(result.stdout).toContain("All retries exhausted");
      expect(result.stdout).toContain("SchemaValidationError: output.score must be >= 0");
      expect(result.stdout).toContain("Attempt 3 of 3");
      expect(result.stdout).toContain(
        "smithers up workflow.tsx --run-id failed-run --resume true",
      );
    } finally {
      sqlite.close();
    }
  });

  test("stale heartbeat diagnosis reports orphaned run and force resume command", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "stale-run", "running", {
        heartbeatAtMs: now - 30_000,
      });
      await adapter.insertNode({
        runId: "stale-run",
        nodeId: "inflight-task",
        iteration: 0,
        state: "in-progress",
        lastAttempt: 1,
        updatedAtMs: now - 25_000,
        outputTable: "stale_output",
        label: "Inflight task",
      });

      const result = runSmithers(["why", "stale-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run appears orphaned (last heartbeat");
      expect(result.stdout).toContain(
        "smithers up workflow.tsx --run-id stale-run --resume true --force true",
      );
    } finally {
      sqlite.close();
    }
  });

  test("stale task heartbeat diagnosis reports task timeout details", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "task-heartbeat-run", "running", {
        heartbeatAtMs: now,
      });
      await adapter.insertNode({
        runId: "task-heartbeat-run",
        nodeId: "inflight-task",
        iteration: 0,
        state: "in-progress",
        lastAttempt: 1,
        updatedAtMs: now - 95_000,
        outputTable: "stale_output",
        label: "Inflight task",
      });
      await adapter.insertAttempt({
        runId: "task-heartbeat-run",
        nodeId: "inflight-task",
        iteration: 0,
        attempt: 1,
        state: "in-progress",
        startedAtMs: now - 100_000,
        heartbeatAtMs: now - 90_000,
        heartbeatDataJson: JSON.stringify({ progress: 75 }),
        metaJson: JSON.stringify({ heartbeatTimeoutMs: 60_000 }),
        errorJson: null,
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: repo.dir,
      });

      const result = runSmithers(["why", "task-heartbeat-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hasn't heartbeated in");
      expect(result.stdout).toContain("timeout:");
      expect(result.stdout).toContain(
        "smithers retry-task workflow.tsx --run-id task-heartbeat-run --node-id inflight-task --iteration 0 --force true",
      );
    } finally {
      sqlite.close();
    }
  });

  test("finished run reports nothing blocked", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);

    try {
      await insertRun(adapter, "finished-run", "finished", {
        finishedAtMs: Date.now() - 1_000,
      });

      const result = runSmithers(["why", "finished-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run is finished, nothing is blocked.");
    } finally {
      sqlite.close();
    }
  });

  test("healthy running run reports currently executing node", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "healthy-run", "running", {
        heartbeatAtMs: now,
      });
      await adapter.insertNode({
        runId: "healthy-run",
        nodeId: "build-node",
        iteration: 0,
        state: "in-progress",
        lastAttempt: 1,
        updatedAtMs: now - 500,
        outputTable: "healthy_output",
        label: "Build node",
      });

      const result = runSmithers(["why", "healthy-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run is executing normally. Currently on node build-node.");
    } finally {
      sqlite.close();
    }
  });

  test("multiple blockers include approval and signal blockers", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "multi-run", "waiting-approval", {
        startedAtMs: now - 20_000,
      });

      await adapter.insertNode({
        runId: "multi-run",
        nodeId: "approval-a",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 1,
        updatedAtMs: now - 15_000,
        outputTable: "multi_output",
        label: "Approval A",
      });
      await adapter.insertOrUpdateApproval({
        runId: "multi-run",
        nodeId: "approval-a",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 15_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
      });

      await adapter.insertNode({
        runId: "multi-run",
        nodeId: "await-signal-b",
        iteration: 0,
        state: "waiting-event",
        lastAttempt: 1,
        updatedAtMs: now - 12_000,
        outputTable: "multi_output",
        label: "Await signal B",
      });
      await insertFrame(
        adapter,
        "multi-run",
        workflowFrame([
          {
            kind: "element",
            tag: "smithers:wait-for-event",
            props: { id: "await-signal-b", event: "pipeline.ready" },
            children: [],
          },
        ]),
      );

      const result = runSmithers(["why", "multi-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("approval-a");
      expect(result.stdout).toContain("await-signal-b");
      expect(result.stdout).toContain("smithers approve multi-run");
      expect(result.stdout).toContain("smithers signal multi-run pipeline.ready --data '{}'");
    } finally {
      sqlite.close();
    }
  });

  test("--json output returns structured diagnosis payload", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "json-run", "waiting-approval", {
        startedAtMs: now - 25_000,
      });
      await adapter.insertNode({
        runId: "json-run",
        nodeId: "review-json",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 1,
        updatedAtMs: now - 20_000,
        outputTable: "json_output",
        label: "Review JSON",
      });
      await adapter.insertOrUpdateApproval({
        runId: "json-run",
        nodeId: "review-json",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 20_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
      });

      const result = runSmithers(["why", "json-run", "--json"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as any;
      expect(parsed.status).toBe("waiting-approval");
      expect(Array.isArray(parsed.blockers)).toBe(true);
      expect(parsed.blockers[0]?.nodeId).toBe("review-json");
      expect(typeof parsed.blockers[0]?.reason).toBe("string");
      expect(typeof parsed.blockers[0]?.unblocker).toBe("string");
      expect(typeof parsed.blockers[0]?.waitingSince).toBe("number");
    } finally {
      sqlite.close();
    }
  });

  test("non-existent run returns exit code 4 and not-found message", async () => {
    const repo = createTempRepo();
    const { sqlite } = openRepoDb(repo);

    try {
      const result = runSmithers(["why", "bad-id"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(4);
      expect(result.stdout).toContain("Run not found: bad-id");
    } finally {
      sqlite.close();
    }
  });

  test("schema validation retry loop reports schema error and automatic retry", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "schema-run", "waiting-approval", {
        startedAtMs: now - 20_000,
      });
      await adapter.insertNode({
        runId: "schema-run",
        nodeId: "quality-gate",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 2,
        updatedAtMs: now - 10_000,
        outputTable: "schema_output",
        label: "Quality gate",
      });
      await adapter.insertOrUpdateApproval({
        runId: "schema-run",
        nodeId: "quality-gate",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 10_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
      });

      await adapter.insertAttempt({
        runId: "schema-run",
        nodeId: "quality-gate",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: now - 18_000,
        finishedAtMs: now - 17_000,
        errorJson: JSON.stringify({
          name: "SchemaValidationError",
          message: "output.score must be number",
        }),
        metaJson: JSON.stringify({
          retries: 2,
          retryPolicy: { backoff: "fixed", initialDelayMs: 4_000 },
        }),
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: repo.dir,
      });
      await adapter.insertAttempt({
        runId: "schema-run",
        nodeId: "quality-gate",
        iteration: 0,
        attempt: 2,
        state: "failed",
        startedAtMs: now - 16_000,
        finishedAtMs: now - 15_000,
        errorJson: JSON.stringify({
          name: "SchemaValidationError",
          message: "output.score must be >= 0",
        }),
        metaJson: JSON.stringify({
          retries: 2,
          retryPolicy: { backoff: "fixed", initialDelayMs: 4_000 },
        }),
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: repo.dir,
      });

      const result = runSmithers(["why", "schema-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SchemaValidationError: output.score must be >= 0");
      expect(result.stdout).toContain("Retrying automatically");
    } finally {
      sqlite.close();
    }
  });

  test("cancelled run reports cancelled time", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);

    try {
      await insertRun(adapter, "cancelled-run", "cancelled", {
        finishedAtMs: Date.now() - 5_000,
      });

      const result = runSmithers(["why", "cancelled-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run was cancelled at");
      expect(result.stdout).not.toContain("nothing is blocked");
    } finally {
      sqlite.close();
    }
  });

  test("node blocked by upstream failed dependency is diagnosed", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    const now = Date.now();

    try {
      await insertRun(adapter, "dep-run", "failed", {
        finishedAtMs: now - 1_000,
      });
      await adapter.insertNode({
        runId: "dep-run",
        nodeId: "node-a",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: now - 6_000,
        outputTable: "dep_output",
        label: "Node A",
      });
      await adapter.insertNode({
        runId: "dep-run",
        nodeId: "node-b",
        iteration: 0,
        state: "pending",
        lastAttempt: null,
        updatedAtMs: now - 4_000,
        outputTable: "dep_output",
        label: "Node B",
      });
      await adapter.insertAttempt({
        runId: "dep-run",
        nodeId: "node-a",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: now - 8_000,
        finishedAtMs: now - 7_000,
        errorJson: JSON.stringify({ message: "upstream exploded" }),
        metaJson: JSON.stringify({ retries: 0 }),
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: repo.dir,
      });
      await insertFrame(
        adapter,
        "dep-run",
        workflowFrame([
          {
            kind: "element",
            tag: "smithers:task",
            props: { id: "node-a" },
            children: [],
          },
          {
            kind: "element",
            tag: "smithers:task",
            props: { id: "node-b", dependsOn: "[\"node-a\"]" },
            children: [],
          },
        ]),
      );

      const result = runSmithers(["why", "dep-run"], {
        cwd: repo.dir,
        format: null,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Node node-b is blocked because dependency node-a failed.");
    } finally {
      sqlite.close();
    }
  });
});
