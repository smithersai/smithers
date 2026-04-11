import * as DurableDeferred from "@effect/workflow/DurableDeferred";
import * as Workflow from "@effect/workflow/Workflow";
import { resolve as resolvePath } from "node:path";
import { Effect, Exit, Schema } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { updateAsyncExternalWaitPending } from "@smithers/observability/metrics";

export const DurableDeferredBridgeWorkflow = Workflow.make({
  name: "SmithersDurableDeferredBridge",
  payload: { executionId: Schema.String },
  success: Schema.Unknown,
  idempotencyKey: ({ executionId }) => executionId,
});

const adapterNamespaces = new WeakMap<object, string>();
let nextAdapterNamespace = 0;

const getAdapterNamespace = (adapter: SmithersDb): string => {
  const filename = (adapter as any)?.db?.$client?.filename;
  if (typeof filename === "string" && filename.length > 0 && filename !== ":memory:") {
    return `sqlite:${resolvePath(filename)}`;
  }

  const existing = adapterNamespaces.get(adapter);
  if (existing) {
    return existing;
  }
  const created = `adapter-${++nextAdapterNamespace}`;
  adapterNamespaces.set(adapter, created);
  return created;
};

export const approvalDurableDeferredSuccessSchema = Schema.Struct({
  approved: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(Schema.String),
  decisionJson: Schema.NullOr(Schema.String),
  autoApproved: Schema.Boolean,
});

export type ApprovalDurableDeferredResolution = Schema.Schema.Type<
  typeof approvalDurableDeferredSuccessSchema
>;

export const waitForEventDurableDeferredSuccessSchema = Schema.Struct({
  signalName: Schema.String,
  correlationId: Schema.NullOr(Schema.String),
  payloadJson: Schema.String,
  seq: Schema.Number,
  receivedAtMs: Schema.Number,
});

export type WaitForEventDurableDeferredResolution = Schema.Schema.Type<
  typeof waitForEventDurableDeferredSuccessSchema
>;

type WaitForEventSignalInput = {
  signalName: string;
  correlationId: string | null;
  payloadJson: string;
  seq: number;
  receivedAtMs: number;
};

type WaitForEventAttemptSnapshot = {
  meta: Record<string, unknown>;
  signalName: string;
  correlationId: string | null;
  waitAsync: boolean;
  resolvedSignalSeq?: number;
  receivedAtMs?: number;
};

function normalizeCorrelationId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function parseOptionalFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseWaitForEventAttemptSnapshot(
  metaJson?: string | null,
): WaitForEventAttemptSnapshot | null {
  if (!metaJson) return null;
  try {
    const parsed = JSON.parse(metaJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const waitForEvent = parsed?.waitForEvent;
    if (!waitForEvent || typeof waitForEvent !== "object" || Array.isArray(waitForEvent)) {
      return null;
    }
    const signalName =
      typeof (waitForEvent as any).signalName === "string"
        ? (waitForEvent as any).signalName.trim()
        : "";
    if (!signalName) {
      return null;
    }
    return {
      meta: parsed as Record<string, unknown>,
      signalName,
      correlationId: normalizeCorrelationId((waitForEvent as any).correlationId),
      waitAsync: (waitForEvent as any).waitAsync === true,
      resolvedSignalSeq: parseOptionalFiniteNumber((waitForEvent as any).resolvedSignalSeq),
      receivedAtMs: parseOptionalFiniteNumber((waitForEvent as any).receivedAtMs),
    };
  } catch {
    return null;
  }
}

function buildResolvedWaitForEventMetaJson(
  snapshot: WaitForEventAttemptSnapshot,
  signal: WaitForEventSignalInput,
): string {
  const waitForEvent =
    snapshot.meta.waitForEvent &&
    typeof snapshot.meta.waitForEvent === "object" &&
    !Array.isArray(snapshot.meta.waitForEvent)
      ? (snapshot.meta.waitForEvent as Record<string, unknown>)
      : {};

  return JSON.stringify({
    ...snapshot.meta,
    kind:
      typeof snapshot.meta.kind === "string"
        ? snapshot.meta.kind
        : "wait-for-event",
    waitForEvent: {
      ...waitForEvent,
      signalName: snapshot.signalName,
      correlationId: snapshot.correlationId,
      waitAsync: snapshot.waitAsync,
      resolvedSignalSeq: signal.seq,
      receivedAtMs: signal.receivedAtMs,
    },
  });
}

async function markWaitForEventResolved(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  signal: WaitForEventSignalInput,
) {
  const attempts = await Effect.runPromise(adapter.listAttempts(runId, nodeId, iteration));
  const waitingAttempt =
    (attempts as any[]).find((attempt) => attempt.state === "waiting-event") ??
    attempts[0];
  const snapshot = parseWaitForEventAttemptSnapshot(waitingAttempt?.metaJson);
  if (!waitingAttempt || !snapshot || snapshot.resolvedSignalSeq !== undefined) {
    return;
  }

  await Effect.runPromise(adapter.updateAttempt(
    runId,
    nodeId,
    iteration,
    waitingAttempt.attempt,
    {
      metaJson: buildResolvedWaitForEventMetaJson(snapshot, signal),
    },
  ));

  if (snapshot.waitAsync) {
    try {
      await Effect.runPromise(updateAsyncExternalWaitPending("event", -1));
    } catch {}
  }
}

type BridgeDeferredResult =
  | { _tag: "Complete"; exit: Exit.Exit<any, any> }
  | { _tag: "Pending" };

const deferredResolutions = new Map<string, Exit.Exit<any, any>>();

const awaitBridgeDeferred = async <
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
>(
  executionId: string,
  _deferred: DurableDeferred.DurableDeferred<Success, Error>,
): Promise<BridgeDeferredResult> => {
  const exit = deferredResolutions.get(executionId);
  return exit ? { _tag: "Complete", exit } : { _tag: "Pending" };
};

const resolveBridgeDeferred = async <
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
>(
  executionId: string,
  _deferred: DurableDeferred.DurableDeferred<Success, Error>,
  exit: Exit.Exit<Success["Type"], Error["Type"]>,
) => {
  deferredResolutions.set(executionId, exit as Exit.Exit<any, any>);
};

export const makeDurableDeferredBridgeExecutionId = (
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
): string =>
  [
    "smithers-durable-deferred-bridge",
    getAdapterNamespace(adapter),
    runId,
    nodeId,
    String(iteration),
  ].join(":");

export const makeApprovalDurableDeferred = (nodeId: string) =>
  DurableDeferred.make(`approval:${nodeId}`, {
    success: approvalDurableDeferredSuccessSchema,
  });

export const makeWaitForEventDurableDeferred = (nodeId: string) =>
  DurableDeferred.make(`wait-for-event:${nodeId}`, {
    success: waitForEventDurableDeferredSuccessSchema,
  });

export const awaitApprovalDurableDeferred = (
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
) =>
  awaitBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeApprovalDurableDeferred(nodeId),
  );

export const awaitWaitForEventDurableDeferred = (
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
) =>
  awaitBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeWaitForEventDurableDeferred(nodeId),
  );

export const bridgeApprovalResolve = async (
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  resolution: {
    approved: boolean;
    note?: string | null;
    decidedBy?: string | null;
    decisionJson?: string | null;
    autoApproved?: boolean;
  },
) => {
  await resolveBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeApprovalDurableDeferred(nodeId),
    Exit.succeed({
      approved: resolution.approved,
      note: resolution.note ?? null,
      decidedBy: resolution.decidedBy ?? null,
      decisionJson: resolution.decisionJson ?? null,
      autoApproved: resolution.autoApproved ?? false,
    }),
  );
};

export const bridgeWaitForEventResolve = async (
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  signal: WaitForEventSignalInput,
) => {
  await markWaitForEventResolved(adapter, runId, nodeId, iteration, signal);
  await resolveBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeWaitForEventDurableDeferred(nodeId),
    Exit.succeed({
      signalName: signal.signalName,
      correlationId: normalizeCorrelationId(signal.correlationId),
      payloadJson: signal.payloadJson,
      seq: signal.seq,
      receivedAtMs: signal.receivedAtMs,
    }),
  );
};

export const bridgeSignalResolve = async (
  adapter: SmithersDb,
  runId: string,
  signal: WaitForEventSignalInput,
) => {
  const nodes = await Effect.runPromise(adapter.listNodes(runId));
  const normalizedCorrelationId = normalizeCorrelationId(signal.correlationId);

  for (const node of nodes as any[]) {
    if (node.state !== "waiting-event") continue;
    const iteration = node.iteration ?? 0;
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, node.nodeId, iteration));
    const waitingAttempt =
      (attempts as any[]).find((attempt) => attempt.state === "waiting-event") ??
      attempts[0];
    if (!waitingAttempt) continue;

    const snapshot = parseWaitForEventAttemptSnapshot(waitingAttempt.metaJson);
    if (!snapshot) continue;
    if (snapshot.signalName !== signal.signalName) continue;
    if (snapshot.correlationId !== normalizedCorrelationId) continue;

    await bridgeWaitForEventResolve(
      adapter,
      runId,
      node.nodeId,
      iteration,
      signal,
    );
  }
};
