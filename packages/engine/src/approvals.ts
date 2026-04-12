import { Effect, Metric } from "effect";
import { nowMs } from "@smithers/scheduler/nowMs";
import { SmithersDb } from "@smithers/db/adapter";
import {
  approvalWaitDuration,
  trackEvent,
  updateAsyncExternalWaitPending,
} from "@smithers/observability/metrics";
import { bridgeApprovalResolve } from "./effect/durable-deferred-bridge";
import { SmithersError } from "@smithers/errors/SmithersError";

function nextRunStatusForApproval(
  currentStatus: string | null | undefined,
  pendingApprovals: number,
): "waiting-approval" | "waiting-event" | null {
  if (
    currentStatus !== "waiting-approval" &&
    currentStatus !== "waiting-event"
  ) {
    return null;
  }
  return pendingApprovals > 0 ? "waiting-approval" : "waiting-event";
}

function serializeDecision(decision: unknown) {
  return decision === undefined ? null : JSON.stringify(decision);
}

function isAsyncApprovalRequest(requestJson?: string | null) {
  if (!requestJson) return false;
  try {
    return JSON.parse(requestJson)?.waitAsync === true;
  } catch {
    return false;
  }
}


function validateNodeWaitingForApproval(
  runId: string,
  nodeId: string,
  iteration: number,
  state: string | null | undefined,
): Effect.Effect<void, SmithersError> {
  if (state === "waiting-approval" || state === "waiting_approval") {
    return Effect.void;
  }
  return Effect.fail(
    new SmithersError(
      "INVALID_INPUT",
      `Node ${nodeId} is not waiting for approval.`,
      { runId, nodeId, iteration, state: state ?? null },
    ),
  );
}

export function approveNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
  decision?: unknown,
  autoApproved = false,
) {
  const ts = nowMs();
  const event = {
    type: autoApproved ? ("ApprovalAutoApproved" as const) : ("ApprovalGranted" as const),
    runId,
    nodeId,
    iteration,
    timestampMs: ts,
  };
  return Effect.gen(function* () {
    const existing = yield* adapter.getApproval(runId, nodeId, iteration);
    const currentNode = yield* adapter.getNode(runId, nodeId, iteration);
    yield* validateNodeWaitingForApproval(runId, nodeId, iteration, currentNode?.state);
    yield* adapter.withTransactionEffect(
      "approval",
      Effect.gen(function* () {
        yield* adapter.insertOrUpdateApproval({
          runId,
          nodeId,
          iteration,
          status: "approved",
          requestedAtMs: null,
          decidedAtMs: ts,
          note: note ?? null,
          decidedBy: decidedBy ?? null,
          requestJson: existing?.requestJson ?? null,
          decisionJson: serializeDecision(decision) ?? existing?.decisionJson ?? null,
          autoApproved,
        });
        yield* adapter.insertNode({
          runId,
          nodeId,
          iteration,
          state: "pending",
          lastAttempt: currentNode?.lastAttempt ?? null,
          updatedAtMs: nowMs(),
          outputTable: currentNode?.outputTable ?? "",
          label: currentNode?.label ?? null,
        });

        const run = yield* adapter.getRun(runId);
        if (run) {
          const pending = yield* adapter.listPendingApprovals(runId);
          const nextStatus = nextRunStatusForApproval(run.status, pending.length);
          if (nextStatus && run.status !== nextStatus) {
            yield* adapter.updateRun(runId, { status: nextStatus });
          }
        }
      }),
    );
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    if (existing?.status === "requested" && isAsyncApprovalRequest(existing.requestJson)) {
      yield* updateAsyncExternalWaitPending("approval", -1);
    }
    yield* adapter.insertEventWithNextSeq({
      runId,
      timestampMs: ts,
      type: event.type,
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* Effect.logInfo(autoApproved ? "approval auto-approved" : "approval granted");
    yield* Effect.promise(() =>
      bridgeApprovalResolve(adapter, runId, nodeId, iteration, {
        approved: true,
        note: note ?? null,
        decidedBy: decidedBy ?? null,
        decisionJson: serializeDecision(decision),
        autoApproved,
      }),
    );
  }).pipe(
    Effect.annotateLogs({
      runId,
      nodeId,
      iteration,
      approvalStatus: autoApproved ? "auto-approved" : "approved",
      approvalDecidedBy: decidedBy ?? null,
    }),
    Effect.withLogSpan("approval:grant"),
  );
}

export function denyNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
  decision?: unknown,
) {
  const ts = nowMs();
  const event = {
    type: "ApprovalDenied" as const,
    runId,
    nodeId,
    iteration,
    timestampMs: ts,
  };
  return Effect.gen(function* () {
    const existing = yield* adapter.getApproval(runId, nodeId, iteration);
    const currentNode = yield* adapter.getNode(runId, nodeId, iteration);
    yield* validateNodeWaitingForApproval(runId, nodeId, iteration, currentNode?.state);
    yield* adapter.withTransactionEffect(
      "approval",
      Effect.gen(function* () {
        yield* adapter.insertOrUpdateApproval({
          runId,
          nodeId,
          iteration,
          status: "denied",
          requestedAtMs: null,
          decidedAtMs: ts,
          note: note ?? null,
          decidedBy: decidedBy ?? null,
          requestJson: existing?.requestJson ?? null,
          decisionJson: serializeDecision(decision) ?? existing?.decisionJson ?? null,
          autoApproved: false,
        });
        yield* adapter.insertNode({
          runId,
          nodeId,
          iteration,
          state: "failed",
          lastAttempt: currentNode?.lastAttempt ?? null,
          updatedAtMs: nowMs(),
          outputTable: currentNode?.outputTable ?? "",
          label: currentNode?.label ?? null,
        });

        const run = yield* adapter.getRun(runId);
        if (run) {
          const pending = yield* adapter.listPendingApprovals(runId);
          const nextStatus = nextRunStatusForApproval(run.status, pending.length);
          if (nextStatus && run.status !== nextStatus) {
            yield* adapter.updateRun(runId, { status: nextStatus });
          }
        }
      }),
    );
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    if (existing?.status === "requested" && isAsyncApprovalRequest(existing.requestJson)) {
      yield* updateAsyncExternalWaitPending("approval", -1);
    }
    yield* adapter.insertEventWithNextSeq({
      runId,
      timestampMs: ts,
      type: "ApprovalDenied",
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* Effect.logInfo("approval denied");
    yield* Effect.promise(() =>
      bridgeApprovalResolve(adapter, runId, nodeId, iteration, {
        approved: false,
        note: note ?? null,
        decidedBy: decidedBy ?? null,
        decisionJson: serializeDecision(decision),
      }),
    );
  }).pipe(
    Effect.annotateLogs({
      runId,
      nodeId,
      iteration,
      approvalStatus: "denied",
      approvalDecidedBy: decidedBy ?? null,
    }),
    Effect.withLogSpan("approval:deny"),
  );
}
