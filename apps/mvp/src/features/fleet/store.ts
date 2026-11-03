import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { LiveQuery } from "@smthrs/effect-tanstack-db"
import { Cache, Context, Effect, Latch, Layer, Option, Scope, Stream } from "effect"
import { AuthStore, SESSION } from "../auth/store"
import { repoId } from "../repo/contract"
import type { Source } from "../repo/gate"
import { RepoStore } from "../repo/store"
import { repoVisibility } from "../repo/visibility"
import { AGENT_RUNS_SHAPE_ROUTE, MACHINES_SHAPE_ROUTE } from "./contract"
import { AgentRun, Machine } from "./schema"

// The fleet on this tab (decision 0143, docs/features/fleet.md#the-browser): Electric's `agent_runs` and `runners` of
// each repository something asked for, never kept on the device. A repository's runs sync once something asks for
// them, for as long as the store lives, one collection per repository and shape: one shape each, however many runs.
// The shape decides what the viewer may see: runs for a Member and up (the account label for a Maintainer), machines
// for a Maintainer and up; a refused shape holds no rows.

/** Where the fleet syncs from: ChatApi's origin, the site's own. */
export interface FleetConfig {
  readonly origin: string
}

/** A repository's runs, newest first, read through the data gate (repo/gate.ts). */
const runsQuery = (collection: Source<AgentRun>) =>
  LiveQuery.make((q) => q.from({ run: collection.tanstack }).orderBy(({ run }) => run.queuedAt, "desc"))

/** A repository's machines, by name, read through the data gate (repo/gate.ts). */
const machinesQuery = (collection: Source<Machine>) =>
  LiveQuery.make((q) => q.from({ machine: collection.tanstack }).orderBy(({ machine }) => machine.name, "asc"))

/** One repository's runs or machines, as a live query. */
export type Runs = Effect.Success<ReturnType<typeof runsQuery>>
export type Machines = Effect.Success<ReturnType<typeof machinesQuery>>

/** Electric's text for a timestamp, a big integer and a numeric, as the rows hold them. */
const parser = {
  timestamptz: (value: string) => new Date(value).toISOString(),
  int8: (value: string) => Number(value),
  numeric: (value: string) => Number(value),
}

/** A shape of `repo` (`owner/name`). */
const shapeOf = (origin: string, route: string, repo: string) => ({
  url: `${origin}${route}?repo=${encodeURIComponent(repo)}`,
  columnMapper: ElectricCollection.snakeCamelMapper(),
  parser,
})

/**
 * A shape of the fleet, whose rows are memory only. A 403 drops them and sends no more requests: Members are refused
 * machines, so this is the shape's refusal and says nothing of the repository's other shapes. A 401 stops the shape and
 * asks the session, whose confirmed end drops them (decision 0110, 2026-11-03). A session check that confirms someone, or
 * a role read whose answer grants something new on the repository, starts it again. Restarts need a session that
 * isn't signed out or unverified, since authority may have come back.
 */
const refusable = <A extends object>(
  scope: Scope.Scope,
  auth: Option.Option<AuthStore["Service"]>,
  repos: Option.Option<RepoStore["Service"]>,
  id: string,
  make: Effect.Effect<ElectricCollection.ElectricCollection<A>, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const source = yield* ShapeSource.ShapeSource
    const running = yield* Latch.make(true)
    let collection: ElectricCollection.ElectricCollection<A> | undefined
    const stop = Effect.andThen(running.close, Effect.suspend(() => collection?.evict ?? Effect.void))
    collection = yield* make.pipe(Effect.provideService(ShapeSource.ShapeSource, {
      cacheNamespace: source.cacheNamespace,
      request: (url, init) => Effect.andThen(running.await, Effect.tap(source.request(url, init), (response) => {
        if (response.status === 401) return Effect.andThen(running.close, Option.isSome(auth) ? auth.value.askCheck : Effect.void)
        // In the store's scope: evicting aborts the request this runs in.
        return response.status === 403 ? Effect.forkIn(stop, scope, { startImmediately: true }) : Effect.void
      })),
    }))
    // Only while the repository may show (`repoVisibility`): a failed verification or a refusal starts nothing.
    const again = Effect.gen(function* () {
      if (Option.isSome(auth)) {
        const session = yield* auth.value.session.get(SESSION)
        const row = Option.isSome(repos) ? Option.getOrUndefined(yield* repos.value.roles.get(id)) : undefined
        if (Option.isSome(session) && repoVisibility(session.value, row) !== "show") return
      }
      yield* running.open
      yield* collection!.reconnect
    })
    if (Option.isSome(auth)) {
      yield* auth.value.sessionState.rows.pipe(
        // Signed out: the rows go. What shows while the session can't be verified is the plugin host's gate (`gateLive`).
        Stream.runForEach((sessions) => sessions[0]?.status === "signed_out" ? stop : Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* auth.value.confirmations.pipe(
        Stream.mapEffect(() => Effect.map(auth.value.session.get(SESSION), (row) => Option.isSome(row) && row.value.status === "signed_in")),
        Stream.filter((signedIn) => signedIn),
        Stream.runForEach(() => again),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    }
    if (Option.isSome(repos)) {
      yield* repos.value.rolesState.rows.pipe(
        Stream.map((rows) => rows.find((row) => row.id === id)),
        // Each answer that grants something, by what it grants: Member to Maintainer starts machines again.
        Stream.map((row) => row === undefined || row.refused !== undefined || row.failure !== undefined
          ? undefined
          : `${row.role}|${row.own}|${row.workspaceRole ?? ""}|${row.readable ?? ""}`),
        Stream.changes,
        Stream.filter((granted) => granted !== undefined),
        Stream.runForEach(() => again),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    }
    return { collection, stop }
  })

export class FleetStore extends Context.Service<
  FleetStore,
  {
    /** Repository `repo`'s (`owner/name`, lowercased) runs, newest first, opened once and synced while the store lives. */
    readonly runs: (repo: string) => Effect.Effect<Runs>
    /** Repository `repo`'s machines, by name, opened once and synced while the store lives. */
    readonly machines: (repo: string) => Effect.Effect<Machines>
  }
>()("@smthrs/mvp/fleet/FleetStore") {
  /** The store; its shapes closed when the scope closes. Needs the tab's `ShapeSource`. */
  static readonly layer = (config: FleetConfig) =>
    Layer.effect(
      FleetStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const auth = yield* Effect.serviceOption(AuthStore)
        const repos = yield* Effect.serviceOption(RepoStore)
        // Each shape opened, by repository id: a repository's refusal stops it and drops its rows until authority returns.
        const stops = new Map<string, Array<Effect.Effect<void>>>()
        const registered = <A extends object>(repo: string, make: Effect.Effect<ElectricCollection.ElectricCollection<A>, never, Scope.Scope>) =>
          Effect.gen(function* () {
            const [owner, name] = repo.split("/") as [string, string]
            const id = repoId(owner, name)
            const { collection, stop } = yield* refusable(scope, auth, repos, id, make)
            stops.set(id, [...(stops.get(id) ?? []), stop])
            if (Option.isSome(repos) && repos.value.isRefused(id)) yield* stop
            return collection
          })
        if (Option.isSome(repos)) {
          yield* repos.value.registerCache(["agent-runs", "machines"], (id) =>
            Effect.suspend(() => Effect.all(stops.get(id) ?? [], { discard: true })))
        }
        // What shows of a repository's rows: only through the data gate (repo/gate.ts), so a refusal or a session a
        // reached server couldn't verify drops them in the change that hides the repository, before any eviction.
        const shown = <A extends object & { readonly repoId: string }>(collection: ElectricCollection.ElectricCollection<A>) =>
          Option.isSome(repos) ? repos.value.gate(collection) : Effect.succeed(collection)
        // Opening a repository twice at once opens it once: each cache runs one lookup per repository and keeps it.
        const runs = yield* Cache.make({
          lookup: (repo: string) =>
            Effect.gen(function* () {
              const collection = yield* registered(repo, ElectricCollection.make<AgentRun>({
                id: `agent-runs:${repo}`,
                schema: AgentRun,
                getKey: (row) => row.key,
                syncMode: "eager",
                shape: shapeOf(config.origin, AGENT_RUNS_SHAPE_ROUTE, repo),
              }))
              return yield* runsQuery(yield* shown(collection))
            }).pipe(Scope.provide(scope), Effect.orDie),
          capacity: Number.MAX_SAFE_INTEGER,
        })
        const machines = yield* Cache.make({
          lookup: (repo: string) =>
            Effect.gen(function* () {
              const collection = yield* registered(repo, ElectricCollection.make<Machine>({
                id: `machines:${repo}`,
                schema: Machine,
                getKey: (row) => row.id,
                syncMode: "eager",
                shape: shapeOf(config.origin, MACHINES_SHAPE_ROUTE, repo),
              }))
              return yield* machinesQuery(yield* shown(collection))
            }).pipe(Scope.provide(scope), Effect.orDie),
          capacity: Number.MAX_SAFE_INTEGER,
        })
        return FleetStore.of({ runs: (repo) => Cache.get(runs, repo), machines: (repo) => Cache.get(machines, repo) })
      }),
    )
}
