import { Effect } from "effect";
import { SmithersDb } from "../db/adapter";
import { runPromise } from "../effect/runtime";
import { SmithersError } from "../utils/errors";
import { nowMs } from "../utils/time";

export type SignalRunOptions = {
  correlationId?: string | null;
  receivedBy?: string | null;
  timestampMs?: number;
};

function normalizeSignalName(signalName: string): string {
  const normalized = signalName.trim();
  if (!normalized) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Signal name must be a non-empty string.",
      { signalName },
    );
  }
  return normalized;
}

function serializeSignalPayload(payload: unknown): string {
  try {
    const payloadJson = JSON.stringify(payload ?? null);
    if (payloadJson === undefined) {
      throw new Error("Signal payload serialized to undefined.");
    }
    return payloadJson;
  } catch (error) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Signal payload must be valid JSON-serializable data.",
      undefined,
      { cause: error },
    );
  }
}

export function signalRunEffect(
  adapter: SmithersDb,
  runId: string,
  signalName: string,
  payload: unknown,
  options: SignalRunOptions = {},
) {
  const normalizedSignalName = normalizeSignalName(signalName);
  const payloadJson = serializeSignalPayload(payload);
  const receivedAtMs = options.timestampMs ?? nowMs();
  return Effect.gen(function* () {
    const run = yield* adapter.getRunEffect(runId);
    if (!run) {
      throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, {
        runId,
      });
    }

    const seq = yield* adapter.insertSignalWithNextSeqEffect({
      runId,
      signalName: normalizedSignalName,
      correlationId: options.correlationId ?? null,
      payloadJson,
      receivedAtMs,
      receivedBy: options.receivedBy ?? null,
    });

    return {
      runId,
      seq,
      signalName: normalizedSignalName,
      correlationId: options.correlationId ?? null,
      receivedAtMs,
    };
  }).pipe(
    Effect.annotateLogs({
      runId,
      signalName: normalizedSignalName,
      correlationId: options.correlationId ?? null,
    }),
    Effect.withLogSpan("signal:send"),
  );
}

export async function signalRun(
  adapter: SmithersDb,
  runId: string,
  signalName: string,
  payload: unknown,
  options: SignalRunOptions = {},
) {
  return runPromise(signalRunEffect(adapter, runId, signalName, payload, options));
}
