import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import type { AuthStore } from "../auth/store"
import type { DraftSelection } from "../chat/sharedPrompt"
import type { ChatStore } from "../chat/store"
import { choose, dismiss, highlight, submit, type } from "./actions"
import { CommandsStore } from "./store"
import type { Plugins } from "../../plugins/plugins"
import type { IssuesStore } from "../issues/store"
import type { TodosStore } from "../todos/store"
import type { RunSteers } from "../runs/steers"
import type { SteerWrites } from "../runs/writes"

// Slash commands as a frontend sees them: the menu's live query to read and plain functions to act, with no Effect in
// sight. React renders the query with `useLiveQuery` and hands the actions to the composer; it holds no state.

type Store = CommandsStore["Service"]

/** What a frontend reads: the menu for the composer's draft. */
export interface CommandsQueries {
  readonly menu: Store["menuState"]["tanstack"]
}

/** What a person does in the composer, as plain functions. Write promises resolve after local admission. */
export interface CommandsActions {
  /** The composer's text changed. */
  /** Typing, with where the selection is after it. */
  readonly type: (text: string, selection?: DraftSelection) => Promise<void>
  /** The arrows or the pointer moved the highlight. */
  readonly highlight: (index: number) => void
  /** Enter or a click (`accept`) or Tab (`complete`) on a row. */
  readonly choose: (index: number, how: "accept" | "complete", keyboard?: boolean) => Promise<void>
  /** Escape closed the menu. */
  readonly dismiss: () => void
  /** Enter or Send with no row to choose: run the command, or ask Smithers. */
  readonly submit: (text: string) => Promise<void>
}

export class Commands extends Context.Service<
  Commands,
  { readonly queries: CommandsQueries; readonly actions: CommandsActions }
>()("@smthrs/mvp/commands/Commands") {
  /**
   * Binds the store's query and the actions for frontends. Each action runs its Effect with the services this layer was
   * built with (`runners`, src/boundary.ts); a command's flow runs on in the store's scope.
   */
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const store = yield* CommandsStore
      const { runSync: run, runPromise: promise } = runners(yield* Effect.context<CommandsStore | ChatStore | AuthStore | FlowDispatch | Plugins | IssuesStore | TodosStore | RunSteers | SteerWrites>(), "commands")
      return Commands.of({
        queries: { menu: store.menuState.tanstack },
        actions: {
          type: (text, selection) => promise(type(text, selection)),
          highlight: (index) => run(highlight(index)),
          choose: (index, how, keyboard) => promise(choose(index, how, keyboard)),
          dismiss: () => run(dismiss),
          submit: (text) => promise(submit(text)),
        },
      })
    }),
  )
}

/** The commands layer's value: what frontends get. */
export type CommandsView = Commands["Service"]
