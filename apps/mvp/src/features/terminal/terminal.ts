import { Cause, Context, Effect, FiberHandle, Layer, Scope } from "effect"
import { runners } from "../../boundary"
import { codeOf } from "../../errorCode"
import type { FlowDispatch } from "../../flows/dispatch"
import type { AuthStore } from "../auth/store"
import { attach, detach, input, open, resize, show, type Sink } from "./actions"
import { TerminalStore } from "./store"

// The branch terminal as a frontend sees it (docs/features/branch-workspace.md#the-terminal): a live query to read and
// plain functions to act. React renders the panel and hands the frame's output seam to `attach`.

type Store = TerminalStore["Service"]

export interface TerminalQueries {
  /** The panel this tab shows. */
  readonly panel: Store["panelState"]["tanstack"]
  /** The live terminals on the panel's branch: its tabs. */
  readonly tabs: Store["tabsState"]["tanstack"]
}

export interface TerminalActions {
  /**
   * Shows branch `branchId`'s panel, watching terminal `watching` when given; `null` shows none. Resolves with the
   * terminal it shows, if any. A route may cancel a pending show with `signal`.
   */
  readonly show: (branchId: string | null, watching?: string, signal?: AbortSignal) => Promise<string | null>
  /** Selects the panel without waiting for rows; a later show, route abort or store close cancels it. */
  readonly showInBackground: (branchId: string, watching: string | undefined, shown: (terminalId: string | null) => Promise<void>, signal?: AbortSignal) => void
  /** Open terminal. */
  readonly open: () => void
  /** Attaches the frame's output to terminal `terminalId`; the function it returns detaches it. */
  readonly attach: (terminalId: string, sink: Sink) => () => void
  readonly input: (data: string) => void
  readonly resize: (cols: number, rows: number) => void
}

export class Terminal extends Context.Service<
  Terminal,
  { readonly queries: TerminalQueries; readonly actions: TerminalActions }
>()("@smthrs/mvp/terminal/Terminal") {
  /** Binds frontend actions to the injected Effect services. */
  static readonly make = Effect.gen(function* () {
    const store = yield* TerminalStore
    const context = yield* Effect.context<TerminalStore | AuthStore | FlowDispatch>()
    const { runSync: run, runPromise: runAsync } = runners(context, "terminal")
    // A route cancels a show with its signal.
    const showAsync = <A, E>(effect: Effect.Effect<A, E, TerminalStore | AuthStore | FlowDispatch>, signal: AbortSignal | undefined) =>
      runAsync(effect, { signal })
    const showing = yield* FiberHandle.make<void, never>().pipe(Scope.provide(store.scope))
    const runShowing = yield* FiberHandle.runtime(showing)<TerminalStore | AuthStore | FlowDispatch>()
    return Terminal.of({
      queries: { panel: store.panelState.tanstack, tabs: store.tabsState.tanstack },
      actions: {
        show: (branchId, watching, signal) => showAsync(Effect.andThen(FiberHandle.clear(showing), show(branchId, watching)), signal),
        showInBackground: (branchId, watching, shown, signal) => {
          if (signal?.aborted) return
          runShowing(
            show(branchId, watching).pipe(
              Effect.flatMap((terminalId) => Effect.tryPromise(() => shown(terminalId))),
              Effect.catchCause((cause) =>
                Effect.logError("terminal.show.failed").pipe(
                  Effect.annotateLogs({ feature: "terminal", errorCode: codeOf(Cause.squash(cause)) }),
                )
              ),
            ),
            { signal },
          )
        },
        open: () => void runAsync(open),
        attach: (terminalId, sink) => {
          run(attach(terminalId, sink))
          return () => run(detach)
        },
        input: (data) => run(input(data)),
        resize: (cols, rows) => run(resize(cols, rows)),
      },
    })
  })

  /** Binds the store's query and actions for frontends, with the services this layer was built with. */
  static readonly layer = (config: { readonly origin: string }) =>
    Layer.effect(Terminal, Terminal.make).pipe(Layer.provideMerge(TerminalStore.layer(config)))
}

/** The terminal layer's value: what frontends get. */
export type TerminalView = Terminal["Service"]
