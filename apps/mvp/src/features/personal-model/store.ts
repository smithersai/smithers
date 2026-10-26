import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Context, type Duration, Effect, Layer, type Scope, Stream } from "effect"
import { AuthStore } from "../auth/store"
import { PERSONAL_MODEL_SHAPE_ROUTE } from "./contract"
import { record } from "./metrics"
import { formQuery, hiddenQuery, rowsQuery, testQuery } from "./queries"
import { FORM, Form, Hidden, PersonalModelRow, TestRow } from "./schema"
import { signedInShapeSource } from "./source"
import { awaiting, landed } from "./view"

// A person's own models on this tab (decisions 0096 and 0107, docs/features/personal-model.md#the-settings-section):
// their saved keys' rows in Postgres, synced by Electric once they are signed in and kept on the device; the form's last write and the last test,
// in memory; and the failure whose toast this device hid, kept on the device. No collection here has a field for a
// key, so none can hold one: the key lives in the form's password field until Save (actions.ts), and nowhere after.

/**
 * Where the rows sync from: ChatApi's origin; and how long a write ChatApi took may take to show in the rows before the
 * section says it hasn't yet (`confirmWithin`, 60 s unless set).
 */
export interface PersonalModelConfig {
  readonly origin: string
  readonly confirmWithin?: Duration.Input
}

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/**
 * The state of a person's own model on one tab:
 * - `rows`: their saved keys' rows, synced while they are signed in, kept on the device; `saved`, their live query;
 * - `form` and `formState`: the form's last write; `tests` and `testState`: the last test;
 * - `hidden` and `hiddenState`: the failure whose toast this device hid;
 * - `scope`, where a write runs; `confirmWithin`, how long a taken write may take to show in the row.
 *
 * A follower watches the rows beside the form: a write ChatApi took, or whose answer never came, is `done` once the rows
 * show it landed (`landed`): a save's rows with what it sent, a remove's rows gone.
 */
export class PersonalModelStore extends Context.Service<
  PersonalModelStore,
  {
    readonly rows: ElectricCollection.ElectricCollection<PersonalModelRow>
    readonly saved: Query<typeof rowsQuery>
    readonly form: Collection.Collection<Form, string>
    readonly formState: Query<typeof formQuery>
    readonly tests: Collection.Collection<TestRow, string>
    readonly testState: Query<typeof testQuery>
    readonly hidden: Collection.Collection<Hidden, string>
    readonly hiddenState: Query<typeof hiddenQuery>
    readonly scope: Scope.Scope
    readonly confirmWithin: Duration.Input
  }
>()("@smthrs/mvp/personal-model/PersonalModelStore") {
  /** The store; its collections cleaned up and its shape closed when the scope closes. */
  static readonly layer = (config: PersonalModelConfig) => Layer.effect(PersonalModelStore, make(config))
}

const make = Effect.fnUntraced(function* (config: PersonalModelConfig) {
  const scope = yield* Effect.scope
  const auth = yield* AuthStore
  const source = yield* ShapeSource.ShapeSource
  const rows = yield* ElectricCollection.make<PersonalModelRow>({
    id: "personal-model",
    schema: PersonalModelRow,
    // One row per saved key: the person's, by protocol.
    getKey: (row) => `${row.personId}:${row.protocol}`,
    // ChatApi's proxy of the person's own rows, never another's, and never the sealed key's columns.
    shape: {
      url: `${config.origin}${PERSONAL_MODEL_SHAPE_ROUTE}`,
      columnMapper: ElectricCollection.snakeCamelMapper(),
      parser: { timestamptz: (value: string) => new Date(value).toISOString() },
    },
    syncMode: "eager",
    persist: { schemaVersion: 2 },
  }).pipe(Effect.provideService(ShapeSource.ShapeSource, signedInShapeSource(source, auth)))
  const form = yield* Collection.local<Form, string>({ id: "personal-model-form", schema: Form, getKey: (row) => row.id })
  const tests = yield* Collection.local<TestRow, string>({
    id: "personal-model-test",
    schema: TestRow,
    getKey: (row) => row.id,
  })
  const hidden = yield* Collection.persisted<Hidden, string>({
    id: "personal-model-hidden",
    schema: Hidden,
    getKey: (row) => row.id,
    schemaVersion: 1,
  })
  const saved = yield* rowsQuery(rows)
  const formState = yield* formQuery(form)

  /** The form's write the rows show landed: `done`. */
  const settle = (write: Form) =>
    Effect.gen(function* () {
      const op = write.op === "remove" ? "delete" : "put"
      // A lost answer left the outcome unknown; the rows now prove ChatApi took the write.
      if (write.state === "unknown") yield* record(op, "started")
      yield* record(op, "landed")
      yield* form.update(FORM, (draft) => {
        if (draft.state === "unknown") draft.saved++
        draft.state = "done"
      })
    }).pipe(Effect.ignore)
  yield* Stream.zipLatest(saved.rows, formState.rows).pipe(
    Stream.runForEach(([synced, [write]]) =>
      write !== undefined && awaiting(write) && landed(write, synced) ? settle(write) : Effect.void
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  )

  return PersonalModelStore.of({
    rows,
    saved,
    form,
    formState,
    tests,
    testState: yield* testQuery(tests),
    hidden,
    hiddenState: yield* hiddenQuery(hidden),
    scope,
    confirmWithin: config.confirmWithin ?? "60 seconds",
  })
})
