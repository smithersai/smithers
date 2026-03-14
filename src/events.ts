import { EventEmitter } from "node:events";
import * as FileSystem from "@effect/platform/FileSystem";
import { join } from "node:path";
import { Effect } from "effect";
import type { SmithersEvent } from "./SmithersEvent";
import { fromPromise } from "./effect/interop";
import { runPromise } from "./effect/runtime";
import { trackEvent } from "./effect/metrics";

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
    return Effect.gen(this, function* () {
      yield* Effect.sync(() => this.emit("event", event));
      yield* trackEvent(event);
      if (this.db) {
        yield* this.persistDbEffect(event);
      }
    }).pipe(
      Effect.annotateLogs({ runId: event.runId, eventType: event.type }),
      Effect.withLogSpan(`event:${event.type}`),
    );
  }

  async emitEvent(event: SmithersEvent) {
    await runPromise(this.emitEventEffect(event));
  }

  emitEventWithPersistEffect(event: SmithersEvent) {
    return Effect.gen(this, function* () {
      yield* Effect.sync(() => this.emit("event", event));
      yield* this.persistEffect(event);
    }).pipe(
      Effect.annotateLogs({ runId: event.runId, eventType: event.type }),
      Effect.withLogSpan(`event:${event.type}:persist`),
    );
  }

  async emitEventWithPersist(event: SmithersEvent) {
    await runPromise(this.emitEventWithPersistEffect(event));
  }

  emitEventQueued(event: SmithersEvent): Promise<void> {
    this.emit("event", event);
    return runPromise(this.enqueuePersistEffect(event));
  }

  flushEffect() {
    return fromPromise("flush queued events", async () => {
      await this.persistTail;
      if (this.persistError) {
        const err = this.persistError;
        this.persistError = null;
        throw err;
      }
    }).pipe(Effect.withLogSpan("event:flush"));
  }

  async flush(): Promise<void> {
    await runPromise(this.flushEffect());
  }

  persistEffect(event: SmithersEvent) {
    return Effect.gen(this, function* () {
      yield* this.persistDbEffect(event);
      const persistedLog = yield* Effect.either(this.persistLogEffect(event));
      if (persistedLog._tag === "Left") {
        yield* Effect.logWarning(
          `[smithers] failed to append event log: ${persistedLog.left instanceof Error ? persistedLog.left.message : String(persistedLog.left)}`,
        );
      }
    }).pipe(
      Effect.annotateLogs({ runId: event.runId, eventType: event.type }),
      Effect.withLogSpan("event:persist"),
    );
  }

  async persist(event: SmithersEvent) {
    await runPromise(this.persistEffect(event));
  }

  private enqueuePersistEffect(event: SmithersEvent) {
    const task = this.persistTail.then(() => runPromise(this.persistEffect(event)));
    this.persistTail = task.catch((error) => {
      this.persistError = error;
    });
    return fromPromise("enqueue event persistence", () => task);
  }

  private persistDbEffect(event: SmithersEvent) {
    if (!this.db) return Effect.void;
    const payloadJson = JSON.stringify(event);
    if (typeof this.db.insertEventWithNextSeq === "function") {
      if (typeof this.db.insertEventWithNextSeqEffect === "function") {
        return this.db.insertEventWithNextSeqEffect({
          runId: event.runId,
          timestampMs: event.timestampMs,
          type: event.type,
          payloadJson,
        });
      }
      return fromPromise("persist event db row", () =>
        this.db.insertEventWithNextSeq({
          runId: event.runId,
          timestampMs: event.timestampMs,
          type: event.type,
          payloadJson,
        }),
      );
    }
    if (typeof this.db.insertEventEffect === "function") {
      return this.db.insertEventEffect({
        runId: event.runId,
        seq: this.seq++,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson,
      });
    }
    return fromPromise("persist event db row", () =>
      this.db.insertEvent({
        runId: event.runId,
        seq: this.seq++,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson,
      }),
    );
  }

  private persistLogEffect(event: SmithersEvent) {
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
}
