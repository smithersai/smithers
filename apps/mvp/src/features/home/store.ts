import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Context, Effect, FiberHandle, Layer, Option, Semaphore, type Schema } from "effect"
import { CuratedHomesStore, HomesStore } from "../../device/registry"
import { ItemSummary, SyncRow, syncKey } from "../issues/schema"
import type { Source, Visible } from "../repo/gate"
import { RepoStore } from "../repo/store"
import { Run } from "../status/schema"
import { StatusStore } from "../status/store"
import { Access, Todo } from "../todos/schema"
import { CuratedRow, CurrentRow, emptyCurrent, FileRow, HomeRow } from "./rows"

// A repository's home on this tab (docs/features/home.md#the-browser): every home this device read, kept on the device
// because a home at a commit never changes; the curated homes ChatApi answered, kept until the next answer; the files
// a home's Markdown blocks read, in memory; and whose home the routed page shows. Actions reach RepoApi through the
// repository feature's `RepoClient` and ChatApi through `HomeClient`; nothing here does.

type Rows<A extends object> = Collection.Collection<A, string>
/** What the page's queries read: rows through the data gate (repo/gate.ts), or the tab's own. */
type Shown<A extends object> = Source<A>

/** Identity shared by the tab's rows, including its empty fallback collections. */
const rowId = (row: { readonly id: string }): string => row.id

/** Whose home the page shows, with its declared home once this device has read it, and its curated one. */
export const homeQuery = (current: Rows<CurrentRow>, homes: Shown<HomeRow>, curated: Shown<CuratedRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ current: current.tanstack })
      .leftJoin({ home: homes.tanstack }, ({ current, home }) => Query.eq(current.key, home.key))
      .leftJoin({ curated: curated.tanstack }, ({ current, curated }) => Query.eq(current.repoId, curated.key))
      .findOne()
  )

/** The files the shown home's Markdown blocks read. */
export const filesQuery = (current: Rows<CurrentRow>, files: Shown<FileRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ file: files.tanstack })
      .innerJoin({ current: current.tanstack }, ({ file, current }) => Query.eq(file.home, current.key))
      .select(({ file }) => ({ path: file.path, state: file.state, text: file.text }))
  )

/**
 * The shown repository's declared and curated homes, while it may show (the data gate, repo/gate.ts): a home and a
 * curated home name their repository only in their key, and the page reads only the current repository's, so each is
 * joined through the current row's repository to its visibility row.
 */
const shownHomesQuery = (current: Rows<CurrentRow>, homes: Rows<HomeRow>, visible: Shown<Visible>) =>
  LiveQuery.make((q) =>
    q
      .from({ home: homes.tanstack })
      .innerJoin({ current: current.tanstack }, ({ home, current }) => Query.eq(home.key, current.key))
      .innerJoin({ seen: visible.tanstack }, ({ current, seen }) => Query.eq(current.repoId, seen.id))
      .where(({ seen }) => Query.eq(seen.show, true))
      .select(({ home }) => home)
  )
const shownCuratedQuery = (current: Rows<CurrentRow>, curated: Rows<CuratedRow>, visible: Shown<Visible>) =>
  LiveQuery.make((q) =>
    q
      .from({ curated: curated.tanstack })
      .innerJoin({ current: current.tanstack }, ({ curated, current }) => Query.eq(curated.key, current.repoId))
      .innerJoin({ seen: visible.tanstack }, ({ current, seen }) => Query.eq(current.repoId, seen.id))
      .where(({ seen }) => Query.eq(seen.show, true))
      .select(({ curated }) => curated)
  )

/** Every row of a collection, live. */
const rowsOf = <A extends object>(collection: { readonly tanstack: Collection.Collection<A, any>["tanstack"] }) =>
  LiveQuery.make((q) => q.from({ row: collection.tanstack }))

/**
 * Every row of `pick`'s collection from a store this tab may lack: none when it has no such store, as a test of the
 * home alone has none.
 */
const liveRows = <S, A extends object>(
  store: Option.Option<S>,
  pick: (store: S) => { readonly tanstack: Collection.Collection<A, any>["tanstack"] },
  empty: { readonly id: string; readonly schema: Schema.Codec<A, any>; readonly getKey: (row: A) => string },
) =>
  Effect.gen(function* () {
    if (Option.isSome(store)) return yield* rowsOf(pick(store.value))
    return yield* rowsOf(yield* Collection.local<A, string>(empty))
  })

const make = Effect.gen(function* () {
  const homes = yield* Collection.persisted(HomesStore)
  const curated = yield* Collection.persisted(CuratedHomesStore)
  const files = yield* Collection.local<FileRow, string>({ id: "home-files", schema: FileRow, getKey: (row) => row.key })
  // A refused repository's homes, which hold its README and manifest, leave the device with its other rows.
  const repos = yield* Effect.serviceOption(RepoStore)
  if (Option.isSome(repos)) {
    yield* repos.value.registerCache(["homes", "curated-homes", "home-files"], (id) => Effect.gen(function* () {
      // After the device's rows are back: a wipe that ran first would see none, and they'd return after it.
      yield* Effect.all([homes.restored, curated.restored], { discard: true })
      yield* Effect.forEach(yield* files.toArray, (row) => row.key.startsWith(`${id}@`) ? Effect.ignore(files.delete(row.key)) : Effect.void, { discard: true })
      yield* Effect.forEach(yield* homes.toArray, (row) => row.key.startsWith(`${id}@`) ? Effect.ignore(homes.delete(row.key)) : Effect.void, { discard: true })
      yield* Effect.ignore(curated.delete(id))
    }))
  }
  const current = yield* Collection.local<CurrentRow, string>({
    id: "home-current",
    schema: CurrentRow,
    getKey: rowId,
    initialData: [emptyCurrent],
  })
  const shownFiles = Option.isSome(repos) ? yield* repos.value.gate(files) : files
  let shownHomes: Shown<HomeRow> = homes
  let shownCurated: Shown<CuratedRow> = curated
  if (Option.isSome(repos)) {
    const { track, visible } = repos.value
    // The shown repository gets a visibility row as the route names it.
    yield* Effect.acquireRelease(
      Effect.sync(() => current.tanstack.subscribeChanges((changes) => {
        for (const change of changes) if (change.type !== "delete") track(change.value.repoId)
      }, { includeInitialState: true })),
      (subscription) => Effect.sync(() => subscription.unsubscribe()),
    )
    shownHomes = (yield* shownHomesQuery(current, homes, visible)) as unknown as typeof shownHomes
    shownCurated = (yield* shownCuratedQuery(current, curated, visible)) as unknown as typeof shownCurated
  }
  // The live blocks' rows, from the stores that sync them: this person's runs, only those whose conversation may show
  // (the data gate, `StatusStore.shownRuns`), so one repository's home never lists a refused one's runs. A `stack`
  // block's rows are the TODOs store's own (`TodosStore.opened`), and an `issues` block's the issues store's.
  const status = yield* Effect.serviceOption(StatusStore)
  const runs = yield* liveRows(status, (store) => store.shownRuns as unknown as { readonly tanstack: Collection.Collection<Run, any>["tanstack"] }, { id: "home-no-runs", schema: Run, getKey: rowId })
  // What an `issues` block reads on a tab with no issues store: no issues, and no sync.
  const noItems = yield* rowsOf(yield* Collection.local<ItemSummary, string>({ id: "home-no-items", schema: ItemSummary, getKey: rowId }))
  const noSyncs = yield* rowsOf(yield* Collection.local<SyncRow, string>({ id: "home-no-syncs", schema: SyncRow, getKey: syncKey }))
  // What a `stack` block reads on a tab with no TODOs store: no TODOs, and no word on access.
  const noTodos = yield* rowsOf(yield* Collection.local<Todo, string>({ id: "home-no-todos", schema: Todo, getKey: rowId }))
  const noAccess = yield* rowsOf(
    yield* Collection.local<Access, string>({ id: "home-no-access", schema: Access, getKey: rowId }),
  )
  return {
    homes,
    /** Serializes declaration readers until the cached row is available. */
    homeReads: new Map<string, Semaphore.Semaphore>(),
    /** Tokens keep action completions scoped to the page that started them. */
    actions: new Map<string, symbol>(),
    curated,
    noItems,
    noSyncs,
    runs,
    noTodos,
    noAccess,
    files,
    current,
    // The data gate (repo/gate.ts): the page reads a repository's homes and files only while it may show. A tab
    // without the repository store has no refusal to keep.
    homeState: yield* homeQuery(current, shownHomes, shownCurated),
    fileState: yield* filesQuery(current, shownFiles),
    /** The one load the routed page runs: opening another repository interrupts it. */
    loader: yield* FiberHandle.make<void, Collection.LoadFailed>(),
    /** Where the loads an action starts run, closed with the store. */
    scope: yield* Effect.scope,
  }
})

/**
 * The home's state for one tab:
 * - `homes`: each home this device read, by repository and commit; kept on the device.
 * - `curated`: the curated home ChatApi last answered for each repository; kept on the device.
 * - `runs`: a live block's rows, from the agent status's store when the tab has it; `noItems`, `noSyncs`: what an
 *   `issues` block reads on a tab without the issues' store.
 * - `files`: the files the Markdown blocks read, by home and path.
 * - `current`: whose home the routed page shows, one row.
 * - the live queries frontends read, `loader` and `scope`.
 */
export class HomeStore extends Context.Service<HomeStore, Effect.Success<typeof make>>()("@smthrs/mvp/home/HomeStore") {
  /** The store; its collections cleaned up and its load interrupted with the scope. */
  static readonly layer = Layer.effect(HomeStore, make)
}
