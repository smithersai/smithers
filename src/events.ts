import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SmithersEvent } from "./types";

export class EventBus extends EventEmitter {
  private seq = 0;
  private logDir?: string;
  private db?: any;

  constructor(opts: { db?: any; logDir?: string; startSeq?: number }) {
    super();
    this.db = opts.db;
    this.logDir = opts.logDir;
    this.seq = opts.startSeq ?? 0;
  }

  async emitEvent(event: SmithersEvent) {
    this.emit("event", event);
    if (this.db) {
      await this.db.insertEvent?.({
        runId: event.runId,
        seq: this.seq++,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
      });
    }
  }

  async emitEventWithPersist(event: SmithersEvent) {
    this.emit("event", event);
    await this.persist(event);
  }

  async persist(event: SmithersEvent) {
    await this.persistDb(event);
    await this.persistLog(event);
  }

  private async persistDb(event: SmithersEvent) {
    if (!this.db) return;
    const payloadJson = JSON.stringify(event);
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
