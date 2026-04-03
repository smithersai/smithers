import { cosineSimilarity } from "ai";
import { Effect, Metric } from "effect";
import { fromSync } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { nowMs } from "../utils/time";
import { ragRetrieveDuration } from "./metrics";
import type {
  Chunk,
  EmbeddedChunk,
  RetrievalResult,
  VectorQueryOptions,
  VectorStore,
} from "./types";

// ---------------------------------------------------------------------------
// SQLite vector store
// ---------------------------------------------------------------------------

const TABLE_NAME = "_smithers_vectors";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  metadata_json TEXT,
  document_id TEXT,
  chunk_index INTEGER,
  created_at_ms INTEGER NOT NULL
)`;

function floatArrayToBlob(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i]!, i * 4);
  }
  return buf;
}

function blobToFloatArray(buf: Buffer): number[] {
  const arr: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    arr.push(buf.readFloatLE(i));
  }
  return arr;
}

type SqliteRow = {
  id: string;
  namespace: string;
  content: string;
  embedding: Buffer;
  dimensions: number;
  metadata_json: string | null;
  document_id: string | null;
  chunk_index: number | null;
  created_at_ms: number;
};

export function createSqliteVectorStore(
  db: any,
  tableName?: string,
): VectorStore {
  const table = tableName ?? TABLE_NAME;

  // Ensure table exists
  const client = db.$client ?? db;
  if (typeof client.exec === "function") {
    client.exec(
      CREATE_TABLE_SQL.replace(TABLE_NAME, table),
    );
  }

  return {
    async upsert(chunks: EmbeddedChunk[], namespace?: string): Promise<void> {
      const ns = namespace ?? "default";
      const ts = nowMs();
      const stmt = client.prepare(
        `INSERT OR REPLACE INTO ${table} (id, namespace, content, embedding, dimensions, metadata_json, document_id, chunk_index, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of chunks) {
        const blob = floatArrayToBlob(chunk.embedding);
        stmt.run(
          chunk.id,
          ns,
          chunk.content,
          blob,
          chunk.embedding.length,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          chunk.documentId,
          chunk.index,
          ts,
        );
      }
    },

    async query(
      embedding: number[],
      options?: VectorQueryOptions,
    ): Promise<RetrievalResult[]> {
      const ns = options?.namespace ?? "default";
      const topK = options?.topK ?? 10;

      const rows: SqliteRow[] = client
        .prepare(
          `SELECT id, namespace, content, embedding, dimensions, metadata_json, document_id, chunk_index, created_at_ms FROM ${table} WHERE namespace = ?`,
        )
        .all(ns) as SqliteRow[];

      const scored: RetrievalResult[] = [];
      for (const row of rows) {
        const stored = blobToFloatArray(
          Buffer.isBuffer(row.embedding)
            ? row.embedding
            : Buffer.from(row.embedding as any),
        );
        const score = cosineSimilarity(embedding, stored);
        const chunk: Chunk = {
          id: row.id,
          documentId: row.document_id ?? "",
          content: row.content,
          index: row.chunk_index ?? 0,
          metadata: row.metadata_json
            ? JSON.parse(row.metadata_json)
            : undefined,
        };
        scored.push({
          chunk,
          score,
          metadata: chunk.metadata,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },

    async delete(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      client
        .prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`)
        .run(...ids);
    },

    async count(namespace?: string): Promise<number> {
      const ns = namespace ?? "default";
      const row = client
        .prepare(
          `SELECT COUNT(*) as cnt FROM ${table} WHERE namespace = ?`,
        )
        .get(ns) as { cnt: number };
      return row?.cnt ?? 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Effect wrappers
// ---------------------------------------------------------------------------

export function upsertEffect(
  store: VectorStore,
  chunks: EmbeddedChunk[],
  namespace?: string,
) {
  return fromSync("rag vector upsert", () =>
    store.upsert(chunks, namespace),
  ).pipe(
    Effect.annotateLogs({ operation: "vectorUpsert", count: chunks.length }),
    Effect.withLogSpan("rag:vector-upsert"),
  );
}

export function queryEffect(
  store: VectorStore,
  embedding: number[],
  options?: VectorQueryOptions,
) {
  return Effect.gen(function* () {
    const start = performance.now();
    const results = yield* fromSync("rag vector query", () =>
      store.query(embedding, options),
    );
    yield* Metric.update(ragRetrieveDuration, performance.now() - start);
    return results;
  }).pipe(
    Effect.annotateLogs({ operation: "vectorQuery" }),
    Effect.withLogSpan("rag:vector-query"),
  );
}
