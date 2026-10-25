import { Effect, Layer, Stream } from "effect"
import { ChatStore } from "../chat/store"
import { embed } from "../repo/embed"
import { repoOf } from "./rows"
import { ViewsStore } from "./store"

// A repository's view in the conversation (decision 0004 §3, docs/features/views.md#a-repository-and-its-issues) shows
// what the device loads of its repository, through RepoApi. No component starts a load (no `useEffect`): this follows
// the conversation the tab shows, and loads what each `repo` view in it renders as it arrives, from a person's `/repo`,
// the agent's `ui/repo`, or another device. A view loaded once stays loaded for as long as the tab lives. A
// repository's issues view needs nothing here: its live query starts the issues' Electric sync when it renders.

/** Loads what each repository's view of the conversation this tab shows renders, as they arrive. */
export const followEmbeds = Effect.gen(function* () {
  const chat = yield* ChatStore
  const views = yield* ViewsStore
  yield* chat.place.changes({ initial: true }).pipe(
    Stream.flatMap((changes) => Stream.fromIterable(changes)),
    Stream.map((change) => change.value.conversationId),
    Stream.changes,
    // The home conversation's views, or a branch's, which chat opened before it showed it (src/features/chat/store.ts).
    Stream.switchMap((conversationId) => views.rowsIn(conversationId ?? undefined).rows),
    Stream.runForEach((rows) =>
      Effect.forEach(rows, (row) => {
        const repo = repoOf(row)
        return repo === undefined ? Effect.void : embed(row.id, repo)
      }, { discard: true })
    ),
    Effect.forkIn(views.scope),
  )
})

/** The follower, for as long as the views' store lives. */
export const embedsLayer = Layer.effectDiscard(followEmbeds)
