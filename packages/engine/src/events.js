import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { trackEvent } from "@smithers/observability/metrics";
import { correlationContextToLogAnnotations, getCurrentCorrelationContext, mergeCorrelationContext, withCurrentCorrelationContext, } from "@smithers/observability/correlation";
/** @typedef {import("@smithers/observability/correlation").CorrelationContext} CorrelationContext */

/**
 * @typedef {SmithersEvent & { correlation?: CorrelationContext; }} CorrelatedSmithersEvent
 */
/** @typedef {import("@smithers/observability/SmithersEvent").SmithersEvent} SmithersEvent */

export class EventBus extends EventEmitter {
    seq = 0;
    logDir;
    db;
    persistTail = Promise.resolve();
    persistError = null;
    /**
   * @param {{ db?: any; logDir?: string; startSeq?: number }} opts
   */
    constructor(opts) {
        super();
        this.db = opts.db;
        this.logDir = opts.logDir;
        this.seq = opts.startSeq ?? 0;
    }
    /**
   * @param {SmithersEvent} event
   */
    emitEvent(event) {
        const correlatedEvent = this.attachCorrelation(event);
        const self = this;
        return withCurrentCorrelationContext(Effect.gen(function* () {
            yield* self.emitAndTrack(correlatedEvent);
            if (self.db) {
                yield* self.persistDb(correlatedEvent);
            }
        }).pipe(Effect.annotateLogs(this.eventLogAnnotations(correlatedEvent)), Effect.withLogSpan(`event:${correlatedEvent.type}`)));
    }
    /**
   * @param {SmithersEvent} event
   */
    emitEventWithPersist(event) {
        const correlatedEvent = this.attachCorrelation(event);
        const self = this;
        return withCurrentCorrelationContext(Effect.gen(function* () {
            yield* self.emitAndTrack(correlatedEvent);
            yield* self.persist(correlatedEvent);
        }).pipe(Effect.annotateLogs(this.eventLogAnnotations(correlatedEvent)), Effect.withLogSpan(`event:${correlatedEvent.type}:persist`)));
    }
    /**
   * @param {SmithersEvent} event
   * @returns {Promise<void>}
   */
    emitEventQueued(event) {
        const correlatedEvent = this.attachCorrelation(event);
        this.emit("event", correlatedEvent);
        return Effect.runPromise(withCurrentCorrelationContext(trackEvent(correlatedEvent).pipe(Effect.andThen(this.enqueuePersist(correlatedEvent)))));
    }
    flush() {
        return withCurrentCorrelationContext(Effect.tryPromise({
            try: async () => {
                await this.persistTail;
                if (this.persistError) {
                    const err = this.persistError;
                    this.persistError = null;
                    throw err;
                }
            },
            catch: (cause) => toSmithersError(cause, "flush queued events"),
        }).pipe(Effect.withLogSpan("event:flush")));
    }
    /**
   * @param {CorrelatedSmithersEvent} event
   */
    persist(event) {
        const self = this;
        return withCurrentCorrelationContext(Effect.gen(function* () {
            yield* self.persistDb(event);
            const persistedLog = yield* Effect.either(self.persistLog(event));
            if (persistedLog._tag === "Left") {
                yield* Effect.logWarning(`[smithers] failed to append event log: ${persistedLog.left instanceof Error ? persistedLog.left.message : String(persistedLog.left)}`);
            }
        }).pipe(Effect.annotateLogs(this.eventLogAnnotations(event)), Effect.withLogSpan("event:persist")));
    }
    /**
   * @param {CorrelatedSmithersEvent} event
   */
    emitAndTrack(event) {
        const self = this;
        return Effect.gen(function* () {
            yield* Effect.sync(() => self.emit("event", event));
            yield* trackEvent(event);
        });
    }
    /**
   * @param {CorrelatedSmithersEvent} event
   */
    enqueuePersist(event) {
        const task = this.persistTail.then(() => Effect.runPromise(this.persist(event)));
        this.persistTail = task.catch((error) => {
            this.persistError = error;
        });
        return Effect.tryPromise({
            try: () => task,
            catch: (cause) => toSmithersError(cause, "enqueue event persistence"),
        });
    }
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    persistDb(event) {
        if (!this.db)
            return Effect.void;
        const payloadJson = JSON.stringify(event);
        const nextSeqRow = {
            runId: event.runId,
            timestampMs: event.timestampMs,
            type: event.type,
            payloadJson,
        };
        const eventRow = {
            ...nextSeqRow,
            seq: this.seq++,
        };
        if (typeof this.db.insertEventWithNextSeqEffect === "function") {
            return this.callDbPersistence(`insert event ${event.type}`, this.db.insertEventWithNextSeqEffect, nextSeqRow);
        }
        if (typeof this.db.insertEventWithNextSeq === "function") {
            return this.callDbPersistence(`insert event ${event.type}`, this.db.insertEventWithNextSeq, nextSeqRow);
        }
        if (typeof this.db.insertEventEffect === "function") {
            return this.callDbPersistence(`insert event ${event.type}`, this.db.insertEventEffect, eventRow);
        }
        if (typeof this.db.insertEvent === "function") {
            return this.callDbPersistence(`insert event ${event.type}`, this.db.insertEvent, eventRow);
        }
        return Effect.void;
    }
    /**
   * @param {string} label
   * @param {(row: any) => unknown} method
   * @param {any} row
   * @returns {Effect.Effect<void, unknown>}
   */
    callDbPersistence(label, method, row) {
        const db = this.db;
        return Effect.try({
            try: () => method.call(db, row),
            catch: (cause) => toSmithersError(cause, label),
        }).pipe(Effect.flatMap((result) => {
            if (Effect.isEffect(result)) {
                return result;
            }
            if (result &&
                typeof result === "object" &&
                typeof result.then === "function") {
                return Effect.tryPromise({
                    try: () => result,
                    catch: (cause) => toSmithersError(cause, label),
                });
            }
            return Effect.void;
        }), Effect.asVoid);
    }
    /**
   * @param {CorrelatedSmithersEvent} event
   */
    persistLog(event) {
        if (!this.logDir)
            return Effect.void;
        const dir = this.logDir;
        return Effect.tryPromise({
            try: async () => {
                await mkdir(dir, { recursive: true });
                const file = join(dir, "stream.ndjson");
                const line = JSON.stringify(event) + "\n";
                let prefix = "";
                try {
                    prefix = await readFile(file, "utf8");
                }
                catch (error) {
                    if (!error ||
                        typeof error !== "object" ||
                        error.code !== "ENOENT") {
                        throw error;
                    }
                }
                await writeFile(file, prefix + line);
            },
            catch: (cause) => toSmithersError(cause, "append event log"),
        });
    }
    /**
   * @param {SmithersEvent} event
   * @returns {CorrelatedSmithersEvent}
   */
    attachCorrelation(event) {
        const correlation = mergeCorrelationContext(getCurrentCorrelationContext(), {
            runId: event.runId,
            nodeId: "nodeId" in event && typeof event.nodeId === "string"
                ? event.nodeId
                : undefined,
            iteration: "iteration" in event && typeof event.iteration === "number"
                ? event.iteration
                : undefined,
            attempt: "attempt" in event && typeof event.attempt === "number"
                ? event.attempt
                : undefined,
        });
        return correlation ? { ...event, correlation } : event;
    }
    /**
   * @param {CorrelatedSmithersEvent} event
   */
    eventLogAnnotations(event) {
        return {
            ...correlationContextToLogAnnotations(event.correlation),
            runId: event.runId,
            eventType: event.type,
        };
    }
}
