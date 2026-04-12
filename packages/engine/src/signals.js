import { Effect } from "effect";
import { SmithersDb } from "@smithers/db/adapter";
import { bridgeSignalResolve } from "./effect/durable-deferred-bridge.js";
import { SmithersError } from "@smithers/errors/SmithersError";
import { nowMs } from "@smithers/scheduler/nowMs";
/** @typedef {import("./signals.ts").signals} signals */

/** @typedef {import("./signals.ts").SignalRunOptions} SignalRunOptions */

/**
 * @param {string} signalName
 * @returns {string}
 */
function normalizeSignalName(signalName) {
    const normalized = signalName.trim();
    if (!normalized) {
        throw new SmithersError("INVALID_INPUT", "Signal name must be a non-empty string.", { signalName });
    }
    return normalized;
}
/**
 * @param {unknown} payload
 * @returns {string}
 */
function serializeSignalPayload(payload) {
    try {
        const payloadJson = JSON.stringify(payload ?? null);
        if (payloadJson === undefined) {
            throw new Error("Signal payload serialized to undefined.");
        }
        return payloadJson;
    }
    catch (error) {
        throw new SmithersError("INVALID_INPUT", "Signal payload must be valid JSON-serializable data.", undefined, { cause: error });
    }
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} signalName
 * @param {unknown} payload
 * @param {SignalRunOptions} [options]
 */
export function signalRun(adapter, runId, signalName, payload, options = {}) {
    const normalizedSignalName = normalizeSignalName(signalName);
    const payloadJson = serializeSignalPayload(payload);
    const receivedAtMs = options.timestampMs ?? nowMs();
    return Effect.gen(function* () {
        const run = yield* adapter.getRun(runId);
        if (!run) {
            throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, {
                runId,
            });
        }
        const seq = yield* adapter.insertSignalWithNextSeq({
            runId,
            signalName: normalizedSignalName,
            correlationId: options.correlationId ?? null,
            payloadJson,
            receivedAtMs,
            receivedBy: options.receivedBy ?? null,
        });
        const delivered = {
            runId,
            seq,
            signalName: normalizedSignalName,
            correlationId: options.correlationId ?? null,
            receivedAtMs,
        };
        yield* Effect.promise(() => bridgeSignalResolve(adapter, runId, {
            signalName: delivered.signalName,
            correlationId: delivered.correlationId ?? null,
            payloadJson,
            seq: delivered.seq,
            receivedAtMs: delivered.receivedAtMs,
        }));
        return delivered;
    }).pipe(Effect.annotateLogs({
        runId,
        signalName: normalizedSignalName,
        correlationId: options.correlationId ?? null,
    }), Effect.withLogSpan("signal:send"));
}
