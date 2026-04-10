import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb, type HumanRequestRow } from "../src/db/adapter";
import { ensureSmithersTables } from "../src/db/ensure";
import { buildHumanRequestId } from "../src/human-requests";
import { createTempRepo, runSmithers } from "./e2e-helpers";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    sqlite,
    adapter: new SmithersDb(db),
  };
}

function openRepoDb(repo: ReturnType<typeof createTempRepo>) {
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db as any);
  return {
    sqlite,
    adapter: new SmithersDb(db as any),
  };
}

function humanRequestRow(
  overrides: Partial<HumanRequestRow> = {},
): HumanRequestRow {
  const now = Date.now();
  return {
    requestId: buildHumanRequestId("run-1", "human-review", 0),
    runId: "run-1",
    nodeId: "human-review",
    iteration: 0,
    kind: "json",
    status: "pending",
    prompt: "Provide review metadata as JSON.",
    schemaJson: '{"type":"object"}',
    optionsJson: null,
    responseJson: null,
    requestedAtMs: now - 1_000,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: now + 60_000,
    ...overrides,
  };
}

describe("human request persistence", () => {
  test("insertHumanRequest and getHumanRequest round-trip", async () => {
    const { sqlite, adapter } = createAdapter();

    try {
      const row = humanRequestRow();
      await adapter.insertHumanRequest(row);

      const request = await adapter.getHumanRequest(row.requestId);
      expect(request).toEqual(row);
    } finally {
      sqlite.close();
    }
  });

  test("listPendingHumanRequests returns only pending requests in age order", async () => {
    const { sqlite, adapter } = createAdapter();

    try {
      const now = Date.now();
      await adapter.insertRun({
        runId: "run-1",
        workflowName: "human-flow",
        status: "waiting-approval",
        createdAtMs: 1_000,
      });
      await adapter.insertNode({
        runId: "run-1",
        nodeId: "human-review",
        iteration: 0,
        state: "waiting-approval",
        updatedAtMs: 1_000,
        outputTable: "review_output",
        label: "Human Review",
      });
      await adapter.insertRun({
        runId: "run-2",
        workflowName: "human-flow",
        status: "waiting-approval",
        createdAtMs: 2_000,
      });

      await adapter.insertHumanRequest(
        humanRequestRow({
          requestId: buildHumanRequestId("run-2", "human-review", 0),
          runId: "run-2",
          requestedAtMs: now - 1_000,
          timeoutAtMs: now + 60_000,
          prompt: "Second request",
        }),
      );
      await adapter.insertHumanRequest(
        humanRequestRow({
          requestedAtMs: now - 2_000,
          timeoutAtMs: now + 60_000,
        }),
      );
      await adapter.insertHumanRequest(
        humanRequestRow({
          requestId: buildHumanRequestId("run-3", "human-review", 0),
          runId: "run-3",
          status: "answered",
          responseJson: '{"approved":true}',
          answeredAtMs: 3_000,
        }),
      );

      const requests = await adapter.listPendingHumanRequests(now);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.requestId).toBe(buildHumanRequestId("run-1", "human-review", 0));
      expect(requests[0]?.workflowName).toBe("human-flow");
      expect(requests[0]?.nodeLabel).toBe("Human Review");
      expect(requests[1]?.requestId).toBe(buildHumanRequestId("run-2", "human-review", 0));
    } finally {
      sqlite.close();
    }
  });

  test("answerHumanRequest and cancelHumanRequest update request status", async () => {
    const { sqlite, adapter } = createAdapter();

    try {
      const answerId = buildHumanRequestId("run-answer", "human-review", 0);
      const cancelId = buildHumanRequestId("run-cancel", "human-review", 0);

      await adapter.insertHumanRequest(
        humanRequestRow({
          requestId: answerId,
          runId: "run-answer",
        }),
      );
      await adapter.insertHumanRequest(
        humanRequestRow({
          requestId: cancelId,
          runId: "run-cancel",
        }),
      );

      await adapter.answerHumanRequest(
        answerId,
        '{"approved":true}',
        5_000,
        "operator:alice",
      );
      await adapter.cancelHumanRequest(cancelId);

      const answered = await adapter.getHumanRequest(answerId);
      const cancelled = await adapter.getHumanRequest(cancelId);

      expect(answered?.status).toBe("answered");
      expect(answered?.responseJson).toBe('{"approved":true}');
      expect(answered?.answeredAtMs).toBe(5_000);
      expect(answered?.answeredBy).toBe("operator:alice");
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.responseJson).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

test("smithers human inbox lists pending requests", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);

  try {
    await adapter.insertRun({
      runId: "human-run",
      workflowName: "human-cli",
      status: "waiting-approval",
      createdAtMs: 1_000,
    });
    await adapter.insertNode({
      runId: "human-run",
      nodeId: "review",
      iteration: 0,
      state: "waiting-approval",
      updatedAtMs: 1_000,
      outputTable: "review_output",
      label: "Review",
    });
    await adapter.insertHumanRequest(
      humanRequestRow({
        requestId: buildHumanRequestId("human-run", "review", 0),
        runId: "human-run",
        nodeId: "review",
        prompt: "Review the release checklist as JSON.",
        requestedAtMs: Date.now() - 5_000,
      }),
    );
    await adapter.insertHumanRequest(
      humanRequestRow({
        requestId: buildHumanRequestId("human-run", "answered", 0),
        runId: "human-run",
        nodeId: "answered",
        status: "answered",
        responseJson: '{"done":true}',
        answeredAtMs: Date.now(),
      }),
    );

    const humanResult = runSmithers(["human", "inbox"], {
      cwd: repo.dir,
      format: null,
    });
    expect(humanResult.exitCode).toBe(0);
    expect(humanResult.stdout).toContain("Review the release checklist as JSON.");
    expect(humanResult.stdout).toContain("kind: json");
    expect(humanResult.stdout).toContain("run: human-run");
    expect(humanResult.stdout).not.toContain("answered");

    const jsonResult = runSmithers(["human", "inbox"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(jsonResult.exitCode).toBe(0);
    const payload = jsonResult.json as { requests?: Array<Record<string, unknown>> };
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests?.[0]?.requestId).toBe(buildHumanRequestId("human-run", "review", 0));
    expect(payload.requests?.[0]?.prompt).toBe("Review the release checklist as JSON.");
    expect(payload.requests?.[0]?.kind).toBe("json");
  } finally {
    sqlite.close();
  }
});
