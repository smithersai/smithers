/**
 * The bind the `smithers opencode` server listens on, the rule that admits
 * it, the banner, and the assembled application.
 *
 * The bind rule is the one `smithers serve` applies: loopback needs nothing;
 * any other host needs an explicit `--listen` and a password, because a
 * server that runs a coding agent in the operator's directory, reachable
 * from another machine without a credential, is a remote execution service.
 *
 * The application is the routes behind the CORS and basic-auth middleware,
 * over the hub and the turns, and whichever driver and store the host
 * supplies. The health evaluator is the host's too, or the one the
 * environment names (`Health.evaluatorLayer`). `layer` binds it to a Node
 * socket; `app` is the same assembly without the socket, for an in-process
 * handler in tests.
 *
 * @since 1.0.0
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { type Duration, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { HttpServer } from "effect/unstable/http/HttpServer"
import type { ServeError } from "effect/unstable/http/HttpServerError"
import { createServer } from "node:http"
import { resolve } from "node:path"
import * as Auth from "./Auth.ts"
import * as Cors from "./Cors.ts"
import type * as Driver from "./Driver.ts"
import * as Events from "./Events.ts"
import * as Health from "./Health.ts"
import type * as Projection from "./Projection.ts"
import * as Routes from "./Routes.ts"
import * as Store from "./Store.ts"
import * as Turns from "./Turns.ts"

/**
 * The addresses that need no opt-in.
 *
 * @category constants
 * @since 1.0.0
 */
export const loopbackHosts: ReadonlyArray<string> = ["127.0.0.1", "::1", "localhost"]

/**
 * What the verb was asked to bind.
 *
 * @category models
 * @since 1.0.0
 */
export interface Bind {
  readonly hostname: string
  readonly port: number
  readonly listen: boolean
  readonly cors: ReadonlyArray<string>
  readonly credentials: Auth.Credentials | undefined
}

/**
 * The default bind: loopback on the port the hosted OpenCode app expects.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultBind: Bind = { hostname: "127.0.0.1", port: 4096, listen: false, cors: [], credentials: undefined }

/**
 * Whether a host is a loopback address.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isLoopback = (hostname: string): boolean => loopbackHosts.includes(hostname)

/**
 * Why a bind is refused, or `undefined` when it is admitted.
 *
 * @category getters
 * @since 1.0.0
 */
export const refusal = (bind: Bind): string | undefined => {
  if (isLoopback(bind.hostname)) return undefined
  if (!bind.listen) return `Refusing to bind ${bind.hostname}: pass --listen to serve on a non-loopback address.`
  if (bind.credentials === undefined) {
    return `Refusing to bind ${bind.hostname} without a password: set OPENCODE_SERVER_PASSWORD.`
  }
  return undefined
}

/**
 * The URL the app connects to.
 *
 * @category getters
 * @since 1.0.0
 */
export const url = (bind: Bind): string =>
  `http://${bind.hostname.includes(":") ? `[${bind.hostname}]` : bind.hostname}:${bind.port}`

/**
 * The line printed once the server is listening.
 *
 * @category constructors
 * @since 1.0.0
 */
export const banner = (bind: Bind, directory: string): string =>
  `Serving ${resolve(directory)} at ${url(bind)}. Open https://app.opencode.ai and allow the local network permission.`

/**
 * The database file under the served directory: `Store.databasePath`.
 *
 * @category getters
 * @since 1.0.0
 */
export const databasePath: (directory: string) => string = Store.databasePath

/**
 * How the server is assembled.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly directory: string
  readonly bind: Bind
  readonly version: string
  readonly seat: string
  /** The one agent's name. `smithers` by default. */
  readonly agent?: string | undefined
  /** The hub's keepalive cadence; the default is fifteen seconds. */
  readonly heartbeat?: Events.Options["heartbeat"]
  /** The evaluator health asks. `Health.evaluatorLayer` over `environment` by default. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  /** Where `AI_GATEWAY_API_KEY` is read from when no evaluator is given. The process environment by default. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The frame budget the health state reports. */
  readonly maxFrames?: number | undefined
  /** The seat's price, for the cost the session and the messages carry. */
  readonly pricing?: Projection.Pricing | undefined
}

/**
 * The application: routes behind CORS and auth, over the store, the hub,
 * and the turns. Needs a driver and a store.
 *
 * @category layers
 * @since 1.0.0
 */
export const app = (
  options: Options
): Layer.Layer<never, never, HttpRouter.HttpRouter | Driver.Driver | Store.Store> => assemble(options, hubOf(options))

const hubOf = (options: Options): Layer.Layer<Events.Events> => {
  const directory = resolve(options.directory)
  return Events.layer({ directory, project: Routes.projectID(directory), heartbeat: options.heartbeat })
}

const assemble = (
  options: Options,
  hub: Layer.Layer<Events.Events>
): Layer.Layer<never, never, HttpRouter.HttpRouter | Driver.Driver | Store.Store> => {
  const directory = resolve(options.directory)
  const agentName = options.agent ?? "smithers"
  const evaluator = options.evaluator ?? Health.evaluatorLayer(options.environment ?? Health.ambientEnvironment())
  const turns = Turns.layer({
    directory,
    agent: agentName,
    model: Routes.modelOf(options.seat),
    maxFrames: options.maxFrames,
    pricing: options.pricing
  }).pipe(Layer.provide(Layer.mergeAll(hub, evaluator)))
  return Layer.mergeAll(
    Routes.layer({ directory, version: options.version, seat: options.seat, agent: agentName }),
    Cors.layer(options.bind.cors),
    Auth.layer(options.bind.credentials)
  ).pipe(Layer.provide(Layer.mergeAll(hub, turns)))
}

/**
 * How long the socket waits for its connections to drain on shutdown
 * before it closes them. The event streams are ended first, so the wait
 * covers a response mid-write, not a stream a client holds open.
 *
 * @category constants
 * @since 1.0.0
 */
export const shutdownTimeout: Duration.Input = "2 seconds"

/**
 * The server on a Node socket. Needs a driver and a store: the engine
 * driver brings its own store over the engine database, and the scripted
 * driver is paired with `Store.layerSqlite(databasePath(directory))`. The
 * layer fails when the bind is refused or the socket cannot be bound.
 *
 * On shutdown the hub ends every event stream first, so the open
 * `/global/event` responses finish and the socket closes at once instead
 * of waiting its graceful timeout on clients that never disconnect.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options
): Layer.Layer<HttpServer, ServeError | Error, Driver.Driver | Store.Store> =>
  Layer.unwrap(
    Effect.suspend(() => {
      const refused = refusal(options.bind)
      if (refused !== undefined) return Effect.fail(new Error(refused))
      const hub = hubOf(options)
      const served = HttpRouter.serve(assemble(options, hub), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, {
            host: options.bind.hostname,
            port: options.bind.port,
            gracefulShutdownTimeout: shutdownTimeout
          })
        )
      )
      // Built after the socket, so its finalizer runs before the socket's.
      const closing = Layer.effectDiscard(
        Effect.flatMap(Events.Events, (events) => Effect.addFinalizer(() => events.close))
      ).pipe(Layer.provide(hub))
      return Effect.succeed(Layer.provideMerge(closing, served))
    })
  )

/**
 * Hosts the server until the fiber is interrupted.
 *
 * @category constructors
 * @since 1.0.0
 */
export const host = (options: Options): Effect.Effect<never, ServeError | Error, Driver.Driver | Store.Store> =>
  Layer.launch(layer(options))
