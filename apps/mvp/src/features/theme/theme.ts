import { Context, Effect, Layer, Metric } from "effect"
import { runners } from "../../boundary"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import { toggleTheme } from "./actions"
import type { ThemeMode } from "./contract"
import { ThemeStore } from "./store"

// The theme as a frontend sees it: a live query to read and a plain function to act. React renders the query with
// `useLiveQuery` and calls the action from the button; it holds no state and runs no Effect.

export const toggleDefects = Metric.counter("smithers_theme_toggle_defects", { incremental: true })

type Store = ThemeStore["Service"]

/** What a frontend reads: this device's preference, if it has one, and what the page shows without one. */
export interface ThemeQueries {
  readonly theme: Store["theme"]["tanstack"]
  readonly shown: () => ThemeMode
  readonly shownMode: Store["shownMode"]["tanstack"]
}

/** What a person does: switch to the other mode. It resolves once the flow has set it. */
export interface ThemeActions {
  readonly toggle: () => Promise<void>
}

export class Theme extends Context.Service<Theme, { readonly queries: ThemeQueries; readonly actions: ThemeActions }>()(
  "@smthrs/mvp/theme/Theme",
) {
  /**
   * Binds the store's query and the toggle for frontends. The toggle runs with the services this layer was built with
   * (`runners`); a dispatch that fails is already logged and counted, so it resolves all the same.
   * Unexpected defects are counted and logged here without their content before the event handler resolves.
   */
  static readonly layer = Layer.effect(
    Theme,
    Effect.gen(function* () {
      const store = yield* ThemeStore
      const { runPromise: run } = runners(yield* Effect.context<ThemeStore | FlowDispatch>(), "theme")
      return Theme.of({
        queries: { theme: store.theme.tanstack, shown: store.shown, shownMode: store.shownMode.tanstack },
        actions: {
          toggle: () => run(toggleTheme.pipe(
            Effect.ignore,
            Effect.catchDefect((defect) => Metric.update(toggleDefects, 1).pipe(
              Effect.andThen(Effect.logError("theme.toggle.defect").pipe(
                Effect.annotateLogs({ feature: "theme", errorCode: codeOf(defect) }),
              )),
              Effect.withSpan("theme.toggle.defect"),
            )),
          )),
        },
      })
    }),
  )
}

/** The theme layer's value: what frontends get. */
export type ThemeView = Theme["Service"]
