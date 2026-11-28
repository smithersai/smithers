import { Host } from "@smthrs/plugin"
import { Uphill } from "@smthrs/rpc"
import { Effect, Fiber, Scope, Stream } from "effect"
import {
  extractUphill,
  extractUphillIndexRefs,
  type FeedDocument,
  stepCategory,
  type UntrustedUphillRun,
  type UphillIndexRefs,
  type UphillSummary,
} from "./model"

// The Uphill tab (plugins/uphill): reads a repository's eager `core/feeds` index through `PluginHost`,
// discovers visibility-partitioned references to on-demand `uphill/untrusted-*` previews and
// `uphill/history`, and opens real `core/feed` subscriptions only while the scorecard view listens.
// Zero React imports, zero clock.

export const VIEW = "uphill/scorecard"

export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

const cell = <A>(initial: A, onActiveChange?: (active: boolean) => void) => {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    current: () => value,
    subscribe: (listener: () => void) => {
      const wasEmpty = listeners.size === 0
      listeners.add(listener)
      if (wasEmpty && onActiveChange !== undefined) onActiveChange(true)
      return () => {
        if (listeners.delete(listener) && listeners.size === 0 && onActiveChange !== undefined) {
          onActiveChange(false)
        }
      }
    },
    set: (next: A) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

export interface RepoUphillState {
  readonly status: "loading" | "ready" | "refused"
  readonly hasFeed: boolean
  readonly envelope: Uphill.FeedEnvelope | undefined
  readonly overall: number | null
  readonly band: Uphill.ScoreBand
  readonly updatedAt: string | null
  readonly history: ReadonlyArray<Uphill.HistoryPoint>
  readonly selectedCategory: string | null
  readonly untrustedRuns: ReadonlyArray<UntrustedUphillRun>
  readonly pendingPreviews: ReadonlyArray<string>
  readonly failedPreviews: ReadonlyArray<string>
  readonly loadingHistory: boolean
  readonly historyFailed: boolean
}

export interface UphillTab {
  readonly queries: {
    readonly state: (repository: Host.Repository) => Watched<RepoUphillState>
    readonly summary: (repository: Host.Repository) => Watched<UphillSummary>
  }
  readonly actions: {
    readonly href: (repository: Host.Repository) => string
    readonly open: (repository: Host.Repository) => void
    readonly selectCategory: (repository: Host.Repository, category: string | null) => void
    readonly step: (repository: Host.Repository, delta: 1 | -1) => void
  }
}

export const repoKeyOf = (repository: Host.Repository): string =>
  `${repository.owner}/${repository.name}`.toLowerCase()

export const hrefOf = (repository: Host.Repository): string =>
  Host.pathOf({ plugin: "uphill", scope: "repository", path: "" }, repository)!

export type PluginHostShape = Effect.Success<typeof Host.PluginHost>

const EMPTY_SUMMARY: UphillSummary = { hasFeed: false, overall: null, band: "none", opportunities: 0, previewCount: 0 }

const emptyState = (status: "loading" | "refused"): RepoUphillState => ({
  status,
  hasFeed: false,
  envelope: undefined,
  overall: null,
  band: "none",
  updatedAt: null,
  history: [],
  selectedCategory: null,
  untrustedRuns: [],
  pendingPreviews: [],
  failedPreviews: [],
  loadingHistory: false,
  historyFailed: false,
})

interface OnDemandHandle {
  stop: (() => void) | undefined
  fiber?: Fiber.Fiber<void, never>
}

export const make = (host: PluginHostShape) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = Effect.runForkWith(yield* Effect.context<never>())
    let activeRepo: Host.Repository | undefined

    interface RepoEntry {
      readonly key: string
      readonly state: ReturnType<typeof cell<RepoUphillState>>
      readonly summary: ReturnType<typeof cell<UphillSummary>>
      readonly onDemand: Map<string, OnDemandHandle>
      readonly onDemandDocs: Map<string, FeedDocument>
      readonly failedRefs: Set<string>
      docs: ReadonlyArray<FeedDocument>
      selectedCategory: string | null
      status: "loading" | "ready" | "refused"
      stateActive: boolean
    }

    const entries = new Map<string, RepoEntry>()

    const closeHandle = (entry: RepoEntry, name: string) => {
      const handle = entry.onDemand.get(name)!
      entry.onDemand.delete(name)
      entry.onDemandDocs.delete(name)
      entry.failedRefs.delete(name)
      if (handle.stop !== undefined) handle.stop()
      run(Fiber.interrupt(handle.fiber!))
    }

    const closeAllOnDemand = (entry: RepoEntry) => {
      for (const name of [...entry.onDemand.keys()]) closeHandle(entry, name)
    }

    const reconcileOnDemand = (entry: RepoEntry, refs: UphillIndexRefs) => {
      if (!entry.stateActive) {
        closeAllOnDemand(entry)
        return
      }
      const desired = new Set<string>(refs.previews.map((ref) => ref.name))
      if (refs.history !== null) desired.add(refs.history.name)

      for (const name of [...entry.onDemand.keys()]) {
        if (!desired.has(name)) closeHandle(entry, name)
      }

      for (const name of desired) {
        if (entry.onDemand.has(name)) continue
        const handle: OnDemandHandle = { stop: undefined }
        entry.onDemand.set(name, handle)
        handle.fiber = run(
          host.query<FeedDocument>("core/feed", { repo: entry.key, name }).pipe(
            Effect.flatMap((live) =>
              Effect.sync(() => {
                const update = () => {
                  const doc = live.current().find((row) => row.name === name)
                  if (doc === undefined) entry.onDemandDocs.delete(name)
                  else entry.onDemandDocs.set(name, doc)
                  entry.failedRefs.delete(name)
                  recompute(entry)
                }
                handle.stop = live.subscribe(update)
                update()
              }),
            ),
            // expected: an on-demand document refused by the host surfaces its failure without blocking the view
            Effect.catch(() =>
              Effect.sync(() => {
                entry.onDemandDocs.delete(name)
                entry.failedRefs.add(name)
                recompute(entry)
              }),
            ),
          ),
        )
      }
    }

    const recompute = (entry: RepoEntry) => {
      if (entry.status !== "ready") {
        closeAllOnDemand(entry)
        entry.state.set(emptyState(entry.status))
        entry.summary.set(EMPTY_SUMMARY)
        return
      }
      const indexRefs = extractUphillIndexRefs(entry.docs)
      reconcileOnDemand(entry, indexRefs)

      const extracted = extractUphill(entry.docs, entry.onDemandDocs)
      const names = extracted.envelope?.report.categories.map((c) => c.name) ?? []
      if (entry.selectedCategory !== null && !names.includes(entry.selectedCategory)) {
        entry.selectedCategory = null
      }
      const hasDoc = (name: string) => entry.onDemandDocs.has(name) || entry.docs.some((doc) => doc.name === name)
      const pendingPreviews = extracted.indexRefs.previews
        .filter((ref) => !hasDoc(ref.name) && !entry.failedRefs.has(ref.name))
        .map((ref) => ref.name)
      const failedPreviews = extracted.indexRefs.previews
        .filter((ref) => entry.failedRefs.has(ref.name))
        .map((ref) => ref.name)
      const hasHistoryRef = extracted.indexRefs.history !== null
      const historyFailed = hasHistoryRef && entry.failedRefs.has(Uphill.UPHILL_HISTORY_FEED_NAME)
      const loadingHistory = hasHistoryRef &&
        !historyFailed &&
        !hasDoc(Uphill.UPHILL_HISTORY_FEED_NAME) &&
        (extracted.envelope === undefined || extracted.envelope.history.length === 0)

      entry.summary.set({
        hasFeed: extracted.hasFeed,
        overall: extracted.overall,
        band: extracted.band,
        opportunities: extracted.envelope?.report.opportunities.length ?? 0,
        previewCount: extracted.previewCount,
      })
      entry.state.set({
        status: "ready",
        hasFeed: extracted.hasFeed,
        envelope: extracted.envelope,
        overall: extracted.overall,
        band: extracted.band,
        updatedAt: extracted.updatedAt,
        history: extracted.history,
        selectedCategory: entry.selectedCategory,
        untrustedRuns: extracted.untrustedRuns,
        pendingPreviews,
        failedPreviews,
        loadingHistory,
        historyFailed,
      })
    }

    const entryOf = (repository: Host.Repository): RepoEntry => {
      activeRepo = repository
      const key = repoKeyOf(repository)
      const existing = entries.get(key)
      if (existing !== undefined) return existing
      const entry: RepoEntry = {
        key,
        state: cell<RepoUphillState>(emptyState("loading"), (active) => {
          entry.stateActive = active
          if (entry.status === "ready") recompute(entry)
        }),
        summary: cell<UphillSummary>(EMPTY_SUMMARY),
        onDemand: new Map(),
        onDemandDocs: new Map(),
        failedRefs: new Set(),
        docs: [],
        selectedCategory: null,
        status: "loading",
        stateActive: false,
      }
      entries.set(key, entry)
      run(
        host.query<FeedDocument>("core/feeds", { repo: key }).pipe(
          Effect.flatMap((live) =>
            Scope.provide(
              Effect.acquireRelease(
                Effect.sync(() => {
                  const update = () => {
                    entry.docs = live.current()
                    entry.status = "ready"
                    recompute(entry)
                  }
                  const stop = live.subscribe(update)
                  update()
                  return stop
                }),
                (stop) => Effect.sync(stop),
              ),
              scope,
            ),
          ),
          // expected: a repository whose feeds are refused renders the refused state cleanly
          Effect.catch(() =>
            Effect.sync(() => {
              entry.status = "refused"
              recompute(entry)
            }),
          ),
        ),
      )
      return entry
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of entries.values()) closeAllOnDemand(entry)
      }),
    )

    const step = (repository: Host.Repository, delta: 1 | -1) => {
      const entry = entryOf(repository)
      const names = entry.state.current().envelope?.report.categories.map((c) => c.name) ?? []
      entry.selectedCategory = stepCategory(names, entry.selectedCategory, delta)
      recompute(entry)
    }

    yield* host.events(VIEW).pipe(
      Stream.runForEach(({ name }) =>
        Effect.sync(() => {
          if (activeRepo !== undefined) step(activeRepo, name === "next" ? 1 : -1)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return {
      queries: {
        state: (repository) => entryOf(repository).state,
        summary: (repository) => entryOf(repository).summary,
      },
      actions: {
        href: (repository) => hrefOf(repository),
        open: (repository) => void run(host.open(VIEW, repository)),
        selectCategory: (repository, category) => {
          const entry = entryOf(repository)
          entry.selectedCategory = category
          recompute(entry)
        },
        step,
      },
    } satisfies UphillTab
  })

export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  return yield* make(host)
})
