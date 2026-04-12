import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { trackEvent } from "@smithers/observability/metrics";
import type { CorrelationContext } from "@smithers/observability/correlation";
import {
  correlationContextToLogAnnotations,
  getCurrentCorrelationContext,
  mergeCorrelationContext,
  withCurrentCorrelationContext,
} from "@smithers/observability/correlation";

type CorrelatedSmithersEvent = SmithersEvent & {
  correlation?: CorrelationContext;
};

export class EventBus extends EventEmitter {
  private seq = 0;
  private logDir?: string;
  private db?: any;
  private persistTail: Promise<void> = Promise.resolve();
  private persistError: unknown = null;

  constructor(opts: { db?: any; logDir?: string; startSeq?: number }) {
    super();
    this.db = opts.db;
    this.logDir = opts.logDir;
    this.seq = opts.startSeq ?? 0;
  }

  emitEventEffect(event: SmithersEvent) {
    const correlatedEvent = this.attachCorrelation(event);
    const self = this;
    return withCurrentCorrelationContext(
      Effect.gen(function* () {
        yield* self.emitAndTrackEffect(correlatedEvent);
        if (self.db) {
          yield* self.persistDbEffect(correlatedEvent);
        }
      }).pipe(
        Effect.annotateLogs(this.eventLogAnnotations(correlatedEvent)),
        Effect.withLogSpan(`event:${correlatedEvent.type}`),
      ),
    );
  }

  async emitEvent(event: SmithersEvent) {
    await Effect.runPromise(this.emitEventEffect(event));
  }

  emitEventWithPersistEffect(event: SmithersEvent) {
    const correlatedEvent = this.attachCorrelation(event);
    const self = this;
    return withCurrentCorrelationContext(
      Effect.gen(function* () {
        yield* self.emitAndTrackEffect(correlatedEvent);
        yield* self.persistEffect(correlatedEvent);
      }).pipe(
        Effect.annotateLogs(this.eventLogAnnotations(correlatedEvent)),
        Effect.withLogSpan(`event:${correlatedEvent.type}:persist`),
      ),
    );
  }

  async emitEventWithPersist(event: SmithersEvent) {
    await Effect.runPromise(this.emitEventWithPersistEffect(event));
  }

  emitEventQueued(event: SmithersEvent): Promise<void> {
    const correlatedEvent = this.attachCorrelation(event);
    this.emit("event", correlatedEvent);
    return Effect.runPromise(
      withCurrentCorrelationContext(
        trackEvent(correlatedEvent).pipe(
          Effect.andThen(this.enqueuePersistEffect(correlatedEvent)),
        ),
      ),
    );
  }

  flushEffect() {
    return withCurrentCorrelationContext(
      Effect.tryPromise({
        try: async () => {
          await this.persistTail;
          if (this.persistError) {
            const err = this.persistError;
            this.persistError = null;
            throw err;
          }
        },
        catch: (cause) => toSmithersError(cause, "flush queued events"),
      }).pipe(Effect.withLogSpan("event:flush")),
    );
  }

  async flush(): Promise<void> {
    await Effect.runPromise(this.flushEffect());
  }

  persistEffect(event: CorrelatedSmithersEvent) {
    const self = this;
    return withCurrentCorrelationContext(
      Effect.gen(function* () {
        yield* self.persistDbEffect(event);
        const persistedLog = yield* Effect.either(self.persistLogEffect(event));
        if (persistedLog._tag === "Left") {
          yield* Effect.logWarning(
            `[smithers] failed to append event log: ${persistedLog.left instanceof Error ? persistedLog.left.message : String(persistedLog.left)}`,
          );
        }
      }).pipe(
        Effect.annotateLogs(this.eventLogAnnotations(event)),
        Effect.withLogSpan("event:persist"),
      ),
    );
  }

  async persist(event: SmithersEvent) {
    await Effect.runPromise(this.persistEffect(this.attachCorrelation(event)));
  }

  private emitAndTrackEffect(event: CorrelatedSmithersEvent) {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.sync(() => self.emit("event", event));
      yield* trackEvent(event);
    });
  }

  private enqueuePersistEffect(event: CorrelatedSmithersEvent) {
    const task = this.persistTail.then(() => Effect.runPromise(this.persistEffect(event)));
    this.persistTail = task.catch((error) => {
      this.persistError = error;
    });
    return Effect.tryPromise({
      try: () => task,
      catch: (cause) => toSmithersError(cause, "enqueue event persistence"),
    });
  }

  private persistDbEffect(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown> {
    if (!this.db) return Effect.void;
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
      return this.callDbPersistenceEffect(
        `insert event ${event.type}`,
        this.db.insertEventWithNextSeqEffect,
        nextSeqRow,
      );
    }
    if (typeof this.db.insertEventWithNextSeq === "function") {
      return this.callDbPersistenceEffect(
        `insert event ${event.type}`,
        this.db.insertEventWithNextSeq,
        nextSeqRow,
      );
    }
    if (typeof this.db.insertEventEffect === "function") {
      return this.callDbPersistenceEffect(
        `insert event ${event.type}`,
        this.db.insertEventEffect,
        eventRow,
      );
    }
    if (typeof this.db.insertEvent === "function") {
      return this.callDbPersistenceEffect(
        `insert event ${event.type}`,
        this.db.insertEvent,
        eventRow,
      );
    }
    return Effect.void;
  }

  private callDbPersistenceEffect(
    label: string,
    method: (row: any) => unknown,
    row: any,
  ): Effect.Effect<void, unknown> {
    const db = this.db;
    return Effect.try({
      try: () => method.call(db, row),
      catch: (cause) => toSmithersError(cause, label),
    }).pipe(
      Effect.flatMap((result) => {
        if (Effect.isEffect(result)) {
          return result as Effect.Effect<unknown, unknown, never>;
        }
        if (
          result &&
          typeof result === "object" &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          return Effect.tryPromise({
            try: () => result as PromiseLike<unknown>,
            catch: (cause) => toSmithersError(cause, label),
          });
        }
        return Effect.void;
      }),
      Effect.asVoid,
    );
  }

  private persistLogEffect(event: CorrelatedSmithersEvent) {
    if (!this.logDir) return Effect.void;
    const dir = this.logDir;
    return Effect.tryPromise({
      try: async () => {
      await mkdir(dir, { recursive: true });
      const file = join(dir, "stream.ndjson");
      const line = JSON.stringify(event) + "\n";
      let prefix = "";
      try {
        prefix = await readFile(file, "utf8");
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
      }
      await writeFile(file, prefix + line);
      },
      catch: (cause) => toSmithersError(cause, "append event log"),
    });
  }

  private attachCorrelation(event: SmithersEvent): CorrelatedSmithersEvent {
    const correlation = mergeCorrelationContext(getCurrentCorrelationContext(), {
      runId: event.runId,
      nodeId:
        "nodeId" in event && typeof event.nodeId === "string"
          ? event.nodeId
          : undefined,
      iteration:
        "iteration" in event && typeof event.iteration === "number"
          ? event.iteration
          : undefined,
      attempt:
        "attempt" in event && typeof event.attempt === "number"
          ? event.attempt
          : undefined,
    });
    return correlation ? { ...event, correlation } : event;
  }

  private eventLogAnnotations(event: CorrelatedSmithersEvent) {
    return {
      ...correlationContextToLogAnnotations(event.correlation),
      runId: event.runId,
      eventType: event.type,
    };
  }
}
