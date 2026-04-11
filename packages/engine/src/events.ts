import { EventEmitter } from "node:events";
import * as FileSystem from "@effect/platform/FileSystem";
import { join } from "node:path";
import { Effect } from "effect";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import { fromPromise } from "@smithers/driver/interop";
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
    return withCurrentCorrelationContext(
      Effect.gen(this, function* () {
        yield* this.emitAndTrackEffect(correlatedEvent);
        if (this.db) {
          yield* this.persistDbEffect(correlatedEvent);
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
    return withCurrentCorrelationContext(
      Effect.gen(this, function* () {
        yield* this.emitAndTrackEffect(correlatedEvent);
        yield* this.persistEffect(correlatedEvent);
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
      fromPromise("flush queued events", async () => {
        await this.persistTail;
        if (this.persistError) {
          const err = this.persistError;
          this.persistError = null;
          throw err;
        }
      }).pipe(Effect.withLogSpan("event:flush")),
    );
  }

  async flush(): Promise<void> {
    await Effect.runPromise(this.flushEffect());
  }

  persistEffect(event: CorrelatedSmithersEvent) {
    return withCurrentCorrelationContext(
      Effect.gen(this, function* () {
        yield* this.persistDbEffect(event);
        const persistedLog = yield* Effect.either(this.persistLogEffect(event));
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
    return Effect.gen(this, function* () {
      yield* Effect.sync(() => this.emit("event", event));
      yield* trackEvent(event);
    });
  }

  private enqueuePersistEffect(event: CorrelatedSmithersEvent) {
    const task = this.persistTail.then(() => Effect.runPromise(this.persistEffect(event)));
    this.persistTail = task.catch((error) => {
      this.persistError = error;
    });
    return fromPromise("enqueue event persistence", () => task);
  }

  private persistDbEffect(event: CorrelatedSmithersEvent) {
    if (!this.db) return Effect.void;
    const payloadJson = JSON.stringify(event);
    if (typeof this.db.insertEventWithNextSeq === "function") {
      return this.db.insertEventWithNextSeq({
        runId: event.runId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson,
      });
    }
    if (typeof this.db.insertEvent === "function") {
      return this.db.insertEvent({
        runId: event.runId,
        seq: this.seq++,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson,
      });
    }
    return Effect.void;
  }

  private persistLogEffect(event: CorrelatedSmithersEvent) {
    if (!this.logDir) return Effect.void;
    const dir = this.logDir;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true });
      const file = join(dir, "stream.ndjson");
      const line = JSON.stringify(event) + "\n";
      const current = yield* Effect.option(fs.readFileString(file, "utf8"));
      const prefix = current._tag === "Some" ? current.value : "";
      yield* fs.writeFileString(file, prefix + line);
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
