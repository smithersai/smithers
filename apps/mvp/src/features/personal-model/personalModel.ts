import { Context, Effect, Layer } from "effect"
import type { FlowDispatch } from "../../flows/dispatch"
import { hide, remove, save, test } from "./actions"
import type { PersonalModelClient } from "./api"
import { PersonalModelStore } from "./store"
import type { SaveForm } from "./view"

// A person's own models as a frontend sees them (docs/features/personal-model.md#the-settings-section): live queries to
// read and plain functions to act, with no Effect in sight. A key passes through `save` once, into its request, and is
// kept nowhere.

type Store = PersonalModelStore["Service"]

/** What a frontend reads live. */
export interface PersonalModelQueries {
  /** The person's saved keys, one row per protocol: base URL, tiers' models, last characters and last failure. */
  readonly saved: Store["saved"]["tanstack"]
  /** The form's last write: on its way, or why it failed. */
  readonly form: Store["formState"]["tanstack"]
  /** The last test: running, its result, or why there was none. */
  readonly test: Store["testState"]["tanstack"]
  /** The failure whose toast this device hid. */
  readonly hidden: Store["hiddenState"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface PersonalModelActions {
  /** Save: whether it was sent. */
  readonly save: (form: SaveForm) => boolean
  /** Remove: whether it was sent. */
  readonly remove: () => boolean
  /** Test: whether it was sent. */
  readonly test: () => boolean
  /** Hide on the failure toast, by the failure's `failedAt`. */
  readonly hide: (failedAt: string) => void
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
      const run = Effect.runSyncWith(yield* Effect.context<PersonalModelStore | PersonalModelClient | FlowDispatch>())
      return PersonalModel.of({
        queries: {
          saved: store.saved.tanstack,
          form: store.formState.tanstack,
          test: store.testState.tanstack,
          hidden: store.hiddenState.tanstack,
        },
        actions: {
          save: (form) => run(save(form)),
          remove: () => run(remove),
          test: () => run(test),
          hide: (failedAt) => run(hide(failedAt)),
        },
      })
    }),
  )
}

/** The personal model layer's value: what frontends get. */
export type PersonalModelView = PersonalModel["Service"]
