import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Persistence, Query } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Clock, Context, Duration, Effect, Layer, Metric, Option, Scope, Semaphore, Stream } from "effect"
import { RemoteReadFailed, RemoteRunsClient } from "./api"
import { isRemoteRun, JOURNAL_PAGE, REMOTE_RUN_SHAPE_ROUTE, RUN_LIST_LIMIT, settled } from "./contract"
import { ACTIONS_SHAPE_ROUTE } from "../actions/contract"
import { CloudRun, type Inspection, type RepoName, RepoRunRow, RepoRunsLoaded, RunChange, RunPage, RunRow, RunView, VIEW } from "./schema"
import { routeTiming, type RouteTiming } from "./timing"
import { domainOutcomeOf, hasDomainOutcome } from "./todoRun"
import { repoId } from "../repo/contract"
import { AuthStore } from "../auth/store"
import { RepoStore } from "../repo/store"
import { cloudRunList, memberRunSource } from "./source"
import { codeOf } from "../../errorCode"

// Runs on this tab (decision 0014 §1 and §3, docs/features/runs.md#the-browser): the list of this device's runs, each
// open run's read, and the run view, all local collections read from this device's engine through `BrowserEngine`. A
// run's page follows the engine as it works: every event the leader commits reads the open run, and the list while it
// shows, again, at most once per `FOLLOW_EVERY`; nothing polls. No value of a run reaches a record: a read is counted and
// logged by its outcome, its event count and its size.
//
// A run Smithers runs on Cloudflare, a TODO's (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare), reads the
// same way from ChatApi (`RemoteRunsClient`), which reads the engine there, and is followed through Electric: its row
// of the engine's change feed, whose revision moves with the run, reads the open run again on each change, at most once
// per `FOLLOW_EVERY`. It is never one of this device's runs.
//
// The list shows the runs on Cloudflare this person may read beside this device's (`cloudRuns`, ruling FLOW-13): read
// from ChatApi when the list opens, and again whenever one of its unsettled runs moves on Cloudflare, followed through
// the same change feed a run's page follows. A run started elsewhere shows the next time the list opens.

/** A read of one run, a page of its journal at a time, from where its page reads runs. */
type Reader = (
  runId: string,
  read: { readonly afterSeq?: number; readonly limit: number },
) => Effect.Effect<Inspection, RemoteReadFailed | BrowserEngine.RequestRefused | BrowserEngine.EngineUnavailable>

/** Where a run on Cloudflare is followed from: ChatApi's origin. */
export interface RunsConfig {
  readonly origin: string
}

/** How often an open run, and the list, are read again while the engine works. */
export const FOLLOW_EVERY = Duration.millis(200)

/** Reads of runs from the tab, by `read` (`run`, `list`) and `outcome`. */
export const reads = Metric.counter("smithers_run_reads", {
  description: "Reads of this device's runs from the tab, by read and outcome",
  incremental: true,
})

/** Remote change batches received, including those ignored while their run is hidden. No run content is recorded. */
export const followChanges = Metric.counter("smithers_run_follow_changes", {
  description: "Remote run changes received by whether their run is open",
  incremental: true,
})

/** The run of `view`, joined to its read: what the run page shows. */
export const pageQuery = (view: Collection.Collection<RunView, string>, pages: Collection.Collection<RunPage, string>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .innerJoin({ page: pages.tanstack }, ({ view, page }) => Query.eq(view.runId, page.id))
      .select(({ view, page }) => ({ view, page }))
      .findOne()
  )

/** The run the list shows opened in place, joined to its read. */
export const expandedQuery = (view: Collection.Collection<RunView, string>, pages: Collection.Collection<RunPage, string>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .innerJoin({ page: pages.tanstack }, ({ view, page }) => Query.eq(view.expanded, page.id))
      .select(({ page }) => ({ page }))
      .findOne()
  )

/** The view's one row. */
export const viewQuery = (view: Collection.Collection<RunView, string>) =>
  LiveQuery.make((q) => q.from({ view: view.tanstack }).findOne())

/** Every run of the list. */
export const runsQuery = (runs: Collection.Collection<RunRow, string>) => LiveQuery.make((q) => q.from({ run: runs.tanstack }))

/** Every run on Cloudflare the list holds. */
export const cloudRunsQuery = (rows: Collection.Collection<CloudRun, string>) =>
  LiveQuery.make((q) => q.from({ run: rows.tanstack }))

/** How many unsettled runs on Cloudflare one read of the list follows: the newest. */
export const CLOUD_FOLLOWS = 6

/** How many completed answers or drafts one read of the list reads the results of, newest first. */
export const OUTCOME_READS = 10

/** Every repository run the device holds: the list filters it to the repository it shows. */
export const repoRunsQuery = (rows: Collection.Collection<RepoRunRow, string>) =>
  LiveQuery.make((q) => q.from({ run: rows.tanstack }))

/** Every repository whose runs this tab has loaded. */
export const repoRunsLoadedQuery = (loaded: Collection.Collection<RepoRunsLoaded, string>) =>
  LiveQuery.make((q) => q.from({ repo: loaded.tanstack }))

/** A list row from the engine's summary of a run. */
const rowOf = (run: Inspection["children"][number] | Omit<Inspection["run"], "input" | "result">): RunRow => ({
  id: run.runId,
  flow: run.flowName,
  status: run.status,
  cancelRequested: run.cancelRequestedAtMs !== null,
  createdAtMs: run.createdAtMs,
  startedAtMs: run.startedAtMs,
  finishedAtMs: run.finishedAtMs,
  seq: run.lastSeq,
  origin: run.origin,
  ...("result" in run && hasDomainOutcome(run.flowName) && run.status === "completed"
    ? { outcome: domainOutcomeOf(run.flowName, run.result) }
    : {}),
})

/** Puts `row` into `collection`, replacing the one under its key. */
const put = <A extends { readonly id: string }>(collection: Collection.Collection<A, string>, row: A) =>
  Effect.gen(function* () {
    const current = yield* collection.get(row.id)
    if (Option.isNone(current)) return yield* Effect.asVoid(collection.insert(row))
    yield* Effect.asVoid(collection.update(row.id, (draft) => void Object.assign(draft, row)))
  })

type Read = "run" | "list" | "cloud" | "outcome"

/**
 * The reads that follow a run's first page: the rest of its journal (`page`), a run it started (`child`), the rest of
 * that run's journal (`child_page`), and More (`more`). They aren't counted; one that fails is logged, and the page
 * keeps what it read.
 */
type FollowingRead = "page" | "child" | "child_page" | "more"

/**
 * A failed read's code, never a message: the tag the engine refused it with, why the engine is down, else the
 * failure's own (`codeOf`).
 */
export const readCode = (failure: unknown): string =>
  failure instanceof BrowserEngine.RequestRefused
    ? codeOf({ code: failure.error })
    : failure instanceof BrowserEngine.EngineUnavailable
    ? failure.reason
    : codeOf(failure)

/**
 * Logs one read as `run.read`: at Warn with its `errorCode`, and ChatApi's `status` for a run on Cloudflare, when it
 * couldn't reach the run (`unavailable`); else at Debug, since not found and not started are answers about the run.
 */
const logRead = (act: Read | FollowingRead, outcome: string, startedAt: number, events?: number, failure?: unknown) =>
  Effect.gen(function* () {
    yield* (outcome === "unavailable" ? Effect.logWarning : Effect.logDebug)("run.read").pipe(Effect.annotateLogs({
      feature: "runs",
      act,
      outcome,
      durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      ...(events === undefined ? {} : { events }),
      ...(failure === undefined ? {} : { errorCode: readCode(failure) }),
      ...(failure instanceof RemoteReadFailed && failure.status !== undefined ? { status: failure.status } : {}),
    }))
  })

/** Counts and logs one read of the engine: its outcome and, for a run, how many events it held. */
const recordRead = (read: Read, outcome: string, startedAt: number, events?: number, failure?: unknown) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(reads, { read, outcome }), 1),
    logRead(read, outcome, startedAt, events, failure),
  )

/** Logs a following read that failed (`FollowingRead`). */
const recordFollowing = (act: FollowingRead, failure: unknown, startedAt: number) =>
  logRead(act, stateOf(failure), startedAt, undefined, failure)

/**
 * Waits for a repository's runs to load: the device's rows restored and the first sync answered. A first sync that
 * fails still settles the list, which then shows the device's rows as if loaded, so it is logged as
 * `runs.repo_runs.load`.
 */
export const repoRunsSynced = (rows: {
  readonly restored: Effect.Effect<void, Collection.LoadFailed>
  readonly preload: Effect.Effect<void, Collection.LoadFailed>
}) =>
  Effect.gen(function* () {
    // expected: restore failures are logged by Collection
    yield* Effect.ignore(rows.restored)
    yield* rows.preload.pipe(
      Effect.catch((failure) =>
        Effect.logWarning("runs.repo_runs.load").pipe(
          Effect.annotateLogs({ feature: "runs", outcome: "failed", errorCode: codeOf(failure) }),
        )
      ),
    )
  })

/**
 * The runs' state for one tab:
 * - `runs`: this device's runs, newest first, as the engine last listed them;
 * - `pages`: each open run as the engine last read it;
 * - `view`: the run this tab shows, the step and tab selected, an act in flight and why one was refused;
 * - `readRun`, `readList`, `readMore`: read the engine again.
 */
export class RunsStore extends Context.Service<
  RunsStore,
  {
    readonly runs: Collection.Collection<RunRow, string>
    readonly pages: Collection.Collection<RunPage, string>
    readonly view: Collection.Collection<RunView, string>
    readonly page: Effect.Success<ReturnType<typeof pageQuery>>
    readonly expandedPage: Effect.Success<ReturnType<typeof expandedQuery>>
    readonly viewRow: Effect.Success<ReturnType<typeof viewQuery>>
    readonly list: Effect.Success<ReturnType<typeof runsQuery>>
    /** The runs on Cloudflare this person may read, as ChatApi last listed them. */
    readonly cloudRuns: Collection.Collection<CloudRun, string>
    readonly cloudList: Effect.Success<ReturnType<typeof cloudRunsQuery>>
    /** Reads the runs on Cloudflare again; a read that fails keeps what the list showed. */
    readonly readCloud: Effect.Effect<void>
    /** Starts `readCloud` in the store's scope and returns at once: the list's route never waits for ChatApi. */
    readonly loadCloud: Effect.Effect<void>
    /**
     * The repositories' runs on Cloudflare (docs/features/actions.md), as the device holds them: empty until a list
     * opens (`openRepoRuns`), then synced by Electric and kept on the device.
     */
    readonly repoRunList: Effect.Success<ReturnType<typeof repoRunsQuery>>
    /** The repositories whose runs have loaded: until then a list of none says nothing (`repoRunsLoaded`). */
    readonly repoRunsLoaded: Effect.Success<ReturnType<typeof repoRunsLoadedQuery>>
    /** Starts syncing this repository's runs, once per repository. */
    readonly openRepoRuns: (owner: string, name: string) => Effect.Effect<void>
    readonly loadRun: (runId: string, repo: RepoName | null) => Effect.Effect<void>
    readonly beginRoute: (runId: string) => Effect.Effect<void>
    readonly rendered: (runId: string) => Effect.Effect<void>
    readonly readRun: (runId: string) => Effect.Effect<void>
    readonly readList: Effect.Effect<void>
    readonly warmList: Effect.Effect<void>
    readonly readMore: (runId: string) => Effect.Effect<void>
    /**
     * Follows a run on Cloudflare (`isRemoteRun`, or one `cloud` marked) for as long as the store lives: each change of
     * its row in the engine's change feed reads it again while the page shows it, and, for a repository's run, each run
     * it started too. Once per run; a local run needs none.
     */
    readonly follow: (runId: string) => Effect.Effect<void>
    /** Marks `runId` a repository's run, read and followed on Cloudflare (docs/features/actions.md). */
    readonly cloud: (runId: string) => Effect.Effect<void>
  }
>()("@smthrs/mvp/runs/RunsStore") {
  /**
   * The store over this tab's `BrowserEngine` and ChatApi at `config.origin`, following the engine's events from when it
   * is built, and each run on Cloudflare once opened, until its scope closes.
   */
  static readonly layer = (config: RunsConfig) => Layer.effect(
    RunsStore,
    Effect.gen(function* () {
      const auth = yield* Effect.serviceOption(AuthStore)
      const repos = yield* Effect.serviceOption(RepoStore)
      const timing = yield* routeTiming
      const attempts = new Map<string, RouteTiming>()
      const scope = yield* Effect.scope
      const engine = yield* BrowserEngine.BrowserEngine
      const remote = yield* RemoteRunsClient
      /**
       * Where the page of run `rootId` reads a run, it or one it started: ChatApi when the root runs on Cloudflare,
       * else this device's engine.
       */
      const reader = (rootId: string, attempt = attempts.get(rootId)): Reader => (id, read) =>
        Effect.gen(function* () {
          yield* attempt?.record("inspection", "start") ?? Effect.void
          const request: ReturnType<Reader> = onCloud(rootId) ? remote.inspect(id, read) : engine.inspect(id, read)
          const result = yield* Effect.result(request)
          yield* attempt?.record("inspection", result._tag === "Success" ? "ready" : "failed",
            result._tag === "Success" ? result.success.journal.events.length : 0) ?? Effect.void
          return yield* result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)
        })
      /** Repository runs this tab opened: each, and the runs it started, read and followed on Cloudflare. */
      const cloudRoots = new Set<string>()
      /** Whether the page of `rootId` reads Cloudflare: a TODO's run, or a repository's. */
      const onCloud = (rootId: string) => isRemoteRun(rootId) || cloudRoots.has(rootId)
      const runs = yield* Collection.local<RunRow, string>({ id: "runs", schema: RunRow, getKey: (row) => row.id })
      const pages = yield* Collection.local<RunPage, string>({ id: "run-pages", schema: RunPage, getKey: (row) => row.id })
      const view = yield* Collection.local<RunView, string>({
        id: "run-view",
        schema: RunView,
        getKey: (row) => row.id,
        initialData: [{ id: VIEW, runId: null, listOpen: false, selected: null, tab: "steps", acting: null, refusal: null }],
      })

      const generations = new Map<string, number>()
      const readRun = (runId: string, changed?: ReadonlySet<string>): Effect.Effect<void> =>
        Effect.gen(function* () {
          const held = Option.getOrThrow(yield* view.get(VIEW))
          if (held.runId === runId && held.at != null) return
          const generation = (generations.get(runId) ?? 0) + 1
          generations.set(runId, generation)
          const startedAt = yield* Clock.currentTimeMillis
          const attempt = attempts.get(runId)
          const source = reader(runId, attempt)
          const read = yield* Effect.result(source(runId, { limit: JOURNAL_PAGE }))
          if (generations.get(runId) !== generation) return
          const afterRead = Option.getOrThrow(yield* view.get(VIEW))
          if (afterRead.runId === runId && afterRead.at != null) return
          if (read._tag === "Success") {
            const inspection = read.success
            const current = yield* pages.get(runId)
            // A run read again keeps the pages More read only while the first page still ends where they begin.
            let kept: { more: ReadonlyArray<Inspection["journal"]["events"][number]>; hasMore: boolean } = Option.match(current, {
              onNone: () => ({ more: [], hasMore: inspection.journal.hasMore }),
              onSome: (page) => page.more.length > 0 && inspection.journal.hasMore
                ? { more: page.more as Inspection["journal"]["events"], hasMore: page.hasMore }
                : { more: [], hasMore: inspection.journal.hasMore },
            })
            // Publish the first inspection before reading any other page or child. The known graph is useful now.
            const cached = Option.isSome(current) ? current.value.descendants as ReadonlyArray<Inspection> ?? [] : []
            const publish = (descendants: ReadonlyArray<Inspection>) => Effect.gen(function* () {
              if (generations.get(runId) !== generation) return
              const shown = Option.getOrThrow(yield* view.get(VIEW))
              if (shown.runId === runId && shown.at != null) return
              // Keep every reachable cached sibling until its replacement arrives, including nested runs.
              const known = new Map([...cached, ...descendants].map((child) => [child.run.runId, child]))
              const visible: Inspection[] = []
              const visited = new Set([runId])
              const pending = inspection.children.map((child) => child.runId)
              for (let index = 0; index < pending.length; index++) {
                const id = pending[index]!
                if (visited.has(id)) continue
                visited.add(id)
                const child = known.get(id)
                if (child === undefined) continue
                visible.push(child)
                pending.push(...child.children.map((nested) => nested.runId))
              }
              yield* put(pages, { id: runId, state: "read", inspection, ...kept, descendants: visible })
            })
            yield* publish([])
            yield* attempt?.record("page", "rows", 1) ?? Effect.void
            // Read finite pages through this inspection's snapshot, never poll or retry.
            let after = kept.more.at(-1)?.seq ?? inspection.journal.nextSeq
            // An earlier fully read page can have new events beyond it now.
            if (inspection.run.lastSeq > after && inspection.journal.hasMore) kept = { ...kept, hasMore: true }
            while (kept.hasMore && after < inspection.run.lastSeq) {
              const next = yield* Effect.result(source(runId, { afterSeq: after, limit: JOURNAL_PAGE }))
              if (next._tag === "Failure") {
                yield* recordFollowing("page", next.failure, startedAt)
                break
              }
              const fresh = next.success.journal.events.filter((event) => event.seq > after)
              if (fresh.length === 0) break
              kept = { more: [...kept.more, ...fresh], hasMore: next.success.journal.hasMore }
              after = fresh.at(-1)!.seq
            }
            // Child journals carry their own identities. Never join children by display name.
            const descendants: Inspection[] = []
            const seen = new Set([runId])
            const pending = [...inspection.children.map((child) => child.runId)]
            for (let i = 0; i < pending.length; i++) {
              const childId = pending[i]!
              if (seen.has(childId)) continue
              seen.add(childId)
              const previous = Option.isSome(current) ? (current.value.descendants as ReadonlyArray<Inspection> | undefined)?.find((read) => read.run.runId === childId) : undefined
              if (previous !== undefined && changed !== undefined && !changed.has(childId)) {
                descendants.push(previous)
                pending.push(...previous.children.map((child) => child.runId))
                continue
              }
              const child = yield* Effect.result(source(childId, { limit: JOURNAL_PAGE }))
              if (child._tag === "Failure") {
                yield* recordFollowing("child", child.failure, startedAt)
                continue
              }
              const childIndex = descendants.length
              const firstEnd = child.success.journal.nextSeq
              const retained = child.success.journal.hasMore && previous !== undefined ? previous.journal.events.filter((event) => event.seq > firstEnd) : []
              const events = [...child.success.journal.events, ...retained]
              let cursor = events.at(-1)?.seq ?? firstEnd
              let hasMore = child.success.journal.hasMore && cursor < child.success.run.lastSeq
              descendants.push({ ...child.success, journal: { ...child.success.journal, events: [...events], nextSeq: cursor, hasMore } })
              yield* publish(descendants)
              while (hasMore && cursor < child.success.run.lastSeq) {
                const next = yield* Effect.result(source(childId, { afterSeq: cursor, limit: JOURNAL_PAGE }))
                if (next._tag === "Failure") {
                  yield* recordFollowing("child_page", next.failure, startedAt)
                  break
                }
                const fresh = next.success.journal.events.filter((event) => event.seq > cursor)
                if (fresh.length === 0) break
                events.push(...fresh); cursor = fresh.at(-1)!.seq; hasMore = next.success.journal.hasMore
              }
              descendants[childIndex] = { ...child.success, journal: { ...child.success.journal, events, nextSeq: cursor, hasMore } }
              yield* publish(descendants)
              pending.push(...child.success.children.map((child) => child.runId))
            }
            if (generations.get(runId) !== generation) return
            const latestView = Option.getOrThrow(yield* view.get(VIEW))
            if (latestView.runId === runId && latestView.at != null) return
            yield* put(pages, { id: runId, state: "read", inspection, ...kept, descendants })
            // A run on Cloudflare is never one of this device's runs.
            if (!onCloud(runId)) yield* put(runs, rowOf(inspection.run))
            // A repository's run works in the runs it started, its jobs: each is followed, and its change reads the run.
            if (cloudRoots.has(runId)) {
              for (const child of descendants) yield* Effect.forkIn(follow(child.run.runId, runId), scope)
            }
            return yield* recordRead("run", "read", startedAt, inspection.journal.events.length)
          }
          const state = stateOf(read.failure)
          // A run this device's engine never held may be one on Cloudflare, such as a system flow an Admin opened from
          // the list or a link: if ChatApi answers it, it is read and followed there from now on.
          if (state === "not_found" && !onCloud(runId)) {
            const there = yield* Effect.result(remote.inspect(runId, { limit: 1 }))
            if (there._tag === "Success") {
              cloudRoots.add(runId)
              yield* Effect.forkIn(follow(runId), scope, { startImmediately: true })
              return yield* readRun(runId, changed)
            }
          }
          // A read that couldn't reach the run leaves a page that has read it as it was: the next change reads it
          // again. Only an answer about the run itself (not found, not started) replaces what the page shows.
          const shown = yield* pages.get(runId)
          if (state !== "unavailable" || Option.isNone(shown) || shown.value.state !== "read") {
            yield* put(pages, { id: runId, state, inspection: null, more: [], hasMore: false })
          }
          yield* recordRead("run", state, startedAt, undefined, read.failure)
        }).pipe(Effect.orDie)

      const readMore = (runId: string) =>
        Effect.gen(function* () {
          const held = Option.getOrThrow(yield* view.get(VIEW))
          if (held.runId === runId && held.at != null) return
          const current = yield* pages.get(runId)
          if (Option.isNone(current) || current.value.inspection === null) return
          const page = current.value
          const events = [...(page.inspection as Inspection).journal.events, ...(page.more as Inspection["journal"]["events"])]
          const afterSeq = events.at(-1)?.seq ?? -1
          const startedAt = yield* Clock.currentTimeMillis
          const read = yield* Effect.result(reader(runId)(runId, { afterSeq, limit: JOURNAL_PAGE }))
          if (read._tag === "Failure") return yield* recordFollowing("more", read.failure, startedAt)
          const latestView = Option.getOrThrow(yield* view.get(VIEW))
          if (latestView.runId === runId && latestView.at != null) return
          // More contributes events to the current page, never its pre-read snapshot.
          const latest = yield* pages.get(runId)
          if (Option.isNone(latest) || latest.value.inspection === null) return
          const inspection = latest.value.inspection as Inspection
          const more = new Map((latest.value.more as Inspection["journal"]["events"]).map((event) => [event.seq, event]))
          for (const event of read.success.journal.events) {
            if (event.seq > inspection.journal.nextSeq) more.set(event.seq, event)
          }
          const latestEnd = (latest.value.more as Inspection["journal"]["events"]).at(-1)?.seq ?? inspection.journal.nextSeq
          yield* put(pages, {
            ...latest.value,
            more: [...more.values()].sort((a, b) => a.seq - b.seq),
            hasMore: latestEnd >= read.success.journal.nextSeq ? latest.value.hasMore : read.success.journal.hasMore,
          })
        }).pipe(Effect.orDie)

      const readList = Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const revision = Option.getOrThrow(yield* view.get(VIEW)).listRevision ?? 0
        yield* view.update(VIEW, (row) => { row.listReady = false })
        const read = yield* Effect.result(engine.list({ limit: RUN_LIST_LIMIT }))
        yield* view.update(VIEW, (row) => { row.listLoaded = true })
        if (read._tag === "Failure") return yield* recordRead("list", "unavailable", startedAt, undefined, read.failure)
        const listedIds = new Set(read.success.runs.map((run) => run.runId))
        const previous = yield* runs.toArray
        const previousById = new Map(previous.map((row) => [row.id, row]))
        const stale = previous.filter((row) => !listedIds.has(row.id)).map((row) => row.id)
        if (stale.length > 0) yield* Effect.asVoid(runs.delete(stale))
        for (const run of read.success.runs) {
          const row = rowOf(run)
          const cached = previousById.get(run.runId)
          // List summaries have no result. A detail read can establish a completed answer or draft's outcome; keep that finite
          // result only for the same journal version. Opening Runs must never await a second read per row.
          const outcome = hasDomainOutcome(run.flowName) && run.status === "completed"
            ? cached?.seq === run.lastSeq ? cached.outcome ?? "unknown" : "unknown"
            : undefined
          yield* put(runs, outcome === undefined ? row : { ...row, outcome })
        }
        yield* view.update(VIEW, (row) => { row.listReady = (row.listRevision ?? 0) === revision })
        yield* recordRead("list", "read", startedAt)
        // A completed answer or draft whose work failed must not read Done: the newest few are read once, in the
        // background, for their finite result. The list itself never waits for them.
        const unknown = (yield* runs.toArray)
          .filter((row) => hasDomainOutcome(row.flow) && row.status === "completed" && row.outcome === "unknown")
          .sort((left, right) => right.createdAtMs - left.createdAtMs)
          .slice(0, OUTCOME_READS)
          .filter((row) => !outcomeRead.has(`${row.id}@${row.seq}`))
        for (const row of unknown) outcomeRead.add(`${row.id}@${row.seq}`)
        if (unknown.length > 0) yield* Effect.forkIn(Effect.forEach(unknown, readOutcome, { discard: true }), scope)
      }).pipe(Effect.orDie)

      /** Runs whose result one read already established or tried, by id and journal version. */
      const outcomeRead = new Set<string>()
      /** Reads one completed answer's or draft's result, and keeps only its finite outcome on the list's row. */
      const readOutcome = (row: RunRow) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis
          const read = yield* Effect.result(engine.inspect(row.id, { limit: 1 }))
          if (read._tag === "Failure") return yield* recordRead("outcome", "unavailable", startedAt, undefined, read.failure)
          const run = read.success.run
          const current = yield* runs.get(row.id)
          if (Option.isNone(current) || current.value.seq !== run.lastSeq || !hasDomainOutcome(run.flowName)) return
          yield* put(runs, { ...current.value, outcome: domainOutcomeOf(run.flowName, run.result) })
          yield* recordRead("outcome", "read", startedAt)
        }).pipe(Effect.orDie)

      // A hover reads the engine without opening the page. Its click reuses that snapshot; concurrent hovers share
      // the read, and engine events below invalidate it even while the list is hidden.
      const listWarming = yield* Semaphore.make(1)
      const warmList = Semaphore.withPermits(listWarming, 1)(Effect.gen(function* () {
        if (Option.getOrThrow(yield* view.get(VIEW)).listReady) return
        yield* readList
      }))

      // Presentation clock only: no engine polling, dispatch, retry or background job.
      yield* Stream.tick(Duration.seconds(1)).pipe(
        Stream.runForEach(() => Effect.gen(function* () {
          const current = Option.getOrThrow(yield* view.get(VIEW))
          if (current.runId === null || current.at != null) return
          const now = yield* Clock.currentTimeMillis
          yield* view.update(VIEW, (draft) => { draft.now = now }).pipe(Effect.orDie)
        })), Effect.forkScoped,
      )

      // Every event the engine commits reads the open run, and the list while it shows, again.
      yield* engine.events.pipe(
        Stream.groupedWithin(Number.MAX_SAFE_INTEGER, FOLLOW_EVERY),
        Stream.runForEach((events) =>
          Effect.gen(function* () {
            yield* view.update(VIEW, (row) => {
              row.listRevision = (row.listRevision ?? 0) + 1
              row.listReady = false
            }).pipe(Effect.orDie)
            const current = Option.getOrThrow(yield* view.get(VIEW))
            const executions = new Set(events.map((event) => event.executionId))
            if (current.runId !== null) yield* readRun(current.runId, executions)
            if (current.listOpen) {
              yield* readList
              // The run opened in the list follows its engine too.
              if (current.expanded != null && current.expanded !== current.runId) yield* readRun(current.expanded, executions)
            }
          })
        ),
        Effect.forkScoped,
      )

      // Each run on Cloudflare this tab opened, followed once: its row of the engine's change feed through Electric.
      const followed = new Set<string>()
      const following = yield* Semaphore.make(1)
      /** The pages each followed run's change reads again: its own, and those of the runs that started it. */
      const readers = new Map<string, Set<string>>()
      const follow = (runId: string, rootId: string = runId): Effect.Effect<void> =>
        Semaphore.withPermits(following, 1)(Effect.gen(function* () {
          if (!onCloud(rootId)) return
          const pagesOf = readers.get(runId) ?? new Set<string>()
          readers.set(runId, pagesOf.add(rootId))
          const attempt = attempts.get(rootId)
          if (followed.has(runId)) {
            yield* attempt?.record("changes", "reused") ?? Effect.void
            return
          }
          followed.add(runId)
          yield* attempt?.record("changes", "start") ?? Effect.void
          const changes = yield* ElectricCollection.make<RunChange>({
            id: `remote-run:${runId}`,
            schema: RunChange,
            getKey: (row) => row.runId,
            syncMode: "eager",
            shape: {
              url: `${config.origin}${REMOTE_RUN_SHAPE_ROUTE}?run=${encodeURIComponent(runId)}`,
              columnMapper: ElectricCollection.snakeCamelMapper(),
            },
          }).pipe(Scope.provide(scope))
          yield* attempt?.record("changes", "ready") ?? Effect.void
          let firstRows = true
          // The run moved on Cloudflare: read it again while the page shows it.
          yield* changes.changes({ initial: true }).pipe(
            Stream.tap((batch) => Effect.gen(function* () {
              if (!firstRows || batch.length === 0) return
              firstRows = false
              yield* attempt?.record("changes", "rows", batch.length) ?? Effect.void
            })),
            Stream.filter((batch) => batch.length > 0),
            Stream.groupedWithin(Number.MAX_SAFE_INTEGER, FOLLOW_EVERY),
            Stream.runForEach(() =>
              Effect.gen(function* () {
                const current = Option.getOrThrow(yield* view.get(VIEW))
                const pagesOf = readers.get(runId)!
                const shown = current.runId !== null && pagesOf.has(current.runId)
                  ? current.runId
                  : current.listOpen && current.expanded != null && pagesOf.has(current.expanded)
                  ? current.expanded
                  : null
                const listed = current.listOpen && cloudListed.has(runId)
                yield* Metric.update(
                  Metric.withAttributes(followChanges, { showing: shown === null && !listed ? "false" : "true" }),
                  1,
                )
                // The shown run moved, or a run it started did: the shown run is read again, and of its runs only that one.
                if (shown !== null) yield* readRun(shown, runId === shown ? undefined : new Set([runId]))
                // A run the list shows moved: the list of runs on Cloudflare is read again.
                if (listed) yield* readCloud
              })
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }))

      // The runs on Cloudflare this person may read, beside this device's own (ruling FLOW-13).
      const cloudRuns = yield* Collection.local<CloudRun, string>({ id: "cloud-runs", schema: CloudRun, getKey: (row) => row.runId })
      /** The runs the list of runs on Cloudflare last showed: a change of one reads the list again. */
      const cloudListed = new Set<string>()
      const cloudReading = yield* Semaphore.make(1)
      const readCloud: Effect.Effect<void> = Semaphore.withPermits(cloudReading, 1)(Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const read = yield* Effect.result(cloudRunList(remote.list, auth))
        yield* view.update(VIEW, (row) => { row.cloudLoaded = true })
        // A list that couldn't be read keeps what it showed: signed out, a Guest, or ChatApi unreachable.
        if (read._tag === "Failure") return yield* recordRead("cloud", stateOf(read.failure), startedAt, undefined, read.failure)
        const listed = new Set(read.success.map((run) => run.runId))
        const stale = (yield* cloudRuns.toArray).filter((row) => !listed.has(row.runId)).map((row) => row.runId)
        if (stale.length > 0) yield* Effect.asVoid(cloudRuns.delete(stale))
        cloudListed.clear()
        for (const run of read.success) {
          const held = yield* cloudRuns.get(run.runId)
          yield* Option.isNone(held)
            ? Effect.asVoid(cloudRuns.insert(run))
            : Effect.asVoid(cloudRuns.update(run.runId, (draft) => void Object.assign(draft, run)))
          cloudListed.add(run.runId)
          // Its page, and its details in the list, read it on Cloudflare.
          if (!isRemoteRun(run.runId)) cloudRoots.add(run.runId)
        }
        // The newest unsettled runs are followed, so the list moves with them.
        const live = read.success.filter((run) => !settled(run.status)).slice(0, CLOUD_FOLLOWS)
        for (const run of live) yield* Effect.forkIn(follow(run.runId), scope, { startImmediately: true })
        yield* recordRead("cloud", "read", startedAt)
      }).pipe(Effect.orDie))

      // A repository's runs sync only once a tab opens a repository's list: Electric's rows, kept on the device, shown
      // through a collection of this tab's that follows them.
      const persistence = yield* Persistence.Persistence
      const shownRepoRuns = yield* Collection.local<RepoRunRow, string>({
        id: "repo-runs-shown",
        schema: RepoRunRow,
        getKey: (row) => row.id,
      })
      const loadedRepoRuns = yield* Collection.local<RepoRunsLoaded, string>({
        id: "repo-runs-loaded",
        schema: RepoRunsLoaded,
        getKey: (row) => row.id,
      })
      const opening = yield* Semaphore.make(1)
      const opened = new Set<string>()
      const openRepoRuns = (owner: string, name: string, route?: RouteTiming) => Semaphore.withPermits(opening, 1)(Effect.gen(function* () {
        const repo = `${owner}/${name}`.toLowerCase()
        const attempt = route ?? (yield* timing.begin)
        if (opened.has(repo)) return yield* attempt.record("repo-runs", "reused")
        yield* attempt.record("repo-runs", "start")
        const rows = yield* ElectricCollection.make<RepoRunRow>({
          id: `repo-runs:${repo}`,
          schema: RepoRunRow,
          getKey: (row) => row.id,
          syncMode: "eager",
          persist: { schemaVersion: 1 },
          shape: { url: `${config.origin}${ACTIONS_SHAPE_ROUTE}?repo=${encodeURIComponent(repo)}`, columnMapper: ElectricCollection.snakeCamelMapper() },
        }).pipe(
          Effect.provideService(ShapeSource.ShapeSource, memberRunSource(yield* ShapeSource.ShapeSource, auth, repos, repoId(owner, name))),
          Scope.provide(scope), Effect.provideService(Persistence.Persistence, persistence), Effect.orDie)
        yield* attempt.record("repo-runs", "ready")
        let firstRows = true
        opened.add(repo)
        yield* rows.changes({ initial: true }).pipe(
          Stream.tap((batch) => Effect.gen(function* () {
            if (!firstRows || batch.length === 0) return
            firstRows = false
            yield* attempt.record("repo-runs", "rows", batch.length)
          })),
          Stream.runForEach((batch) =>
            Effect.forEach(batch, (change) =>
              change.type === "delete" ? Effect.asVoid(shownRepoRuns.delete(String(change.key))) : put(shownRepoRuns, change.value))
          ),
          Effect.orDie,
          Effect.forkIn(scope, { startImmediately: true }),
        )
        // Loaded: the device's rows restored and the first sync answered, or failed. A slow shape leaves the list saying
        // nothing rather than that the repository has no runs.
        yield* Effect.gen(function* () {
          yield* repoRunsSynced(rows)
          yield* Effect.orDie(loadedRepoRuns.insert({ id: repoId(owner, name) }))
          yield* attempt.record("repo-runs", "loaded", (yield* rows.toArray).length)
        }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      }))

      return RunsStore.of({
        runs,
        pages,
        view,
        page: yield* pageQuery(view, pages),
        expandedPage: yield* expandedQuery(view, pages),
        viewRow: yield* viewQuery(view),
        list: yield* runsQuery(runs),
        cloudRuns,
        cloudList: yield* cloudRunsQuery(cloudRuns),
        readCloud,
        loadCloud: Effect.asVoid(Effect.forkIn(readCloud, scope, { startImmediately: true })),
        repoRunList: yield* repoRunsQuery(shownRepoRuns),
        repoRunsLoaded: yield* repoRunsLoadedQuery(loadedRepoRuns),
        openRepoRuns,
        // Reads and live subscriptions belong to the store's scope, never the router's pending navigation.
        loadRun: (runId, repo) => Effect.gen(function* () {
          if (Option.isNone(yield* pages.get(runId))) {
            yield* put(pages, { id: runId, state: "loading", inspection: null, more: [], hasMore: false })
          }
          if (repo !== null) {
            yield* Effect.forkIn(openRepoRuns(repo.owner, repo.name, attempts.get(runId)), scope, { startImmediately: true })
          }
          yield* Effect.forkIn(readRun(runId), scope, { startImmediately: true })
          yield* Effect.forkIn(follow(runId), scope, { startImmediately: true })
        }).pipe(Effect.orDie),
        beginRoute: (runId) => Effect.gen(function* () {
          attempts.set(runId, yield* timing.begin)
          yield* attempts.get(runId)!.record("page", "ready", (yield* pages.toArray).length)
        }),
        rendered: (runId) => attempts.get(runId)?.rendered ?? Effect.void,
        readRun,
        readList,
        warmList,
        readMore,
        follow: (runId) => follow(runId),
        cloud: (runId) => Effect.sync(() => void cloudRoots.add(runId)),
      })
    }),
  )
}

/**
 * A page's state from why its run couldn't be read: one no TODO started, or this person may not read, or this engine
 * never held, is `not_found`; one on Cloudflare its TODO just started, `not_started`; anything else, `unavailable`.
 */
export const stateOf = (failure: unknown): "not_found" | "not_started" | "unavailable" => {
  if (failure instanceof RemoteReadFailed) {
    if (failure.code === "not_started") return "not_started"
    return failure.status === 401 || failure.status === 403 || failure.status === 404 ? "not_found" : "unavailable"
  }
  return failure instanceof BrowserEngine.RequestRefused && failure.error === "@smthrs/engine-store/RunNotFound"
    ? "not_found"
    : "unavailable"
}
