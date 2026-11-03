import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { LiveQuery } from "@smthrs/effect-tanstack-db"
import { Cache, Context, Effect, Fiber, Layer, Metric, Option, Scope, Stream } from "effect"
import type { Source } from "../repo/gate"
import { RepoStore } from "../repo/store"
import { shapeRefusals } from "../issues/source"
import { runners } from "../../boundary"
import { feedDocumentId, FEEDS_SHAPE_ROUTE } from "./contract"
import { FeedDocument } from "./schema"

// Repository feeds on this tab (decision 0128 §5, docs/features/feeds.md#the-browser): Electric's `feed_documents`,
// never kept on the device. A repository's index (the documents whose name has no `/`) syncs once something asks for
// it, for as long as the store lives, one collection per repository. A document with a `/` in its name syncs only while
// something listens to it, and stops when the last listener leaves. The shape decides what the viewer may see: public
// documents for anyone, the private ones too for the repository's Maintainers and Admins in person.

/** Where feeds sync from: ChatApi's origin, the site's own. */
export interface FeedsConfig {
  readonly origin: string
}

/** A framework-free live list of rows: the current rows, and a way to hear they changed (`PluginHost`'s `Live`). */
export interface LiveRows<A> {
  readonly current: () => ReadonlyArray<A>
  /** Calls `listener` after every change; the returned function unsubscribes. */
  readonly subscribe: (listener: () => void) => () => void
}

/** On-demand documents opened, by `outcome`: `opened` on a first listener, `closed` after the last. */
export const documents = Metric.counter("smithers_web_feed_documents", {
  description: "On-demand feed documents a tab opened and closed, by outcome",
  incremental: true,
})

/** A repository's index, by name, read through the data gate (repo/gate.ts). */
const indexQuery = (documents: Source<FeedDocument>) =>
  LiveQuery.make((q) => q.from({ document: documents.tanstack }).orderBy(({ document }) => document.name, "asc"))

/** One repository's index: its rows by name, only while the repository may show. */
export interface FeedIndex {
  readonly byName: Effect.Success<ReturnType<typeof indexQuery>>
}

/**
 * `collection`'s documents while their repository may show (repo/gate.ts): each names its repository `owner/name`, which
 * the gate joins as `github/owner/name`. Without the repository store (a test's), every document.
 */
const shownDocuments = (
  repos: Option.Option<RepoStore["Service"]>,
  collection: ElectricCollection.ElectricCollection<FeedDocument>,
): Effect.Effect<Source<FeedDocument>, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (Option.isNone(repos)) return collection
    return (yield* repos.value.gate(collection, "repo")) as unknown as Source<FeedDocument>
  })

/** The shape of `repo`'s documents: its index, or one document by `name`. */
const shapeOf = (origin: string, repo: string, name?: string) => ({
  url: `${origin}${FEEDS_SHAPE_ROUTE}?repo=${encodeURIComponent(repo)}${
    name === undefined ? "" : `&name=${encodeURIComponent(name)}`
  }`,
  columnMapper: ElectricCollection.snakeCamelMapper(),
  parser: { timestamptz: (value: string) => new Date(value).toISOString() },
})

export class FeedsStore extends Context.Service<
  FeedsStore,
  {
    /** Repository `repo`'s (`owner/name`, lowercased) index, opened once and synced while the store lives. */
    readonly index: (repo: string) => Effect.Effect<FeedIndex>
    /** Document `name` of `repo`, live: synced while it has a listener, never kept. One per document. */
    readonly document: (repo: string, name: string) => LiveRows<FeedDocument>
  }
>()("@smthrs/mvp/feeds/FeedsStore") {
  /** The store; its shapes closed when the scope closes. Needs the tab's `ShapeSource`. */
  static readonly layer = (config: FeedsConfig) =>
    Layer.effect(
      FeedsStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const context = yield* Effect.context<never>()
        const run = runners(context, "feeds")
        // What is open of each repository (`owner/name`): its refusal drops all of it.
        const holding = new Map<string, Set<{ readonly evict: Effect.Effect<void> }>>()
        const held = (repo: string) => {
          const key = `github/${repo}`.toLowerCase()
          const set = holding.get(key) ?? new Set()
          holding.set(key, set)
          return set
        }
        const repos = yield* Effect.serviceOption(RepoStore)
        // A feed shape's 403 refuses the repository's feeds, not the repository (ruling #3): its documents go.
        const narrow = Option.isNone(repos) ? undefined : yield* shapeRefusals(repos.value, scope)
        // Requests wait while the repository is refused, so an eviction doesn't sync rows back (decision 0110).
        const unrefused = (source: ShapeSource.Source, repo: string) => {
          if (Option.isNone(repos) || narrow === undefined) return source
          const id = `github/${repo}`.toLowerCase()
          const marked = ShapeSource.gated(source, repos.value.rolesState.rows.pipe(
            Stream.map((rows) => rows.find((row) => row.id === id)?.refused !== "forbidden"),
            Stream.changes,
          ))
          return narrow.source(marked, id, Effect.suspend(() =>
            Effect.forEach(holding.get(id) ?? [], (collection) => collection.evict, { discard: true })))
        }
        if (Option.isSome(repos)) {
          yield* repos.value.registerCache(["feeds", "feed"], (id) =>
            Effect.suspend(() => Effect.forEach(holding.get(id) ?? [], (collection) => collection.evict, { discard: true })))
        }
        // Opening an index twice at once opens it once: the cache runs one lookup per repository and keeps it.
        const opening = yield* Cache.make({
          lookup: (repo: string) =>
            Effect.gen(function* () {
              const collection = yield* ElectricCollection.make<FeedDocument>({
                id: `feeds:${repo}`,
                schema: FeedDocument,
                getKey: (row) => row.id,
                syncMode: "eager",
                shape: shapeOf(config.origin, repo),
              }).pipe(Effect.provideService(ShapeSource.ShapeSource, unrefused(yield* ShapeSource.ShapeSource, repo)))
              held(repo).add(collection)
              return { byName: yield* indexQuery(yield* shownDocuments(repos, collection)) }
            }).pipe(Scope.provide(scope), Effect.orDie),
          capacity: Number.MAX_SAFE_INTEGER,
        })

        /** One document's collection and rows, until the scope it opened in closes. */
        const follow = (repo: string, name: string, onRows: (rows: ReadonlyArray<FeedDocument>) => void) =>
          Effect.scoped(Effect.gen(function* () {
            const collection = yield* ElectricCollection.make<FeedDocument>({
              id: `feed:${feedDocumentId(repo, name)}`,
              schema: FeedDocument,
              getKey: (row) => row.id,
              syncMode: "eager",
              shape: shapeOf(config.origin, repo, name),
            }).pipe(Effect.provideService(ShapeSource.ShapeSource, unrefused(yield* ShapeSource.ShapeSource, repo)))
            held(repo).add(collection)
            yield* Effect.addFinalizer(() => Effect.sync(() => held(repo).delete(collection)))
            const shown = yield* shownDocuments(repos, collection)
            const query = yield* LiveQuery.make((q) => q.from({ document: shown.tanstack }))
            yield* Stream.runForEach(query.rows, (rows) => Effect.sync(() => onRows(rows)))
          }))

        // Each document's follower runs while it has a listener; any still running stop with the store.
        const running = new Set<Fiber.Fiber<void, unknown>>()
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => Effect.forEach([...running], (fiber) => Fiber.interrupt(fiber), { discard: true }))
        )
        const opened = new Map<string, LiveRows<FeedDocument>>()
        const document = (repo: string, name: string): LiveRows<FeedDocument> => {
          const key = feedDocumentId(repo, name)
          const known = opened.get(key)
          if (known !== undefined) return known
          let current: ReadonlyArray<FeedDocument> = []
          const listeners = new Set<() => void>()
          let fiber: Fiber.Fiber<void, unknown> | undefined
          const live: LiveRows<FeedDocument> = {
            current: () => current,
            subscribe: (listener) => {
              listeners.add(listener)
              if (fiber === undefined) {
                fiber = run.runFork(
                  Metric.update(Metric.withAttributes(documents, { outcome: "opened" }), 1).pipe(
                    Effect.andThen(follow(repo, name, (rows) => {
                      current = rows
                      for (const each of listeners) each()
                    })),
                  ),
                )
                running.add(fiber)
              }
              return () => {
                listeners.delete(listener)
                if (listeners.size > 0 || fiber === undefined) return
                const stopping = fiber
                fiber = undefined
                current = []
                running.delete(stopping)
                run.runFork(
                  Fiber.interrupt(stopping).pipe(
                    Effect.andThen(Metric.update(Metric.withAttributes(documents, { outcome: "closed" }), 1)),
                  ),
                )
              }
            },
          }
          opened.set(key, live)
          return live
        }

        return FeedsStore.of({ index: (repo) => Cache.get(opening, repo), document })
      }),
    )
}
