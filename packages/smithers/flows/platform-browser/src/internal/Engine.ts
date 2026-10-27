/**
 * The durable engine's composition in a dedicated Web Worker: everything
 * `BrowserRuntime` loads only when a worker builds an engine, so a tab that
 * imports this package from its root never loads the engine.
 *
 * @since 1.0.0
 */

import { WebCrypto } from "@smthrs/crypto"
import type { DurableWriter } from "@smthrs/database"
import { OwnerIdentity, RunCatalogRead, RunInspection, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { type Flow, type FlowRuntime, RunMetrics } from "@smthrs/flow"
import { Runtime } from "@smthrs/flows"
import * as Jj from "@smthrs/jj"
import { Ownership } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type { HttpClient } from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { SqlClient } from "effect/sql/SqlClient"
import * as BrowserSqlite from "../BrowserSqlite.ts"
import { filename, type Service as SharedDatabase } from "../SharedSqlite.ts"
import type * as TabChannel from "../TabChannel.ts"
import type * as WebLock from "../WebLock.ts"
import * as HttpClientLayer from "./HttpClient.ts"
import * as Leader from "./Leader.ts"
import * as Prepare from "./Prepare.ts"
import * as SqlConnection from "./SqlConnection.ts"

/**
 * What names one engine, and the flows whose runs its run reads render
 * through their own schemas (`RunInspection.Options`).
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly name: string
  readonly flows?: ReadonlyArray<Flow.Any> | undefined
}

/**
 * What {@link layerHost} adds: the SQLite build the stores open.
 *
 * @category models
 * @since 1.0.0
 */
export interface HostOptions extends Options {
  readonly sqlite: BrowserSqlite.Source
  /** What the leader runs on the app's database before serving it; its flow is registered here. */
  readonly prepare?: Prepare.Prepare | undefined
  /** Checked on every activation, before the engine exists; see `BrowserRuntime.HostOptions.authorize`. */
  readonly authorize?: ((database: SharedDatabase) => Effect.Effect<void, unknown>) | undefined
}

/**
 * The services the engine host gives every registered flow: the platform's,
 * and `RunInspection`, the engine's own run reads, so a flow such as a retry
 * can read another run of the same engine.
 *
 * @category models
 * @since 1.0.0
 */
export type Host =
  | Crypto.Crypto
  | OwnerIdentity.OwnerIdentity
  | Path.Path
  | HttpClient
  | Jj.Jj
  | RunInspection.RunInspection

/** The browser engine host's platform services; the run reads come from the engine's own database. */
const engineHost: Layer.Layer<Exclude<Host, RunInspection.RunInspection>> = Layer.mergeAll(
  OwnerIdentity.layerWithoutPid,
  Path.layer,
  HttpClientLayer.layer,
  Jj.layerNoop({})
).pipe(Layer.provideMerge(WebCrypto.layer))

/**
 * How many runs the engine resumes on its own at once (`@smthrs/flows`
 * `Runtime.Options.resumeConcurrency`). The engine has one connection to its
 * store, so every run in flight shares it with the run a tab starts next; two
 * at a time leaves that run a turn at the connection however many runs the
 * last leader was cut off with.
 *
 * @category constants
 * @since 1.0.0
 */
export const resumeConcurrency = 2

/**
 * The durable engine, the run catalog and the run reads over the `SqlClient`
 * the caller provides; see `BrowserRuntime.layer`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = <Registered, RegistrationError, RegistrationRequirements>(
  options: Options,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
) =>
  Runtime.layer(
    {
      owner: { hostId: options.name },
      isAlive: Ownership.singleIncarnationLiveness,
      placement: "browser",
      resumeConcurrency
    },
    StepBoundary.layerUnsupported,
    WorkspaceSandbox.layerUnsupported,
    registerFlows
  ).pipe(
    Layer.provideMerge(Layer.merge(RunCatalogRead.layer, RunInspection.layerWith({ flows: options.flows }))),
    Layer.provideMerge(engineHost),
    // The worker's logs are its telemetry: the usage lines (`flow.run.*`) go out at Info.
    Layer.provide(RunMetrics.layerInfoLines)
  )

/** The owner the activation check's statements run as on the leader's connection. */
const AUTHORIZE_OWNER = "@authorize"

/**
 * {@link layer} over SQLite in OPFS, with the app's shared database beside
 * it; see `BrowserRuntime.layerHost`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerHost = <Registered, RegistrationError, RegistrationRequirements>(
  options: HostOptions,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
) =>
  Layer.unwrap(Effect.gen(function*() {
    // The activation check runs before the engine is built, so a refusal leaves no run resumed and no tab served.
    if (options.authorize !== undefined) {
      const connection = yield* SqlConnection.SqlConnection
      yield* options.authorize(Prepare.database(connection, AUTHORIZE_OWNER)).pipe(
        Effect.ensuring(connection.abandon(AUTHORIZE_OWNER))
      )
    }
    return layer(
      options,
      // The preparation's flow runs over the leader's connection to the app's database.
      options.prepare === undefined
        ? registerFlows
        : Layer.merge(registerFlows, Prepare.declare(options.prepare).registration)
    )
  })).pipe(
    Layer.provide(BrowserSqlite.layer({ filename: "engine.db" })),
    Layer.provideMerge(SqlConnection.layer({ filename })),
    Layer.provide(BrowserSqlite.layerSqlite({ build: options.sqlite, directory: `smithers/${options.name}` }))
  )

/**
 * What a worker's engine runs; see `BrowserRuntime.run`.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunOptions<Registered, RegistrationError, RegistrationRequirements> extends HostOptions {
  readonly flows: ReadonlyArray<Flow.Any>
  readonly registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
}

/**
 * The worker's program: `Leader.serve` over {@link layerHost}.
 * `BrowserRuntime.run` reports failures across the entire worker initialization.
 *
 * @category running
 * @since 1.0.0
 */
export const program = <
  Registered,
  RegistrationError,
  RegistrationRequirements extends FlowRuntime.FlowRuntime | Host | SqlClient | DurableWriter.DurableWriter
>(
  options: RunOptions<Registered, RegistrationError, RegistrationRequirements>
): Effect.Effect<never, unknown, WebLock.WebLock | TabChannel.TabChannel> => // Every service `RegistrationRequirements` may name is one the engine host
// provides, which the generic `Exclude` chain cannot show.
(Leader.serve(options, layerHost(options, options.registerFlows)) as Effect.Effect<
  never,
  unknown,
  WebLock.WebLock | TabChannel.TabChannel
>)
