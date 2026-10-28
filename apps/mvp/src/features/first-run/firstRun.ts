import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { press } from "./actions"
import type { ShownStep } from "./contract"
import { FirstRunStore } from "./store"

// The first run as a frontend sees it (docs/features/first-run.md): its row, live, and the list's press, with no
// Effect in sight.

type Store = FirstRunStore["Service"]

export interface FirstRunQueries {
  /** What `/app` shows in the composer's place: the gate, nothing yet, or the steps. */
  readonly state: Store["state"]["tanstack"]
}

export interface FirstRunActions {
  /** The list's button for `step` was pressed: recorded before its link goes. */
  readonly press: (step: ShownStep) => void
}

export class FirstRun extends Context.Service<
  FirstRun,
  { readonly queries: FirstRunQueries; readonly actions: FirstRunActions }
>()("@smthrs/mvp/first-run/FirstRun") {
  /** Binds the store's query and the list's press for frontends, over the store with its follower running. */
  static readonly layer = Layer.effect(
    FirstRun,
    Effect.gen(function* () {
      const store = yield* FirstRunStore
      const { runSync: run } = runners(yield* Effect.context<never>(), "first-run")
      return FirstRun.of({
        queries: { state: store.state.tanstack },
        actions: { press: (step) => run(press(step)) },
      })
    }),
  ).pipe(Layer.provideMerge(FirstRunStore.layer))
}

/** The first run layer's value: what frontends get. */
export type FirstRunView = FirstRun["Service"]
