import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { EventBus } from "../src/events";
import { signalRun } from "../src/signals";
import {
  cancelPendingTimersBridge,
  resolveDeferredTaskStateBridge,
} from "../src/effect/workflow-bridge";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import { approvalDecisionSchema } from "@smithers/components/components/Approval";
import { createTestSmithers } from "../../smithers/tests/helpers";

function makeApprovalDescriptor(
  outputTable: any,
  overrides: Partial<TaskDescriptor> = {},
): TaskDescriptor {
  return {
    nodeId: "approval-gate",
    ordinal: 0,
    iteration: 0,
    outputTable,
    outputTableName: outputTable._?.name ?? "approval",
    outputSchema: approvalDecisionSchema,
    needsApproval: true,
    approvalMode: "decision",
    approvalOnDeny: "continue",
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    ...overrides,
  };
}

function makeTimerDescriptor(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    nodeId: "timer-gate",
    ordinal: 0,
    iteration: 0,
    outputTable: null,
    outputTableName: "",
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    meta: {
      __timer: true,
      __timerType: "duration",
      __timerDuration: "50ms",
    },
    ...overrides,
  };
}

function makeWaitForEventDescriptor(
  outputTable: any,
  overrides: Partial<TaskDescriptor> = {},
): TaskDescriptor {
  return {
    nodeId: "await-signal",
    ordinal: 0,
    iteration: 0,
    outputTable,
    outputTableName: outputTable._?.name ?? "event_output",
    outputSchema: z.object({ ok: z.boolean() }),
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    meta: {
      __waitForEvent: true,
      __eventName: "deploy.ready",
      __correlationId: "ticket-42",
      __onTimeout: "fail",
    },
    ...overrides,
  };
}

async function insertRun(adapter: SmithersDb, runId: string, workflowName: string) {
  await adapter.insertRun({
    runId,
    workflowName,
    workflowHash: "workflow-hash",
    status: "running",
    createdAtMs: Date.now(),
  });
}

describe("workflow bridge deferred contract", () => {
  test("requests approval and marks the node waiting", async () => {
    const { tables, db, cleanup } = createTestSmithers({
      approval: approvalDecisionSchema,
    });

    try {
      ensureSmithersTables(db as any);
      const adapter = new SmithersDb(db as any);
      const runId = "bridge-approval-request";
      await insertRun(adapter, runId, "bridge-approval-request");

      const eventBus = new EventBus({ db: adapter });
      const eventTypes: string[] = [];
      eventBus.on("event", (event: any) => {
        eventTypes.push(event.type);
      });

      const result = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        makeApprovalDescriptor(tables.approval),
        eventBus,
      );

      expect(result).toEqual({
        handled: true,
        state: "waiting-approval",
      });

      const approval = await adapter.getApproval(runId, "approval-gate", 0);
      expect(approval?.status).toBe("requested");

      const node = await adapter.getNode(runId, "approval-gate", 0);
      expect(node?.state).toBe("waiting-approval");
      expect(eventTypes).toEqual(["ApprovalRequested", "NodeWaitingApproval"]);
    } finally {
      cleanup();
    }
  });

  test("approved decisions fall through to task execution", async () => {
    const { tables, db, cleanup } = createTestSmithers({
      approval: approvalDecisionSchema,
    });

    try {
      ensureSmithersTables(db as any);
      const adapter = new SmithersDb(db as any);
      const runId = "bridge-approval-approved";
      await insertRun(adapter, runId, "bridge-approval-approved");
      await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "approval-gate",
        iteration: 0,
        status: "approved",
        requestedAtMs: null,
        decidedAtMs: Date.now(),
        note: null,
        decidedBy: null,
      });

      const result = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        makeApprovalDescriptor(tables.approval),
        new EventBus({ db: adapter }),
      );

      expect(result).toEqual({ handled: false });
      const node = await adapter.getNode(runId, "approval-gate", 0);
      expect(node).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("denied decisions with continue return the node to pending", async () => {
    const { tables, db, cleanup } = createTestSmithers({
      approval: approvalDecisionSchema,
    });

    try {
      ensureSmithersTables(db as any);
      const adapter = new SmithersDb(db as any);
      const runId = "bridge-approval-denied";
      await insertRun(adapter, runId, "bridge-approval-denied");
      await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "approval-gate",
        iteration: 0,
        status: "denied",
        requestedAtMs: null,
        decidedAtMs: Date.now(),
        note: "not yet",
        decidedBy: "qa",
      });

      const transitions: string[] = [];
      const result = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        makeApprovalDescriptor(tables.approval, {
          approvalOnDeny: "continue",
        }),
        new EventBus({ db: adapter }),
        async (state) => {
          transitions.push(state);
        },
      );

      expect(result).toEqual({
        handled: true,
        state: "pending",
      });
      expect(transitions).toEqual(["pending"]);

      const node = await adapter.getNode(runId, "approval-gate", 0);
      expect(node?.state).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("creates and later fires a timer", async () => {
    const { db, cleanup } = createTestSmithers({
      out: z.object({ value: z.number() }),
    });

    try {
      ensureSmithersTables(db as any);
      const adapter = new SmithersDb(db as any);
      const runId = "bridge-timer-fire";
      await insertRun(adapter, runId, "bridge-timer-fire");

      const eventBus = new EventBus({ db: adapter });
      const eventTypes: string[] = [];
      eventBus.on("event", (event: any) => {
        eventTypes.push(event.type);
      });

      const desc = makeTimerDescriptor();
      const first = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        desc,
        eventBus,
      );
      expect(first).toEqual({
        handled: true,
        state: "waiting-timer",
      });

      await Bun.sleep(90);

      const second = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        desc,
        eventBus,
      );
      expect(second).toEqual({
        handled: true,
        state: "finished",
      });

      const attempts = await adapter.listAttempts(runId, "timer-gate", 0);
      expect(attempts[0]?.state).toBe("finished");

      const node = await adapter.getNode(runId, "timer-gate", 0);
      expect(node?.state).toBe("finished");
      expect(eventTypes).toEqual([
        "TimerCreated",
        "NodeWaitingTimer",
        "TimerFired",
        "NodeFinished",
      ]);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("wait-for-event pauses until a matching signal is delivered", async () => {
    const eventSchema = z.object({ ok: z.boolean() });
    const { tables, db, cleanup } = createTestSmithers({
      eventOut: eventSchema,
    });

    try {
      ensureSmithersTables(db as any);
      const adapter = new SmithersDb(db as any);
      const runId = "bridge-wait-event";
      await insertRun(adapter, runId, "bridge-wait-event");

      const desc = makeWaitForEventDescriptor(tables.eventOut);
      const first = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        desc,
        new EventBus({ db: adapter }),
      );
      expect(first).toEqual({
        handled: true,
        state: "waiting-event",
      });

      const waitingAttempts = await adapter.listAttempts(runId, "await-signal", 0);
      expect(waitingAttempts[0]?.state).toBe("waiting-event");

      await signalRun(
        adapter,
        runId,
        "deploy.ready",
        { ok: true },
        { correlationId: "ticket-42", receivedBy: "tester" },
      );

      const second = await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        desc,
        new EventBus({ db: adapter }),
      );
      expect(second).toEqual({
        handled: true,
        state: "finished",
      });

      const outputRows = await (db as any).select().from(tables.eventOut);
      expect(outputRows).toEqual([
        expect.objectContaining({
          runId,
          nodeId: "await-signal",
          iteration: 0,
          ok: true,
        }),
      ]);
    } finally {
      cleanup();
    }
  });

  test("cancels pending timers through the bridge", async () => {
    const { db, cleanup } = createTestSmithers({
      out: z.object({ value: z.number() }),
    });

    try {
      ensureSmithersTables(db as any);
      const adapter = new SmithersDb(db as any);
      const runId = "bridge-timer-cancel";
      await insertRun(adapter, runId, "bridge-timer-cancel");

      const eventBus = new EventBus({ db: adapter });
      const eventTypes: string[] = [];
      eventBus.on("event", (event: any) => {
        eventTypes.push(event.type);
      });

      await resolveDeferredTaskStateBridge(
        adapter,
        db as any,
        runId,
        makeTimerDescriptor({
          meta: {
            __timer: true,
            __timerType: "duration",
            __timerDuration: "5s",
          },
        }),
        eventBus,
      );

      await cancelPendingTimersBridge(adapter, runId, eventBus, "test-cancel");

      const attempts = await adapter.listAttempts(runId, "timer-gate", 0);
      expect(attempts[0]?.state).toBe("cancelled");

      const node = await adapter.getNode(runId, "timer-gate", 0);
      expect(node?.state).toBe("cancelled");
      expect(eventTypes).toContain("TimerCancelled");
      expect(eventTypes).toContain("NodeCancelled");
    } finally {
      cleanup();
    }
  }, 30_000);
});
