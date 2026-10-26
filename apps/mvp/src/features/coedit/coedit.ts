import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import type { ChatStore } from "../chat/store"
import type { StatusStore } from "../status/store"
import { type Edit, followAnswers, hideFiles, save, select, showFile, type } from "./actions"
import type { Selection } from "./schema"
import { CoeditStore } from "./store"
import type { TextWrites } from "./writes"

// Co-editing as a frontend sees it (docs/features/coedit.md#the-browser): a live query of the texts this tab has open,
// and plain functions to act, with no Effect in sight. Typing and moving the caret finish before they return, so an
// input's change shows in the same event.

type Store = CoeditStore["Service"]

export interface CoeditQueries {
  /** Every text this tab has open: its text, this person's selection and everyone else's carets. */
  readonly texts: Store["textsState"]["tanstack"]
}

export interface CoeditActions {
  /** The person typed in text `textId`, making it `value`. */
  readonly type: (textId: string, value: string, edit?: Edit) => void
  /** The person moved their caret or selection in text `textId`. */
  readonly select: (textId: string, selection: Selection) => void
  /**
   * Shows file `path` of branch `branchId`'s working copy to edit together, or, for `undefined`, leaves the file shown:
   * resolves with the file's text id. A route may cancel a pending open with `signal`.
   */
  readonly showFile: (branchId: string, path: string | undefined, signal?: AbortSignal) => Promise<string | undefined>
  /** Leaves the room of the file shown, as when the live editor goes. */
  readonly hideFiles: () => Promise<void>
  /** Writes an open file to its branch's working copy. */
  readonly save: (textId: string) => Promise<void>
}

export class Coedit extends Context.Service<Coedit, { readonly queries: CoeditQueries; readonly actions: CoeditActions }>()(
  "@smthrs/mvp/coedit/Coedit",
) {
  /** Binds frontend actions to the injected Effect services. */
  static readonly make = Effect.gen(function* () {
    const store = yield* CoeditStore
    const context = yield* Effect.context<CoeditStore | ChatStore | TextWrites | FlowDispatch | StatusStore>()
    const { runSync: sync, runPromise: run } = runners(context, "coedit")
    yield* followAnswers
    return Coedit.of({
      queries: { texts: store.textsState.tanstack },
      actions: {
        type: (textId, value, edit) => sync(type(textId, value, edit)),
        select: (textId, selection) => sync(select(textId, selection)),
        // A route cancels a file it no longer shows with its signal.
        showFile: (branchId, path, signal) => run(showFile(branchId, path), { signal }),
        hideFiles: () => run(hideFiles),
        save: (textId) => run(save(textId)),
      },
    })
  })

  /**
   * Binds the store's query and actions for frontends, with the services this layer was built with, and follows the
   * runs that need this person, whose answer boxes it opens.
   */
  static readonly layer = Layer.effect(Coedit, Coedit.make)
}

/** The co-editing layer's value: what frontends get. */
export type CoeditView = Coedit["Service"]
