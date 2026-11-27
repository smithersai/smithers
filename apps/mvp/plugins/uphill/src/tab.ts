import { Host } from "@smthrs/plugin"
import type { Uphill } from "@smthrs/rpc"
import { Effect, Scope, Stream } from "effect"
import { extractUphill, type FeedDocument, stepCategory, type UntrustedUphillRun, type UphillSummary } from "./model"

// The Uphill tab (plugins/uphill): reads a repository's `core/feeds` through `PluginHost`, decodes its
// `uphill` report feed and optional `uphill/history`, and tracks the selected category per repository.
// Zero React imports, zero clock.

export const VIEW = "uphill/scorecard"

export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

const cell = <A>(initial: A) => {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    current: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
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

const EMPTY_SUMMARY: UphillSummary = { hasFeed: false, overall: null, band: "none", opportunities: 0 }

export const make = (host: PluginHostShape) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = Effect.runForkWith(yield* Effect.context<never>())
    let activeRepo: Host.Repository | undefined

    interface RepoEntry {
      readonly state: ReturnType<typeof cell<RepoUphillState>>
      readonly summary: ReturnType<typeof cell<UphillSummary>>
      docs: ReadonlyArray<FeedDocument>
      selectedCategory: string | null
      status: "loading" | "ready" | "refused"
    }

    const entries = new Map<string, RepoEntry>()

    const recompute = (entry: RepoEntry) => {
      if (entry.status !== "ready") {
        entry.state.set({
          status: entry.status,
          hasFeed: false,
          envelope: undefined,
          overall: null,
          band: "none",
          updatedAt: null,
          history: [],
          selectedCategory: null,
          untrustedRuns: [],
        })
        entry.summary.set(EMPTY_SUMMARY)
        return
      }
      const extracted = extractUphill(entry.docs)
      const names = extracted.envelope?.report.categories.map((c) => c.name) ?? []
      if (entry.selectedCategory !== null && !names.includes(entry.selectedCategory)) {
        entry.selectedCategory = null
      }
      entry.summary.set({
        hasFeed: extracted.hasFeed,
        overall: extracted.overall,
        band: extracted.band,
        opportunities: extracted.envelope?.report.opportunities.length ?? 0,
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
      })
    }

    const entryOf = (repository: Host.Repository): RepoEntry => {
      activeRepo = repository
      const key = repoKeyOf(repository)
      const existing = entries.get(key)
      if (existing !== undefined) return existing
      const entry: RepoEntry = {
        state: cell<RepoUphillState>({
          status: "loading",
          hasFeed: false,
          envelope: undefined,
          overall: null,
          band: "none",
          updatedAt: null,
          history: [],
          selectedCategory: null,
          untrustedRuns: [],
        }),
        summary: cell<UphillSummary>(EMPTY_SUMMARY),
        docs: [],
        selectedCategory: null,
        status: "loading",
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
