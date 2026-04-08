import { Effect, Metric } from "effect";
import { nowMs } from "../utils/time";
import { SmithersDb } from "../db/adapter";
import { runPromise } from "../effect/runtime";
import { approvalWaitDuration, trackEvent } from "../effect/metrics";
import { bridgeApprovalResolve } from "../effect/deferred-bridge";

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

export function approveNodeEffect(
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
    const existing = yield* adapter.getApprovalEffect(runId, nodeId, iteration);
    yield* adapter.withTransactionEffect(
      "approval",
      Effect.gen(function* () {
        const existingNode = yield* adapter.getNodeEffect(runId, nodeId, iteration);
        yield* adapter.insertOrUpdateApprovalEffect({
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
        yield* adapter.insertNodeEffect({
          runId,
          nodeId,
          iteration,
          state: "pending",
          lastAttempt: existingNode?.lastAttempt ?? null,
          updatedAtMs: nowMs(),
          outputTable: existingNode?.outputTable ?? "",
          label: existingNode?.label ?? null,
        });

        const run = yield* adapter.getRunEffect(runId);
        if (run) {
          const pending = yield* adapter.listPendingApprovalsEffect(runId);
          const nextStatus = nextRunStatusForApproval(run.status, pending.length);
          if (nextStatus && run.status !== nextStatus) {
            yield* adapter.updateRunEffect(runId, { status: nextStatus });
          }
        }
      }),
    );
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    yield* adapter.insertEventWithNextSeqEffect({
      runId,
      timestampMs: ts,
      type: event.type,
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* Effect.logInfo(autoApproved ? "approval auto-approved" : "approval granted");
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

export async function approveNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
  decision?: unknown,
) {
  await runPromise(
    approveNodeEffect(adapter, runId, nodeId, iteration, note, decidedBy, decision),
  );
  bridgeApprovalResolve(runId, nodeId, iteration, { approved: true });
}

export function denyNodeEffect(
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
    const existing = yield* adapter.getApprovalEffect(runId, nodeId, iteration);
    yield* adapter.withTransactionEffect(
      "approval",
      Effect.gen(function* () {
        const existingNode = yield* adapter.getNodeEffect(runId, nodeId, iteration);
        yield* adapter.insertOrUpdateApprovalEffect({
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
        yield* adapter.insertNodeEffect({
          runId,
          nodeId,
          iteration,
          state: "failed",
          lastAttempt: existingNode?.lastAttempt ?? null,
          updatedAtMs: nowMs(),
          outputTable: existingNode?.outputTable ?? "",
          label: existingNode?.label ?? null,
        });

        const run = yield* adapter.getRunEffect(runId);
        if (run) {
          const pending = yield* adapter.listPendingApprovalsEffect(runId);
          const nextStatus = nextRunStatusForApproval(run.status, pending.length);
          if (nextStatus && run.status !== nextStatus) {
            yield* adapter.updateRunEffect(runId, { status: nextStatus });
          }
        }
      }),
    );
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    yield* adapter.insertEventWithNextSeqEffect({
      runId,
      timestampMs: ts,
      type: "ApprovalDenied",
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* Effect.logInfo("approval denied");
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

export async function denyNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
  decision?: unknown,
) {
  await runPromise(
    denyNodeEffect(adapter, runId, nodeId, iteration, note, decidedBy, decision),
  );
  bridgeApprovalResolve(runId, nodeId, iteration, { approved: false });
}

export async function autoApproveNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  options?: {
    note?: string;
    decidedBy?: string;
    decision?: unknown;
  },
) {
  await runPromise(
    approveNodeEffect(
      adapter,
      runId,
      nodeId,
      iteration,
      options?.note,
      options?.decidedBy ?? "smithers:auto",
      options?.decision,
      true,
    ),
  );
  bridgeApprovalResolve(runId, nodeId, iteration, { approved: true });
}
