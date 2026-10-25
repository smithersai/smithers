import { Context, Effect, Layer } from "effect"
import type { FlowDispatch } from "../../flows/dispatch"
import type { IssuesStore } from "../issues/store"
import type { PullsClient } from "../pulls/api"
import { closeForm, openForm, publish, resync, show, update } from "./publishActions"
import { type PublishConfig, PublishStore } from "./publishStore"
import type { BranchStore } from "./store"

// Publish, Update branch and Compare as a frontend sees them (docs/features/branch-publish.md#the-branch-page): live
// queries to read and plain functions to act, with no Effect in sight. The branch layer composes it as
// `branch.publishing`.

type Store = PublishStore["Service"]

export interface PublishingQueries {
  /** The shown branch's publication, once it has one. */
  readonly publication: Store["publication"]["tanstack"]
  /** The title of the shown branch's pull request, once the device has it. */
  readonly pullTitle: Store["pullTitle"]["tanstack"]
  /** This tab's presses on the shown branch. */
  readonly press: Store["press"]["tanstack"]
  /** The person's own Publish and Update branch writes of the shown branch. */
  readonly writes: Store["writes"]["tanstack"]
  /** The comparisons Compare read, by `<base>...<head>`. */
  readonly comparisons: Store["comparisonList"]["tanstack"]
}

export interface PublishingActions {
  /** Shows branch `branchId`'s publication, `null` none; with `compare`, reads its base and head for Compare. */
  readonly show: (branchId: string | null, compare?: boolean) => Promise<void>
  readonly openForm: () => Promise<void>
  readonly closeForm: () => Promise<void>
  /** Publish with the form's title and description (empty once published): whether it pressed. */
  readonly publish: (title: string, body: string) => Promise<boolean>
  /** Update branch: whether it pressed. */
  readonly update: () => Promise<boolean>
  /** Resync: whether it pressed. */
  readonly resync: () => Promise<boolean>
}

export class Publishing extends Context.Service<
  Publishing,
  { readonly queries: PublishingQueries; readonly actions: PublishingActions }
>()("@smthrs/mvp/branch/Publishing") {
  /** Binds the store's queries and actions for frontends, with the services this layer was built with. */
  static readonly layer = (config: PublishConfig) =>
    Layer.effect(
      Publishing,
      Effect.gen(function* () {
        const store = yield* PublishStore
        const run = Effect.runPromiseWith(yield* Effect.context<PublishStore | BranchStore | FlowDispatch | PullsClient | IssuesStore>())
        return Publishing.of({
          queries: {
            publication: store.publication.tanstack,
            pullTitle: store.pullTitle.tanstack,
            press: store.press.tanstack,
            writes: store.writes.tanstack,
            comparisons: store.comparisonList.tanstack,
          },
          actions: {
            show: (branchId, compare) => run(show(branchId, compare)),
            openForm: () => run(openForm),
            closeForm: () => run(closeForm),
            publish: (title, body) => run(publish(title, body)),
            update: () => run(update),
            resync: () => run(resync),
          },
        })
      }),
    ).pipe(Layer.provideMerge(PublishStore.layer(config)))
}

/** The publishing layer's value: what frontends get. */
export type PublishingView = Publishing["Service"]
