import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SmithersEvent } from "./SmithersEvent";

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

  async emitEvent(event: SmithersEvent) {
    this.emit("event", event);
    if (this.db) {
      await this.persistDb(event);
    }
  }

  async emitEventWithPersist(event: SmithersEvent) {
    this.emit("event", event);
    await this.persist(event);
  }

  emitEventQueued(event: SmithersEvent): Promise<void> {
    this.emit("event", event);
    return this.enqueuePersist(event);
  }

  async flush(): Promise<void> {
    await this.persistTail;
    if (this.persistError) {
      const err = this.persistError;
      this.persistError = null;
      throw err;
    }
  }

  async persist(event: SmithersEvent) {
    await this.persistDb(event);
    try {
      await this.persistLog(event);
    } catch (error) {
      console.warn(
        `[smithers] failed to append event log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private enqueuePersist(event: SmithersEvent): Promise<void> {
    const task = this.persistTail.then(() => this.persist(event));
    this.persistTail = task.catch((error) => {
      this.persistError = error;
    });
    return task;
  }

  private async persistDb(event: SmithersEvent) {
    if (!this.db) return;
    const payloadJson = JSON.stringify(event);
    if (typeof this.db.insertEventWithNextSeq === "function") {
      await this.db.insertEventWithNextSeq({
        runId: event.runId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson,
      });
      return;
    }
    await this.db.insertEvent({
      runId: event.runId,
      seq: this.seq++,
      timestampMs: event.timestampMs,
      type: event.type,
      payloadJson,
    });
  }

  private async persistLog(event: SmithersEvent) {
    if (!this.logDir) return;
    const dir = this.logDir;
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, "stream.ndjson");
    const line = JSON.stringify(event) + "\n";
    await fs.appendFile(file, line, "utf8");
  }
}
