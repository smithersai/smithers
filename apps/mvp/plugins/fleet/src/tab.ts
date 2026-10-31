import { Host } from "@smthrs/plugin"
import { Effect, Scope } from "effect"
import type { AgentRun, Machine } from "./model"

// The fleet's tab (decision 0136, docs/features/fleet.md#the-view): one per app, built by the host on first use. It
// reads a repository's agent runs and runner machines through the core's queries, `core/agent-runs` and
// `core/machines`, asked with the repository, and gives the views each one live. It acts on nothing itself: a run's
// Watch is a link to its TODO, where the run's transcript shows.

/** The core's queries the fleet reads. */
export const RUNS = "core/agent-runs"
export const MACHINES = "core/machines"

/** One value, live: what it is now, and a way to hear it changed. */
export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

/** What a view has of a repository's runs or machines: loading, refused by the host, or the rows. */
export type Rows<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Refused"; readonly reason: string }
  | { readonly _tag: "Ready"; readonly rows: ReadonlyArray<A> }

/** What the fleet's components read and do. */
export interface FleetTab {
  readonly queries: {
    /** A repository's agent runs, live; the same value for the same repository. */
    readonly runs: (repository: Host.Repository) => Watched<Rows<AgentRun>>
    /** A repository's runner machines, live. */
    readonly machines: (repository: Host.Repository) => Watched<Rows<Machine>>
  }
  readonly actions: {
    /** Where the fleet shows on `repository`. */
    readonly href: (repository: Host.Repository) => string
    /** Opens the fleet on `repository`. */
    readonly open: (repository: Host.Repository) => void
  }
}

/** `owner/name`, as the core keys a repository. */
export const repoOf = (repository: Host.Repository): string => `${repository.owner}/${repository.name}`.toLowerCase()

/** A value that changes, and tells its listeners. */
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

/** The fleet's one view. */
export const VIEW = "fleet/runs"

/** The tab over `host`, in the scope it is built in. */
export const make = (host: Host.PluginHost) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = Effect.runForkWith(yield* Effect.context<never>())

    /** Query `name` of each repository, followed once in the tab's scope. */
    const perRepository = <A>(name: string) => {
      const built = new Map<string, Watched<Rows<A>>>()
      return (repository: Host.Repository): Watched<Rows<A>> => {
        const key = repoOf(repository)
        const known = built.get(key)
        if (known !== undefined) return known
        const value = cell<Rows<A>>({ _tag: "Loading" })
        built.set(key, value)
        run(Effect.forkIn(
          host.query<A>(name, { repo: key }).pipe(
            Effect.flatMap((live) =>
              Scope.provide(
                Effect.acquireRelease(
                  Effect.sync(() => {
                    value.set({ _tag: "Ready", rows: live.current() })
                    return live.subscribe(() => value.set({ _tag: "Ready", rows: live.current() }))
                  }),
                  (stop) => Effect.sync(stop),
                ),
                scope,
              )
            ),
            // expected: a refused read shows as Refused, with its reason
            Effect.catch((refused) => Effect.sync(() => value.set({ _tag: "Refused", reason: refused.reason }))),
          ),
          scope,
        ))
        return value
      }
    }

    return {
      queries: { runs: perRepository<AgentRun>(RUNS), machines: perRepository<Machine>(MACHINES) },
      actions: {
        href: (repository) => Host.pathOf({ plugin: "fleet", scope: "repository", path: "" }, repository)!,
        open: (repository) => void run(host.open(VIEW, repository)),
      },
    } satisfies FleetTab
  })

/** The tab: built by the host in the plugin's scope on first use. */
export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  return yield* make(host)
})
