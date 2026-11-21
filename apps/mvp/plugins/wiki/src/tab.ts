import { Host } from "@smthrs/plugin"
import { Effect, Scope, Stream } from "effect"
import { clampIndex, type FeedDocument, filterNotes, hasWikiFeed, type WikiNote, wikiNotesOf } from "./model"

// The wiki's tab (plugins/wiki): reads a repository's `core/feeds` through `PluginHost`, builds the live note/backlink
// graph, and tracks the active search query and selected note per repository. Zero React imports, zero clock.

export const VIEW = "wiki/notes"

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

export interface RepoWikiState {
  readonly status: "loading" | "ready" | "refused"
  readonly fromFeed: boolean
  readonly notes: ReadonlyArray<WikiNote>
  readonly filtered: ReadonlyArray<WikiNote>
  readonly selectedPath: string | null
  readonly selected: WikiNote | undefined
  readonly query: string
}

export interface WikiTab {
  readonly queries: {
    readonly state: (repository: Host.Repository) => Watched<RepoWikiState>
    readonly hasFeed: (repository: Host.Repository) => Watched<boolean>
  }
  readonly actions: {
    readonly href: (repository: Host.Repository) => string
    readonly open: (repository: Host.Repository) => void
    readonly select: (repository: Host.Repository, path: string) => void
    readonly search: (repository: Host.Repository, query: string) => void
    readonly step: (repository: Host.Repository, delta: 1 | -1) => void
  }
}

export const repoKeyOf = (repository: Host.Repository): string =>
  `${repository.owner}/${repository.name}`.toLowerCase()

export const hrefOf = (repository: Host.Repository): string =>
  Host.pathOf({ plugin: "wiki", scope: "repository", path: "" }, repository)!

export type PluginHostShape = Effect.Success<typeof Host.PluginHost>

export const make = (host: PluginHostShape) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = Effect.runForkWith(yield* Effect.context<never>())
    let activeRepo: Host.Repository | undefined

    interface RepoEntry {
      readonly state: ReturnType<typeof cell<RepoWikiState>>
      readonly hasFeed: ReturnType<typeof cell<boolean>>
      docs: ReadonlyArray<FeedDocument>
      query: string
      selectedPath: string | null
      status: "loading" | "ready" | "refused"
    }

    const entries = new Map<string, RepoEntry>()

    const recompute = (repo: string, entry: RepoEntry) => {
      if (entry.status !== "ready") {
        entry.state.set({
          status: entry.status,
          fromFeed: false,
          notes: [],
          filtered: [],
          selectedPath: null,
          selected: undefined,
          query: entry.query,
        })
        entry.hasFeed.set(false)
        return
      }
      const { notes, fromFeed } = wikiNotesOf(repo, entry.docs)
      const filtered = filterNotes(notes, entry.query)
      const matched = filtered.find((n) => n.path === entry.selectedPath) ?? filtered[0]
      entry.selectedPath = matched?.path ?? null
      entry.hasFeed.set(hasWikiFeed(entry.docs))
      entry.state.set({
        status: "ready",
        fromFeed,
        notes,
        filtered,
        selectedPath: entry.selectedPath,
        selected: matched,
        query: entry.query,
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
        state: cell<RepoWikiState>({
          status: "loading",
          fromFeed: false,
          notes: [],
          filtered: [],
          selectedPath: null,
          selected: undefined,
          query: "",
        }),
        hasFeed: cell<boolean>(false),
        docs: [],
        query: "",
        selectedPath: null,
        status: "loading",
      }
      entries.set(key, entry)
      activeRepo = repository
      run(
        host.query<FeedDocument>("core/feeds", { repo: key }).pipe(
          Effect.flatMap((live) =>
            Scope.provide(
              Effect.acquireRelease(
                Effect.sync(() => {
                  const update = () => {
                    entry.docs = live.current()
                    entry.status = "ready"
                    recompute(key, entry)
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
              recompute(key, entry)
            }),
          ),
        ),
      )
      return entry
    }

    const step = (repository: Host.Repository, delta: 1 | -1) => {
      const key = repoKeyOf(repository)
      const entry = entryOf(repository)
      const { filtered, selectedPath } = entry.state.current()
      if (filtered.length === 0) return
      const currentIdx = Math.max(0, filtered.findIndex((n) => n.path === selectedPath))
      const nextIdx = clampIndex(currentIdx + delta, filtered.length)
      entry.selectedPath = filtered[nextIdx]!.path
      recompute(key, entry)
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
        hasFeed: (repository) => entryOf(repository).hasFeed,
      },
      actions: {
        href: (repository) => hrefOf(repository),
        open: (repository) => void run(host.open(VIEW, repository)),
        select: (repository, path) => {
          const key = repoKeyOf(repository)
          const entry = entryOf(repository)
          entry.selectedPath = path
          recompute(key, entry)
        },
        search: (repository, query) => {
          const key = repoKeyOf(repository)
          const entry = entryOf(repository)
          entry.query = query
          recompute(key, entry)
        },
        step,
      },
    } satisfies WikiTab
  })

export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  return yield* make(host)
})
