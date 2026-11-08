import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Context, Effect, FiberHandle, Layer, Option } from "effect"
import type { Source } from "../repo/gate"
import { RepoStore } from "../repo/store"
import { CurrentRow, emptyCurrent, IndexRow, PageRow, SearchRow } from "./rows"

// The Docs tab's state (docs/features/docs.md#the-docs-tab): local rows only, read through one live query. Actions reach
// ChatApi's docs routes through `DocsClient`; nothing here does.

type Rows<A extends object> = Collection.Collection<A, string>
/** A repository's rows as the page reads them: through the data gate (repo/gate.ts). */
type Shown<A extends object> = Source<A>

/** What the routed docs page shows: the current row, with its repository's index, its page and its search. */
export const docsQuery = (
  current: Rows<CurrentRow>,
  indexes: Shown<IndexRow>,
  pages: Shown<PageRow>,
  searches: Shown<SearchRow>,
) =>
  LiveQuery.make((q) =>
    q
      .from({ current: current.tanstack })
      .leftJoin({ index: indexes.tanstack }, ({ current, index }) => Query.eq(current.repoKey, index.key))
      .leftJoin({ page: pages.tanstack }, ({ current, page }) => Query.eq(current.pageKey, page.key))
      .leftJoin({ search: searches.tanstack }, ({ current, search }) => Query.eq(current.searchKey, search.key))
      .findOne()
  )

const make = Effect.gen(function* () {
  const current = yield* Collection.local<CurrentRow, string>({
    id: "docs-current",
    schema: CurrentRow,
    getKey: (row) => row.id,
    initialData: [emptyCurrent],
  })
  const indexes = yield* Collection.local<IndexRow, string>({ id: "docs-indexes", schema: IndexRow, getKey: (row) => row.key })
  const pages = yield* Collection.local<PageRow, string>({ id: "docs-pages", schema: PageRow, getKey: (row) => row.key })
  const searches = yield* Collection.local<SearchRow, string>({
    id: "docs-searches",
    schema: SearchRow,
    getKey: (row) => row.key,
  })
  // A refused repository's docs leave this tab: its index, pages and searches, keyed by `owner/name` first.
  const repos = yield* Effect.serviceOption(RepoStore)
  if (Option.isSome(repos)) {
    yield* repos.value.registerCache(["docs-indexes", "docs-pages", "docs-searches"], (id) => {
      const repoKey = id.slice("github/".length)
      const mine = (key: string) => key === repoKey || key.startsWith(`${repoKey}:`) || key.startsWith(`${repoKey}?`)
      return Effect.forEach([indexes, pages, searches] as const, (rows) =>
        Effect.flatMap(rows.toArray, (all: ReadonlyArray<{ readonly key: string }>) =>
          Effect.forEach(all.filter((row) => mine(row.key)), (row) => Effect.ignore(rows.delete(row.key)), { discard: true })),
      { discard: true })
    })
  }
  return {
    current,
    indexes,
    pages,
    searches,
    // Each repository's docs show only while it may (repo/gate.ts). A tab with no repository store has no refusal to
    // hide them by.
    docs: Option.isSome(repos)
      ? yield* docsQuery(current, yield* repos.value.gate(indexes), yield* repos.value.gate(pages), yield* repos.value.gate(searches))
      : yield* docsQuery(current, indexes, pages, searches),
    /** The searchbox's search: typing again interrupts it. */
    searcher: yield* FiberHandle.make<void, never>(),
    /** Where loads run, closed with the store. */
    scope: yield* Effect.scope,
  }
})

/**
 * The Docs tab's state:
 * - `current`: which docs the routed page shows, one row;
 * - `indexes`, `pages`, `searches`: what this tab read, by repository, page and search;
 * - `docs`: the live query the page reads; `searcher` and `scope`.
 */
export class DocsStore extends Context.Service<DocsStore, Effect.Success<typeof make>>()("@smthrs/mvp/docs/DocsStore") {
  /** The store; its collections cleaned up and its loads interrupted with the scope. */
  static readonly layer = Layer.effect(DocsStore, make)
}
