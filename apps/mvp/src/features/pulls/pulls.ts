import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { IssuesStore } from "../issues/store"
import { loadFiles, merge, open, retry, warm } from "./actions"
import { PullsClient } from "./api"
import type { PullTab } from "./contract"
import { PullsStore } from "./store"

// Pull requests as a frontend sees them: live queries to read and plain functions to act, with no Effect in sight. React
// renders the queries with `useLiveQuery`, and the pull request routes' loaders call `open`.

type Store = PullsStore["Service"]

/** What a frontend reads live, for the routed repository and pull request. */
export interface PullsQueries {
  readonly view: Store["viewState"]["tanstack"]
  readonly list: Store["list"]["tanstack"]
  readonly pull: Store["pull"]["tanstack"]
  readonly comments: Store["comments"]["tanstack"]
  readonly reviews: Store["reviewList"]["tanstack"]
  readonly commits: Store["commitList"]["tanstack"]
  readonly checks: Store["checkList"]["tanstack"]
  readonly files: Store["fileList"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface PullsActions {
  readonly open: (owner: string, name: string, number?: number, tab?: PullTab) => void
  readonly warm: () => void
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
      const { runSync: run } = runners(yield* Effect.context<PullsStore | PullsClient | IssuesStore>(), "pulls")
      return Pulls.of({
        queries: {
          view: store.viewState.tanstack,
          list: store.list.tanstack,
          pull: store.pull.tanstack,
          comments: store.comments.tanstack,
          reviews: store.reviewList.tanstack,
          commits: store.commitList.tanstack,
          checks: store.checkList.tanstack,
          files: store.fileList.tanstack,
        },
        actions: {
          open: (owner, name, number, tab) => run(open(owner, name, number, tab)),
          warm: () => run(warm),
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
