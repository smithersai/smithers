import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import { archive, resume, search, showArchived } from "./actions"
import { type ConversationsConfig, ConversationsStore } from "./store"

// Your conversations as a frontend sees it (docs/features/conversations.md#the-list): live queries to read and plain
// functions to act, with no Effect in sight.

type Store = ConversationsStore["Service"]

export interface ConversationsQueries {
  /** The list this tab shows, the latest opened first. */
  readonly list: Store["listState"]["tanstack"]
  /** The list's search. */
  readonly search: Store["searchState"]["tanstack"]
}

export interface ConversationsActions {
  /** Archives a conversation for this person on all their devices; `false` brings it back. */
  readonly archive: (conversationId: string, archived: boolean) => Promise<void>
  /** Searches the list. */
  readonly search: (text: string) => Promise<void>
  /** Shows the archived conversations instead, or those that aren't. */
  readonly showArchived: (archived: boolean) => Promise<void>
}

export class Conversations extends Context.Service<
  Conversations,
  { readonly queries: ConversationsQueries; readonly actions: ConversationsActions }
>()("@smthrs/mvp/conversations/Conversations") {
  /**
   * Binds the store's queries and actions for frontends, with the services this layer was built with, once the acts
   * this device still holds follow their runs again.
   */
  static readonly layer = (config: ConversationsConfig) =>
    Layer.effect(
      Conversations,
      Effect.gen(function* () {
        const store = yield* ConversationsStore
        // Acts a closed tab left on the device follow their runs again, in the background.
        yield* Effect.forkIn(resume, store.scope)
        const { runPromise: run } = runners(yield* Effect.context<ConversationsStore | FlowDispatch>(), "conversations")
        return Conversations.of({
          queries: { list: store.listState.tanstack, search: store.searchState.tanstack },
          actions: {
            archive: (conversationId, archived) => run(archive(conversationId, archived)),
            search: (text) => run(Effect.asVoid(search(text))),
            showArchived: (archived) => run(Effect.asVoid(showArchived(archived))),
          },
        })
      }),
    ).pipe(Layer.provideMerge(ConversationsStore.layer(config)))
}

/** The conversations layer's value: what frontends get. */
export type ConversationsView = Conversations["Service"]
