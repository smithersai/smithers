/**
 * Thread and message operations of the SQL memory store.
 *
 * @since 0.1.0
 */

import { DurableWriter } from "@smthrs/database"
import * as Dialect from "@smthrs/database/Dialect"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import type { DatabaseService } from "../Database.ts"
import type { GetThreadInput, Service } from "../MemoryStore.ts"
import type * as Namespace from "../Namespace.ts"
import { canonicalJson } from "./Canonical.ts"
import { resolveNamespace } from "./ResolveNamespace.ts"
import {
  decodeJson,
  decodeThread,
  encodeJson,
  error,
  type Fragment,
  type MessageRow,
  storeError,
  type ThreadRow,
  validateLimit,
  validateNonEmpty,
  validateTime
} from "./Store.ts"

const THREAD_COLUMNS = "thread_id, namespace_kind, namespace_id, title, metadata_json, created_at_ms, updated_at_ms"
const MESSAGE_COLUMNS = "thread_id, id, role, text, at_ms"

const DELETE_MESSAGES_CHUNK_SIZE = 900

/**
 * Builds the thread and message operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (database: DatabaseService, random: typeof SecureRandom.SecureRandom.Service): Pick<
  Service,
  | "createThread"
  | "getThread"
  | "listThreads"
  | "deleteThread"
  | "appendMessage"
  | "appendMessageOnce"
  | "listMessages"
  | "countMessages"
  | "messageStats"
  | "listThreadRefs"
  | "deleteMessages"
  | "compactMessages"
> => {
  const { sql } = database
  const threadColumns = sql.literal(THREAD_COLUMNS)
  const messageColumns = sql.literal(MESSAGE_COLUMNS)

  // A thread id names a thread only inside its namespace, so every statement
  // keyed by a thread id carries the namespace predicate too.
  const inThread = (namespace: Namespace.Namespace, threadId: string): Fragment =>
    sql`namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id} AND thread_id = ${threadId}`

  // Resolves the namespace and validates the thread id every scoped call names.
  const scope = (input: GetThreadInput) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      return namespace
    })

  const getThread: Service["getThread"] = (input) =>
    Effect.gen(function*() {
      const namespace = yield* scope(input)
      const rows = yield* sql<ThreadRow>`SELECT ${threadColumns}
        FROM memory_threads WHERE ${inThread(namespace, input.threadId)} LIMIT 1`.pipe(
        Effect.mapError(storeError("could not read memory thread"))
      )
      return rows[0] === undefined ? undefined : yield* decodeThread(rows[0])
    })

  const createThread: Service["createThread"] = (input) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      const id = input.id ?? (yield* random.uuidV4().pipe(
        Effect.catchCause((cause) =>
          Effect.fail(error("store", "could not generate memory thread id", Cause.squash(cause)))
        )
      ))
      yield* validateNonEmpty(id, "threadId", ["id"])
      const metadataJson = input.metadata === undefined
        ? null
        : canonicalJson(
          yield* decodeJson(
            yield* encodeJson(input.metadata, "thread metadata", ["metadata"]),
            "thread metadata"
          )
        )
      const now = yield* Clock.currentTimeMillis
      return yield* database.write(
        Effect.gen(function*() {
          const inserted = yield* sql`INSERT INTO memory_threads (${threadColumns}) VALUES (
              ${id}, ${namespace.kind}, ${namespace.id}, ${input.title ?? null}, ${metadataJson}, ${now}, ${now}
            ) ON CONFLICT (namespace_kind, namespace_id, thread_id) DO NOTHING`.raw
          const rows = yield* sql<ThreadRow>`SELECT ${threadColumns}
            FROM memory_threads WHERE ${inThread(namespace, id)} LIMIT 1`
          const existing = rows[0]
          if (existing === undefined) {
            return yield* Effect.fail(error("store", "created memory thread could not be read back"))
          }
          if ((yield* DurableWriter.affectedRows(inserted)) === 0) {
            const existingMetadata = existing.metadata_json === null
              ? null
              : canonicalJson(yield* decodeJson(existing.metadata_json, "thread metadata"))
            if (existing.title !== (input.title ?? null) || existingMetadata !== metadataJson) {
              return yield* Effect.fail(
                error(
                  "idempotency_conflict",
                  `thread id "${id}" already exists with different creation data`,
                  undefined,
                  ["threadId"]
                )
              )
            }
          }
          return yield* decodeThread(existing)
        })
      ).pipe(Effect.mapError(storeError("could not create memory thread")))
    })

  const listThreads: Service["listThreads"] = (input = {}) =>
    Effect.gen(function*() {
      const namespace = input.namespace === undefined
        ? undefined
        : (yield* resolveNamespace(input.namespace)).namespace
      const where = namespace === undefined
        ? sql.literal("")
        : sql`WHERE namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id}`
      const rows = yield* sql<ThreadRow>`SELECT ${threadColumns}
        FROM memory_threads
        ${where}
        ORDER BY created_at_ms, thread_id`.pipe(
        Effect.mapError(storeError("could not list memory threads"))
      )
      return yield* Effect.forEach(rows, decodeThread)
    })

  const deleteThread: Service["deleteThread"] = (input) =>
    Effect.gen(function*() {
      const thread = inThread(yield* scope(input), input.threadId)
      return yield* database.write(
        Effect.gen(function*() {
          yield* sql`DELETE FROM memory_messages WHERE ${thread}`
          const result = yield* sql`DELETE FROM memory_threads WHERE ${thread}`.raw
          return (yield* DurableWriter.affectedRows(result)) > 0
        })
      ).pipe(Effect.mapError(storeError("could not delete memory thread")))
    })

  const appendMessageOnce: Service["appendMessageOnce"] = (input) =>
    Effect.gen(function*() {
      const namespace = yield* scope(input)
      const thread = inThread(namespace, input.threadId)
      yield* validateNonEmpty(input.id, "message id", ["id"])
      yield* validateNonEmpty(input.role, "message role", ["role"])
      if (input.at !== undefined) yield* validateTime(input.at, "message at", ["at"])
      return yield* database.write(
        Effect.gen(function*() {
          const at = input.at ?? (yield* Clock.currentTimeMillis)
          // An append to a thread nobody created makes it in the caller's
          // namespace, never in a shared one another caller could reach.
          yield* sql`INSERT INTO memory_threads (
            thread_id, namespace_kind, namespace_id, created_at_ms, updated_at_ms
          )
            VALUES (${input.threadId}, ${namespace.kind}, ${namespace.id}, ${at}, ${at})
            ON CONFLICT (namespace_kind, namespace_id, thread_id) DO NOTHING`
          const inserted = yield* sql`INSERT INTO memory_messages (
              namespace_kind, namespace_id, thread_id, id, role, text, at_ms
            )
            VALUES (
              ${namespace.kind}, ${namespace.id}, ${input.threadId}, ${input.id}, ${input.role}, ${input.text}, ${at}
            )
            ON CONFLICT (namespace_kind, namespace_id, thread_id, id) DO NOTHING`.raw
          if ((yield* DurableWriter.affectedRows(inserted)) > 0) {
            yield* sql`UPDATE memory_threads
              SET updated_at_ms = ${Dialect.greatest(sql)}(updated_at_ms, ${at})
              WHERE ${thread}`
            return { threadId: input.threadId, id: input.id, role: input.role, text: input.text, at }
          }
          const existing = yield* sql<MessageRow>`SELECT ${messageColumns}
            FROM memory_messages
            WHERE ${thread} AND id = ${input.id}
            LIMIT 1`
          const message = existing[0]
          if (message === undefined) {
            return yield* Effect.fail(error("store", "existing memory message could not be read back"))
          }
          const conflict = message.role !== input.role
            ? "role"
            : message.text !== input.text
            ? "text"
            : input.at !== undefined && Number(message.at_ms) !== input.at
            ? "at"
            : undefined
          if (conflict !== undefined) {
            return yield* Effect.fail(
              error(
                "idempotency_conflict",
                `message id "${input.id}" already exists in thread "${input.threadId}" with different ${conflict}`,
                undefined,
                [conflict]
              )
            )
          }
          return {
            threadId: message.thread_id,
            id: message.id,
            role: message.role,
            text: message.text,
            at: Number(message.at_ms)
          }
        })
      ).pipe(Effect.mapError(storeError("could not append memory message")))
    })

  // Keep the explicit-timestamp API and its strict validation unchanged.
  const appendMessage: Service["appendMessage"] = (input) =>
    validateTime(input.at, "message at", ["at"]).pipe(Effect.andThen(appendMessageOnce(input)), Effect.asVoid)

  const listMessages: Service["listMessages"] = (input) =>
    Effect.gen(function*() {
      const namespace = yield* scope(input)
      const limit = yield* validateLimit(input.limit, "listMessages")
      if (limit === 0) return []
      // Summary ids use a leading control character. Locale collations can
      // ignore it, so ordering and pagination must use the same byte order.
      const messageId = sql.literal(Dialect.isPostgres(sql) ? "id COLLATE \"C\"" : "id COLLATE BINARY")
      const conditions: Array<Fragment> = [inThread(namespace, input.threadId)]
      if (input.cursor !== undefined) {
        yield* validateTime(input.cursor.at, "message cursor at", ["cursor", "at"])
        yield* validateNonEmpty(input.cursor.id, "message cursor id", ["cursor", "id"])
        conditions.push(
          sql`(at_ms > ${input.cursor.at} OR (at_ms = ${input.cursor.at} AND ${messageId} > ${input.cursor.id}))`
        )
      }
      const bound = limit === undefined ? sql.literal("") : sql`LIMIT ${limit}`
      const rows = yield* sql<MessageRow>`SELECT ${messageColumns}
        FROM memory_messages
        WHERE ${sql.and(conditions)}
        ORDER BY at_ms, ${messageId}
        ${bound}`.pipe(Effect.mapError(storeError("could not list memory messages")))
      return rows.map((row) => ({
        threadId: row.thread_id,
        id: row.id,
        role: row.role,
        text: row.text,
        at: Number(row.at_ms)
      }))
    })

  const countMessages: Service["countMessages"] = (input) =>
    Effect.gen(function*() {
      const namespace = yield* scope(input)
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM memory_messages WHERE ${inThread(namespace, input.threadId)}
      `.pipe(Effect.mapError(storeError("could not count memory messages")))
      // An aggregate without GROUP BY always returns exactly one row.
      return Number(rows[0]!.count)
    })

  const messageStats: Service["messageStats"] = (input) =>
    Effect.gen(function*() {
      const namespace = yield* scope(input)
      const rows = yield* sql<{ readonly count: number; readonly code_points: number; readonly bytes: number }>`
        SELECT count(*) AS count,
          COALESCE(SUM(length(text)), 0) AS code_points,
          COALESCE(SUM(${
        sql.literal(Dialect.isPostgres(sql) ? "octet_length(text)" : "length(CAST(text AS BLOB))")
      }), 0) AS bytes
        FROM memory_messages WHERE ${inThread(namespace, input.threadId)}
      `.pipe(Effect.mapError(storeError("could not measure memory messages")))
      // An aggregate without GROUP BY always returns exactly one row; COALESCE fills empty sums.
      const row = rows[0]!
      return { messages: Number(row.count), codePoints: Number(row.code_points), bytes: Number(row.bytes) }
    })

  const deleteMessageRows = (thread: Fragment, ids: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      let deleted = 0
      for (let offset = 0; offset < ids.length; offset += DELETE_MESSAGES_CHUNK_SIZE) {
        const chunk = ids.slice(offset, offset + DELETE_MESSAGES_CHUNK_SIZE)
        const result = yield* sql`DELETE FROM memory_messages
          WHERE ${thread} AND ${sql.in("id", chunk)}`.raw
        deleted += yield* DurableWriter.affectedRows(result)
      }
      return deleted
    })

  const listThreadRefs: Service["listThreadRefs"] = sql<
    Pick<ThreadRow, "thread_id" | "namespace_kind" | "namespace_id">
  >`
    SELECT namespace_kind, namespace_id, thread_id FROM memory_threads
    ORDER BY created_at_ms, namespace_kind, namespace_id, thread_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ namespace: { kind: row.namespace_kind, id: row.namespace_id }, threadId: row.thread_id }))
    ),
    Effect.mapError(storeError("could not list memory threads"))
  )

  const deleteMessages: Service["deleteMessages"] = (input) =>
    Effect.gen(function*() {
      const namespace = yield* scope(input)
      const ids = Array.from(new Set(input.ids))
      if (ids.length === 0) {
        return 0
      }
      return yield* database.write(deleteMessageRows(inThread(namespace, input.threadId), ids)).pipe(
        Effect.mapError(storeError("could not delete memory messages"))
      )
    })

  const compactMessages: Service["compactMessages"] = (input) => {
    // Capture scalar payloads now so caller mutation cannot change a suspended write.
    const threadId = input.threadId
    const owner = typeof input.namespace === "string" ? input.namespace : { ...input.namespace }
    const summary = { ...input.summary }
    const sources = input.sourceMessages.map((message) => ({ ...message }))
    return Effect.gen(function*() {
      const namespace = yield* scope({ namespace: owner, threadId })
      const thread = inThread(namespace, threadId)
      yield* validateNonEmpty(summary.id, "summary id", ["summary", "id"])
      yield* validateNonEmpty(summary.role, "summary role", ["summary", "role"])
      yield* validateTime(summary.at, "summary at", ["summary", "at"])
      if (summary.threadId !== threadId) {
        return yield* Effect.fail(
          error(
            "invalid_argument",
            "summary threadId must match the compacted thread",
            undefined,
            ["summary", "threadId"]
          )
        )
      }
      if (sources.some((message) => message.threadId !== threadId)) {
        return yield* Effect.fail(
          error("invalid_argument", "source threadId must match the compacted thread", undefined, ["sourceMessages"])
        )
      }
      const ids = Array.from(new Set(sources.map((message) => message.id))).filter((id) => id !== summary.id)
      if (ids.length === 0) {
        return 0
      }
      return yield* database.write(
        Effect.gen(function*() {
          // Preserve the existing-summary error even on a retry whose sources are gone.
          const existing = yield* sql<MessageRow>`SELECT ${messageColumns}
            FROM memory_messages WHERE ${thread} AND id = ${summary.id}`
          if (existing.length > 0) {
            return yield* Effect.fail(
              error(
                "idempotency_conflict",
                `summary id "${summary.id}" already exists`,
                undefined,
                ["summary", "id"]
              )
            )
          }
          for (let offset = 0; offset < sources.length; offset += DELETE_MESSAGES_CHUNK_SIZE) {
            const chunk = sources.slice(offset, offset + DELETE_MESSAGES_CHUNK_SIZE)
            const rows = yield* sql<MessageRow>`SELECT ${messageColumns}
              FROM memory_messages WHERE ${thread} AND ${sql.in("id", chunk.map((message) => message.id))}`
            const byId = new Map(rows.map((row) => [row.id, row]))
            for (const source of chunk) {
              const row = byId.get(source.id)
              if (
                row === undefined || row.role !== source.role || row.text !== source.text ||
                Number(row.at_ms) !== source.at
              ) {
                return yield* Effect.fail(
                  error(
                    "compaction_conflict",
                    `source message "${source.id}" changed or disappeared before compaction`,
                    undefined,
                    ["sourceMessages"]
                  )
                )
              }
            }
          }
          yield* sql`INSERT INTO memory_messages (
              namespace_kind, namespace_id, thread_id, id, role, text, at_ms
            )
            VALUES (
              ${namespace.kind}, ${namespace.id}, ${threadId}, ${summary.id}, ${summary.role}, ${summary.text},
              ${summary.at}
            )`
          return yield* deleteMessageRows(thread, ids)
        })
      ).pipe(Effect.mapError(storeError("could not compact memory history")))
    })
  }

  return {
    createThread,
    getThread,
    listThreads,
    deleteThread,
    appendMessage,
    appendMessageOnce,
    listMessages,
    countMessages,
    messageStats,
    listThreadRefs,
    deleteMessages,
    compactMessages
  }
}
