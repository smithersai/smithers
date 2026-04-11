import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "../src/adapter";
import { ensureSmithersTables } from "../src/ensure";
import { toSmithersError } from "@smithers/core/errors";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

async function insertRun(adapter: SmithersDb, runId: string) {
  await adapter.insertRun({
    runId,
    workflowName: "txn-test",
    workflowHash: "hash",
    status: "running",
    createdAtMs: Date.now(),
  });
}

describe("SmithersDb transactions", () => {
  test("commits grouped writes atomically", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "txn-commit";
      await insertRun(adapter, runId);

      await adapter.withTransaction(
        "test-commit",
        Effect.gen(function* () {
          yield* adapter.insertAttemptEffect({
            runId,
            nodeId: "node-a",
            iteration: 0,
            attempt: 1,
            state: "in-progress",
            startedAtMs: Date.now(),
            finishedAtMs: null,
            heartbeatAtMs: null,
            heartbeatDataJson: null,
            errorJson: null,
            jjPointer: null,
            jjCwd: null,
            cached: false,
            metaJson: null,
          });
          yield* adapter.insertNodeEffect({
            runId,
            nodeId: "node-a",
            iteration: 0,
            state: "in-progress",
            lastAttempt: 1,
            updatedAtMs: Date.now(),
            outputTable: "output_a",
            label: "Node A",
          });
        }),
      );

      const attempt = await adapter.getAttempt(runId, "node-a", 0, 1);
      const node = await adapter.getNode(runId, "node-a", 0);
      expect(attempt?.state).toBe("in-progress");
      expect(node?.state).toBe("in-progress");
      expect(node?.outputTable).toBe("output_a");
      expect(node?.label).toBe("Node A");
    } finally {
      sqlite.close();
    }
  });

  test("rolls back grouped writes when one step fails", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "txn-rollback";
      await insertRun(adapter, runId);

      await expect(
        adapter.withTransaction(
          "test-rollback",
          Effect.gen(function* () {
            yield* adapter.insertAttemptEffect({
              runId,
              nodeId: "node-a",
              iteration: 0,
              attempt: 1,
              state: "in-progress",
              startedAtMs: Date.now(),
              finishedAtMs: null,
              heartbeatAtMs: null,
              heartbeatDataJson: null,
              errorJson: null,
              jjPointer: null,
              jjCwd: null,
              cached: false,
              metaJson: null,
            });
            yield* Effect.fail(
              toSmithersError(new Error("boom"), "test rollback", {
                code: "DB_WRITE_FAILED",
              }),
            );
          }),
        ),
      ).rejects.toThrow("boom");

      const attempt = await adapter.getAttempt(runId, "node-a", 0, 1);
      const node = await adapter.getNode(runId, "node-a", 0);
      expect(attempt).toBeUndefined();
      expect(node).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("does not leak unrelated writes into an active transaction", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "txn-isolation";
      await insertRun(adapter, runId);

      const transaction = adapter.withTransaction(
        "test-isolation",
        Effect.gen(function* () {
          yield* adapter.insertAttemptEffect({
            runId,
            nodeId: "inside",
            iteration: 0,
            attempt: 1,
            state: "in-progress",
            startedAtMs: Date.now(),
            finishedAtMs: null,
            heartbeatAtMs: null,
            heartbeatDataJson: null,
            errorJson: null,
            jjPointer: null,
            jjCwd: null,
            cached: false,
            metaJson: null,
          });
          yield* Effect.tryPromise({
            try: () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
            catch: (cause) =>
              toSmithersError(cause, "test isolation sleep", {
                code: "DB_WRITE_FAILED",
              }),
          });
          yield* Effect.fail(
            toSmithersError(new Error("isolation boom"), "test isolation", {
              code: "DB_WRITE_FAILED",
            }),
          );
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      await adapter.insertNode({
        runId,
        nodeId: "outside",
        iteration: 0,
        state: "pending",
        lastAttempt: null,
        updatedAtMs: Date.now(),
        outputTable: "output_a",
        label: null,
      });

      await expect(transaction).rejects.toThrow("isolation boom");

      const insideAttempt = await adapter.getAttempt(runId, "inside", 0, 1);
      const outsideNode = await adapter.getNode(runId, "outside", 0);
      expect(insideAttempt).toBeUndefined();
      expect(outsideNode?.state).toBe("pending");
    } finally {
      sqlite.close();
    }
  });

  test("rolls back and retries when COMMIT fails", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "txn-commit-retry";
      await insertRun(adapter, runId);

      const dbClient = (adapter as any).db;
      const client = dbClient.session?.client ?? dbClient.$client;
      const originalRun = client.run.bind(client);
      let commitFailures = 0;

      client.run = (statement: string, ...args: any[]) => {
        if (statement === "COMMIT" && commitFailures === 0) {
          commitFailures += 1;
          const error: any = new Error("database is busy");
          error.code = "SQLITE_BUSY";
          throw error;
        }
        return originalRun(statement, ...args);
      };

      try {
        await adapter.withTransaction(
          "test-commit-retry",
          Effect.gen(function* () {
            yield* adapter.insertAttemptEffect({
              runId,
              nodeId: "node-a",
              iteration: 0,
              attempt: 1,
              state: "in-progress",
              startedAtMs: Date.now(),
              finishedAtMs: null,
              heartbeatAtMs: null,
              heartbeatDataJson: null,
              errorJson: null,
              jjPointer: null,
              jjCwd: null,
              cached: false,
              metaJson: null,
            });
            yield* adapter.insertNodeEffect({
              runId,
              nodeId: "node-a",
              iteration: 0,
              state: "in-progress",
              lastAttempt: 1,
              updatedAtMs: Date.now(),
              outputTable: "output_a",
              label: "Node A",
            });
          }),
        );
      } finally {
        client.run = originalRun;
      }

      expect(commitFailures).toBe(1);
      const attempt = await adapter.getAttempt(runId, "node-a", 0, 1);
      const node = await adapter.getNode(runId, "node-a", 0);
      expect(attempt?.state).toBe("in-progress");
      expect(node?.state).toBe("in-progress");

      await expect(
        adapter.withTransaction("post-commit-retry", Effect.void),
      ).resolves.toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("gates reads until active transactions complete", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "txn-read-gating";
      await insertRun(adapter, runId);

      const transaction = adapter.withTransaction(
        "test-read-gating",
        Effect.gen(function* () {
          yield* adapter.insertAttemptEffect({
            runId,
            nodeId: "inside",
            iteration: 0,
            attempt: 1,
            state: "in-progress",
            startedAtMs: Date.now(),
            finishedAtMs: null,
            heartbeatAtMs: null,
            heartbeatDataJson: null,
            errorJson: null,
            jjPointer: null,
            jjCwd: null,
            cached: false,
            metaJson: null,
          });
          yield* Effect.tryPromise({
            try: () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
            catch: (cause) =>
              toSmithersError(cause, "test read gating delay", {
                code: "DB_WRITE_FAILED",
              }),
          });
          yield* Effect.fail(
            toSmithersError(new Error("read gating boom"), "test read gating", {
              code: "DB_WRITE_FAILED",
            }),
          );
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      const readStartedAt = performance.now();
      const readPromise = adapter.getAttempt(runId, "inside", 0, 1);

      await expect(transaction).rejects.toThrow("read gating boom");
      const attempt = await readPromise;
      const readElapsedMs = performance.now() - readStartedAt;

      expect(attempt).toBeUndefined();
      expect(readElapsedMs).toBeGreaterThanOrEqual(35);
    } finally {
      sqlite.close();
    }
  });

  test("fails fast on nested transactions", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await expect(
        adapter.withTransaction(
          "outer",
          Effect.gen(function* () {
            yield* adapter.withTransactionEffect("inner", Effect.void);
          }),
        ),
      ).rejects.toThrow("Nested sqlite transactions are not supported");
    } finally {
      sqlite.close();
    }
  });
});
