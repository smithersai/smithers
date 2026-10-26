import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Cache, Context, type Duration, Effect, Layer, Option, Scope, Stream } from "effect"
import { SECRETS_SHAPE_ROUTE } from "./contract"
import { record } from "./metrics"
import { formsQuery, listQuery, viewQuery } from "./queries"
import { SecretForm, SecretRow, SecretsView, VIEW } from "./schema"
import { awaiting, landed } from "./view"

// Secrets on this tab (decision 0005 §4, docs/features/secrets.md#the-secrets-page): each repository's secret names and
// bindings in Postgres, synced by Electric once its page opens and kept on the device; what the route shows; and each
// form's last write. No collection here has a field for a value, so none can hold one: a value lives in its form's
// input until the write is sent (actions.ts), and nowhere after.

/**
 * Where the secrets sync from: ChatApi's origin; and how long a write ChatApi took may take to show in the list before
 * the page says it hasn't yet (`confirmWithin`, 60 s unless set).
 */
export interface SecretsConfig {
  readonly origin: string
  readonly confirmWithin?: Duration.Input
}

/** A secret's key in its repository's collection: its name. */
const byName = (row: SecretRow): string => row.name

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/** One repository's secrets, live. */
export type SecretList = Query<typeof listQuery>

/**
 * The secrets' state for one tab:
 * - `listOf(repoId)`: a repository's secrets, synced once a page opened them, for as long as the store lives;
 * - `opened(repoId)`: the same, if a page opened them, else none; `empty`, the rows of a repository not opened;
 * - `view`: what the route shows; `forms`: each form's last write; their live queries; `scope`, where a write runs;
 * - `confirmWithin`: how long a taken write may take to show in the list.
 *
 * While a repository's list is open, a follower watches it beside the forms: a write ChatApi took, or whose answer never
 * came, is `done` once the list shows it landed (`landed`), and its Rotate or Delete closes.
 */
export class SecretsStore extends Context.Service<
  SecretsStore,
  {
    readonly listOf: (repoId: string) => Effect.Effect<SecretList, Collection.LoadFailed>
    readonly opened: (repoId: string) => SecretList | undefined
    readonly empty: SecretList
    /** Secret `name`'s row, if the device has it. */
    readonly rowOf: (repoId: string, name: string) => Effect.Effect<Option.Option<SecretRow>>
    readonly view: Collection.Collection<SecretsView, string>
    readonly forms: Collection.Collection<SecretForm, string>
    readonly viewState: Query<typeof viewQuery>
    readonly formList: Query<typeof formsQuery>
    readonly scope: Scope.Scope
    readonly confirmWithin: Duration.Input
  }
>()("@smthrs/mvp/secrets/SecretsStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. */
  static readonly layer = (config: SecretsConfig) => Layer.effect(SecretsStore, make(config))
}

const make = Effect.fnUntraced(function* (config: SecretsConfig) {
  const scope = yield* Effect.scope
  const persistence = yield* Persistence.Persistence
  const view = yield* Collection.local<SecretsView, string>({
    id: "secrets-view",
    schema: SecretsView,
    getKey: (row) => row.id,
    initialData: [{ id: VIEW, owner: "", name: "", repoId: "", rotating: null, deleting: null }],
  })
  const forms = yield* Collection.local<SecretForm, string>({
    id: "secret-forms",
    schema: SecretForm,
    getKey: (row) => row.id,
  })
  // A repository nobody opened: no rows, never a request.
  const nothing = yield* Collection.local<SecretRow, string>({
    id: "secrets-none",
    schema: SecretRow,
    getKey: byName,
  })
  const empty = yield* listQuery(nothing)
  const formList = yield* formsQuery(forms)

  /** A form's write the list shows landed: Add's form says so; Rotate's and Delete's close. */
  const settle = (form: SecretForm) =>
    Effect.gen(function* () {
      const op = form.kind === "delete" ? "delete" : "put"
      // A lost 202 left the outcome unknown; the row now proves ChatApi took the write.
      if (form.state === "unknown") yield* record(op, form.secret, "started")
      yield* record(op, form.secret, "landed")
      if (form.kind === "add") return yield* forms.update(form.id, (row) => {
        if (row.state === "unknown") row.saved++
        row.state = "done"
      })
      yield* forms.delete(form.id)
      yield* view.update(VIEW, (row) => {
        if (row.repoId !== form.repoId) return
        if (row.rotating === form.secret && form.kind === "rotate") row.rotating = null
        if (row.deleting === form.secret && form.kind === "delete") row.deleting = null
      })
      // expected: Discard can close a late form while the list settles it, and it is then gone already
    }).pipe(Effect.ignore)

  // The lists opened so far, by repository id, for frontends to read at once; each opens once (`opening`).
  const lists = new Map<string, SecretList>()
  const collections = new Map<string, ElectricCollection.ElectricCollection<SecretRow>>()
  const open = (id: string) =>
    Effect.gen(function* () {
      const secrets = yield* ElectricCollection.make<SecretRow>({
        id: `secrets:${id}`,
        schema: SecretRow,
        getKey: byName,
        // ChatApi's proxy of one repository's names and bindings; anyone below Member gets a shape with no rows.
        shape: {
          url: `${config.origin}${SECRETS_SHAPE_ROUTE}?repo=${encodeURIComponent(id)}`,
          columnMapper: ElectricCollection.snakeCamelMapper(),
          parser: { timestamptz: (value: string) => new Date(value).toISOString() },
        },
        syncMode: "eager",
        persist: { schemaVersion: 1 },
      })
      const list = yield* listQuery(secrets)
      yield* Stream.zipLatest(list.rows, formList.rows).pipe(
        Stream.runForEach(([rows, all]) =>
          Effect.forEach(all.filter((form) => form.repoId === id && awaiting(form) && landed(form, rows)), settle, {
            discard: true,
          })
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      lists.set(id, list)
      collections.set(id, secrets)
      return list
    }).pipe(Scope.provide(scope), Effect.provideService(Persistence.Persistence, persistence))
  // Opening a list twice at once opens it once: the cache runs one lookup per repository and keeps it.
  const opening = yield* Cache.make({ lookup: open, capacity: Number.MAX_SAFE_INTEGER })

  return SecretsStore.of({
    listOf: (id) => Cache.get(opening, id),
    opened: (id) => lists.get(id),
    empty,
    rowOf: (id, name) => {
      const secrets = collections.get(id)
      return secrets === undefined ? Effect.succeed(Option.none()) : secrets.get(name)
    },
    view,
    forms,
    viewState: yield* viewQuery(view),
    formList,
    scope,
    confirmWithin: config.confirmWithin ?? "60 seconds",
  })
})
