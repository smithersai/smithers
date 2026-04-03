import { and, desc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect, Metric } from "effect";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { dbQueryDuration } from "../effect/metrics";
import { nowMs } from "../utils/time";
import type { SmithersError } from "../utils/errors";
import type {
  MemoryNamespace,
  MemoryFact,
  MemoryThread,
  MemoryMessage,
} from "./types";
import { namespaceToString } from "./types";
import {
  smithersMemoryFacts,
  smithersMemoryThreads,
  smithersMemoryMessages,
} from "./schema";
import {
  memoryFactReads,
  memoryFactWrites,
  memoryMessageSaves,
} from "./metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryStore = {
  // Working memory
  getFact: (ns: MemoryNamespace, key: string) => Promise<MemoryFact | undefined>;
  setFact: (ns: MemoryNamespace, key: string, value: unknown, ttlMs?: number) => Promise<void>;
  deleteFact: (ns: MemoryNamespace, key: string) => Promise<void>;
  listFacts: (ns: MemoryNamespace) => Promise<MemoryFact[]>;

  // Threads
  createThread: (ns: MemoryNamespace, title?: string) => Promise<MemoryThread>;
  getThread: (threadId: string) => Promise<MemoryThread | undefined>;
  deleteThread: (threadId: string) => Promise<void>;

  // Messages
  saveMessage: (msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number }) => Promise<void>;
  listMessages: (threadId: string, limit?: number) => Promise<MemoryMessage[]>;
  countMessages: (threadId: string) => Promise<number>;

  // Maintenance
  deleteExpiredFacts: () => Promise<number>;

  // Effect variants
  getFactEffect: (ns: MemoryNamespace, key: string) => Effect.Effect<MemoryFact | undefined, SmithersError>;
  setFactEffect: (ns: MemoryNamespace, key: string, value: unknown, ttlMs?: number) => Effect.Effect<void, SmithersError>;
  deleteFactEffect: (ns: MemoryNamespace, key: string) => Effect.Effect<void, SmithersError>;
  listFactsEffect: (ns: MemoryNamespace) => Effect.Effect<MemoryFact[], SmithersError>;
  createThreadEffect: (ns: MemoryNamespace, title?: string) => Effect.Effect<MemoryThread, SmithersError>;
  getThreadEffect: (threadId: string) => Effect.Effect<MemoryThread | undefined, SmithersError>;
  deleteThreadEffect: (threadId: string) => Effect.Effect<void, SmithersError>;
  saveMessageEffect: (msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number }) => Effect.Effect<void, SmithersError>;
  listMessagesEffect: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage[], SmithersError>;
  countMessagesEffect: (threadId: string) => Effect.Effect<number, SmithersError>;
  deleteExpiredFactsEffect: () => Effect.Effect<number, SmithersError>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEffect<A>(
  label: string,
  operation: () => PromiseLike<A>,
): Effect.Effect<A, SmithersError> {
  return Effect.gen(function* () {
    const start = performance.now();
    const result = yield* fromPromise(label, operation, {
      code: "DB_QUERY_FAILED",
      details: { operation: label },
    });
    yield* Metric.update(dbQueryDuration, performance.now() - start);
    return result;
  }).pipe(
    Effect.annotateLogs({ dbOperation: label }),
    Effect.withLogSpan(`memory:${label}`),
  );
}

function writeEffect<A>(
  label: string,
  operation: () => PromiseLike<A>,
): Effect.Effect<A, SmithersError> {
  return Effect.gen(function* () {
    const start = performance.now();
    const result = yield* fromPromise(label, operation, {
      code: "DB_WRITE_FAILED",
      details: { operation: label },
    });
    yield* Metric.update(dbQueryDuration, performance.now() - start);
    return result;
  }).pipe(
    Effect.annotateLogs({ dbOperation: label }),
    Effect.withLogSpan(`memory:${label}`),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryStore(db: BunSQLiteDatabase<any>): MemoryStore {
  // --- Working Memory Effects ---

  function getFactEffect(
    ns: MemoryNamespace,
    key: string,
  ): Effect.Effect<MemoryFact | undefined, SmithersError> {
    const nsStr = namespaceToString(ns);
    return Effect.gen(function* () {
      yield* Metric.increment(memoryFactReads);
      const rows = yield* readEffect("memory getFact", () =>
        db
          .select()
          .from(smithersMemoryFacts)
          .where(
            and(
              eq(smithersMemoryFacts.namespace, nsStr),
              eq(smithersMemoryFacts.key, key),
            ),
          )
          .limit(1),
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        namespace: row.namespace,
        key: row.key,
        valueJson: row.valueJson,
        schemaSig: row.schemaSig,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
        ttlMs: row.ttlMs,
      } as MemoryFact;
    });
  }

  function setFactEffect(
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
  ): Effect.Effect<void, SmithersError> {
    const nsStr = namespaceToString(ns);
    const now = nowMs();
    return Effect.gen(function* () {
      yield* Metric.increment(memoryFactWrites);
      yield* writeEffect("memory setFact", () =>
        db
          .insert(smithersMemoryFacts)
          .values({
            namespace: nsStr,
            key,
            valueJson: JSON.stringify(value),
            createdAtMs: now,
            updatedAtMs: now,
            ttlMs: ttlMs ?? null,
          })
          .onConflictDoUpdate({
            target: [smithersMemoryFacts.namespace, smithersMemoryFacts.key],
            set: {
              valueJson: JSON.stringify(value),
              updatedAtMs: now,
              ttlMs: ttlMs ?? null,
            },
          }),
      );
    });
  }

  function deleteFactEffect(
    ns: MemoryNamespace,
    key: string,
  ): Effect.Effect<void, SmithersError> {
    const nsStr = namespaceToString(ns);
    return writeEffect("memory deleteFact", () =>
      db
        .delete(smithersMemoryFacts)
        .where(
          and(
            eq(smithersMemoryFacts.namespace, nsStr),
            eq(smithersMemoryFacts.key, key),
          ),
        ),
    ).pipe(Effect.asVoid);
  }

  function listFactsEffect(
    ns: MemoryNamespace,
  ): Effect.Effect<MemoryFact[], SmithersError> {
    const nsStr = namespaceToString(ns);
    return readEffect("memory listFacts", () =>
      db
        .select()
        .from(smithersMemoryFacts)
        .where(eq(smithersMemoryFacts.namespace, nsStr))
        .orderBy(smithersMemoryFacts.key),
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          namespace: row.namespace,
          key: row.key,
          valueJson: row.valueJson,
          schemaSig: row.schemaSig,
          createdAtMs: row.createdAtMs,
          updatedAtMs: row.updatedAtMs,
          ttlMs: row.ttlMs,
        })),
      ),
    );
  }

  // --- Thread Effects ---

  function createThreadEffect(
    ns: MemoryNamespace,
    title?: string,
  ): Effect.Effect<MemoryThread, SmithersError> {
    const nsStr = namespaceToString(ns);
    const now = nowMs();
    const threadId = crypto.randomUUID();
    const thread: MemoryThread = {
      threadId,
      namespace: nsStr,
      title: title ?? null,
      metadataJson: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    return writeEffect("memory createThread", () =>
      db.insert(smithersMemoryThreads).values(thread),
    ).pipe(Effect.map(() => thread));
  }

  function getThreadEffect(
    threadId: string,
  ): Effect.Effect<MemoryThread | undefined, SmithersError> {
    return readEffect("memory getThread", () =>
      db
        .select()
        .from(smithersMemoryThreads)
        .where(eq(smithersMemoryThreads.threadId, threadId))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] as MemoryThread | undefined));
  }

  function deleteThreadEffect(
    threadId: string,
  ): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      // Delete messages first
      yield* writeEffect("memory deleteThreadMessages", () =>
        db
          .delete(smithersMemoryMessages)
          .where(eq(smithersMemoryMessages.threadId, threadId)),
      );
      // Delete the thread
      yield* writeEffect("memory deleteThread", () =>
        db
          .delete(smithersMemoryThreads)
          .where(eq(smithersMemoryThreads.threadId, threadId)),
      );
    });
  }

  // --- Message Effects ---

  function saveMessageEffect(
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      yield* Metric.increment(memoryMessageSaves);
      yield* writeEffect("memory saveMessage", () =>
        db.insert(smithersMemoryMessages).values({
          id: msg.id,
          threadId: msg.threadId,
          role: msg.role,
          contentJson: msg.contentJson,
          runId: msg.runId ?? null,
          nodeId: msg.nodeId ?? null,
          createdAtMs: msg.createdAtMs ?? nowMs(),
        }),
      );
    });
  }

  function listMessagesEffect(
    threadId: string,
    limit?: number,
  ): Effect.Effect<MemoryMessage[], SmithersError> {
    return readEffect("memory listMessages", () => {
      let query = db
        .select()
        .from(smithersMemoryMessages)
        .where(eq(smithersMemoryMessages.threadId, threadId))
        .orderBy(smithersMemoryMessages.createdAtMs);
      if (limit) {
        query = query.limit(limit) as any;
      }
      return query;
    }).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          id: row.id,
          threadId: row.threadId,
          role: row.role,
          contentJson: row.contentJson,
          runId: row.runId,
          nodeId: row.nodeId,
          createdAtMs: row.createdAtMs,
        })),
      ),
    );
  }

  function countMessagesEffect(
    threadId: string,
  ): Effect.Effect<number, SmithersError> {
    return readEffect("memory countMessages", () =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(smithersMemoryMessages)
        .where(eq(smithersMemoryMessages.threadId, threadId)),
    ).pipe(Effect.map((rows) => rows[0]?.count ?? 0));
  }

  // --- Maintenance ---

  function deleteExpiredFactsEffect(): Effect.Effect<number, SmithersError> {
    const now = nowMs();
    return writeEffect("memory deleteExpiredFacts", () =>
      db
        .delete(smithersMemoryFacts)
        .where(
          and(
            sql`${smithersMemoryFacts.ttlMs} IS NOT NULL`,
            sql`${smithersMemoryFacts.updatedAtMs} + ${smithersMemoryFacts.ttlMs} < ${now}`,
          ),
        ),
    ).pipe(Effect.map((result: any) => result?.changes ?? result?.rowsAffected ?? 0));
  }

  // --- Build the store ---

  return {
    // Promise variants (delegate to Effect)
    getFact: (ns, key) => runPromise(getFactEffect(ns, key)),
    setFact: (ns, key, value, ttlMs) => runPromise(setFactEffect(ns, key, value, ttlMs)),
    deleteFact: (ns, key) => runPromise(deleteFactEffect(ns, key)),
    listFacts: (ns) => runPromise(listFactsEffect(ns)),
    createThread: (ns, title) => runPromise(createThreadEffect(ns, title)),
    getThread: (threadId) => runPromise(getThreadEffect(threadId)),
    deleteThread: (threadId) => runPromise(deleteThreadEffect(threadId)),
    saveMessage: (msg) => runPromise(saveMessageEffect(msg)),
    listMessages: (threadId, limit) => runPromise(listMessagesEffect(threadId, limit)),
    countMessages: (threadId) => runPromise(countMessagesEffect(threadId)),
    deleteExpiredFacts: () => runPromise(deleteExpiredFactsEffect()),

    // Effect variants
    getFactEffect,
    setFactEffect,
    deleteFactEffect,
    listFactsEffect,
    createThreadEffect,
    getThreadEffect,
    deleteThreadEffect,
    saveMessageEffect,
    listMessagesEffect,
    countMessagesEffect,
    deleteExpiredFactsEffect,
  };
}
