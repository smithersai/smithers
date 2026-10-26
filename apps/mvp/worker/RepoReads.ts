import { ImmutableCache } from "@smthrs/artifacts"
import { CodeStorage } from "@smthrs/effect-code-storage"
import { Cause, Config, Data, Effect, Layer, Metric, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { MAX_BLOB_BYTES, REFS_PAGE_SIZE, repoId, textOf, TREE_PAGE_SIZE } from "../src/features/repo/contract.ts"
import {
  type FileRead,
  RepoNotFound,
  RepoReader,
  RepoReadsPaused,
  RepoReadUnavailable,
} from "../src/features/repo/flows.ts"
import { type Refs, RefsListing, TreeListing } from "../src/features/repo/schema.ts"
import { codeOf } from "./ErrorCode.ts"
import * as RepoMetrics from "./RepoMetrics.ts"
import * as Repos from "./Repos.ts"

// Reading a cloned repository (decision 0006 §1, docs/features/repo.md#reads): one implementation for RepoApi's `GET`
// routes and the agent's `repo/tree`, `repo/read` and `repo/refs` flows. Nothing at a commit SHA changes, so every answer
// goes through the immutable cache first: a hit costs Code Storage nothing and is served over budget too. A miss checks
// this month's read budget, reads Code Storage, and meters what it read. A failed read is never cached. A repository's
// branches and tags are fixed by its one sync, so they are cached under the default branch's head commit, which names
// that sync.

/** Why a read couldn't answer: RepoApi's status and code, a file's size, and Code Storage's wait. */
export class ReadRefused extends Data.TaggedError("ReadRefused")<{
  readonly code: "not_imported" | "not_found" | "not_synced" | "too_large" | "capacity" | "unavailable"
  readonly size?: number
  readonly retryAfterMillis?: number
}> {}

/**
 * What reads need: Code Storage, Postgres for the read budget, its meter and the ready row's head, the budgets, and
 * the listing bounds.
 */
export interface Services<E = unknown, R = never> {
  readonly codeStorage: CodeStorage.Client
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  readonly budgets: Repos.Budgets
  /** The most paths a tree lists before it answers `truncated` (`REPO_TREE_MAX_PATHS`, default 50,000). */
  readonly maxTreePaths: number
  /** The most branches, and the most tags, a listing names before it answers `truncated` (`REPO_MAX_REFS`, 1,000). */
  readonly maxRefs: number
}

/** Reads `REPO_TREE_MAX_PATHS`. */
export const maxTreePaths = Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "REPO_TREE_MAX_PATHS").pipe(
  Config.withDefault(50_000),
)

/** Reads `REPO_MAX_REFS`. */
export const maxRefs = Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "REPO_MAX_REFS").pipe(
  Config.withDefault(1_000),
)

/** Code Storage's codes for a repository, ref or path it doesn't have. */
const MISSING = new Set(["not_found", "repository_not_found", "ref_not_found", "branch_not_found", "repository_deleted"])

const refusedBy = (error: CodeStorage.CodeStorageError): ReadRefused =>
  error.code === "too_large"
    ? new ReadRefused({ code: "too_large", ...(error.size === undefined ? {} : { size: error.size }) })
    : MISSING.has(error.code)
    ? new ReadRefused({ code: "not_found" })
    : new ReadRefused({
      code: "unavailable",
      ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
    })

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const decodeListing = Schema.decodeUnknownEffect(Schema.fromJsonString(TreeListing))
const decodeRefs = Schema.decodeUnknownEffect(Schema.fromJsonString(RefsListing))

/** Every page of a listing until `max` entries: what it holds, whether it stopped early, and the bytes it read. */
const pages = <A, E>(
  page: (cursor: string | undefined) => Effect.Effect<
    { readonly items: ReadonlyArray<A>; readonly nextCursor: string | undefined; readonly bytesRead: number },
    E
  >,
  max: number,
) =>
  Effect.gen(function* () {
    const items: Array<A> = []
    let cursor: string | undefined
    let bytesRead = 0
    do {
      const next = yield* page(cursor)
      bytesRead += next.bytesRead
      items.push(...next.items)
      cursor = next.nextCursor
    } while (cursor !== undefined && items.length < max)
    return { items: items.slice(0, max), truncated: cursor !== undefined || items.length > max, bytesRead }
  })

/** The reads over `services`. Each needs the `ImmutableCache` in context. */
export const make = <E, R>(services: Services<E, R>) => {
  const { codeStorage, database, budgets } = services

  /** Refuses a miss once this month's reads are spent; a budget Postgres can't read is `unavailable`. */
  const admitRead = Repos.readsSpent(budgets).pipe(
    Effect.provide(database),
    Effect.mapError(() => new ReadRefused({ code: "unavailable" })),
    Effect.flatMap((spent) => (spent ? Effect.fail(new ReadRefused({ code: "capacity" })) : Effect.void)),
  )

  /** Adds what Code Storage served to this month's reads. A meter Postgres refuses is logged, and the read answers. */
  const meter = (bytes: number) =>
    Repos.meterRead(bytes, budgets).pipe(
      Effect.provide(database),
      Effect.flatMap(RepoMetrics.recordSpend),
      Effect.catchCause((cause) =>
        Effect.logWarning("repo.meter").pipe(Effect.annotateLogs({ bytes, errorCode: codeOf(Cause.squash(cause)) }))
      ),
    )

  // A missing path at a known commit is genuinely absent. A missing commit isn't proof of absence on GitHub.
  const classifyMissing = (id: string, sha: string, error: CodeStorage.CodeStorageError) => {
    if (!MISSING.has(error.code)) return Effect.fail(refusedBy(error))
    return Effect.gen(function* () {
      const head = yield* Repos.readyHead(id).pipe(Effect.provide(database), Effect.mapError(() => new ReadRefused({ code: "unavailable" })))
      if (Option.isNone(head)) return yield* new ReadRefused({ code: "not_found" })
      const commit = yield* codeStorage.listCommits(id, { ref: sha, limit: 1 }).pipe(Effect.result)
      if (commit._tag === "Failure" && !MISSING.has(commit.failure.code)) return yield* refusedBy(commit.failure)
      if (commit._tag === "Success") yield* meter(commit.success.bytesRead)
      return yield* new ReadRefused({ code: commit._tag === "Success" && commit.success.commits.length > 0 ? "not_found" : "not_synced" })
    })
  }

  /** Every page of `id`'s files at `sha`, until `maxTreePaths`. */
  const listAll = (id: string, sha: string) =>
    Effect.map(
      pages(
        (cursor) =>
          Effect.map(
            codeStorage.listFiles(id, {
              ref: sha,
              recursive: true,
              limit: TREE_PAGE_SIZE,
              ...(cursor === undefined ? {} : { cursor }),
            }),
            (page) => ({ items: page.paths, nextCursor: page.nextCursor, bytesRead: page.bytesRead }),
          ),
        services.maxTreePaths,
      ),
      ({ items, truncated, bytesRead }) => ({ listing: { paths: items, truncated }, bytesRead }),
    )

  /** Every page of `id`'s branches, then of its tags, each until `maxRefs`. */
  const listRefs = (id: string) =>
    Effect.gen(function* () {
      const options = (cursor: string | undefined) => ({ limit: REFS_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) })
      const branches = yield* pages(
        (cursor) =>
          Effect.map(codeStorage.listBranches(id, options(cursor)), (page) => ({
            items: page.branches.map(({ name, sha }) => ({ name, sha })),
            nextCursor: page.nextCursor,
            bytesRead: page.bytesRead,
          })),
        services.maxRefs,
      )
      const tags = yield* pages(
        (cursor) =>
          Effect.map(codeStorage.listTags(id, options(cursor)), (page) => ({
            items: page.tags,
            nextCursor: page.nextCursor,
            bytesRead: page.bytesRead,
          })),
        services.maxRefs,
      )
      return {
        listing: { branches: branches.items, tags: tags.items, truncated: branches.truncated || tags.truncated },
        bytesRead: branches.bytesRead + tags.bytesRead,
      }
    })

  /** `owner/name`'s files at `sha`, as `TreeListing` JSON. */
  const tree = (owner: string, name: string, sha: string) => {
    const id = repoId(owner, name)
    return ImmutableCache.readThrough(
      ImmutableCache.key("repo.tree", id, sha),
      Effect.gen(function* () {
        yield* admitRead
        const { listing, bytesRead } = yield* listAll(id, sha).pipe(Effect.catch((error) => classifyMissing(id, sha, error)))
        yield* meter(bytesRead)
        return { bytes: encoder.encode(JSON.stringify(listing)), metadata: {} }
      }),
    ).pipe(Effect.map((entry) => entry.bytes))
  }

  /** How many files `owner/name` has at `sha`, read as `tree` reads them, so the list is cached for the first visit. */
  const files = (owner: string, name: string, sha: string) =>
    tree(owner, name, sha).pipe(
      Effect.flatMap((bytes) => Effect.orDie(decodeListing(decoder.decode(bytes)))),
      Effect.map((listing) => listing.paths.length),
    )

  /** One file of `owner/name` at `sha`: its bytes, and its git blob id when Code Storage sent one. */
  const blob = (owner: string, name: string, sha: string, path: string) => {
    const id = repoId(owner, name)
    return ImmutableCache.readThrough(
      ImmutableCache.key("repo.blob", id, sha, path),
      Effect.gen(function* () {
        yield* admitRead
        const file = yield* codeStorage.readFile(id, { path, ref: sha, maxBytes: MAX_BLOB_BYTES }).pipe(
          Effect.catch((error) => classifyMissing(id, sha, error)),
        )
        yield* meter(file.bytes.length)
        const metadata: Record<string, string> = file.blobSha === undefined ? {} : { blobSha: file.blobSha }
        return { bytes: file.bytes, metadata }
      }),
    )
  }

  /**
   * `owner/name`'s default branch, head commit, branches and tags: the ready row's head from Postgres, and the listing
   * cached under it. A repository that isn't ready is `not_imported`.
   */
  const refs = (owner: string, name: string, ephemeralNames: ReadonlyArray<string> = []) => {
    const id = repoId(owner, name)
    return Effect.gen(function* () {
      const head = yield* Repos.readyHead(id).pipe(
        Effect.provide(database),
        Effect.mapError(() => new ReadRefused({ code: "unavailable" })),
      )
      if (Option.isNone(head)) return yield* new ReadRefused({ code: "not_imported" })
      const entry = yield* ImmutableCache.readThrough(
        ImmutableCache.key("repo.refs", id, head.value.sha, String(head.value.refsChangedAt)),
        Effect.gen(function* () {
          yield* admitRead
          const { listing, bytesRead } = yield* listRefs(id).pipe(Effect.mapError(refusedBy))
          yield* meter(bytesRead)
          return { bytes: encoder.encode(JSON.stringify(listing)), metadata: {} }
        }),
      )
      const listing = yield* Effect.orDie(decodeRefs(decoder.decode(entry.bytes)))
      if (ephemeralNames.length === 0) {
        return { defaultBranch: head.value.defaultBranch, head: head.value.sha, ...listing } satisfies Refs
      }
      // The default listing is shared; ephemeral discovery is authorized per request and never cached on a device
      // across an access decision. Object reads remain pinned to SHA: both namespaces share Git objects.
      yield* admitRead
      const ephemeral = yield* pages(
        (cursor) => codeStorage.listBranches(id, { namespace: "ephemeral", cursor, limit: REFS_PAGE_SIZE }).pipe(
          Effect.map((page) => ({ items: page.branches, nextCursor: page.nextCursor, bytesRead: page.bytesRead })),
        ),
        services.maxRefs,
      ).pipe(Effect.mapError(refusedBy))
      yield* meter(ephemeral.bytesRead)
      const visible = new Set(ephemeralNames)
      const branches = new Map(listing.branches.map((branch) => [branch.name, branch]))
      for (const { name, sha } of ephemeral.items) {
        if (visible.has(name)) branches.set(name, { name, sha })
      }
      return {
        defaultBranch: head.value.defaultBranch, head: head.value.sha,
        tags: listing.tags, branches: [...branches.values()], truncated: listing.truncated || ephemeral.truncated,
      } satisfies Refs
    })
  }

  return { tree, files, blob, refs }
}

/** A read's refusal as the flows declare it. */
const flowFailure = (refused: ReadRefused) =>
  (refused.code === "not_found" || refused.code === "not_imported")
    ? new RepoNotFound()
    : refused.code === "capacity"
    ? new RepoReadsPaused()
    : new RepoReadUnavailable(refused.retryAfterMillis === undefined ? {} : { retryAfterMillis: refused.retryAfterMillis })

/**
 * The agent's reads on the server and the Node host: `RepoReader` over the same reads RepoApi answers, within `cache`.
 * A file over `MAX_BLOB_BYTES` is `too-large`, and a binary one only its size.
 */
export const reader = (reads: ReturnType<typeof make<unknown, never>>, cache: Layer.Layer<ImmutableCache.ImmutableCache>) =>
  Layer.succeed(
    RepoReader,
    RepoReader.of({
      tree: (owner, name, sha) =>
        reads.tree(owner, name, sha).pipe(
          Effect.flatMap((bytes) => Effect.orDie(decodeListing(decoder.decode(bytes)))),
          Effect.mapError(flowFailure),
          Effect.provide(cache),
        ),
      refs: (owner, name) => reads.refs(owner, name).pipe(Effect.mapError(flowFailure), Effect.provide(cache)),
      read: (owner, name, sha, path) =>
        reads.blob(owner, name, sha, path).pipe(
          Effect.map(({ bytes }): FileRead => {
            const text = textOf(bytes)
            return text === undefined
              ? { state: "binary", size: bytes.length }
              : { state: "text", contents: text, size: bytes.length }
          }),
          Effect.catchIf(
            (refused) => refused.code === "too_large",
            (refused): Effect.Effect<FileRead> => Effect.succeed({ state: "too-large", size: refused.size ?? MAX_BLOB_BYTES + 1 }),
          ),
          Effect.mapError(flowFailure),
          Effect.provide(cache),
        ),
    }),
  )

/** Counts a read RepoApi answered, by kind and status, and the bytes it returned. */
export const counted = (kind: "tree" | "blob" | "raw" | "refs" | "about", status: number, bytes: number) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(RepoMetrics.reads, { kind, status: String(status) }), 1),
    Metric.update(RepoMetrics.readBytes, bytes),
  )
