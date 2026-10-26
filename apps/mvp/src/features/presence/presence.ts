import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { at, join, leave } from "./actions"
import type { Where } from "./schema"
import { type PresenceConfig, PresenceStore } from "./store"

// Presence as a frontend sees it (docs/features/branch-workspace.md#presence): live queries to read and plain functions
// to act, with no Effect in sight.

type Store = PresenceStore["Service"]

export interface PresenceQueries {
  /** Everyone in the room of the branch the page shows, this tab included, in the room's order. */
  readonly participants: Store["participantsState"]["tanstack"]
  /** This tab's place in its room. */
  readonly room: Store["roomState"]["tanstack"]
}

export interface PresenceActions {
  /** Joins branch `branchId`'s room: resolves once this tab is joining it. */
  readonly join: (branchId: string, signal?: AbortSignal) => Promise<void>
  /** Says where this person is on the page. */
  readonly at: (where: Where, signal?: AbortSignal) => Promise<void>
  /** Leaves the room. */
  readonly leave: (signal?: AbortSignal) => Promise<void>
}

export class Presence extends Context.Service<
  Presence,
  { readonly queries: PresenceQueries; readonly actions: PresenceActions }
>()("@smthrs/mvp/presence/Presence") {
  /** Binds frontend actions to the injected Effect services. */
  static readonly make = Effect.gen(function* () {
    const store = yield* PresenceStore
    // A route cancels these with its signal.
    const { runPromise: run } = runners(yield* Effect.context<PresenceStore>(), "presence")
    return Presence.of({
      queries: { participants: store.participantsState.tanstack, room: store.roomState.tanstack },
      actions: {
        join: (branchId, signal) => run(join(branchId), { signal }),
        at: (where, signal) => run(at(where), { signal }),
        leave: (signal) => run(leave, { signal }),
      },
    })
  })

  /** Binds the store's queries and actions for frontends, with the services this layer was built with. */
  static readonly layer = (config: PresenceConfig) =>
    Layer.effect(Presence, Presence.make).pipe(Layer.provideMerge(PresenceStore.layer(config)))
}

/** The presence layer's value: what frontends get. */
export type PresenceView = Presence["Service"]
