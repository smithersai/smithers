import { Host } from "@smthrs/plugin"
import { Effect, Scope, Stream } from "effect"
import { type EpicGroup, extractMythical, type FeedDocument, type MythicalCommit } from "./model"

export const VIEW = "mythical/history"

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

export interface RepoMythicalState {
  readonly status: "loading" | "ready" | "refused"
  readonly hasFeed: boolean
  readonly commits: ReadonlyArray<MythicalCommit>
  readonly epics: ReadonlyArray<EpicGroup>
  readonly treeEqualToMain: boolean
  readonly selectedPosition: number | null
  readonly selected: MythicalCommit | undefined
  readonly updatedAt: string | null
}

export interface MythicalTab {
  readonly queries: {
    readonly state: (repository: Host.Repository) => Watched<RepoMythicalState>
    readonly count: (repository: Host.Repository) => Watched<number>
  }
  readonly actions: {
    readonly href: (repository: Host.Repository) => string
    readonly open: (repository: Host.Repository) => void
    readonly select: (repository: Host.Repository, position: number) => void
    readonly step: (repository: Host.Repository, delta: 1 | -1) => void
  }
}

export const repoKeyOf = (repository: Host.Repository): string =>
  `${repository.owner}/${repository.name}`.toLowerCase()

export const hrefOf = (repository: Host.Repository): string =>
  Host.pathOf({ plugin: "mythical", scope: "repository", path: "" }, repository)!

export type PluginHostShape = Effect.Success<typeof Host.PluginHost>

export const make = (host: PluginHostShape) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = Effect.runForkWith(yield* Effect.context<never>())
    let activeRepo: Host.Repository | undefined

    interface RepoEntry {
      readonly state: ReturnType<typeof cell<RepoMythicalState>>
      readonly count: ReturnType<typeof cell<number>>
      docs: ReadonlyArray<FeedDocument>
      selectedPosition: number | null
      status: "loading" | "ready" | "refused"
    }

    const entries = new Map<string, RepoEntry>()

    const recompute = (entry: RepoEntry) => {
      if (entry.status !== "ready") {
        entry.state.set({
          status: entry.status,
          hasFeed: false,
          commits: [],
          epics: [],
          treeEqualToMain: false,
          selectedPosition: null,
          selected: undefined,
          updatedAt: null,
        })
        entry.count.set(0)
        return
      }
      const extracted = extractMythical(entry.docs)
      const matched = extracted.commits.find((c) => c.position === entry.selectedPosition) ?? extracted.commits[0]
      entry.selectedPosition = matched?.position ?? null
      entry.count.set(extracted.commits.length)
      entry.state.set({
        status: "ready",
        hasFeed: extracted.hasFeed,
        commits: extracted.commits,
        epics: extracted.epics,
        treeEqualToMain: extracted.treeEqualToMain,
        selectedPosition: entry.selectedPosition,
        selected: matched,
        updatedAt: extracted.updatedAt,
      })
    }

    const entryOf = (repository: Host.Repository): RepoEntry => {
      const key = repoKeyOf(repository)
      const existing = entries.get(key)
      if (existing !== undefined) {
        activeRepo = repository
        return existing
      }
      const entry: RepoEntry = {
        state: cell<RepoMythicalState>({
          status: "loading",
          hasFeed: false,
          commits: [],
          epics: [],
          treeEqualToMain: false,
          selectedPosition: null,
          selected: undefined,
          updatedAt: null,
        }),
        count: cell<number>(0),
        docs: [],
        selectedPosition: null,
        status: "loading",
      }
      entries.set(key, entry)
      activeRepo = repository

      run(
        Effect.gen(function* () {
          const live = yield* host.query<FeedDocument>("core/feeds", { repo: key })
          const apply = () => {
            entry.docs = live.current()
            entry.status = "ready"
            recompute(entry)
          }
          apply()
          const stop = live.subscribe(apply)
          yield* Scope.addFinalizer(scope, Effect.sync(stop))
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("mythical.feed.refused", { repo: key, cause: String(cause) }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  entry.status = "refused"
                  recompute(entry)
                }),
              ),
            ),
          ),
        ),
      )

      return entry
    }

    const stepRepo = (repository: Host.Repository, delta: 1 | -1) => {
      const entry = entryOf(repository)
      const current = entry.state.current()
      if (current.commits.length === 0) return
      const idx = current.commits.findIndex((c) => c.position === current.selectedPosition)
      const nextIdx = idx === -1 ? 0 : (idx + delta + current.commits.length) % current.commits.length
      const next = current.commits[nextIdx]
      if (next !== undefined) {
        entry.selectedPosition = next.position
        recompute(entry)
      }
    }

    yield* Stream.runForEach(host.events(VIEW), (event) =>
      Effect.sync(() => {
        if (activeRepo === undefined) return
        if (event.name === "next") stepRepo(activeRepo, 1)
        if (event.name === "previous") stepRepo(activeRepo, -1)
      }),
    ).pipe(Effect.forkIn(scope))

    return {
      queries: {
        state: (repository) => entryOf(repository).state,
        count: (repository) => entryOf(repository).count,
      },
      actions: {
        href: hrefOf,
        open: (repository) => {
          activeRepo = repository
          run(host.open(VIEW, repository))
        },
        select: (repository, position) => {
          const entry = entryOf(repository)
          entry.selectedPosition = position
          recompute(entry)
        },
        step: stepRepo,
      },
    } satisfies MythicalTab
  })

export const tab = make
