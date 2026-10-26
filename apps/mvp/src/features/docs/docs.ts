import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { open, search, warm } from "./actions"
import type { DocsClient } from "./api"
import { DocsStore } from "./store"

// A repository's docs as a frontend sees them: one live query to read and plain functions to act, with no Effect in
// sight. React renders the query with `useLiveQuery`; the docs routes' `beforeLoad` calls `warm` and `open`.

/** What a frontend reads live. */
export interface DocsQueries {
  /** Which docs the routed page shows, with its index, its page and its search, as this tab read them. */
  readonly docs: DocsStore["Service"]["docs"]["tanstack"]
}

/** What the routes and the page do. */
export interface DocsActions {
  /** A docs route first, on a link's hover or focus and before every navigation: reads without showing. */
  readonly warm: (owner: string, name: string, path?: string) => Promise<void>
  /** A docs route, once warm: shows `owner/name`'s docs, at the page at `path` or its index. Returns at once. */
  readonly open: (owner: string, name: string, path?: string) => void
  /** The searchbox's change: searches the routed docs for its words. Returns at once. */
  readonly search: (query: string) => void
}

export class Docs extends Context.Service<Docs, { readonly queries: DocsQueries; readonly actions: DocsActions }>()(
  "@smthrs/mvp/docs/Docs",
) {
  /** Binds the store's query and the actions, which run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Docs,
    Effect.gen(function* () {
      const store = yield* DocsStore
      const context = yield* Effect.context<DocsStore | DocsClient>()
      const { runSync: run, runPromise: promise } = runners(context, "docs")
      return Docs.of({
        queries: { docs: store.docs.tanstack },
        actions: {
          warm: (owner, name, path) => promise(warm(owner, name, path)),
          open: (owner, name, path) => run(open(owner, name, path)),
          search: (query) => run(search(query)),
        },
      })
    }),
  )
}

/** The docs layer's value: what frontends get. */
export type DocsView = Docs["Service"]
