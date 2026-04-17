import { Effect } from "effect";
import { diffSnapshots } from "@smithers/devtools";
import { runPromise } from "../smithersRuntime.js";
import {
    DevToolsRouteError,
    getDevToolsSnapshotRoute,
    validateFromSeqInput,
    validateRunId,
} from "./getDevToolsSnapshot.js";

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers/protocol/devtools").DevToolsEvent} DevToolsEvent */
/** @typedef {import("@smithers/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */

export const DEVTOOLS_REBASELINE_INTERVAL = 50;
export const DEVTOOLS_BACKPRESSURE_LIMIT = 1_000;
export const DEVTOOLS_POLL_INTERVAL_MS = 25;

/**
 * @param {number} timeMs
 * @returns {Promise<void>}
 */
function delay(timeMs) {
    return new Promise((resolve) => setTimeout(resolve, timeMs));
}

/**
 * @param {DevToolsEvent} event
 * @returns {number}
 */
function estimateEventSize(event) {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
}

/**
 * Wrap a promise-returning function in an Effect tracing span with attributes.
 *
 * @template T
 * @param {string} spanName
 * @param {Record<string, unknown>} attrs
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withSpan(spanName, attrs, run) {
    return runPromise(
        Effect.promise(() => run()).pipe(Effect.withSpan(spanName, { attributes: attrs })),
    );
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<{ frameNo: number } | null>}
 */
async function getLastFrameSpan(adapter, runId) {
    return withSpan(
        "db.frames.get",
        { runId, op: "getLastFrame" },
        () => adapter.getLastFrame(runId),
    );
}

class AsyncEventQueue {
    items = [];
    waiters = [];
    closed = false;
    error = null;
    maxItems;
    /**
   * @param {number} maxItems
   */
    constructor(maxItems) {
        this.maxItems = maxItems;
    }
    /**
   * @param {DevToolsEvent} value
   */
    push(value) {
        if (this.closed || this.error) {
            return;
        }
        if (this.items.length >= this.maxItems) {
            this.fail(new DevToolsRouteError("BackpressureDisconnect", "Subscriber event queue exceeded 1000 buffered events."));
            return;
        }
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter?.({ value, done: false });
            return;
        }
        this.items.push(value);
    }
    /**
   * @param {Error} error
   */
    fail(error) {
        if (this.closed || this.error) {
            return;
        }
        this.error = error;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter?.(Promise.reject(error));
        }
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter?.({ value: undefined, done: true });
        }
    }
    /**
   * @returns {Promise<IteratorResult<DevToolsEvent>>}
   */
    async next() {
        if (this.error) {
            throw this.error;
        }
        if (this.items.length > 0) {
            const value = this.items.shift();
            return { value, done: false };
        }
        if (this.closed) {
            return { value: undefined, done: true };
        }
        return new Promise((resolve, reject) => {
            this.waiters.push((result) => {
                if (result && typeof result === "object" && "then" in result) {
                    result.then(resolve, reject);
                    return;
                }
                resolve(/** @type {IteratorResult<DevToolsEvent>} */ (result));
            });
        });
    }
}

/**
 * @param {{ kind: "snapshot"; snapshot: DevToolsSnapshot } | { kind: "delta"; snapshot: DevToolsSnapshot; previous: DevToolsSnapshot }} input
 * @returns {Promise<DevToolsEvent>}
 */
async function makeEvent(input) {
    if (input.kind === "snapshot") {
        return {
            version: 1,
            kind: "snapshot",
            snapshot: input.snapshot,
        };
    }
    const delta = await withSpan(
        "devtools.diffSnapshots",
        {
            runId: input.snapshot.runId,
            baseSeq: input.previous.seq,
            seq: input.snapshot.seq,
        },
        async () => diffSnapshots(input.previous, input.snapshot),
    );
    return {
        version: 1,
        kind: "delta",
        delta: {
            version: 1,
            baseSeq: delta.baseSeq,
            seq: delta.seq,
            ops: delta.ops,
        },
    };
}

/**
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   fromSeq?: number;
 *   subscriberId?: string;
 *   pollIntervalMs?: number;
 *   maxBufferedEvents?: number;
 *   signal?: AbortSignal;
 *   invalidateSnapshot?: () => boolean;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 *   onLog?: (level: "debug" | "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
 *   onEvent?: (event: DevToolsEvent, stats: { bytes: number; durationMs: number; opCount?: number; frameNo?: number }) => void;
 *   onClose?: (summary: { eventsDelivered: number; durationMs: number; errorCode?: string }) => void;
 * }} input
 * @returns {AsyncIterable<DevToolsEvent>}
 */
export async function* streamDevToolsRoute(input) {
    const runId = validateRunId(input.runId);
    const pollIntervalMs = Number.isFinite(input.pollIntervalMs)
        ? Math.max(1, Math.floor(input.pollIntervalMs))
        : DEVTOOLS_POLL_INTERVAL_MS;
    const maxBufferedEvents = Number.isFinite(input.maxBufferedEvents)
        ? Math.max(1, Math.floor(input.maxBufferedEvents))
        : DEVTOOLS_BACKPRESSURE_LIMIT;
    validateFromSeqInput(input.fromSeq);
    const startedAt = Date.now();
    let eventsDelivered = 0;
    let lastSnapshot = null;
    let lastSeenSeq = 0;
    /** Per-subscriber counter: number of delta events since the last snapshot. */
    let eventsSinceSnapshot = 0;
    let producerErrorCode = undefined;
    const queue = new AsyncEventQueue(maxBufferedEvents);
    let cancelled = false;
    input.onLog?.("info", "devtools stream subscribed", {
        runId,
        fromSeq: input.fromSeq ?? null,
        subscriberId: input.subscriberId ?? null,
    });
    /**
   * @param {DevToolsEvent} event
   * @param {number} started
   */
    const publish = (event, started) => {
        queue.push(event);
        const durationMs = Date.now() - started;
        if (event.kind === "snapshot") {
            eventsSinceSnapshot = 0;
        }
        else {
            eventsSinceSnapshot += 1;
        }
        if (!input.onEvent && !input.onLog) {
            return;
        }
        let measuredBytes = 0;
        let hasMeasuredBytes = false;
        const bytes = () => {
            if (!hasMeasuredBytes) {
                measuredBytes = estimateEventSize(event);
                hasMeasuredBytes = true;
            }
            return measuredBytes;
        };
        if (event.kind === "snapshot") {
            input.onLog?.("debug", "devtools snapshot emitted", {
                runId,
                seq: event.snapshot.seq,
                frameNo: event.snapshot.frameNo,
                bytes: bytes(),
                durationMs,
            });
            input.onEvent?.(event, {
                bytes: bytes(),
                durationMs,
                frameNo: event.snapshot.frameNo,
            });
            return;
        }
        input.onLog?.("debug", "devtools delta emitted", {
            runId,
            seq: event.delta.seq,
            opCount: event.delta.ops.length,
            bytes: bytes(),
            durationMs,
        });
        input.onEvent?.(event, {
            bytes: bytes(),
            durationMs,
            opCount: event.delta.ops.length,
        });
    };
    /**
   * @returns {boolean}
   */
    const shouldStop = () => cancelled || Boolean(input.signal?.aborted) || Boolean(queue.error);
    /**
   * Capture a snapshot wrapped in an Effect.withSpan. Lets tracing backends
   * attribute snapshot work to a child span of the stream.
   *
   * @param {number} frameNo
   * @returns {Promise<DevToolsSnapshot>}
   */
    const captureSnapshot = async (frameNo) => withSpan(
        "devtools.captureSnapshot",
        { runId, frameNo },
        () => getDevToolsSnapshotRoute({
            adapter: input.adapter,
            runId,
            frameNo,
            onWarning: input.onWarning,
        }),
    );
    const producer = withSpan(
        "devtools.streamDevTools",
        {
            runId,
            fromSeq: input.fromSeq ?? null,
            subscriberId: input.subscriberId ?? null,
        },
        async () => {
        try {
            const latestFrame = await getLastFrameSpan(input.adapter, runId);
            if (!latestFrame) {
                // Zero-frame run: fromSeq > 0 is in the future relative to the
                // current seq (which is 0). Reject before emitting anything.
                if (typeof input.fromSeq === "number" && input.fromSeq > 0) {
                    throw new DevToolsRouteError("SeqOutOfRange", `fromSeq ${input.fromSeq} is newer than current seq 0.`);
                }
                const emptySnapshot = await captureSnapshot(0);
                publish(/** @type {DevToolsEvent} */ ({
                    version: 1,
                    kind: "snapshot",
                    snapshot: emptySnapshot,
                }), Date.now());
                lastSnapshot = emptySnapshot;
                lastSeenSeq = emptySnapshot.seq;
            }
            else {
                const latestSeq = latestFrame.frameNo;
                if (input.fromSeq !== undefined && input.fromSeq > latestSeq) {
                    throw new DevToolsRouteError("SeqOutOfRange", `fromSeq ${input.fromSeq} is newer than current seq ${latestSeq}.`);
                }
                if (input.fromSeq === undefined) {
                    const snapshot = await captureSnapshot(latestSeq);
                    publish(await makeEvent({ kind: "snapshot", snapshot }), Date.now());
                    lastSnapshot = snapshot;
                    lastSeenSeq = snapshot.seq;
                }
                else {
                    const fromSeq = input.fromSeq;
                    const baseSeq = Math.max(0, Math.floor(fromSeq / DEVTOOLS_REBASELINE_INTERVAL) * DEVTOOLS_REBASELINE_INTERVAL);
                    const initialSeq = Math.min(baseSeq, latestSeq);
                    let initialSnapshot = null;
                    try {
                        initialSnapshot = await captureSnapshot(initialSeq);
                    }
                    catch (error) {
                        if (error instanceof DevToolsRouteError && error.code === "FrameOutOfRange") {
                            input.onLog?.("warn", "devtools fromSeq gap forced re-baseline", {
                                runId,
                                fromSeq,
                                requestedBaseSeq: initialSeq,
                                latestSeq,
                            });
                            initialSnapshot = await captureSnapshot(latestSeq);
                        }
                        else {
                            throw error;
                        }
                    }
                    publish(await makeEvent({ kind: "snapshot", snapshot: initialSnapshot }), Date.now());
                    lastSnapshot = initialSnapshot;
                    lastSeenSeq = initialSnapshot.seq;
                    for (let seq = lastSeenSeq + 1; seq <= latestSeq; seq += 1) {
                        if (shouldStop()) {
                            break;
                        }
                        const started = Date.now();
                        let nextSnapshot = null;
                        try {
                            nextSnapshot = await captureSnapshot(seq);
                        }
                        catch (error) {
                            if (error instanceof DevToolsRouteError && error.code === "FrameOutOfRange") {
                                // Mid-replay gap: the DB no longer has the
                                // requested intermediate frame (possibly pruned
                                // or rewound). Log, emit the latest available
                                // snapshot, reset the replay state, and break.
                                input.onLog?.("warn", "devtools replay gap forced re-baseline", {
                                    runId,
                                    missingSeq: seq,
                                    latestSeq,
                                });
                                const latestAvailable = await getLastFrameSpan(input.adapter, runId);
                                const rebaselineSeq = latestAvailable?.frameNo ?? lastSeenSeq;
                                const rebaseline = await captureSnapshot(rebaselineSeq);
                                publish(await makeEvent({ kind: "snapshot", snapshot: rebaseline }), started);
                                lastSnapshot = rebaseline;
                                lastSeenSeq = rebaseline.seq;
                                break;
                            }
                            throw error;
                        }
                        const deltaEvent = await makeEvent({
                            kind: "delta",
                            snapshot: nextSnapshot,
                            previous: lastSnapshot,
                        });
                        const snapshotEvent = /** @type {DevToolsEvent} */ ({
                            version: 1,
                            kind: "snapshot",
                            snapshot: nextSnapshot,
                        });
                        const invalidated = input.invalidateSnapshot?.() ?? false;
                        const shouldSnapshot =
                            invalidated ||
                            eventsSinceSnapshot + 1 >= DEVTOOLS_REBASELINE_INTERVAL ||
                            estimateEventSize(deltaEvent) >= estimateEventSize(snapshotEvent);
                        publish(shouldSnapshot ? snapshotEvent : deltaEvent, started);
                        lastSnapshot = nextSnapshot;
                        lastSeenSeq = seq;
                    }
                }
            }
            while (!shouldStop()) {
                if (shouldStop()) {
                    break;
                }
                const latest = await getLastFrameSpan(input.adapter, runId);
                if (latest && latest.frameNo < lastSeenSeq) {
                    const started = Date.now();
                    input.onLog?.("info", "devtools rewind detected; forcing re-baseline snapshot", {
                        runId,
                        previousSeq: lastSeenSeq,
                        latestSeq: latest.frameNo,
                    });
                    const rewindSnapshot = await captureSnapshot(latest.frameNo);
                    publish(/** @type {DevToolsEvent} */ ({
                        version: 1,
                        kind: "snapshot",
                        snapshot: rewindSnapshot,
                    }), started);
                    lastSnapshot = rewindSnapshot;
                    lastSeenSeq = rewindSnapshot.seq;
                }
                if (latest && latest.frameNo > lastSeenSeq && lastSnapshot) {
                    for (let seq = lastSeenSeq + 1; seq <= latest.frameNo; seq += 1) {
                        if (shouldStop()) {
                            break;
                        }
                        const started = Date.now();
                        let nextSnapshot = null;
                        try {
                            nextSnapshot = await captureSnapshot(seq);
                        }
                        catch (error) {
                            if (error instanceof DevToolsRouteError && error.code === "FrameOutOfRange") {
                                input.onLog?.("warn", "devtools live gap forced re-baseline", {
                                    runId,
                                    missingSeq: seq,
                                    latestSeq: latest.frameNo,
                                });
                                const rebaselineTarget = await getLastFrameSpan(input.adapter, runId);
                                const rebaselineSeq = rebaselineTarget?.frameNo ?? lastSeenSeq;
                                const rebaseline = await captureSnapshot(rebaselineSeq);
                                publish(/** @type {DevToolsEvent} */ ({
                                    version: 1,
                                    kind: "snapshot",
                                    snapshot: rebaseline,
                                }), started);
                                lastSnapshot = rebaseline;
                                lastSeenSeq = rebaseline.seq;
                                break;
                            }
                            throw error;
                        }
                        const deltaEvent = await makeEvent({
                            kind: "delta",
                            snapshot: nextSnapshot,
                            previous: lastSnapshot,
                        });
                        const snapshotEvent = /** @type {DevToolsEvent} */ ({
                            version: 1,
                            kind: "snapshot",
                            snapshot: nextSnapshot,
                        });
                        const invalidated = input.invalidateSnapshot?.() ?? false;
                        const shouldSnapshot =
                            invalidated ||
                            eventsSinceSnapshot + 1 >= DEVTOOLS_REBASELINE_INTERVAL ||
                            estimateEventSize(deltaEvent) >= estimateEventSize(snapshotEvent);
                        publish(shouldSnapshot ? snapshotEvent : deltaEvent, started);
                        lastSnapshot = nextSnapshot;
                        lastSeenSeq = seq;
                    }
                }
                if (shouldStop()) {
                    break;
                }
                await delay(pollIntervalMs);
            }
        }
        catch (error) {
            producerErrorCode = error?.code ?? undefined;
            queue.fail(error instanceof Error ? error : new Error(String(error)));
        }
        finally {
            queue.close();
        }
    },
    );
    // Keep a reference so the finally block can await it.
    void producer.catch(() => { });
    try {
        while (true) {
            const next = await queue.next();
            if (next.done) {
                break;
            }
            eventsDelivered += 1;
            yield next.value;
        }
    }
    finally {
        cancelled = true;
        queue.close();
        const closeWaitMs = Math.max(25, pollIntervalMs * 4);
        try {
            await Promise.race([producer, delay(closeWaitMs)]);
        }
        catch { }
        if (!producerErrorCode && queue.error?.code) {
            producerErrorCode = queue.error.code;
        }
        const durationMs = Date.now() - startedAt;
        input.onLog?.("info", "devtools stream unsubscribed", {
            runId,
            subscriberId: input.subscriberId ?? null,
            eventsDelivered,
            durationMs,
        });
        input.onClose?.({
            eventsDelivered,
            durationMs,
            errorCode: producerErrorCode,
        });
    }
}
