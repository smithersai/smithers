import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { answer, closePanel, dismiss, expand, hide, open, openPanel, read, retry, togglePanel } from "./actions"
import type { PanelVia, Surface } from "./contract"
import { AttentionStore } from "./store"

// The personal feed as a frontend sees it (decision 0009): live queries to read and plain functions to act, with no
// Effect in sight. The stack reads `stack` and `list` on a page, and `stackHere` and `listHere` over a conversation;
// the top bar's bell reads `unread` and `needs`, and the notifications panel `feed`, `panel` and the expanded entry's
// `detail`.

type Store = AttentionStore["Service"]

/** What a frontend reads live. */
export interface AttentionQueries {
  readonly stack: Store["stack"]["tanstack"]
  readonly stackHere: Store["stackHere"]["tanstack"]
  readonly list: Store["list"]["tanstack"]
  readonly listHere: Store["listHere"]["tanstack"]
  readonly feed: Store["feed"]["tanstack"]
  readonly unread: Store["unread"]["tanstack"]
  readonly needs: Store["needs"]["tanstack"]
  readonly panel: Store["panelState"]["tanstack"]
  readonly detail: Store["detail"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface AttentionActions {
  /** Opens entry `subject` from `surface`: a toast, its Answer, or the panel's Open. */
  readonly open: (subject: string, surface: Surface) => void
  /** Hides entry `subject`'s toast; it stays in the list. */
  readonly hide: (subject: string) => void
  /** Dismisses entry `subject`. */
  readonly dismiss: (subject: string) => void
  /** Marks entry `subject` read. */
  readonly read: (subject: string) => void
  /** A on entry `subject`: its question's field in the panel, or a toast's Answer. */
  readonly answer: (subject: string, surface: Surface | "panel") => void
  /** Opens the notifications panel, at entry `subject` when given. */
  readonly openPanel: (via: PanelVia, subject?: string) => void
  /** The bell and Alt+N: opens the panel, or closes it. */
  readonly togglePanel: (via: PanelVia) => void
  readonly closePanel: () => void
  /** Expands entry `subject` in the panel, or collapses it. */
  readonly expand: (subject: string) => void
  /** Retry on the person's failed run, from the panel. */
  readonly retry: (subject: string) => void
}

export class Attention extends Context.Service<
  Attention,
  { readonly queries: AttentionQueries; readonly actions: AttentionActions }
>()("@smthrs/mvp/attention/Attention") {
  /** Binds the store's queries and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Attention,
    Effect.gen(function* () {
      const store = yield* AttentionStore
      type Needs<A> = A extends (...args: never) => Effect.Effect<unknown, unknown, infer R> ? R : never
      const { runSync: run } = runners(
        yield* Effect.context<
          | Needs<typeof open>
          | Needs<typeof answer>
          | Needs<typeof retry>
          | Needs<typeof togglePanel>
          | Needs<typeof expand>
        >(),
        "attention",
      )
      return Attention.of({
        queries: {
          stack: store.stack.tanstack,
          stackHere: store.stackHere.tanstack,
          list: store.list.tanstack,
          listHere: store.listHere.tanstack,
          feed: store.feed.tanstack,
          unread: store.unread.tanstack,
          needs: store.needs.tanstack,
          panel: store.panelState.tanstack,
          detail: store.detail.tanstack,
        },
        actions: {
          open: (subject, surface) => run(open(subject, surface)),
          hide: (subject) => run(hide(subject)),
          dismiss: (subject) => run(dismiss(subject)),
          read: (subject) => run(read(subject)),
          answer: (subject, surface) => run(answer(subject, surface)),
          openPanel: (via, subject) => run(openPanel(via, subject ?? null)),
          togglePanel: (via) => run(togglePanel(via)),
          closePanel: () => run(closePanel),
          expand: (subject) => run(expand(subject)),
          retry: (subject) => run(retry(subject)),
        },
      })
    }),
  )
}

/** The feed layer's value: what frontends get. */
export type AttentionView = Attention["Service"]
