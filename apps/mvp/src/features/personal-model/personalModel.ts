import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import { add, link, move, remove, removeAll, save, setActive, showAdd, test } from "./actions"
import type { PersonalModelClient } from "./api"
import type { ConnectionPut } from "./contract"
import type { AddView } from "./schema"
import { PersonalModelStore } from "./store"
import type { SaveForm } from "./view"

// A person's own models as a frontend sees them (docs/features/personal-model.md#the-settings-section): live queries to
// read and plain functions to act, with no Effect in sight. A key passes through `save` once, into its request, and is
// kept nowhere.

type Store = PersonalModelStore["Service"]

/** What a frontend reads live. */
export interface PersonalModelQueries {
  /** The person's connections, in their order: kind, active, base URL, tiers' models, last characters, last failure. */
  readonly saved: Store["saved"]["tanstack"]
  /** The form's last write: on its way, or why it failed. */
  readonly form: Store["formState"]["tanstack"]
  /** The last test: running, its result, or why there was none. */
  readonly test: Store["testState"]["tanstack"]
  /** Which of Add's menu and forms shows. */
  readonly add: Store["addState"]["tanstack"]
  /** The last Codex link: its code, or how it ended. */
  readonly link: Store["linkState"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface PersonalModelActions {
  /** Save the whole list: whether it was sent. */
  readonly save: (form: SaveForm) => boolean
  /** Add a connection, last: whether it was sent. */
  readonly add: (connection: ConnectionPut) => boolean
  /** Turn a connection on or off: whether it was sent. */
  readonly setActive: (id: string, active: boolean) => boolean
  /** Move a connection one place: whether it was sent. */
  readonly move: (id: string, by: -1 | 1) => boolean
  /** Remove one connection: whether it was sent. */
  readonly remove: (id: string) => boolean
  /** Remove every connection: whether it was sent. */
  readonly removeAll: () => boolean
  /** Test a saved connection, or each active one: a supplied list must validate and match the saved one before sending. */
  readonly test: (connection?: string, draft?: SaveForm) => boolean
  /** Show Add's menu, a kind's form, or neither. */
  readonly showAdd: (view: AddView) => void
  /** Start a Codex link: whether it was sent. */
  readonly link: () => boolean
}

export class PersonalModel extends Context.Service<
  PersonalModel,
  { readonly queries: PersonalModelQueries; readonly actions: PersonalModelActions }
>()("@smthrs/mvp/personal-model/PersonalModel") {
  /** Binds the store's queries and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    PersonalModel,
    Effect.gen(function* () {
      const store = yield* PersonalModelStore
      const { runSync: run } = runners(yield* Effect.context<PersonalModelStore | PersonalModelClient | FlowDispatch>(), "personal-model")
      return PersonalModel.of({
        queries: {
          saved: store.saved.tanstack,
          form: store.formState.tanstack,
          test: store.testState.tanstack,
          add: store.addState.tanstack,
          link: store.linkState.tanstack,
        },
        actions: {
          save: (form) => run(save(form)),
          add: (connection) => run(add(connection)),
          setActive: (id, active) => run(setActive(id, active)),
          move: (id, by) => run(move(id, by)),
          remove: (id) => run(remove(id)),
          removeAll: () => run(removeAll),
          test: (connection, draft) => run(test(connection, draft)),
          showAdd: (view) => run(showAdd(view)),
          link: () => run(link),
        },
      })
    }),
  )
}

/** The personal model layer's value: what frontends get. */
export type PersonalModelView = PersonalModel["Service"]
