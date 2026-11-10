import { ElectricCollection, type ShapeSource } from "@smthrs/effect-electric"
import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Clock, Context, Deferred, Duration, Effect, Fiber, FiberHandle, Layer, Option, Ref, Stream, type Schedule, SubscriptionRef } from "effect"
import { codeOf } from "../../errorCode"
import { RepoRole, Session } from "../auth/schema"
import { makeVisibility } from "./gate"
import { AuthStore } from "../auth/store"
import { REPOSITORIES_SHAPE_ROUTE } from "./contract"
import { aboutQuery, embedsQuery, fileQuery, manifestQuery, readmeQuery, refsQuery, treeQuery, viewQuery } from "./queries"
import { AboutRow, BlobRow, CloneRow, EmbedRow, emptyView, HeadRow, RefsRow, TreeRow, VIEW, ViewRow } from "./rows"
import { RepoRefusalsStore } from "../../device/registry"
import { Repository } from "./schema"

// The repository feature's state on this tab (docs/features/repo.md#the-browser): the repositories Postgres has, synced
// by Electric and kept on the device; what this tab loaded of them, in memory; where the routed view is; and the live
// queries frontends read. Actions reach the network through `RepoClient`; nothing here does.

/** Where the repositories sync from, and how long Electric gets to deliver a clone RepoApi took. */
export interface RepoConfig {
  /** RepoApi's origin: the site's own. */
  readonly origin: string
  /** How long Electric gets to deliver the row of a clone RepoApi took before the request shows as failed. Default 15 s. */
  readonly confirmWithin?: Duration.Input
  /**
   * How long a navigation keeps the previous page while the next one's files load, before it shows the next page with
   * skeletons where they will be. Default 1 s.
   */
  readonly pageWait?: Duration.Input
  /** How long a failed shape request waits before it is sent again. Default `SyncPolicy.defaultPolicy`. */
  readonly retry?: Schedule.Schedule<unknown, ShapeSource.RequestFailed>
}

/** Whether sign-in's row says someone is signed in; `null` while it doesn't know. */
const signedInOf = (session: { readonly status: string }): boolean | null =>
  session.status === "signed_in" ? true : session.status === "signed_out" ? false : null

/**
 * The repositories' first sync as a page waits for it, from the collection's `preload`. One that fails leaves the page
 * reading the rows the device has as all there are, so it is logged as `repo.repositories.load`, once per store: every
 * later wait answers the same failure.
 */
export const firstSyncOf = (preload: Effect.Effect<void, Collection.LoadFailed>) =>
  Effect.map(Ref.make(false), (logged) =>
    preload.pipe(
      Effect.catch((failure) =>
        Effect.flatMap(Ref.getAndSet(logged, true), (already) =>
          already
            ? Effect.void
            : Effect.logWarning("repo.repositories.load").pipe(
              Effect.annotateLogs({ feature: "repo", outcome: "failed", errorCode: codeOf(failure) }),
            ))
      ),
    ))

/**
 * Writes `row` as the whole of what this tab knows of the person's authority on its repository: nothing of an earlier
 * answer stays (an earlier `readable` would still let a refused person read).
 */
export const replaceRole = (store: { readonly roles: Collection.Collection<RepoRole, string, any> }, row: RepoRole) =>
  Effect.gen(function* () {
    if (Option.isNone(yield* store.roles.get(row.id))) return yield* store.roles.insert(row)
    yield* store.roles.update(row.id, (draft) => {
      const fields = draft as Record<string, unknown>
      for (const key of Object.keys(fields)) if (key !== "id") delete fields[key]
      Object.assign(fields, row)
    })
  }).pipe(Effect.orDie)

const make = Effect.fnUntraced(function* (config: RepoConfig) {
  const roles = yield* Collection.local<RepoRole, string>({ id: "repo-roles", schema: RepoRole, getKey: (row) => row.id })
  // The one owner of "this repository refused this person" on the device. A 403 anywhere marks it, durably, so every tab
  // and every later load reads it, and each cache of the repository registers to be wiped by it (`registerCache`).
  const refusals = yield* Collection.persisted(RepoRefusalsStore)
  const refusalRows = yield* LiveQuery.make((q) => q.from({ refusal: refusals.tanstack }))
  const scope = yield* Effect.scope
  const fences = new Map<string, number>()
  const caches = new Map<string, (id: string) => Effect.Effect<void, unknown>>()
  const marked = new Set<string>()
  // A pending or failed event protects its repository even when the optimistic storage row rolls back.
  const protectedMarks = new Map<string, Set<string>>()
  const protect = (id: string, mark: string) => protectedMarks.set(id, (protectedMarks.get(id) ?? new Set()).add(mark))
  const unprotect = (id: string, mark: string) => {
    const held = protectedMarks.get(id)
    held?.delete(mark)
    if (held?.size === 0) protectedMarks.delete(id)
  }
  const answers = new Map<string, number>()
  const observedMarks = new Set<string>()
  const stale = new Set<string>()
  const answerCount = yield* SubscriptionRef.make(0)
  const refusalsKnown = yield* Deferred.make<void>()
  const startedAt = yield* Clock.currentTimeMillis
  // Each repository's wipes still running: what `wiped` waits for.
  const wiping = new Map<string, Set<Fiber.Fiber<void>>>()
  const wipeCache = (id: string, family: string, wipe: (id: string) => Effect.Effect<void, unknown>) =>
    wipe(id).pipe(
      Effect.interruptible,
      Effect.catchCause(() => Effect.logError("repo.refusal.wipe_failed").pipe(Effect.annotateLogs({ feature: "repo", family }))),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.tap((fiber) => Effect.sync(() => {
        const running = wiping.get(id) ?? new Set()
        wiping.set(id, running.add(fiber))
        fiber.addObserver(() => running.delete(fiber))
      })),
    )
  /** The repository refuses this person: no role this tab holds stands, no read already sent counts, and each cache goes. */
  const applyRefusal = (id: string) => Effect.gen(function* () {
    marked.add(id)
    fences.set(id, (fences.get(id) ?? 0) + 1)
    yield* replaceRole({ roles }, { id, role: null, own: false, refused: "forbidden" })
    yield* Effect.forEach(caches, ([family, wipe]) => wipeCache(id, family, wipe), { discard: true })
  })
  yield* refusals.restored.pipe(
    Effect.andThen(refusalRows.rows.pipe(Stream.runForEach((rows) => Effect.gen(function* () {
      const now = new Set(rows.map((row) => row.repoId))
      // A mark this tab couldn't store stands in memory: the device store's rows don't take it away.
      for (const id of marked) if (!now.has(id) && !protectedMarks.has(id)) marked.delete(id)
      const fresh = rows.filter((row) => !observedMarks.has(row.id))
      observedMarks.clear()
      for (const row of rows) observedMarks.add(row.id)
      yield* Effect.forEach(new Set(fresh.map((row) => row.repoId)), applyRefusal, { discard: true })
      // Once: how long the gate stayed closed on this load, from the store's start (`repo.refusals.known`).
      if (yield* Deferred.succeed(refusalsKnown, undefined)) {
        yield* Effect.logInfo("repo.refusals.known").pipe(Effect.annotateLogs({
          feature: "repo", marks: now.size, durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        }))
      }
    })))),
    Effect.catch(() => Effect.logError("repo.refusals.unavailable").pipe(Effect.annotateLogs({ feature: "repo" }))),
    Effect.forkScoped({ startImmediately: true }),
  )
  // Start authority restoration before repository metadata. Only the data gate waits for it: store construction
  // remains synchronous with memory persistence and never blocks the app on an unavailable restore.
  const repositories = yield* ElectricCollection.make<Repository>({
    id: "repo-repositories",
    schema: Repository,
    getKey: (row) => row.id,
    syncMode: "eager",
    // Version 4 adds `refsChangedAt`; synced caches resync on a version change (decision 0021).
    persist: { schemaVersion: 4 },
    shape: {
      url: `${config.origin}${REPOSITORIES_SHAPE_ROUTE}`,
      columnMapper: ElectricCollection.snakeCamelMapper(),
      parser: { int8: (value: string) => Number(value) },
    },
    ...(config.retry === undefined ? {} : { retry: config.retry }),
  })
  const clones = yield* Collection.local<CloneRow, string>({ id: "repo-clones", schema: CloneRow, getKey: (row) => row.id })
  const trees = yield* Collection.local<TreeRow, string>({ id: "repo-trees", schema: TreeRow, getKey: (row) => row.key })
  const blobs = yield* Collection.local<BlobRow, string>({ id: "repo-blobs", schema: BlobRow, getKey: (row) => row.key })
  const refs = yield* Collection.local<RefsRow, string>({ id: "repo-refs", schema: RefsRow, getKey: (row) => row.key })
  const abouts = yield* Collection.local<AboutRow, string>({ id: "repo-abouts", schema: AboutRow, getKey: (row) => row.key })
  const heads = yield* Collection.local<HeadRow, string>({ id: "repo-heads", schema: HeadRow, getKey: (row) => row.key })
  const embeds = yield* Collection.local<EmbedRow, string>({ id: "repo-embeds", schema: EmbedRow, getKey: (row) => row.key })
  const view = yield* Collection.local<ViewRow, string>({
    id: "repo-view",
    schema: ViewRow,
    getKey: (row) => row.id,
    initialData: [emptyView],
  })

  // The repositories' shape's first answer, rows or a failure: until then the header offers no Clone for a repository
  // this device hasn't seen (`headerOf`).
  yield* repositories.sync.pipe(
    Stream.filter((event) => event._tag !== "Sent"),
    Stream.runHead,
    Effect.andThen(Effect.orDie(view.update(VIEW, (row) => void (row.answered = true)))),
    Effect.forkScoped,
  )

  const firstSync = yield* firstSyncOf(repositories.preload)

  // Who is signed in, from sign-in's own row when the app has sign-in: Clone gives way to the sign-in link.
  const auth = yield* Effect.serviceOption(AuthStore)
  // The data gate (gate.ts): each repository's visibility, from the session and its role row. An app without sign-in
  // reads every repository as a signed-in person's, so only a refusal hides one.
  const session = Option.isSome(auth) ? auth.value.session : yield* Collection.local<Session, string>({
    id: "repo-session-none",
    schema: Session,
    getKey: (row) => row.id,
    initialData: [{ id: "session", status: "signed_in", login: null, role: null, available: true, signingOut: false, restored: true }],
  })
  // Every gated query stays closed until the device's refusal marks are applied (`refusalsKnown`): fail closed on a
  // cold load (Astra on 19af7eb9).
  const visibility = yield* makeVisibility(roles, session, Deferred.await(refusalsKnown))
  // What this tab loaded of each repository, as every query frontends read shows it: only a repository that may show.
  const shown = {
    // A repository's own row: its head's message and author, its branch and commit (Astra on 0c7b9f01).
    repositories: yield* visibility.gate(repositories, "id"),
    trees: yield* visibility.gate(trees),
    blobs: yield* visibility.gate(blobs),
    refs: yield* visibility.gate(refs),
    abouts: yield* visibility.gate(abouts),
    embeds: yield* visibility.gate(embeds),
  }
  if (Option.isSome(auth)) {
    yield* auth.value.sessionState.rows.pipe(
      Stream.runForEach((rows) =>
        // Sign-in's store always holds its one row.
        Effect.orDie(view.update(VIEW, (row) => void (row.signedIn = signedInOf(rows[0]!))))
      ),
      Effect.forkScoped,
    )
  }

  // What this tab loaded of a repository through RepoApi, memory only: file lists, files, refs, what GitHub says of it,
  // heads and embedded views. Keyed by the repository's id, then `@` and a commit.
  const ofRepository = (key: string, id: string) => key === id || key.startsWith(`${id}@`) || key.startsWith(`${id}:`)
  const dropWhere = <A extends object>(collection: Collection.Collection<A, string, any>, keyOf: (row: A) => string, belongs: (row: A) => boolean) =>
    Effect.flatMap(collection.toArray, (rows) =>
      Effect.forEach(rows.filter(belongs), (row) => Effect.ignore(collection.delete(keyOf(row))), { discard: true }))
  caches.set("repo-trees,repo-blobs,repo-refs,repo-abouts,repo-heads,repo-embeds", (id) => Effect.all([
    dropWhere(trees, (row) => row.key, (row) => ofRepository(row.key, id)),
    dropWhere(blobs, (row) => row.key, (row) => ofRepository(row.key, id)),
    dropWhere(refs, (row) => row.key, (row) => ofRepository(row.key, id)),
    dropWhere(abouts, (row) => row.key, (row) => ofRepository(row.key, id)),
    dropWhere(heads, (row) => row.key, (row) => ofRepository(row.key, id)),
    dropWhere(embeds, (row) => row.key, (row) => row.repoId === id),
  ], { discard: true }))

  return {
    repositories,
    /** The repositories' first sync: done, or failed and logged (`repo.repositories.load`). */
    firstSync,
    clones,
    trees,
    blobs,
    refs,
    abouts,
    heads,
    embeds,
    roles,
    rolesState: yield* LiveQuery.make((q) => q.from({ role: roles.tanstack })),
    /** Each repository this tab holds rows of, and whether it may show now (gate.ts): what every store's rows join. */
    visible: visibility.visible,
    /** Repository `id` has rows on this tab: it gets a visibility row now. */
    track: visibility.track,
    /** The gate's decision and subsequent changes, synchronously, without exposing raw rows to an early host. */
    observe: visibility.observe,
    /** A store's rows as the live query it exposes: only the rows of a repository that may show (gate.ts). */
    gate: visibility.gate,
    view,
    /** What shows of the repositories and loaded files, through the data gate (gate.ts): `reads` in queries.ts reads these. */
    shownRepositories: shown.repositories,
    shownTrees: shown.trees,
    shownBlobs: shown.blobs,
    viewState: yield* viewQuery(view, shown.repositories, clones, shown.abouts),
    embedsState: yield* embedsQuery(shown.embeds, shown.repositories, shown.abouts, shown.trees, shown.blobs),
    aboutState: yield* aboutQuery(view, shown.abouts),
    manifestState: yield* manifestQuery(view, shown.blobs),
    refsState: yield* refsQuery(view, shown.refs),
    treeState: yield* treeQuery(view, shown.trees),
    fileState: yield* fileQuery(view, shown.blobs),
    readmeState: yield* readmeQuery(view, shown.blobs),
    /** The one load the routed view runs: opening another location interrupts it. */
    loader: yield* FiberHandle.make<void, never>(),
    /** Where requests an action starts run, closed with the store. */
    scope,
    /** Each repository's role read on its way, by id: a second ask while one is out waits for it (`role`). */
    roleReads: new Map<string, Deferred.Deferred<void>>(),
    /** Once this tab knows which repositories refused: a cache of one opens only after, so it never paints first. */
    refusalsKnown: Deferred.await(refusalsKnown),
    /** Marks repository `id` refused on this device, for every tab and every later load, and wipes its caches. */
    refuse: (id: string) => Effect.gen(function* () {
      // Under one interruption mask: the device's write is registered and started before the mark's cleanup, whose
      // eviction aborts the refused shape's own request, the one this usually runs in (Astra on c64fd4bc). Then the
      // memory mark. The wait for the write stays interruptible and bounded.
      const { pending, mark } = yield* Effect.uninterruptible(Effect.gen(function* () {
        const stored = yield* Deferred.make<void, unknown>()
        const mark = crypto.randomUUID()
        protect(id, mark)
        // Every refusal has its own durable key. A grant may remove only the keys it saw before its request.
        observedMarks.add(mark)
        yield* refusals.insert({ id: mark, repoId: id, at: yield* Clock.currentTimeMillis }).pipe(
          Effect.flatMap((written) => written.persisted),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(stored, exit)),
          Effect.forkIn(scope, { startImmediately: true }),
        )
        yield* applyRefusal(id)
        return { pending: stored, mark }
      }))
      // A store that stopped answering holds neither the caller nor the tab's shutdown. One that fails, takes too long or
      // is interrupted leaves the mark in this tab's memory (fail closed), and is reported.
      const outcome = yield* Deferred.await(pending).pipe(
        Effect.timeout("5 seconds"),
        Effect.result,
        Effect.onInterrupt(() => Effect.logError("repo.refusal.unstored").pipe(Effect.annotateLogs({ feature: "repo", reason: "interrupted" }))),
      )
      if (outcome._tag === "Failure") {
        yield* Effect.logError("repo.refusal.unstored").pipe(Effect.annotateLogs({ feature: "repo" }))
      } else {
        unprotect(id, mark)
      }
    }),
    /**
     * A role read sent after the refusal answered a role: the mark goes. Its caches sync from the start.
     *
     * @throws {never}
     */
    refusalSnapshot: (id: string) => [...new Set([...refusals.tanstack.values()].filter((row) => row.repoId === id).map((row) => row.id).concat([...(protectedMarks.get(id) ?? [])]))],
    clearRefusal: (id: string, seen = [...refusals.tanstack.values()].filter((row) => row.repoId === id).map((row) => row.id).concat([...(protectedMarks.get(id) ?? [])])) => Effect.gen(function* () {
      const expected = new Set(seen)
      const current = (yield* refusals.toArray).filter((row) => row.repoId === id)
      if (current.some((row) => !expected.has(row.id)) || [...(protectedMarks.get(id) ?? [])].some((mark) => !expected.has(mark))) return false
      // Delete only observed events; a concurrent tab's new event has a different key and survives.
      if (current.length > 0) yield* Effect.ignore(refusals.delete(current.map((row) => row.id)))
      if ((yield* refusals.toArray).some((row) => row.repoId === id)) return false
      for (const mark of seen) unprotect(id, mark)
      if (protectedMarks.has(id)) return false
      marked.delete(id)
      return true
    }),
    /** @throws {never} */
    isRefused: (id: string) => marked.has(id),
    /** How many role answers this tab has had for repository `id`: a stack refused under one waits for the next. */
    answersOf: (id: string) => answers.get(id) ?? 0,
    /** Counts a role answer for repository `id` (`readRole`), which also makes the role current again. */
    answered: (id: string) => Effect.andThen(Effect.sync(() => {
      answers.set(id, (answers.get(id) ?? 0) + 1)
      stale.delete(id)
    }), SubscriptionRef.update(answerCount, (count) => count + 1)),
    /** Moves with every role answer, even one that changes no row: what a stack refused under an answer follows. */
    answerChanges: SubscriptionRef.changes(answerCount),
    /** A shape said less than the role this tab holds (a TODO shape's 403): the next route reads the role again. */
    markStale: (id: string) => Effect.sync(() => { stale.add(id) }),
    /** @throws {never} */
    isStale: (id: string) => stale.has(id),
    /**
     * `write`, unless repository `id` refused this person since `fence` (`fenceOf`) was taken: a read that was on its way
     * when the refusal came writes nothing after it, so no wipe is undone.
     */
    fenced: (id: string, fence: number, write: Effect.Effect<void>) =>
      Effect.suspend(() => (fences.get(id) ?? 0) === fence && !marked.has(id) ? write : Effect.void),
    /**
     * Moves with each refusal: a role read that started before one can't answer past it (`readRole`).
     *
     * @throws {never}
     */
    fenceOf: (id: string) => fences.get(id) ?? 0,
    /**
     * Every cache of a repository registers its `families` here, or the test in src/device/repoStores.test.ts fails.
     * `wipe` drops what it holds of a repository, whether or not a page opened it, and runs on each load the mark stands.
     */
    registerCache: (families: ReadonlyArray<string>, wipe: (id: string) => Effect.Effect<void, unknown>) => Effect.gen(function* () {
      const family = families.join(",")
      caches.set(family, wipe)
      yield* Effect.forEach(marked, (id) => wipeCache(id, family, wipe), { discard: true })
    }),
    /** Once every wipe repository `id`'s refusal started has ended: what a test of what a refusal keeps waits on. */
    wiped: (id: string) => Effect.suspend(() => Effect.asVoid(Fiber.awaitAll([...(wiping.get(id) ?? [])]))),
    registeredCaches: () => [...caches.keys()].flatMap((family) => family.split(",")),
    origin: config.origin,
    confirmWithin: config.confirmWithin ?? Duration.seconds(15),
    pageWait: config.pageWait ?? Duration.seconds(1),
  }
})

/**
 * The repository feature's state for one tab:
 * - `repositories`: every cloned repository, synced by Electric and kept on the device; read-only.
 * - `clones`: clones this tab asked for that Postgres doesn't show yet, or that RepoApi refused.
 * - `trees`, `blobs`: the file lists and files this tab loaded, by commit.
 * - `refs`: the branches and tags this tab loaded, by repository and sync.
 * - `abouts`: what GitHub says of each repository this tab opened, by id.
 * - `heads`: the ready heads RepoApi's refs named for repositories whose rows Electric hadn't delivered ready, by id.
 * - `embeds`: each repository's view in a conversation this tab loaded, by the view's id (src/features/repo/embed.ts).
 * - `roles`: the person's role on each repository this tab opened, as ChatApi last answered, by id (decision 0079).
 * - `view`: where the routed view is, one row.
 * - the live queries frontends read (queries.ts), `loader`, `scope`, and the settings.
 */
export class RepoStore extends Context.Service<RepoStore, Effect.Success<ReturnType<typeof make>>>()(
  "@smthrs/mvp/repo/RepoStore",
) {
  /** The store; its collections cleaned up, its load interrupted and its Electric shape closed with the scope. */
  static readonly layer = (config: RepoConfig) => Layer.effect(RepoStore, make(config))
}
