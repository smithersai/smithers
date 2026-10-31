import { ElectricCollection } from "@smthrs/effect-electric"
import { LiveQuery } from "@smthrs/effect-tanstack-db"
import { Cache, Context, Effect, Layer, Scope } from "effect"
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

/** A repository's runs, newest first. */
const runsQuery = (collection: ElectricCollection.ElectricCollection<AgentRun>) =>
  LiveQuery.make((q) => q.from({ run: collection.tanstack }).orderBy(({ run }) => run.queuedAt, "desc"))

/** A repository's machines, by name. */
const machinesQuery = (collection: ElectricCollection.ElectricCollection<Machine>) =>
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
        // Opening a repository twice at once opens it once: each cache runs one lookup per repository and keeps it.
        const runs = yield* Cache.make({
          lookup: (repo: string) =>
            Effect.gen(function* () {
              const collection = yield* ElectricCollection.make<AgentRun>({
                id: `agent-runs:${repo}`,
                schema: AgentRun,
                getKey: (row) => row.key,
                syncMode: "eager",
                shape: shapeOf(config.origin, AGENT_RUNS_SHAPE_ROUTE, repo),
              })
              return yield* runsQuery(collection)
            }).pipe(Scope.provide(scope), Effect.orDie),
          capacity: Number.MAX_SAFE_INTEGER,
        })
        const machines = yield* Cache.make({
          lookup: (repo: string) =>
            Effect.gen(function* () {
              const collection = yield* ElectricCollection.make<Machine>({
                id: `machines:${repo}`,
                schema: Machine,
                getKey: (row) => row.id,
                syncMode: "eager",
                shape: shapeOf(config.origin, MACHINES_SHAPE_ROUTE, repo),
              })
              return yield* machinesQuery(collection)
            }).pipe(Scope.provide(scope), Effect.orDie),
          capacity: Number.MAX_SAFE_INTEGER,
        })
        return FleetStore.of({ runs: (repo) => Cache.get(runs, repo), machines: (repo) => Cache.get(machines, repo) })
      }),
    )
}
