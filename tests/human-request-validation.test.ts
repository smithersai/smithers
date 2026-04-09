import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { SmithersDb, type HumanRequestRow } from "../src/db/adapter";
import { ensureSmithersTables } from "../src/db/ensure";
import { resolveDeferredTaskStateBridge } from "../src/effect/deferred-state-bridge";
import {
  buildHumanRequestId,
  isHumanRequestPastTimeout,
  validateHumanRequestValue,
} from "../src/human-requests";
import type { TaskDescriptor } from "../src/TaskDescriptor";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";
import { zodToTable } from "../src/zodToTable";

function createRepoDb(schema: z.ZodObject<any>, tableName = "review") {
  const sqlite = new Database(":memory:");
  sqlite.exec(zodToCreateTableSQL(tableName, schema));
  const db = drizzle(sqlite);
  ensureSmithersTables(db as any);
  return {
    sqlite,
    db,
    adapter: new SmithersDb(db as any),
    outputTable: zodToTable(tableName, schema),
  };
}

function insertRun(adapter: SmithersDb, runId: string) {
  return adapter.insertRun({
    runId,
    workflowName: "human-validation",
    workflowHash: "workflow-hash",
    status: "running",
    createdAtMs: Date.now(),
  });
}

function makeHumanDescriptor(
  outputTable: any,
  outputSchema: z.ZodObject<any>,
  overrides: Partial<TaskDescriptor> = {},
): TaskDescriptor {
  return {
    nodeId: "review",
    ordinal: 0,
    iteration: 0,
    outputTable,
    outputTableName: outputTable._?.name ?? "review",
    outputSchema,
    needsApproval: true,
    approvalMode: "decision",
    approvalOnDeny: "fail",
    skipIf: false,
    retries: 2,
    timeoutMs: 60_000,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    label: "Human Review",
    meta: {
      humanTask: true,
      prompt: "Review the change and respond with JSON.",
      maxAttempts: 3,
    },
    ...overrides,
  };
}

function buildHumanRequestRow(
  schema: z.ZodObject<any>,
  overrides: Partial<HumanRequestRow> = {},
): HumanRequestRow {
  return {
    requestId: buildHumanRequestId("run-1", "review", 0),
    runId: "run-1",
    nodeId: "review",
    iteration: 0,
    kind: "json",
    status: "pending",
    prompt: "Review the change and respond with JSON.",
    schemaJson: JSON.stringify(z.toJSONSchema(schema)),
    optionsJson: null,
    responseJson: null,
    requestedAtMs: 1_000,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: 61_000,
    ...overrides,
  };
}

async function seedAnsweredHumanFailure(
  adapter: SmithersDb,
  row: HumanRequestRow,
  errorCode: "HUMAN_TASK_INVALID_JSON" | "HUMAN_TASK_VALIDATION_FAILED",
) {
  await insertRun(adapter, row.runId);
  await adapter.insertOrUpdateApproval({
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    status: "approved",
    requestedAtMs: row.requestedAtMs,
    decidedAtMs: row.answeredAtMs,
    note: row.responseJson,
    decidedBy: row.answeredBy,
    requestJson: JSON.stringify({ mode: "decision" }),
    decisionJson: null,
    autoApproved: false,
  });
  await adapter.insertHumanRequest(row);
  await adapter.insertAttempt({
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    attempt: 1,
    state: "failed",
    startedAtMs: (row.answeredAtMs ?? 2_000) + 10,
    finishedAtMs: (row.answeredAtMs ?? 2_000) + 20,
    heartbeatAtMs: null,
    heartbeatDataJson: null,
    errorJson: JSON.stringify({
      code: errorCode,
      message: `${errorCode} for test`,
    }),
    jjPointer: null,
    jjCwd: null,
    cached: false,
    metaJson: null,
    responseText: null,
  });
}

const noopEventBus = {
  emitEventWithPersist: async () => {},
} as any;

describe("human request validation and expiry", () => {
  test("invalid JSON failures reopen answered requests so they can be corrected", async () => {
    const reviewSchema = z.object({ approved: z.boolean() });
    const { sqlite, db, adapter, outputTable } = createRepoDb(reviewSchema);

    try {
      const requestId = buildHumanRequestId("run-1", "review", 0);
      const desc = makeHumanDescriptor(outputTable, reviewSchema);
      await seedAnsweredHumanFailure(
        adapter,
        buildHumanRequestRow(reviewSchema, {
          requestId,
          status: "answered",
          responseJson: "not-json",
          answeredAtMs: 2_000,
          answeredBy: "qa:alice",
        }),
        "HUMAN_TASK_INVALID_JSON",
      );

      const bridgeResult = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        "run-1",
        desc,
        noopEventBus,
      );

      expect(bridgeResult).toEqual({
        handled: true,
        state: "waiting-approval",
      });

      const reopened = await adapter.getHumanRequest(requestId);
      expect(reopened?.status).toBe("pending");
      expect(reopened?.responseJson).toBeNull();
      expect(reopened?.answeredAtMs).toBeNull();
      expect(reopened?.answeredBy).toBeNull();

      const corrected = validateHumanRequestValue(reopened!, {
        approved: true,
      });
      expect(corrected).toEqual({ ok: true });
    } finally {
      sqlite.close();
    }
  });

  test("schema validation failures reopen requests and reject bad corrections", async () => {
    const reviewSchema = z.object({ approved: z.boolean() });
    const { sqlite, db, adapter, outputTable } = createRepoDb(reviewSchema);

    try {
      const requestId = buildHumanRequestId("run-1", "review", 0);
      const desc = makeHumanDescriptor(outputTable, reviewSchema);
      await seedAnsweredHumanFailure(
        adapter,
        buildHumanRequestRow(reviewSchema, {
          requestId,
          status: "answered",
          responseJson: '{"approved":"yes"}',
          answeredAtMs: 2_000,
          answeredBy: "qa:bob",
        }),
        "HUMAN_TASK_VALIDATION_FAILED",
      );

      const bridgeResult = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        "run-1",
        desc,
        noopEventBus,
      );

      expect(bridgeResult).toEqual({
        handled: true,
        state: "waiting-approval",
      });

      const reopened = await adapter.getHumanRequest(requestId);
      expect(reopened?.status).toBe("pending");
      expect(reopened?.responseJson).toBeNull();

      const invalidCorrection = validateHumanRequestValue(reopened!, {
        approved: "yes",
      });
      expect(invalidCorrection.ok).toBe(false);
      if (!invalidCorrection.ok) {
        expect(invalidCorrection.code).toBe("HUMAN_REQUEST_VALIDATION_FAILED");
        expect(invalidCorrection.message).toContain("does not match the stored schema");
      }

      const corrected = validateHumanRequestValue(reopened!, {
        approved: false,
      });
      expect(corrected).toEqual({ ok: true });
    } finally {
      sqlite.close();
    }
  });

  test("stale requests expire and drop out of pending queries", async () => {
    const reviewSchema = z.object({ approved: z.boolean() });
    const { sqlite, adapter } = createRepoDb(reviewSchema);

    try {
      const now = 50_000;
      const expiredId = buildHumanRequestId("run-expired", "review", 0);
      const freshId = buildHumanRequestId("run-fresh", "review", 0);

      await adapter.insertHumanRequest(
        buildHumanRequestRow(reviewSchema, {
          requestId: expiredId,
          runId: "run-expired",
          requestedAtMs: 1_000,
          timeoutAtMs: now - 1,
        }),
      );
      await adapter.insertHumanRequest(
        buildHumanRequestRow(reviewSchema, {
          requestId: freshId,
          runId: "run-fresh",
          requestedAtMs: 2_000,
          timeoutAtMs: now + 10_000,
        }),
      );

      expect(isHumanRequestPastTimeout({ timeoutAtMs: now - 1 }, now)).toBe(true);
      expect(isHumanRequestPastTimeout({ timeoutAtMs: now + 10_000 }, now)).toBe(false);

      const pending = await adapter.listPendingHumanRequests(now);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.requestId).toBe(freshId);

      const expired = await adapter.getHumanRequest(expiredId);
      expect(expired?.status).toBe("expired");
      expect(expired?.responseJson).toBeNull();
      expect(expired?.answeredAtMs).toBeNull();
      expect(expired?.answeredBy).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
