import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { IssuesStore } from "../issues/store"
import { loadFiles, merge, open, retry, warm } from "./actions"
import { PullsClient } from "./api"
import type { PullTab } from "./contract"
import { PullsStore, type RepoPulls } from "./store"

// Pull requests as a frontend sees them: live queries to read and plain functions to act, with no Effect in sight. React
// renders the queries with `useLiveQuery`, and the pull request routes' loaders call `open`.

type Store = PullsStore["Service"]

/**
 * What a frontend reads live, for the routed repository and pull request: each the routed repository's (`open`
 * opened it before the page shows), none for a repository nobody opened.
 */
export interface PullsQueries {
  readonly view: Store["viewState"]["tanstack"]
  readonly list: RepoPulls["list"]["tanstack"]
  readonly pull: RepoPulls["pull"]["tanstack"]
  readonly comments: RepoPulls["comments"]["tanstack"]
  readonly reviews: RepoPulls["reviewList"]["tanstack"]
  readonly commits: RepoPulls["commitList"]["tanstack"]
  readonly checks: RepoPulls["checkList"]["tanstack"]
  readonly files: Store["fileList"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface PullsActions {
  /** What a pull request route calls on a navigation: resolves once the repository's pull requests are open. */
  readonly open: (owner: string, name: string, number?: number, tab?: PullTab) => Promise<void>
  /** On a link's hover or focus: starts the repository's pull requests' sync without showing a page. */
  readonly warm: (owner: string, name: string) => Promise<void>
  readonly retry: () => void
  readonly loadFiles: (owner: string, name: string, base: string, head: string) => void
  /** Merge, bound to the head and base the page shows: whether it was sent. */
  readonly merge: (headSha: string, baseSha: string, number: number) => boolean
}

export class Pulls extends Context.Service<Pulls, { readonly queries: PullsQueries; readonly actions: PullsActions }>()(
  "@smthrs/mvp/pulls/Pulls",
) {
  /** Binds the store's queries and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Pulls,
    Effect.gen(function* () {
      const store = yield* PullsStore
      const { runSync: run, runPromise: promise } = runners(yield* Effect.context<PullsStore | PullsClient | IssuesStore>(), "pulls")
      return Pulls.of({
        queries: {
          view: store.viewState.tanstack,
          get list() { return store.routed().list.tanstack },
          get pull() { return store.routed().pull.tanstack },
          get comments() { return store.routed().comments.tanstack },
          get reviews() { return store.routed().reviewList.tanstack },
          get commits() { return store.routed().commitList.tanstack },
          get checks() { return store.routed().checkList.tanstack },
          files: store.fileList.tanstack,
        },
        actions: {
          open: (owner, name, number, tab) => promise(open(owner, name, number, tab)),
          warm: (owner, name) => promise(warm(owner, name)),
          retry: () => run(retry),
          loadFiles: (owner, name, base, head) => run(loadFiles(owner, name, base, head)),
          merge: (headSha, baseSha, number) => run(merge(headSha, baseSha, number)),
        },
      })
    }),
  )
}

/** The pull requests' layer, as React's context carries it. */
export type PullsLayer = Pulls["Service"]
