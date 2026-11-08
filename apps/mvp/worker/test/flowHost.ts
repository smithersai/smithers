import { TestSchemas } from "@smthrs/database"
// The Node host for the worker tests: the durable flow engine the Node and Bun hosts compose (`Runtime.layer` from
// `@smthrs/flows`), over `@smthrs/platform-node`'s host services and the compose Postgres (`pnpm db:up`), in an engine
// schema of the test's own. A flow that runs here and on the Cloudflare Durable Object (worker/Executions.ts) is
// host-agnostic (sdk.host-agnostic-flows in docs/rules.md).
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { type Flow, FlowRuntime } from "@smthrs/flow"
import { EngineStore, RunStore, Runtime } from "@smthrs/flows"
import { NodeHost } from "@smthrs/platform-node"
import { Context, Effect, Exit, Layer, Redacted, type Schema, Scope, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import * as TestDatabase from "../../db/TestDatabase.ts"

/** Where a Node-host runtime keeps its engine: a fresh schema of the compose Postgres, dropped with the runtime. */
export interface Engine {
  /** The engine's schema, `flows_<epoch-seconds>_<hex>`. */
  readonly schema: string
  /** A run's status in the engine's run table (`running`, `completed`, `failed`, ...), or `undefined` if unknown. */
  readonly status: (executionId: string) => Effect.Effect<string | undefined>
}

/** What the runtime is for: the engine's owner, as the Node and Bun hosts name it. */
export interface HostOptions {
  /** The host id the engine fences its writes with; `node-test` unless set. */
  readonly hostId?: string
  /**
   * An engine schema an earlier runtime made, to resume its runs: this runtime neither creates it nor drops it. A
   * fresh schema, dropped with the runtime, unless set.
   */
  readonly schema?: string
  /**
   * How the engine judges an earlier owner of a run alive: by its lease unless set. A check that tells this host's
   * incarnations apart, such as the browser's `BrowserRuntime.isAlive`, also gives each runtime an incarnation number of
   * its own rather than the process id, as the browser host does, so two runtimes in one test process differ.
   */
  readonly isAlive?: RunStore.Ownership.LivenessCheck
  /**
   * The most connections the engine opens to the compose Postgres: 4 unless set. The suite's files build engines in
   * parallel, and together with Electric's they must fit Postgres' limit of 100 (the pool's own default is 10).
   */
  readonly maxConnections?: number
  /** A test fault service before every engine SQL operation; available unless set. */
  readonly databaseGate?: Effect.Effect<void, SqlError>
  /** Names this engine pool's physical connections so a hard-crash test can terminate every one. */
  readonly connectionName?: string
}

/** A client for the compose Postgres itself, outside any engine schema, for the scope that builds it. */
const admin = Layer.unwrap(
  Effect.map(
    TestDatabase.serverUrl,
    (url) => Pg.PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }),
  ),
)

/** Block both new reservations and previously reserved connections when a host is cut off. */
const gatedDriver = (gate: Effect.Effect<void, SqlError>): PostgresDatabase.Driver => ({
  ...Pg,
  PgClient: {
    ...Pg.PgClient,
    make: (options) => Effect.map(Pg.PgClient.make(options), (client) => Object.assign(client, {
      reserve: Effect.andThen(gate, Effect.map(client.reserve, (connection): Connection => ({
        execute: (...args) => Effect.andThen(gate, connection.execute(...args)),
        executeRaw: (...args) => Effect.andThen(gate, connection.executeRaw(...args)),
        executeValues: (...args) => Effect.andThen(gate, connection.executeValues(...args)),
        executeValuesUnprepared: (...args) => Effect.andThen(gate, connection.executeValuesUnprepared(...args)),
        executeUnprepared: (...args) => Effect.andThen(gate, connection.executeUnprepared(...args)),
        executeStream: (...args) => Stream.unwrap(Effect.as(gate, connection.executeStream(...args))),
      }))),
    })),
  },
})

/**
 * Builds the Node-host runtime in the caller's scope: a fresh engine schema on the compose Postgres (created by the
 * engine's own migrations, dropped when the scope closes), with `registration` registered. Provides the engine's
 * `FlowRuntime` and everything `registration` provides, and returns the `Engine`. Fails with
 * `TestDatabase.Unusable`, naming `pnpm db:up`, when nothing answers at the compose Postgres.
 */
export const build = <ROut, RE, RR>(registration: Layer.Layer<ROut, RE, RR>, options: HostOptions = {}) =>
  Effect.gen(function* () {
    const server = yield* TestDatabase.serverUrl
    const schema = options.schema ?? TestSchemas.schemaName("flows")
    const adminContext = yield* Layer.build(admin)
    const sql = Context.get(adminContext, SqlClient.SqlClient)
    // Registered first, so it runs last: the runtime's connections close before the schema goes.
    if (options.schema === undefined) {
      yield* Effect.addFinalizer(() => Effect.orDie(sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`))
    }
    const runtime = Runtime.layer(
      {
        owner: { hostId: options.hostId ?? "node-test" },
        isAlive: options.isAlive ?? RunStore.Ownership.leaseLiveness(),
      },
      EngineStore.StepBoundary.layerUnsupported,
      EngineStore.WorkspaceSandbox.layerUnsupported,
      registration,
    ).pipe(
      Layer.provide(
        options.isAlive === undefined ? EngineStore.OwnerIdentity.layer : EngineStore.OwnerIdentity.layerWithoutPid,
      ),
      Layer.provide(NodeHost.layer),
      // Every durable composition needs `Crypto` where its executions run, not only where the runtime is built: a
      // `.to()` handoff mints the next round's id with it. The deployed host merges it in the same way
      // (`CloudflareHost.layer` in @smthrs/platform-cloudflare).
      Layer.provideMerge(NodeHost.NodeCrypto.layer),
      Layer.provide(
        PostgresDatabase.layer({
          url: server.toString(),
          driver: options.databaseGate === undefined ? Pg : gatedDriver(options.databaseGate),
          schema,
          postgres: {
            maxConnections: options.maxConnections ?? 4,
            ...(options.connectionName === undefined ? {} : { applicationName: options.connectionName }),
          },
        }),
      ),
    )
    const context = yield* Layer.build(runtime)
    const engine: Engine = {
      schema,
      status: (executionId) =>
        Effect.orDie(sql<{ readonly status: string }>`
          SELECT status FROM ${sql(schema)}.flows_runs WHERE run_id = ${executionId}`).pipe(
          Effect.map((rows) => rows[0]?.status),
        ),
    }
    return { context, engine }
  }).pipe(Effect.mapError(TestDatabase.explain("Postgres", "localhost:54321")))

/** What `runFlow` returns: the flow's exit, its execution id and its status in the engine afterwards. */
export interface Ran<A, E> {
  readonly exit: Exit.Exit<A, E | FlowRuntime.FlowCycleDetected>
  readonly executionId: string
  readonly status: string | undefined
}

/**
 * Runs `flow` with `payload` to its end on the Node host: builds the runtime with `registration` (`build`), executes
 * the flow as `executionId` (a fresh UUID unless set), then closes the runtime and drops its schema. Resolves with the
 * flow's `Exit` (its success, or its typed failure), never rejects for a flow failure; rejects only when the host
 * itself can't be built, for example `TestDatabase.Unusable` when the compose Postgres is down, or when `signal` aborts
 * it, after the run is interrupted and the runtime closed.
 */
export const runFlow = <
  Name extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  ROut,
  RE,
  RR,
>(
  flow: Flow.Flow<Name, Payload, Success, Error, Requires>,
  payload: Payload["Type"],
  registration: Layer.Layer<ROut, RE, RR>,
  options: HostOptions & { readonly executionId?: string; readonly signal?: AbortSignal } = {},
): Promise<Ran<Success["Type"], Error["Type"]>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { context, engine } = yield* build(registration, options)
        const executionId = options.executionId ?? crypto.randomUUID()
        const flows = Context.get(context, FlowRuntime.FlowRuntime)
        const exit = yield* Effect.exit(
          flows.execute(flow, { executionId, payload }).pipe(Effect.provide(context)) as Effect.Effect<
            Success["Type"],
            Error["Type"] | FlowRuntime.FlowCycleDetected
          >,
        )
        return { exit, executionId, status: yield* engine.status(executionId) }
      }),
      // What `registration` requires beyond the engine's own services (`FlowRuntime` and the rest) can't be named
      // generically here; a registration that needs anything else fails to build, loudly.
    ) as Effect.Effect<Ran<Success["Type"], Error["Type"]>, unknown>,
    options.signal === undefined ? undefined : { signal: options.signal },
  )

/** One incarnation of a host's engine (`incarnation`): runs flows until it crashes or closes. */
export interface Incarnation {
  readonly engine: Engine
  /** Starts or resumes `flow` as `executionId` here; resolves with its exit. */
  readonly execute: <A, E>(
    flow: Flow.Any,
    executionId: string,
    payload: unknown,
  ) => Effect.Effect<Exit.Exit<A, E>>
  /** Cuts it off as a process that died would be: its connections end, and it can't reconnect. */
  readonly crash: () => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * One incarnation of a Durable Object's engine over `registration`, on a fresh engine schema or, to resume another's
 * runs, on `schema`: each incarnation is its own host whose predecessor counts as dead
 * (`singleIncarnationLiveness`), as a Durable Object's next alarm is. `crash` ends its connections, so the next
 * incarnation resumes what it was running from the journal (worker/flows/Todo.test.ts' crash test runs the same way).
 */
export const incarnation = async <ROut, RE, RR>(
  registration: Layer.Layer<ROut, RE, RR>,
  schema?: string,
): Promise<Incarnation> => {
  const scope = Effect.runSync(Scope.make())
  let disconnected = false
  const connectionName = `incarnation-${crypto.randomUUID()}`
  const databaseGate = Effect.suspend(() =>
    disconnected
      ? Effect.fail(
        new SqlError({
          reason: new ConnectionError({
            cause: "incarnation crashed",
            message: "The incarnation's database connection ended",
            operation: "execute",
          }),
        }),
      )
      : Effect.void
  )
  // What `registration` requires beyond the engine's own services can't be named generically, as in `runFlow`.
  const built = await Effect.runPromise(
    Scope.provide(scope)(
      build(registration, {
        hostId: "durable-object",
        isAlive: RunStore.Ownership.singleIncarnationLiveness,
        maxConnections: 3,
        databaseGate,
        connectionName,
        ...(schema === undefined ? {} : { schema }),
      }),
    ) as unknown as Effect.Effect<{ readonly context: Context.Context<FlowRuntime.FlowRuntime>; readonly engine: Engine }, unknown>,
  )
  return {
    engine: built.engine,
    execute: <A, E>(flow: Flow.Any, executionId: string, payload: unknown) =>
      Effect.exit(
        Context.get(built.context, FlowRuntime.FlowRuntime).execute(flow as never, { executionId, payload: payload as never })
          .pipe(Effect.provide(built.context)) as Effect.Effect<A, E>,
      ),
    crash: async () => {
      disconnected = true
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const context = yield* Layer.build(admin)
        const sql = Context.get(context, SqlClient.SqlClient)
        yield* Effect.orDie(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND application_name = ${connectionName}`)
      })))
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
