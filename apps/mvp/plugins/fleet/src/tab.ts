import { Host } from "@smthrs/plugin"
import { Effect, Scope } from "effect"
import type { HostNode, ObservedSession, ProviderAccount } from "../../../src/features/fleet/globalSchema"
import type { AgentRun, Machine } from "./model"

export const RUNS = "core/agent-runs"
export const MACHINES = "core/machines"
export const FLEET_NODES = "core/fleet-nodes"
export const FLEET_SESSIONS = "core/fleet-sessions"
export const FLEET_ACCOUNTS = "core/fleet-accounts"

export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

export type Rows<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Refused"; readonly reason: string }
  | { readonly _tag: "Ready"; readonly rows: ReadonlyArray<A> }

export interface FleetTab {
  readonly queries: {
    readonly runs: (repository: Host.Repository) => Watched<Rows<AgentRun>>
    readonly machines: (repository: Host.Repository) => Watched<Rows<Machine>>
    readonly globalNodes: () => Watched<Rows<HostNode>>
    readonly globalSessions: () => Watched<Rows<ObservedSession>>
    readonly globalAccounts: () => Watched<Rows<ProviderAccount>>
  }
  readonly actions: {
    readonly href: (repository: Host.Repository) => string
    readonly open: (repository: Host.Repository) => void
    readonly openGlobal: () => void
  }
}

export const repoOf = (repository: Host.Repository): string => `${repository.owner}/${repository.name}`.toLowerCase()

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

export const VIEW = "fleet/runs"
export const GLOBAL_VIEW = "fleet/global"

export const make = (host: Host.PluginHost) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = Effect.runForkWith(yield* Effect.context<never>())

    const watchQuery = <A>(name: string, params?: Host.QueryParams): Watched<Rows<A>> => {
      const value = cell<Rows<A>>({ _tag: "Loading" })
      run(Effect.forkIn(
        host.query<A>(name, params).pipe(
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
          Effect.catch((refused) =>
            Effect.logWarning("fleet.query.refused", { name, reason: refused.reason }).pipe(
              Effect.andThen(Effect.sync(() => value.set({ _tag: "Refused", reason: refused.reason }))),
            )),
        ),
        scope,
      ))
      return value
    }

    const perRepository = <A>(name: string) => {
      const built = new Map<string, Watched<Rows<A>>>()
      return (repository: Host.Repository): Watched<Rows<A>> => {
        const key = repoOf(repository)
        const known = built.get(key)
        if (known !== undefined) return known
        const watched = watchQuery<A>(name, { repo: key })
        built.set(key, watched)
        return watched
      }
    }

    const singleton = <A>(name: string) => {
      let watched: Watched<Rows<A>> | undefined
      return (): Watched<Rows<A>> => {
        if (watched === undefined) watched = watchQuery<A>(name)
        return watched
      }
    }

    return {
      queries: {
        runs: perRepository<AgentRun>(RUNS),
        machines: perRepository<Machine>(MACHINES),
        globalNodes: singleton<HostNode>(FLEET_NODES),
        globalSessions: singleton<ObservedSession>(FLEET_SESSIONS),
        globalAccounts: singleton<ProviderAccount>(FLEET_ACCOUNTS),
      },
      actions: {
        href: (repository) => Host.pathOf({ plugin: "fleet", scope: "repository", path: "" }, repository)!,
        open: (repository) => void run(host.open(VIEW, repository)),
        openGlobal: () => void run(host.open(GLOBAL_VIEW)),
      },
    } satisfies FleetTab
  })

export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  return yield* make(host)
})
