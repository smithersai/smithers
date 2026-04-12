import { and, desc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect, Layer, Metric } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { dbQueryDuration } from "@smithers/observability/metrics";
import { nowMs } from "@smithers/scheduler/nowMs";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { MemoryNamespace } from "../MemoryNamespace";
import type { MemoryFact } from "../MemoryFact";
import type { MemoryThread } from "../MemoryThread";
import type { MemoryMessage } from "../MemoryMessage";
import { namespaceToString } from "../namespaceToString";
import {
  smithersMemoryFacts,
  smithersMemoryThreads,
  smithersMemoryMessages,
} from "../schema";
import { memoryFactReads } from "../memoryFactReads";
import { memoryFactWrites } from "../memoryFactWrites";
import { memoryMessageSaves } from "../memoryMessageSaves";
import type { MemoryStore } from "./MemoryStore";
import { MemoryStoreDb } from "./MemoryStoreDb";
import { MemoryStoreService } from "./MemoryStoreService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEffect<A>(
  label: string,
  operation: () => PromiseLike<A>,
): Effect.Effect<A, SmithersError> {
  return Effect.gen(function* () {
    const start = performance.now();
    const result = yield* Effect.tryPromise({
      try: () => operation(),
      catch: (cause) => toSmithersError(cause, label, {
        code: "DB_QUERY_FAILED",
        details: { operation: label },
      }),
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
    const result = yield* Effect.tryPromise({
      try: () => operation(),
      catch: (cause) => toSmithersError(cause, label, {
        code: "DB_WRITE_FAILED",
        details: { operation: label },
      }),
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

function makeMemoryStore(db: BunSQLiteDatabase<any>): MemoryStore {
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
    getFact: (ns, key) => Effect.runPromise(getFactEffect(ns, key)),
    setFact: (ns, key, value, ttlMs) => Effect.runPromise(setFactEffect(ns, key, value, ttlMs)),
    deleteFact: (ns, key) => Effect.runPromise(deleteFactEffect(ns, key)),
    listFacts: (ns) => Effect.runPromise(listFactsEffect(ns)),
    createThread: (ns, title) => Effect.runPromise(createThreadEffect(ns, title)),
    getThread: (threadId) => Effect.runPromise(getThreadEffect(threadId)),
    deleteThread: (threadId) => Effect.runPromise(deleteThreadEffect(threadId)),
    saveMessage: (msg) => Effect.runPromise(saveMessageEffect(msg)),
    listMessages: (threadId, limit) => Effect.runPromise(listMessagesEffect(threadId, limit)),
    countMessages: (threadId) => Effect.runPromise(countMessagesEffect(threadId)),
    deleteExpiredFacts: () => Effect.runPromise(deleteExpiredFactsEffect()),

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

export const MemoryStoreLive = Layer.effect(
  MemoryStoreService,
  Effect.map(MemoryStoreDb, (db) => makeMemoryStore(db)),
);
