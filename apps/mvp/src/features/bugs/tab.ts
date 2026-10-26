import { Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { answerAskingTab } from "../../flows/askingTab"
import { TabHistory } from "../../flows/history"
import { bugContextChannel } from "./contract"
import { contextOf } from "./context"

// The tab's side of `app/bug/report` (docs/features/bugs.md#what-a-report-carries): every tab keeps the pages it
// showed and listens on the engine's bug channel, and only the tab that started a report's request answers it
// (src/flows/askingTab.ts), with what it shows: the page before the form, the build, its latest runs' ids, trace ids and
// failure codes (src/flows/history.ts), and the browser and window. It reads no message, answer, payload or page text.

/** The call the step makes: what does this tab show? */
export const ContextCall = Schema.Struct({ kind: Schema.Literal("context") })

/** How many of the latest pages a tab keeps. */
export const PAGES_KEPT = 10

/** What the browser gives a report: the engine, the build, the router's page now and each page it shows, the window. */
export interface BugHost {
  /** The engine's name: its bug channel is `<name>/bug-context`. */
  readonly name: string
  /** The build this tab runs (`version.json`'s). */
  readonly build: string
  /** The router's page now; a host without a router has none. */
  readonly pathname?: () => string
  /** Hears each page the router shows, until the returned function stops it; a host without a router hears none. */
  readonly pages?: (listener: (path: string) => void) => () => void
  /** The browser and the window's size, as `1280x800`. */
  readonly screen?: () => { readonly browser: string; readonly viewport: string }
}

/** The browser and window a host that can't say reports. */
const UNKNOWN_SCREEN = { browser: "unknown", viewport: "unknown" } as const

/**
 * Keeps this tab's pages and answers the bug channel for its requests until its scope closes. Needs this tab's
 * `TabHistory` and `TabRequests`, which dispatch provides.
 */
export const tabBugContext = (host: BugHost) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      // The latest distinct pages, newest first.
      let pages: ReadonlyArray<string> = []
      const listen = host.pages
      if (listen !== undefined) {
        yield* Stream.callback<string>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => listen((path) => void Queue.offerUnsafe(queue, path))),
            (stop) => Effect.sync(stop),
          )
        ).pipe(
          Stream.runForEach((path) =>
            Effect.sync(() => {
              pages = [path, ...pages.filter((page) => page !== path)].slice(0, PAGES_KEPT)
            })
          ),
          // Subscribed before the layer is built, so no page the router shows next is missed.
          Effect.forkScoped({ startImmediately: true }),
        )
      }
      const history = yield* Effect.serviceOption(TabHistory)
      yield* answerAskingTab({
        channel: bugContextChannel(host.name),
        input: ContextCall,
        answer: () =>
          Effect.gen(function* () {
            const ran = Option.isSome(history) ? yield* history.value.recent : []
            const { browser, viewport } = host.screen?.() ?? UNKNOWN_SCREEN
            // The router's page now; the pages it showed before the form keep where the bug was.
            const current = host.pathname?.()
            return contextOf({ current, pages: current === pages[0] ? pages.slice(1) : pages, ran, build: host.build, browser, viewport })
          }),
      })
    }),
  )
