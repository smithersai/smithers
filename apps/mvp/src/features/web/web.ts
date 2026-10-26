import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { cardOpened } from "./actions"

// Web pages as a frontend sees them: plain functions to act, with no Effect in sight. A page's view and card render
// from the conversation's own rows (src/features/views/components); a person's `/web` runs through the slash commands
// (src/features/commands/actions.ts), which hand it to `openWebPage`.

/** What a person does, as plain functions. Each finishes before it returns. */
export interface WebActions {
  /** A card's Open button: the person's click opens the page in a new tab, which the browser always allows. */
  readonly cardOpened: () => void
}

export class Web extends Context.Service<Web, { readonly actions: WebActions }>()("@smthrs/mvp/web/Web") {
  /** Binds the actions for frontends, run with the services this layer was built with (`runners`). */
  static readonly layer = Layer.effect(
    Web,
    Effect.gen(function* () {
      const { runSync: run } = runners(yield* Effect.context<never>(), "web")
      return Web.of({ actions: { cardOpened: () => run(cardOpened) } })
    }),
  )
}

/** The web layer's value: what frontends get. */
export type WebView = Web["Service"]
