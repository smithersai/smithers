import { Collection } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Layer, Ref, type Scope } from "effect"
import { ChatStore } from "../chat/store"
import { menuQuery } from "./queries"
import { Menu, MENU } from "./schema"

// The command menu's state for one tab: one local row (schema.ts `Menu`) and its live query, over chat's composer,
// whose draft the menu completes. Nothing here reaches the network; a command runs as a flow (actions.ts).

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/** The menu as it starts: for the empty draft, listing nothing. */
export const CLOSED: Menu = { id: MENU, draft: "", kind: "none", label: "", items: [], highlighted: 0, refusal: null }

export class CommandsStore extends Context.Service<
  CommandsStore,
  {
    readonly menu: Collection.Collection<Menu, string>
    readonly menuState: Query<typeof menuQuery>
    /** Every menu act, including one that leaves its row unchanged. */
    readonly revision: Ref.Ref<number>
    readonly requestNamespace: string
    /** Where the flows a command starts run, closed with the store. */
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/commands/CommandsStore") {
  /** The store over chat's composer; its collection cleaned up when the scope closes. */
  static readonly layer = Layer.effect(
    CommandsStore,
    Effect.gen(function* () {
      const { composer } = yield* ChatStore
      const menu = yield* Collection.local<Menu, string>({
        id: "commands-menu",
        schema: Menu,
        getKey: (row) => row.id,
        initialData: [CLOSED],
      })
      return { menu, menuState: yield* menuQuery(menu, composer), revision: yield* Ref.make(0), requestNamespace: crypto.randomUUID(), scope: yield* Effect.scope }
    }),
  )
}
