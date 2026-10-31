import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Context, type Duration, Effect, Layer, type Scope, Stream } from "effect"
import { recordUnhandled } from "../../boundary"
import { AuthStore } from "../auth/store"
import { PERSONAL_MODEL_SHAPE_ROUTE } from "./contract"
import { record } from "./metrics"
import { addQuery, formQuery, linkQuery, rowsQuery, testQuery } from "./queries"
import { ADD, AddRow, FORM, Form, LINK, LinkRow, PersonalModelRow, TestRow } from "./schema"
import { signedInShapeSource } from "../auth/source"
import { awaiting, landed, linked } from "./view"

// A person's own models on this tab (decisions 0096 and 0107, docs/features/personal-model.md#the-settings-section):
// their connections' rows in Postgres, synced by Electric once they are signed in and kept on the device; the form's
// last write, the last test, what Add shows and the last Codex link, in memory. No collection here has a field for a
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
 * - `rows`: their connections' rows, synced while they are signed in, kept on the device; `saved`, their live query;
 * - `form` and `formState`: the form's last write; `tests` and `testState`: the last test;
 * - `add` and `addState`: what Add shows; `link` and `linkState`: the last Codex link;
 * - `scope`, where a write runs; `confirmWithin`, how long a taken write may take to show in the row.
 *
 * A follower watches the rows beside the form: a write ChatApi took, or whose answer never came, is `done` once the rows
 * show it landed (`landed`): a save's rows with what it sent, a remove's rows gone. Another watches them beside the
 * link: a link waiting is `done` once the rows show its connection (`linked`).
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
    readonly add: Collection.Collection<AddRow, string>
    readonly addState: Query<typeof addQuery>
    readonly link: Collection.Collection<LinkRow, string>
    readonly linkState: Query<typeof linkQuery>
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
    // One row per connection.
    getKey: (row) => row.id,
    // ChatApi's proxy of the person's own rows, never another's, and never the sealed key's columns.
    shape: {
      url: `${config.origin}${PERSONAL_MODEL_SHAPE_ROUTE}`,
      columnMapper: ElectricCollection.snakeCamelMapper(),
      parser: { timestamptz: (value: string) => new Date(value).toISOString() },
    },
    syncMode: "eager",
    persist: { schemaVersion: 3 },
  }).pipe(Effect.provideService(ShapeSource.ShapeSource, signedInShapeSource(source, auth)))
  const form = yield* Collection.local<Form, string>({ id: "personal-model-form", schema: Form, getKey: (row) => row.id })
  const tests = yield* Collection.local<TestRow, string>({
    id: "personal-model-test",
    schema: TestRow,
    getKey: (row) => row.id,
  })
  const add = yield* Collection.local<AddRow, string>({
    id: "personal-model-add",
    schema: AddRow,
    getKey: (row) => row.id,
    initialData: [{ id: ADD, view: "closed" }],
  })
  const link = yield* Collection.local<LinkRow, string>({ id: "personal-model-link", schema: LinkRow, getKey: (row) => row.id })
  const saved = yield* rowsQuery(rows)
  const formState = yield* formQuery(form)
  const linkState = yield* linkQuery(link)

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
      if (write.adding) yield* add.update(ADD, (draft) => void (draft.view = "closed"))
      // The form's row is there (the follower read it) and nothing deletes it: a refusal is a bug.
    }).pipe(Effect.orDie)
  yield* Stream.zipLatest(saved.rows, formState.rows).pipe(
    Stream.runForEach(([synced, [write]]) =>
      write !== undefined && awaiting(write) && landed(write, synced) ? settle(write) : Effect.void
    ),
    (follower) => recordUnhandled(follower, "personal-model", "fork"),
    Effect.forkIn(scope, { startImmediately: true }),
  )

  /** The link the rows show landed: `done`, and its dialog closes. */
  const settleLink = Effect.gen(function* () {
    yield* record("link", "landed")
    yield* link.update(LINK, (draft) => void (draft.state = "done"))
    yield* add.update(ADD, (draft) => void (draft.view = "closed"))
    // Both rows are there (the follower read one, `initialData` made the other): a refusal is a bug.
  }).pipe(Effect.orDie)
  yield* Stream.zipLatest(saved.rows, linkState.rows).pipe(
    Stream.runForEach(([synced, [waiting]]) => waiting !== undefined && linked(waiting, synced) ? settleLink : Effect.void),
    (follower) => recordUnhandled(follower, "personal-model", "fork"),
    Effect.forkIn(scope, { startImmediately: true }),
  )

  return PersonalModelStore.of({
    rows,
    saved,
    form,
    formState,
    tests,
    testState: yield* testQuery(tests),
    add,
    addState: yield* addQuery(add),
    link,
    linkState,
    scope,
    confirmWithin: config.confirmWithin ?? "60 seconds",
  })
})
