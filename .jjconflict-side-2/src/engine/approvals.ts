import { Effect, Metric } from "effect";
import { nowMs } from "../utils/time";
import { SmithersDb } from "../db/adapter";
import { runPromise } from "../effect/runtime";
import { approvalWaitDuration, trackEvent } from "../effect/metrics";

export function approveNodeEffect(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
) {
  const ts = nowMs();
  const event = {
    type: "ApprovalGranted" as const,
    runId,
    nodeId,
    iteration,
    timestampMs: ts,
  };
  return Effect.gen(function* () {
    const existing = yield* adapter.getApprovalEffect(runId, nodeId, iteration);
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    yield* adapter.insertOrUpdateApprovalEffect({
      runId,
      nodeId,
      iteration,
      status: "approved",
      requestedAtMs: null,
      decidedAtMs: ts,
      note: note ?? null,
      decidedBy: decidedBy ?? null,
    });
    yield* adapter.insertEventWithNextSeqEffect({
      runId,
      timestampMs: ts,
      type: "ApprovalGranted",
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* adapter.insertNodeEffect({
      runId,
      nodeId,
      iteration,
      state: "pending",
      lastAttempt: null,
      updatedAtMs: nowMs(),
      outputTable: "",
      label: null,
    });
    yield* Effect.logInfo("approval granted");
  }).pipe(
    Effect.annotateLogs({
      runId,
      nodeId,
      iteration,
      approvalStatus: "approved",
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
) {
  await runPromise(
    approveNodeEffect(adapter, runId, nodeId, iteration, note, decidedBy),
  );
}

export function denyNodeEffect(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
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
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    yield* adapter.insertOrUpdateApprovalEffect({
      runId,
      nodeId,
      iteration,
      status: "denied",
      requestedAtMs: null,
      decidedAtMs: ts,
      note: note ?? null,
      decidedBy: decidedBy ?? null,
    });
    yield* adapter.insertEventWithNextSeqEffect({
      runId,
      timestampMs: ts,
      type: "ApprovalDenied",
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* adapter.insertNodeEffect({
      runId,
      nodeId,
      iteration,
      state: "failed",
      lastAttempt: null,
      updatedAtMs: nowMs(),
      outputTable: "",
      label: null,
    });
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
) {
  await runPromise(
    denyNodeEffect(adapter, runId, nodeId, iteration, note, decidedBy),
  );
}
