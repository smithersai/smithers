import type { Interactions } from "@smthrs/views"
import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { FlowDispatch } from "../../flows/dispatch"
import type { AppTemplate } from "./contract"
import { type Minimized, minimize, opened } from "./minimize"
import { SHOWING } from "./schema"
import { ViewsStore } from "./store"

// The conversation's views as a frontend sees them: a live query to read and a plain function to act, with no Effect in
// sight. The conversation renders each view from its own row (src/features/chat/queries.ts); the full-screen route's
// loader calls `show`, and its screen renders `shown`.

type Store = ViewsStore["Service"]

/** What a frontend reads live: the view this tab shows full screen, once the device has it. */
export interface ViewsQueries {
  readonly shown: Store["shown"]["tanstack"]
  /** The view shown full screen from branch conversation `conversationId`; the home one's for none or one not open. */
  readonly shownIn: (conversationId: string | undefined) => Store["shown"]["tanstack"]
  /**
   * The views of branch conversation `conversationId`, or of the home conversation for none or one not open: each
   * row, by which the conversation renders a view it lists (src/features/chat/queries.ts).
   */
  readonly rowsIn: (conversationId: string | undefined) => ReturnType<Store["rowsIn"]>["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface ViewsActions {
  /**
   * What the full-screen route's loader calls: shows the view with this id, of branch conversation `conversationId`
   * when given (decision 0013 §1). Resolves once that conversation's views are open.
   */
  readonly show: (viewId: string, conversationId?: string) => Promise<void>
  /**
   * A person's move in a generated view (a `state` event from its frame): `view/set-state` through door `view`. ChatApi
   * makes it from the board it keeps, and every device shows the new board once it syncs; a move against an older
   * board changes nothing. Resolves once the flow has answered.
   */
  readonly move: (viewId: string, revision: number, event: Interactions.Event) => Promise<void>
  /**
   * Back to chat on a repository's or its issues' full-screen page: the path to go to now. The page the view was opened
   * from, or the chat, with the repository left in the home conversation in the background (src/features/views/minimize.ts).
   */
  readonly minimize: (target: Minimized) => string
  /** A repository's or its issues' view opened full screen from the page at `returnTo`: Back to chat returns there. */
  readonly opened: (viewId: string, template: AppTemplate, repo: string, returnTo: string) => void
}

/** Shows the view with `viewId` full screen in this tab: the one row of `showing`. */
export const show = (viewId: string, conversationId?: string) =>
  Effect.gen(function* () {
    const { showing, forConversation } = yield* ViewsStore
    // Select in navigation order; opening the conversation may yield to a later navigation.
    yield* showing.update(SHOWING, (draft) => {
      draft.viewId = viewId
      draft.conversationId = conversationId ?? null
    })
    if (conversationId !== undefined) yield* forConversation(conversationId)
  }).pipe(
    // A local collection refuses only a row its own schema rejects, which an id never is: a bug, not a state.
    Effect.orDie,
  )

/** Dispatches the move: `view/set-state`, door `view`. Its outcome is the flow's to record (src/features/views/steps.ts). */
export const move = (viewId: string, revision: number, event: Interactions.Event) =>
  Effect.gen(function* () {
    yield* (yield* FlowDispatch).dispatch("view/set-state", { viewId, revision, event }, { door: "view" }).pipe(
      Effect.ignore,
    )
  }).pipe(Effect.withSpan("views.move.dispatch"))

export class Views extends Context.Service<Views, { readonly queries: ViewsQueries; readonly actions: ViewsActions }>()(
  "@smthrs/mvp/views/Views",
) {
  /** Binds the store's query and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Views,
    Effect.gen(function* () {
      const store = yield* ViewsStore
      const context = yield* Effect.context<ViewsStore | FlowDispatch>()
      const { runPromise: run, runSync: sync } = runners(context, "views")
      return Views.of({
        queries: {
          shown: store.shown.tanstack,
          shownIn: (conversationId) =>
            (conversationId === undefined ? undefined : store.shownIn(conversationId))?.tanstack ?? store.shown.tanstack,
          rowsIn: (conversationId) => store.rowsIn(conversationId).tanstack,
        },
        actions: {
          show: (viewId, conversationId) => run(Effect.asVoid(show(viewId, conversationId))),
          move: (viewId, revision, event) => run(move(viewId, revision, event)),
          minimize: (target) => sync(minimize(target)),
          opened: (viewId, template, repo, returnTo) => sync(opened(viewId, template, repo, returnTo)),
        },
      })
    }),
  )
}

/** The views layer's value: what frontends get. */
export type ViewsView = Views["Service"]
