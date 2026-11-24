/**
 * In-process semantic recall and best-effort vector projection.
 *
 * V1 intentionally brute-forces cosine similarity over the selected banks;
 * sqlite-vec is deferred to an optimization ticket. Projection is advisory:
 * authoritative MemoryStore writes complete first, projection failures retry
 * once, time out after `Options.projectionTimeout`, and are logged and counted
 * on {@link projectionFailures} without changing the write result;
 * {@link reconcile} repairs the projections such a failure left missing or
 * stale. The vector upsert checks projected text against
 * the authoritative row in the writer transaction, even when write clocks
 * collide or regress.
 *
 * @see https://memory.smithers.sh/reference/api/
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as RcMap from "effect/RcMap"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { DatabaseService } from "./Database.ts"
import * as Embedding from "./Embedding.ts"
import { digest } from "./internal/Digest.ts"
import { searchableText } from "./internal/FactProjection.ts"
import { cosine, recency } from "./internal/Ranking.ts"
import { bankForNamespace, resolveBanks, resolveNamespace } from "./internal/ResolveNamespace.ts"
import { vectorBytes } from "./internal/VectorBytes.ts"
import * as MemoryError from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"
import * as Recall from "./Recall.ts"

/**
 * Durable vector projection row. `recordKind` and `recordId` name the
 * authoritative fact or note the vector describes; a fact's id is its key and
 * a note's id is its note id.
 *
 * @category models
 * @since 0.1.0
 */
export interface Vector {
  readonly bank: string
  readonly recordKind: "fact" | "note"
  readonly recordId: string
  readonly model: string
  readonly contentDigest: string
  /** Authoritative searchable text, when projecting a committed memory row. */
  readonly text?: string
  readonly dimensions: number
  readonly vector: ReadonlyArray<number> | Float32Array
  readonly updatedAtMs: number
}

/**
 * Injectable vector-table adapter for semantic recall.
 *
 * @category services
 * @since 0.1.0
 */
export interface VectorStore {
  /**
   * Finite scan of selected banks/model, in pages of at most 64 vectors.
   * Emit each projection identity at most once. The SQL adapter bounds each
   * bank by its opening count and observes concurrent changes per page.
   */
  readonly scan: (
    banks: ReadonlyArray<string>,
    model: string
  ) => Stream.Stream<ReadonlyArray<Vector>, MemoryError.MemoryError>
  /**
   * Store a projection. SQL adapters accept projections carrying authoritative
   * text only while that text still matches the committed row; direct vector
   * inserts without text retain timestamp-based ordering.
   */
  readonly upsert: (vector: Vector) => Effect.Effect<void, MemoryError.MemoryError>
}

/**
 * Semantic recall configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly vectorStore: VectorStore
  /**
   * The embedding model vectors are stamped with and filtered by. Absent, the
   * `Embedding` service's own `model` is used, then {@link defaultModel}. When
   * both name a model and they differ, recall and {@link reconcile} fail with
   * `vector_model_mismatch` and a projection is counted as failed.
   */
  readonly model?: string
  readonly halfLifeMs?: number
  /**
   * Deadline for one after-commit projection, embedding and vector write
   * included. A projection that exceeds it is logged and dropped like any
   * other failure. Defaults to `defaultProjectionTimeout`.
   */
  readonly projectionTimeout?: Duration.Input | undefined
}

interface SqlVectorRow {
  readonly record_kind: "fact" | "note"
  readonly record_id: string
  readonly namespace_kind: Namespace.Kind
  readonly namespace_id: string
  readonly embedding_model: string
  readonly content_digest: string
  readonly dimensions: number
  readonly vector_bytes: Uint8Array
  readonly updated_at_ms: number
}

/**
 * Deterministic result limits for the three semantic budgets.
 *
 * @category constants
 * @since 0.1.0
 */
export const budgetLimits = {
  low: 3,
  mid: 8,
  high: 20
} as const

/**
 * The embedding model semantic recall uses when a declaration names none: the
 * lexical in-process hash. Name a provider-backed model for semantic
 * similarity.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultModel = Embedding.inProcessModel

/**
 * The projection deadline used when `Options.projectionTimeout` is absent.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultProjectionTimeout: Duration.Input = "5 seconds"
const defaultHalfLifeMs = 7 * 24 * 60 * 60 * 1000

const maximumDimensions = 65_536
const vectorPageSize = 64

// A corrupt row fails the scan, so the failure names the row an operator has
// to find and delete: namespace, record kind, record id, and model.
const readVector = (row: SqlVectorRow): Effect.Effect<Float32Array, MemoryError.MemoryError> => {
  const bytes = row.vector_bytes
  const dimensions = row.dimensions
  const path = [row.namespace_kind, row.namespace_id, row.record_kind, row.record_id, row.embedding_model]
  const identity = `${row.namespace_kind}/${row.namespace_id} ${row.record_kind}/${row.record_id}` +
    ` (model ${row.embedding_model})`
  return !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > maximumDimensions ||
      bytes.byteLength !== dimensions * 4
    ? Effect.fail(
      new MemoryError.MemoryError({
        code: "store",
        message: `stored memory vector ${identity} has invalid dimensions or byte length`,
        path
      })
    )
    : Effect.try({
      try: () => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const vector = new Float32Array(dimensions)
        for (let index = 0; index < dimensions; index++) vector[index] = view.getFloat32(index * 4, true)
        return vector
      },
      catch: (cause) =>
        new MemoryError.MemoryError({
          code: "store",
          message: `stored memory vector ${identity} could not be decoded`,
          path,
          cause
        })
    }).pipe(Effect.flatMap((vector) => {
      const index = vector.findIndex((component) => !Number.isFinite(component))
      return index === -1
        ? Effect.succeed(vector)
        : Effect.fail(
          new MemoryError.MemoryError({
            code: "store",
            message: `stored memory vector ${identity} has nonfinite component at index ${index}`,
            path
          })
        )
    }))
}

const sqlError = (message: string) => (cause: unknown): MemoryError.MemoryError =>
  new MemoryError.MemoryError({ code: "store", message, cause })

const invalidArgument = (message: string, path: ReadonlyArray<string>): MemoryError.MemoryError =>
  new MemoryError.MemoryError({ code: "invalid_argument", message, path })

const validateVector = (vector: Vector): MemoryError.MemoryError | undefined => {
  if (vector.recordId.length === 0) return invalidArgument("vector recordId must not be empty", ["recordId"])
  if (vector.model.length === 0) return invalidArgument("vector model must not be empty", ["model"])
  if (vector.contentDigest.length === 0) {
    return invalidArgument("vector contentDigest must not be empty", ["contentDigest"])
  }
  if (vector.dimensions !== vector.vector.length) {
    return invalidArgument("vector dimensions must match vector length", ["dimensions"])
  }
  if (
    !Number.isSafeInteger(vector.dimensions) ||
    vector.dimensions < 1 ||
    vector.dimensions > maximumDimensions
  ) {
    return invalidArgument(`vector dimensions must be between 1 and ${maximumDimensions}`, ["dimensions"])
  }
  const invalidComponent = vector.vector.findIndex((component) => !Number.isFinite(component))
  if (invalidComponent !== -1) {
    return invalidArgument("vector components must be finite", ["vector", String(invalidComponent)])
  }
  const unrepresentable = vector.vector.findIndex((component) =>
    !Number.isFinite(Math.fround(component)) || (component !== 0 && Math.fround(component) === 0)
  )
  if (unrepresentable !== -1) {
    return invalidArgument("vector components must be representable as Float32", ["vector", String(unrepresentable)])
  }
  if (!Number.isSafeInteger(vector.updatedAtMs) || vector.updatedAtMs < 0) {
    return invalidArgument("vector updatedAtMs must be a non-negative safe integer", ["updatedAtMs"])
  }
  return undefined
}

/**
 * Builds the SQLite adapter for the migration-owned `memory_vectors` table.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeSqlVectorStore = (database: DatabaseService): VectorStore => {
  const scan: VectorStore["scan"] = (banks, model) =>
    Stream.fromEffect(resolveBanks(banks)).pipe(
      Stream.flatMap(Stream.fromIterable),
      Stream.flatMap(({ bank, namespace }) =>
        Stream.fromEffect(database.sql<{ readonly upper: number; readonly count: number }>`
          SELECT COALESCE(MAX(rowid), 0) AS upper, COUNT(*) AS count FROM memory_vectors
          WHERE namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id}
            AND embedding_model = ${model}`.pipe(Effect.mapError(sqlError("memory vector scan failed")))).pipe(
          Stream.flatMap((bounds) =>
            Stream.paginate(
              {
                after: undefined as { readonly kind: string; readonly id: string } | undefined,
                remaining: bounds[0]!.count
              },
              ({ after, remaining }) =>
                Effect.gen(function*() {
                  const continuation = after === undefined ? database.sql.literal("1 = 1") : database.sql`
          (record_kind, record_id) > (${after.kind}, ${after.id})`
                  const rows = yield* database.sql<SqlVectorRow>`
          SELECT record_kind, record_id, namespace_kind, namespace_id,
            embedding_model, content_digest, dimensions,
            CASE WHEN length(vector_bytes) <= ${maximumDimensions * 4}
              THEN vector_bytes ELSE ${new Uint8Array()} END AS vector_bytes, updated_at_ms
          FROM memory_vectors
          WHERE namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id}
            AND embedding_model = ${model} AND rowid <= ${bounds[0]!.upper} AND ${continuation}
          ORDER BY record_kind, record_id
          LIMIT ${Math.min(vectorPageSize, remaining)}`.pipe(Effect.mapError(sqlError("memory vector scan failed")))
                  const vectors = yield* Effect.forEach(rows, (row) =>
                    readVector(row).pipe(
                      Effect.map((vector): Vector => ({
                        bank,
                        recordKind: row.record_kind,
                        recordId: row.record_id,
                        model: row.embedding_model,
                        contentDigest: row.content_digest,
                        dimensions: row.dimensions,
                        vector,
                        updatedAtMs: row.updated_at_ms
                      }))
                    ))
                  const last = rows.at(-1)
                  return [
                    vectors.length === 0 ? [] : [vectors],
                    rows.length === vectorPageSize && rows.length < remaining && last !== undefined
                      ? Option.some({
                        after: { kind: last.record_kind, id: last.record_id },
                        remaining: remaining - rows.length
                      })
                      : Option.none()
                  ] as const
                })
            )
          )
        )
      )
    )
  return {
    scan,
    upsert: (vector) =>
      Effect.gen(function*() {
        const failure = validateVector(vector)
        if (failure !== undefined) return yield* Effect.fail(failure)
        const { namespace } = yield* resolveNamespace(vector.bank)
        const { sql } = database
        // The comparison and vector write share the writer transaction. Time
        // alone cannot order commits made within one millisecond (or after a
        // clock regression). Direct vector inserts retain timestamp ordering.
        const current = vector.text === undefined
          ? sql`1 = 1`
          : vector.recordKind === "note"
          ? sql`EXISTS (SELECT 1 FROM memory_notes
              WHERE id = ${vector.recordId} AND namespace_kind = ${namespace.kind}
                AND namespace_id = ${namespace.id} AND text = ${vector.text})`
          : sql`EXISTS (SELECT 1 FROM memory_facts
              WHERE fact_key = ${vector.recordId} AND namespace_kind = ${namespace.kind}
                AND namespace_id = ${namespace.id}
                AND ${
            Dialect.isPostgres(sql) ?
              sql`CASE
                  WHEN jsonb_typeof(value_json::jsonb) = 'string' THEN value_json::jsonb #>> '{}'
                  WHEN jsonb_typeof(value_json::jsonb -> 'content') = 'string'
                    THEN value_json::jsonb ->> 'content'
                  ELSE value_json END` :
              sql`CASE
                  WHEN json_type(value_json) = 'text' THEN json_extract(value_json, '$')
                  WHEN json_type(value_json) = 'object' AND json_type(value_json, '$.content') = 'text'
                    THEN json_extract(value_json, '$.content')
                  ELSE value_json END`
          } = ${vector.text})`
        yield* database.write(
          sql`
      INSERT INTO memory_vectors (
        record_kind, record_id, namespace_kind, namespace_id,
        embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
      ) SELECT
        ${vector.recordKind},
        ${vector.recordId},
        ${namespace.kind},
        ${namespace.id},
        ${vector.model},
        ${vector.contentDigest},
        ${vector.dimensions},
        ${vectorBytes(vector.vector)},
        ${vector.updatedAtMs}
      WHERE ${current}
      ON CONFLICT (
        namespace_kind, namespace_id, record_kind, record_id, embedding_model
      ) DO UPDATE SET
        content_digest = excluded.content_digest,
        dimensions = excluded.dimensions,
        vector_bytes = excluded.vector_bytes,
        updated_at_ms = excluded.updated_at_ms
      WHERE ${vector.text === undefined ? sql`excluded.updated_at_ms >= memory_vectors.updated_at_ms` : current}
    `
        ).pipe(Effect.mapError(sqlError("memory vector upsert failed")), Effect.asVoid)
      })
  }
}

const mismatch = (message: string): MemoryError.MemoryError =>
  new MemoryError.MemoryError({ code: "embedding_unavailable", message })

const vectorMismatch = (message: string): MemoryError.MemoryError =>
  new MemoryError.MemoryError({ code: "vector_model_mismatch", message })

// The vector space is named by the declaration, else by the provider. Two
// different names mean the stored vectors and the provider's vectors are
// unrelated spaces, so nothing is compared or written under either.
const resolveModel = (
  options: Options,
  embedding: Embedding.Service
): Effect.Effect<string, MemoryError.MemoryError> =>
  options.model !== undefined && embedding.model !== undefined && options.model !== embedding.model
    ? Effect.fail(
      vectorMismatch(
        `semantic memory is configured for embedding model "${options.model}" ` +
          `but the Embedding service embeds with "${embedding.model}"`
      )
    )
    : Effect.succeed(options.model ?? embedding.model ?? defaultModel)

/**
 * Semantic projections that failed, after the retry, and left a row without a
 * current vector until {@link reconcile} repairs it.
 *
 * @category metrics
 * @since 1.0.0
 */
export const projectionFailures = Metric.counter("smithers_memory_projection_failures", {
  description: "Semantic memory projections that failed and left a row without a current vector"
})

const projectionFailed = (cause: unknown): Effect.Effect<void> =>
  Metric.update(projectionFailures, 1).pipe(
    Effect.andThen(Effect.logWarning(`memory semantic projection failed: ${String(cause)}`))
  )

/**
 * Computes a semantic recall result from a vector projection and authoritative
 * rows. Foreign-model rows are skipped and matching-model dimension
 * mismatches are typed stored-data failures.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recall = (
  input: Recall.Input,
  options: Options
): Effect.Effect<Recall.Output, MemoryError.MemoryError, MemoryStore.MemoryStore | Embedding.Embedding> =>
  Effect.gen(function*() {
    const embedding = yield* Embedding.Embedding
    const store = yield* MemoryStore.MemoryStore
    const banks = yield* resolveBanks(input.banks)
    const model = yield* resolveModel(options, embedding)
    const limit = budgetLimits[input.budget ?? "mid"]
    const query = yield* embedding.embed(input.query)
    const now = yield* Clock.currentTimeMillis
    const halfLife = options.halfLifeMs ?? defaultHalfLifeMs
    if (!Number.isFinite(now) || !Number.isFinite(halfLife) || halfLife <= 0) {
      return yield* Effect.fail(mismatch("semantic recency configuration must be finite with a positive half-life"))
    }
    const ranked: Array<Recall.Result> = []
    yield* Stream.runForEach(
      options.vectorStore.scan(banks.map(({ bank }) => bank), model),
      (page) =>
        Effect.gen(function*() {
          if (page.length > vectorPageSize) {
            return yield* Effect.fail(invalidArgument("vector scan page exceeds 64 rows", ["vectorStore", "scan"]))
          }
          for (const { bank, namespace } of banks) {
            const vectors = page.filter((vector) => vector.bank === bank && vector.model === model)
            if (vectors.length === 0) continue
            if (
              vectors.some((vector) =>
                vector.dimensions !== query.vector.length || vector.vector.length !== query.vector.length
              )
            ) {
              return yield* Effect.fail(vectorMismatch("embedding dimensions do not match the query vector"))
            }
            const rows = yield* store.searchRows({
              namespace,
              status: "accepted",
              records: vectors.map((vector) => ({ kind: vector.recordKind, id: vector.recordId }))
            })
            const byIdentity = new Map(
              rows.filter((row) => row.namespace.kind === namespace.kind && row.namespace.id === namespace.id).map((
                row
              ) => [`${row.kind}\u0000${row.id}`, row] as const)
            )
            for (const vector of vectors) {
              const row = byIdentity.get(`${vector.recordKind}\u0000${vector.recordId}`)
              if (row === undefined || vector.contentDigest !== digest(searchableText(row.text))) continue
              if (row.status !== undefined && row.status !== "accepted") continue
              if (
                input.tagGroups !== undefined && !input.tagGroups.every((group) => Namespace.matches(group, row.tags))
              ) continue
              const score = cosine(query.vector, vector.vector) * recency(vector.updatedAtMs, now, halfLife)
              if (score > 0) {
                ranked.push({ bank, key: row.key, text: row.text, score, updatedAtMs: row.updatedAtMs })
                ranked.sort(Recall.compareResults)
                if (ranked.length > limit) ranked.pop()
              }
            }
          }
        })
    )
    return Recall.capRecallResults(ranked, input.maxTokens)
  })

/**
 * One authoritative row submitted for semantic projection after commit.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProjectionInput {
  readonly bank: string
  readonly recordKind: "fact" | "note"
  readonly recordId: string
  readonly text: string
  readonly updatedAtMs: number
}

// One embedding and one vector write, with every failure typed.
const projectOnce = (
  options: Options,
  model: string,
  row: ProjectionInput
): Effect.Effect<void, MemoryError.MemoryError, Embedding.Embedding> =>
  Effect.gen(function*() {
    const embedding = yield* Embedding.Embedding
    const response = yield* embedding.embed(row.text)
    yield* options.vectorStore.upsert({
      bank: row.bank,
      recordKind: row.recordKind,
      recordId: row.recordId,
      model,
      contentDigest: digest(row.text),
      text: row.text,
      dimensions: response.vector.length,
      vector: response.vector,
      updatedAtMs: row.updatedAtMs
    })
  })

/**
 * Per-record serialized semantic projection coordinator.
 *
 * @category models
 * @since 0.1.0
 */
export interface Projector {
  readonly project: (row: ProjectionInput) => Effect.Effect<void, never, Embedding.Embedding>
  readonly activeKeys: () => number
}

/**
 * Constructs the semantic projection coordinator in its owner scope.
 * Keep that scope open until all projection calls have finished.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeProjector = (options: Options): Effect.Effect<Projector, never, Scope.Scope> =>
  Effect.gen(function*() {
    let active = 0
    const locks = yield* RcMap.make({
      lookup: (_key: string) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            active++
            return Semaphore.makeUnsafe(1)
          }),
          () =>
            Effect.sync(() => {
              active--
            })
        )
    })
    const project = (row: ProjectionInput) =>
      Effect.suspend(() => {
        const snapshot = Object.freeze({
          bank: row.bank,
          recordKind: row.recordKind,
          recordId: row.recordId,
          text: row.text,
          updatedAtMs: row.updatedAtMs
        })
        return Effect.gen(function*() {
          const embedding = yield* Embedding.Embedding
          const model = yield* resolveModel(options, embedding)
          const task = projectOnce(options, model, snapshot).pipe(
            Effect.retry({ times: 1 }),
            Effect.timeout(options.projectionTimeout ?? defaultProjectionTimeout)
          )
          const identity = `${model}\u0000${snapshot.bank}\u0000${snapshot.recordKind}\u0000${snapshot.recordId}`
          yield* Effect.scoped(Effect.flatMap(RcMap.get(locks, identity), (lock) => lock.withPermit(task)))
        }).pipe(Effect.catch(projectionFailed))
      })
    return { project, activeKeys: () => active }
  })

/**
 * What one {@link reconcile} pass did.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconcileResult {
  /** Accepted rows read from the selected banks. */
  readonly examined: number
  /** Rows whose missing or stale vector was projected again. */
  readonly repaired: number
  /** Rows whose projection failed again; the next pass retries them. */
  readonly failed: number
}

const reconcilePageSize = 256

/**
 * Repairs the semantic projections of `banks`.
 *
 * A projection that failed after a write is logged and dropped, which leaves
 * the row with no vector or with one whose digest no longer matches, and
 * recall skips both. This pass reads every accepted row of each bank in pages
 * and projects again each row whose vector under the resolved model is missing
 * or stale. A row whose projection fails again is counted in `failed` and on
 * {@link projectionFailures}, and the pass continues. A store or vector-scan
 * failure fails the pass.
 *
 * The pass holds one content digest per stored vector of the bank it is
 * reading, never the vectors themselves.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reconcile = (
  banks: ReadonlyArray<string>,
  options: Options
): Effect.Effect<ReconcileResult, MemoryError.MemoryError, MemoryStore.MemoryStore | Embedding.Embedding> =>
  Effect.gen(function*() {
    const embedding = yield* Embedding.Embedding
    const store = yield* MemoryStore.MemoryStore
    const model = yield* resolveModel(options, embedding)
    let examined = 0
    let repaired = 0
    let failed = 0
    for (const { bank, namespace } of yield* resolveBanks(banks)) {
      const digests = new Map<string, string>()
      yield* Stream.runForEach(options.vectorStore.scan([bank], model), (page) =>
        Effect.sync(() => {
          for (const vector of page) digests.set(`${vector.recordKind}\u0000${vector.recordId}`, vector.contentDigest)
        }))
      for (const kind of ["fact", "note"] as const) {
        let after: MemoryStore.SearchRow | undefined
        let page: ReadonlyArray<MemoryStore.SearchRow>
        do {
          page = yield* store.searchRows({
            namespace,
            status: "accepted",
            kinds: [kind],
            limit: reconcilePageSize,
            ...(after === undefined ? {} : { after })
          })
          for (const row of page) {
            examined++
            const text = searchableText(row.text)
            if (digests.get(`${row.kind}\u0000${row.id}`) === digest(text)) continue
            const projected = yield* projectOnce(options, model, {
              bank,
              recordKind: row.kind,
              recordId: row.id,
              text,
              updatedAtMs: row.updatedAtMs
            }).pipe(
              Effect.timeout(options.projectionTimeout ?? defaultProjectionTimeout),
              Effect.as(true),
              Effect.catch((cause) => Effect.as(projectionFailed(cause), false))
            )
            if (projected) repaired++
            else failed++
          }
          after = page.at(-1)
        } while (page.length === reconcilePageSize)
      }
    }
    return { examined, repaired, failed }
  })

/**
 * Decorates authoritative fact and note writes with an after-commit semantic
 * projection. The supplied embedding service is captured so the returned
 * MemoryStore retains its ordinary no-environment write signatures.
 *
 * @category constructors
 * @since 0.1.0
 */
export const decorateStore = (
  store: MemoryStore.Service,
  projector: Projector,
  embedding: Embedding.Service
): MemoryStore.Service => {
  const project = (row: ProjectionInput): Effect.Effect<void> =>
    projector.project(row).pipe(Effect.provideService(Embedding.Embedding, embedding))
  const superviseAfterCommit = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
    effect.pipe(Effect.ignoreCause({ log: true, message: "memory semantic post-commit projection failed" }))
  return {
    ...store,
    putFact: (input) =>
      store.putFact(input).pipe(
        Effect.tap(() =>
          superviseAfterCommit(
            store.getFact({ namespace: input.namespace, key: input.key }).pipe(
              Effect.flatMap((fact) =>
                fact === undefined
                  ? Effect.void
                  : project({
                    bank: bankForNamespace(fact.namespace),
                    recordKind: "fact",
                    recordId: fact.key,
                    text: searchableText(fact.value),
                    updatedAtMs: fact.updatedAtMs
                  })
              )
            )
          )
        )
      ),
    putNote: (input) =>
      store.putNote(input).pipe(
        Effect.tap((note) =>
          superviseAfterCommit(
            project({
              bank: bankForNamespace(note.namespace),
              recordKind: "note",
              recordId: note.id,
              text: note.text,
              updatedAtMs: note.createdAtMs
            })
          )
        )
      )
  }
}

/**
 * Provides semantic recall from the MemoryStore, Embedding, and vector table.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<Recall.Recall, never, MemoryStore.MemoryStore | Embedding.Embedding> =>
  Layer.effect(
    Recall.Recall,
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const embedding = yield* Embedding.Embedding
      return Recall.Recall.of({
        recall: (input) =>
          recall(input, options).pipe(
            Effect.provideService(MemoryStore.MemoryStore, store),
            Effect.provideService(Embedding.Embedding, embedding)
          )
      })
    })
  )
