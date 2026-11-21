import { Host } from "@smthrs/plugin"
import { Effect, Stream } from "effect"
import { choosePreview, nextStop, previousStop, restartTour, stateAt, type TourState, VIEW } from "./model"

// The tour plugin's tab: owns the guided walkthrough cursor and preview selections, responds to the host keymap's
// `next`/`previous` local events (←/→, j/k), and navigates via the manifest's `go` event (`app/navigate`).

/** One live value with subscribe semantics for React's useSyncExternalStore. */
export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

/** What the tour's component reads and invokes. */
export interface TourTab {
  readonly queries: {
    readonly state: Watched<TourState>
  }
  readonly actions: {
    readonly next: () => void
    readonly previous: () => void
    readonly select: (index: number) => void
    readonly choose: (choiceId: string) => void
    readonly restart: () => void
    readonly go: (to: string) => void
  }
}

/** The tab: built by the host in the plugin's scope on first use. */
export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  const run = Effect.runForkWith(yield* Effect.context<never>())
  let current: TourState = stateAt(0)
  const listeners = new Set<() => void>()

  const update = (next: TourState) => {
    current = next
    for (const listener of listeners) listener()
  }

  yield* host.events(VIEW).pipe(
    Stream.runForEach(({ name }) =>
      Effect.sync(() => {
        if (name === "next") update(nextStop(current))
        else if (name === "previous") update(previousStop(current))
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )

  return {
    queries: {
      state: {
        current: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
    },
    actions: {
      next: () => update(nextStop(current)),
      previous: () => update(previousStop(current)),
      select: (index) => update(stateAt(index, current.chosen)),
      choose: (choiceId) => update(choosePreview(current, choiceId)),
      restart: () => update(restartTour()),
      go: (to) => void run(host.dispatch({ view: VIEW, name: "go" }, { to }).pipe(Effect.ignore)),
    },
  } satisfies TourTab
})
