import { Context, Effect, Layer } from "effect"
import { ChatStore } from "../chat/store"
import { FlowDispatch } from "../../flows/dispatch"
import { Coedit, type CoeditView } from "../coedit/coedit"
import { Conversations, type ConversationsView } from "../conversations/conversations"
import { ConversationsStore } from "../conversations/store"
import { Presence, type PresenceView } from "../presence/presence"
import { Sharing, type SharingView } from "../sharing/sharing"
import { SharingStore } from "../sharing/store"
import { leave, open, writable } from "./actions"
import { Publishing, type PublishingView } from "./publishing"
import { BranchRoute, BranchStore } from "./store"

// The branch workspace as a frontend sees it (docs/features/branch-workspace.md#the-page): a live query to read and
// plain functions to act, with no Effect in sight, and the workspace's live parts beside it: who it is shared with
// (`sharing`, src/features/sharing), who is on it now (`presence`, src/features/presence), and the texts people edit
// together (`coedit`, src/features/coedit), and the person's own list of conversations, one per branch
// (`conversations`, src/features/conversations), and its Publish, Update branch and Compare (`publishing`,
// src/features/branch/publishing.ts).

type Store = BranchStore["Service"]

export interface BranchQueries {
  /** The branch this tab's route shows. */
  readonly current: Store["currentState"]["tanstack"]
}

export interface BranchActions {
  /**
   * Opens branch `ref` of `owner/repo`: resolves once the page can show it, with its id, or why not; at once when the
   * browser is offline, and the route opens again once it is back, unless `signal`, the navigation's, was aborted.
   */
  readonly open: (owner: string, repo: string, ref: string, signal?: AbortSignal) => Promise<string | undefined>
  /** Leaves the branch for the home conversation. */
  readonly leave: () => Promise<void>
  /**
   * Whether this person may write the branch the page shows now: tracked, Owner or Can edit, and open to changes. A
   * route asks it once `open` resolved, to show a Markdown file in the live editor in place.
   */
  readonly writable: () => boolean
}

export class Branch extends Context.Service<
  Branch,
  {
    readonly queries: BranchQueries
    readonly actions: BranchActions
    readonly sharing: SharingView
    readonly presence: PresenceView
    readonly coedit: CoeditView
    readonly conversations: ConversationsView
    readonly publishing: PublishingView
  }
>()("@smthrs/mvp/branch/Branch") {
  /**
   * Binds the store's query and actions for frontends, with the services this layer was built with; sharing,
   * presence and the conversations reach ChatApi on `origin`. Needs the branch's store, which the composer reads too. `reopenRoute` opens the tab's route again, once a branch opened offline can be
   * tracked.
   */
  static readonly layer = (config: { readonly origin: string; readonly reopenRoute: () => void }) =>
    Layer.effect(
      Branch,
      Effect.gen(function* () {
        const store = yield* BranchStore
        const context = yield* Effect.context<BranchRoute | BranchStore | ChatStore | ConversationsStore | FlowDispatch | SharingStore>()
        const run = Effect.runPromiseWith(context)
        return Branch.of({
          queries: { current: store.currentState.tanstack },
          actions: {
            open: (owner, repo, ref, signal) => run(open(owner, repo, ref, signal)),
            leave: () => run(leave),
            writable: () => Effect.runSyncWith(context)(writable),
          },
          sharing: yield* Sharing,
          presence: yield* Presence,
          coedit: yield* Coedit,
          conversations: yield* Conversations,
          publishing: yield* Publishing,
        })
      }),
    ).pipe(
      Layer.provideMerge(BranchRoute.layer(config.reopenRoute)),
      Layer.provideMerge(Sharing.layer(config)),
      Layer.provideMerge(Presence.layer(config)),
      Layer.provideMerge(Coedit.layer),
      Layer.provideMerge(Conversations.layer(config)),
      Layer.provideMerge(Publishing.layer(config)),
    )
}

/** The branch layer's value: what frontends get. */
export type BranchView = Branch["Service"]
