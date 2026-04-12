import { and, desc, eq, sql } from "drizzle-orm";
import { Effect, Layer, Metric } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { dbQueryDuration } from "@smithers/observability/metrics";
import { nowMs } from "@smithers/scheduler/nowMs";
import { namespaceToString } from "../namespaceToString.js";
import { smithersMemoryFacts, smithersMemoryThreads, smithersMemoryMessages, } from "../schema.js";
import { memoryFactReads } from "../memoryFactReads.js";
import { memoryFactWrites } from "../memoryFactWrites.js";
import { memoryMessageSaves } from "../memoryMessageSaves.js";
import { MemoryStoreDb } from "./MemoryStoreDb.js";
import { MemoryStoreService } from "./MemoryStoreService.js";
/** @typedef {import("./MemoryStore.ts").MemoryStore} MemoryStore */

/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * @template A
 * @param {string} label
 * @param {() => PromiseLike<A>} operation
 * @returns {Effect.Effect<A, SmithersError>}
 */
function readEffect(label, operation) {
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
    }).pipe(Effect.annotateLogs({ dbOperation: label }), Effect.withLogSpan(`memory:${label}`));
}
/**
 * @template A
 * @param {string} label
 * @param {() => PromiseLike<A>} operation
 * @returns {Effect.Effect<A, SmithersError>}
 */
function writeEffect(label, operation) {
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
    }).pipe(Effect.annotateLogs({ dbOperation: label }), Effect.withLogSpan(`memory:${label}`));
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {MemoryStore}
 */
function makeMemoryStore(db) {
    // --- Working Memory Effects ---
    /**
   * @param {MemoryNamespace} ns
   * @param {string} key
   * @returns {Effect.Effect<MemoryFact | undefined, SmithersError>}
   */
    function getFactEffect(ns, key) {
        const nsStr = namespaceToString(ns);
        return Effect.gen(function* () {
            yield* Metric.increment(memoryFactReads);
            const rows = yield* readEffect("memory getFact", () => db
                .select()
                .from(smithersMemoryFacts)
                .where(and(eq(smithersMemoryFacts.namespace, nsStr), eq(smithersMemoryFacts.key, key)))
                .limit(1));
            const row = rows[0];
            if (!row)
                return undefined;
            return {
                namespace: row.namespace,
                key: row.key,
                valueJson: row.valueJson,
                schemaSig: row.schemaSig,
                createdAtMs: row.createdAtMs,
                updatedAtMs: row.updatedAtMs,
                ttlMs: row.ttlMs,
            };
        });
    }
    /**
   * @param {MemoryNamespace} ns
   * @param {string} key
   * @param {unknown} value
   * @param {number} [ttlMs]
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function setFactEffect(ns, key, value, ttlMs) {
        const nsStr = namespaceToString(ns);
        const now = nowMs();
        return Effect.gen(function* () {
            yield* Metric.increment(memoryFactWrites);
            yield* writeEffect("memory setFact", () => db
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
            }));
        });
    }
    /**
   * @param {MemoryNamespace} ns
   * @param {string} key
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function deleteFactEffect(ns, key) {
        const nsStr = namespaceToString(ns);
        return writeEffect("memory deleteFact", () => db
            .delete(smithersMemoryFacts)
            .where(and(eq(smithersMemoryFacts.namespace, nsStr), eq(smithersMemoryFacts.key, key)))).pipe(Effect.asVoid);
    }
    /**
   * @param {MemoryNamespace} ns
   * @returns {Effect.Effect<MemoryFact[], SmithersError>}
   */
    function listFactsEffect(ns) {
        const nsStr = namespaceToString(ns);
        return readEffect("memory listFacts", () => db
            .select()
            .from(smithersMemoryFacts)
            .where(eq(smithersMemoryFacts.namespace, nsStr))
            .orderBy(smithersMemoryFacts.key)).pipe(Effect.map((rows) => rows.map((row) => ({
            namespace: row.namespace,
            key: row.key,
            valueJson: row.valueJson,
            schemaSig: row.schemaSig,
            createdAtMs: row.createdAtMs,
            updatedAtMs: row.updatedAtMs,
            ttlMs: row.ttlMs,
        }))));
    }
    // --- Thread Effects ---
    /**
   * @param {MemoryNamespace} ns
   * @param {string} [title]
   * @returns {Effect.Effect<MemoryThread, SmithersError>}
   */
    function createThreadEffect(ns, title) {
        const nsStr = namespaceToString(ns);
        const now = nowMs();
        const threadId = crypto.randomUUID();
        const thread = {
            threadId,
            namespace: nsStr,
            title: title ?? null,
            metadataJson: null,
            createdAtMs: now,
            updatedAtMs: now,
        };
        return writeEffect("memory createThread", () => db.insert(smithersMemoryThreads).values(thread)).pipe(Effect.map(() => thread));
    }
    /**
   * @param {string} threadId
   * @returns {Effect.Effect<MemoryThread | undefined, SmithersError>}
   */
    function getThreadEffect(threadId) {
        return readEffect("memory getThread", () => db
            .select()
            .from(smithersMemoryThreads)
            .where(eq(smithersMemoryThreads.threadId, threadId))
            .limit(1)).pipe(Effect.map((rows) => rows[0]));
    }
    /**
   * @param {string} threadId
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function deleteThreadEffect(threadId) {
        return Effect.gen(function* () {
            // Delete messages first
            yield* writeEffect("memory deleteThreadMessages", () => db
                .delete(smithersMemoryMessages)
                .where(eq(smithersMemoryMessages.threadId, threadId)));
            // Delete the thread
            yield* writeEffect("memory deleteThread", () => db
                .delete(smithersMemoryThreads)
                .where(eq(smithersMemoryThreads.threadId, threadId)));
        });
    }
    // --- Message Effects ---
    /**
   * @param {Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number }} msg
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function saveMessageEffect(msg) {
        return Effect.gen(function* () {
            yield* Metric.increment(memoryMessageSaves);
            yield* writeEffect("memory saveMessage", () => db.insert(smithersMemoryMessages).values({
                id: msg.id,
                threadId: msg.threadId,
                role: msg.role,
                contentJson: msg.contentJson,
                runId: msg.runId ?? null,
                nodeId: msg.nodeId ?? null,
                createdAtMs: msg.createdAtMs ?? nowMs(),
            }));
        });
    }
    /**
   * @param {string} threadId
   * @param {number} [limit]
   * @returns {Effect.Effect<MemoryMessage[], SmithersError>}
   */
    function listMessagesEffect(threadId, limit) {
        return readEffect("memory listMessages", () => {
            let query = db
                .select()
                .from(smithersMemoryMessages)
                .where(eq(smithersMemoryMessages.threadId, threadId))
                .orderBy(smithersMemoryMessages.createdAtMs);
            if (limit) {
                query = query.limit(limit);
            }
            return query;
        }).pipe(Effect.map((rows) => rows.map((row) => ({
            id: row.id,
            threadId: row.threadId,
            role: row.role,
            contentJson: row.contentJson,
            runId: row.runId,
            nodeId: row.nodeId,
            createdAtMs: row.createdAtMs,
        }))));
    }
    /**
   * @param {string} threadId
   * @returns {Effect.Effect<number, SmithersError>}
   */
    function countMessagesEffect(threadId) {
        return readEffect("memory countMessages", () => db
            .select({ count: sql `count(*)` })
            .from(smithersMemoryMessages)
            .where(eq(smithersMemoryMessages.threadId, threadId))).pipe(Effect.map((rows) => rows[0]?.count ?? 0));
    }
    // --- Maintenance ---
    /**
   * @returns {Effect.Effect<number, SmithersError>}
   */
    function deleteExpiredFactsEffect() {
        const now = nowMs();
        return writeEffect("memory deleteExpiredFacts", () => db
            .delete(smithersMemoryFacts)
            .where(and(sql `${smithersMemoryFacts.ttlMs} IS NOT NULL`, sql `${smithersMemoryFacts.updatedAtMs} + ${smithersMemoryFacts.ttlMs} < ${now}`))).pipe(Effect.map((result) => result?.changes ?? result?.rowsAffected ?? 0));
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
export const MemoryStoreLive = Layer.effect(MemoryStoreService, Effect.map(MemoryStoreDb, (db) => makeMemoryStore(db)));
