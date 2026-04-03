import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { PersistedAppSnapshot } from "../shared/types.js";

const SCHEMA_VERSION = 1;

export class PersistenceService {
  private readonly db: Database;

  constructor(private readonly rootDir: string) {
    const dbPath = resolve(rootDir, ".smithers/state/ui-v2.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ui_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  loadSnapshot(): PersistedAppSnapshot | null {
    const row = this.db
      .query("SELECT value_json FROM ui_state WHERE key = ? LIMIT 1")
      .get("snapshot") as { value_json?: string } | null;
    if (!row?.value_json) return null;
    try {
      const snapshot = JSON.parse(row.value_json) as PersistedAppSnapshot;
      return snapshot.version === SCHEMA_VERSION ? snapshot : null;
    } catch {
      return null;
    }
  }

  saveSnapshot(snapshot: PersistedAppSnapshot) {
    const payload = JSON.stringify({
      ...snapshot,
      version: SCHEMA_VERSION,
    });
    this.db
      .query(
        `
        INSERT INTO ui_state (key, value_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at_ms = excluded.updated_at_ms
      `,
      )
      .run("snapshot", payload, Date.now());
  }

  close() {
    try {
      this.db.close();
    } catch {
      // best effort
    }
  }
}
