import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Layer, Metric, type Scope, Stream } from "effect"
import { signedInShapeSource } from "../auth/source"
import { AuthStore } from "../auth/store"
import { MY_CONVERSATIONS_SHAPE_ROUTE } from "./contract"
import { observeShape } from "../issues/shapeSync"
import { listUpdates, shapeTransitions } from "./metrics"
import { landed, listOf } from "./list"
import { Listed, Mine, Pending, SEARCH, Search } from "./schema"

// Your conversations on this tab (decision 0013 decision 2, docs/features/conversations.md#the-browser): the person's
// `conversation_people` rows, synced by Electric and kept on the device, so the list shows offline and every device of
// theirs agrees; the archives and restores this device did that haven't synced back yet, kept on the device too; the
// list's search; and the rows the list shows, worked out from all three (`listOf`) by a follower that also forgets the
// acts the rows show.

/** Where the rows sync from: ChatApi's origin, the site's own. */
export interface ConversationsConfig {
  readonly origin: string
}

/** The list this tab shows, the latest opened first. */
export const listQuery = (list: Collection.Collection<Listed, string>) =>
  LiveQuery.make((q) =>
    q.from({ row: list.tanstack }).orderBy(({ row }) => row.openedAt, "desc").orderBy(({ row }) => row.conversationId)
  )

/** The list's search on this tab. */
export const searchQuery = (search: Collection.Collection<Search, string>) =>
  LiveQuery.make((q) => q.from({ search: search.tanstack }).findOne())

export class ConversationsStore extends Context.Service<
  ConversationsStore,
  {
    readonly mine: ElectricCollection.ElectricCollection<Mine>
    readonly pending: Collection.Collection<Pending, string>
    readonly search: Collection.Collection<Search, string>
    readonly list: Collection.Collection<Listed, string>
    readonly listState: Effect.Success<ReturnType<typeof listQuery>>
    readonly searchState: Effect.Success<ReturnType<typeof searchQuery>>
    /** Where the background work an action starts runs. */
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/conversations/ConversationsStore") {
  /** The store, its follower running until the scope closes. */
  static readonly layer = (config: ConversationsConfig) =>
    Layer.effect(
      ConversationsStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const mine = yield* ElectricCollection.make<Mine>({
          id: "my-conversations",
          schema: Mine,
          getKey: (row) => row.conversationId,
          syncMode: "eager",
          persist: { schemaVersion: 1 },
          shape: {
            url: `${config.origin}${MY_CONVERSATIONS_SHAPE_ROUTE}`,
            columnMapper: ElectricCollection.snakeCamelMapper(),
          },
        }).pipe(Effect.provideService(ShapeSource.ShapeSource, signedInShapeSource(yield* ShapeSource.ShapeSource, yield* AuthStore)))
        yield* observeShape(mine.sync, "conversations.shape.sync", shapeTransitions).pipe(Effect.forkIn(scope, { startImmediately: true }))
        const pending = yield* Collection.persisted<Pending, string>({
          id: "conversation-pending",
          schema: Pending,
          getKey: (row) => row.conversationId,
          schemaVersion: 1,
        })
        const search = yield* Collection.local<Search, string>({
          id: "conversation-search",
          schema: Search,
          getKey: (row) => row.id,
          initialData: [{ id: SEARCH, text: "", archived: false, loaded: false }],
        })
        const list = yield* Collection.local<Listed, string>({
          id: "conversation-list",
          schema: Listed,
          getKey: (row) => row.conversationId,
        })

        // The list: worked out again whenever a row, an act or the search changes.
        let projection: string | undefined
        const work = Effect.gen(function* () {
          const rows = yield* mine.toArray
          const acts = yield* pending.toArray
          // The search always holds its one row.
          const showing = (yield* search.toArray)[0]!
          const next = listOf(rows, acts, showing)
          const keep = new Set(next.map((row) => row.conversationId))
          const before = new Map((yield* list.toArray).map((row) => [row.conversationId, row]))
          const gone = [...before.keys()].filter((id) => !keep.has(id))
          if (gone.length > 0) yield* list.delete(gone)
          for (const row of next) {
            const old = before.get(row.conversationId)
            if (old === undefined) yield* list.insert(row)
            else if ((Object.keys(row) as ReadonlyArray<keyof Listed>).some((field) => old[field] !== row[field])) {
              yield* list.update(row.conversationId, (draft) => void Object.assign(draft, row))
            }
          }
          // Counts distinguish a pending shape, missing personal rows and a filtered list without recording content.
          const fields = {
            syncedRows: rows.length,
            pendingRows: acts.length,
            listedRows: next.length,
            archived: showing.archived,
            loaded: showing.loaded,
          }
          const snapshot = JSON.stringify(fields)
          if (snapshot !== projection) {
            projection = snapshot
            yield* Effect.gen(function* () {
              yield* Metric.update(Metric.withAttributes(listUpdates, { archived: String(showing.archived), loaded: String(showing.loaded) }), 1)
              yield* Effect.annotateCurrentSpan(fields)
              yield* Effect.logInfo("conversations.list").pipe(Effect.annotateLogs(fields))
            }).pipe(Effect.withSpan("conversations.list"))
          }
          const done = landed(rows, acts)
          if (done.length > 0) yield* pending.delete([...done])
        }).pipe(
          // Local collections refuse only rows their own schema rejects, which `listOf` never makes: a bug, not a state.
          Effect.orDie,
        )
        yield* Stream.mergeAll(
          [
            Stream.map(mine.changes({ initial: true }), () => undefined),
            Stream.map(pending.changes({ initial: true }), () => undefined),
            Stream.map(search.changes({ initial: true }), () => undefined),
          ],
          { concurrency: "unbounded" },
        ).pipe(Stream.runForEach(() => work), Effect.forkIn(scope, { startImmediately: true }))

        // Loaded: the device's rows restored and the first sync answered, or failed: the list says it is empty only then.
        yield* Effect.gen(function* () {
          yield* Effect.ignore(mine.restored)
          yield* Effect.ignore(mine.preload)
          yield* Effect.orDie(search.update(SEARCH, (draft) => void (draft.loaded = true)))
        }).pipe(Effect.forkIn(scope, { startImmediately: true }))

        return ConversationsStore.of({
          mine,
          pending,
          search,
          list,
          listState: yield* listQuery(list),
          searchState: yield* searchQuery(search),
          scope,
        })
      }),
    )
}
