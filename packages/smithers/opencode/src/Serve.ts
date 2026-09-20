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
import { Duration, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { HttpServer } from "effect/unstable/http/HttpServer"
import { createServer, type Server } from "node:http"
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
 * Why a bind is refused, or `undefined` when it is admitted: a `--cors`
 * pattern that is not an origin, a non-loopback host with no `--listen`, or
 * a non-loopback host with no password.
 *
 * @category getters
 * @since 1.0.0
 */
export const refusal = (bind: Bind): string | undefined => {
  // A `--cors` pattern the policy cannot use is refused before the socket is
  // bound, because an operator who passed one believes they have a policy.
  const pattern = Cors.refusal(bind.cors)
  if (pattern !== undefined) return pattern
  if (isLoopback(bind.hostname)) return undefined
  if (!bind.listen) return `Refusing to bind ${bind.hostname}: pass --listen to serve on a non-loopback address.`
  if (bind.credentials === undefined) {
    return `Refusing to bind ${bind.hostname} without a password: set OPENCODE_SERVER_PASSWORD.`
  }
  return undefined
}

/**
 * A bind the rule refuses: a non-loopback host without `--listen`, or
 * without a password. The message is the refusal.
 *
 * @category errors
 * @since 1.0.0
 */
export class BindRefused extends Schema.TaggedError<BindRefused>()("@smthrs/opencode/BindRefused", {
  message: Schema.String
}) {}

/**
 * A bind the socket refused: the port is held, the address is not this
 * machine's, or the operating system would not give it. The message names
 * where it tried to bind and what to do about it.
 *
 * The socket's own failure is `ServeError`, which carries the node error as
 * an opaque `cause` and has no message of its own, so the CLI printed
 * `ServeError` and an empty line. That is the one failure an operator meets
 * by ordinary accident, a second server on the same port, and it has to say
 * so.
 *
 * @category errors
 * @since 1.0.0
 */
export class BindFailed extends Schema.TaggedError<BindFailed>()("@smthrs/opencode/BindFailed", {
  message: Schema.String
}) {}

/**
 * The sentence a socket that would not bind reports: where it tried, and the
 * way out. The node error's `code` is what it branches on, never the text.
 *
 * @param bind what the verb asked to bind
 * @param cause the error the socket raised
 * @category getters
 * @since 1.0.0
 */
export const bindFailure = (bind: Bind, cause: unknown): string => {
  const code = (cause as { readonly code?: unknown } | undefined)?.code
  if (code === "EADDRINUSE") {
    return `Port ${bind.port} on ${bind.hostname} is already in use, so nothing is being served. Another program holds it, which is usually a server of this one already running here: stop it, or serve on another port with --port.`
  }
  if (code === "EACCES") {
    return `Binding ${bind.hostname} port ${bind.port} was not permitted, so nothing is being served. A port below 1024 needs root: serve on a port above 1023 with --port.`
  }
  return `${bind.hostname} port ${bind.port} could not be bound, so nothing is being served: ${
    cause instanceof Error ? cause.message : String(cause)
  }. Check that ${bind.hostname} is an address this machine holds and that --port names a free port.`
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
 * How often the drain looks for a connection that has fallen idle.
 *
 * @category constants
 * @since 1.0.0
 */
export const drainInterval: Duration.Input = "10 millis"

/**
 * Closes the socket's connections instead of waiting for them, and bounds
 * the wait at `grace`.
 *
 * `gracefulShutdownTimeout` bounds only the preemptive close inside the
 * serve scope. The finalizer that actually holds the process is node's
 * `server.close`, which calls back when the last connection is gone and
 * which nothing bounds. Node closes the connections that were idle when it
 * was called, and only those: a connection that was mid-request when the
 * signal arrived is waited for, and once its answer is written it is an idle
 * keep-alive socket node no longer looks at, so the process waits out
 * `keepAliveTimeout` on it. One ordinary client that keeps asking on that
 * same connection is never idle at all, and then the wait has no end. Both
 * were measured against this server: a held synchronous prompt cost 5.0 s
 * against 27 ms with nothing held, and a client that kept asking held a
 * process whose listener had closed 152 ms after the signal alive for as
 * long as it was left running, leaving only when the client hung up.
 *
 * So the connections are closed here. The idle ones go at once and again as
 * they fall idle, and whatever is still in flight when the grace expires is
 * destroyed. Both timers are unref'd, so neither keeps the process alive by
 * existing, and both are cleared when the socket closes.
 *
 * @category constructors
 * @since 1.0.0
 */
export const drain = (server: Server, grace: Duration.Input = shutdownTimeout): void => {
  const falling = setInterval(() => server.closeIdleConnections(), Duration.toMillis(drainInterval))
  const expiry = setTimeout(() => {
    clearInterval(falling)
    server.closeAllConnections()
  }, Duration.toMillis(grace))
  falling.unref()
  expiry.unref()
  server.once("close", () => {
    clearInterval(falling)
    clearTimeout(expiry)
  })
  server.closeIdleConnections()
}

/**
 * The server on a Node socket. Needs a driver and a store: the engine
 * driver brings its own store over the engine database, and the scripted
 * driver is paired with `Store.layerSqlite(databasePath(directory))`. The
 * layer fails when the bind is refused or the socket cannot be bound.
 *
 * On shutdown the hub ends every event stream first, so the open
 * `/global/event` responses finish and the socket closes at once instead
 * of waiting its graceful timeout on clients that never disconnect. What is
 * left is then drained rather than waited for ({@link drain}), so the
 * process leaves whatever its clients do with their connections.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options
): Layer.Layer<HttpServer, BindFailed | BindRefused, Driver.Driver | Store.Store> =>
  Layer.unwrap(
    Effect.suspend(() => {
      const refused = refusal(options.bind)
      if (refused !== undefined) return Effect.fail(new BindRefused({ message: refused }))
      const hub = hubOf(options)
      // The socket is built here rather than by the layer so the drain has
      // it: nothing else can reach the connections it is holding.
      const socket = createServer()
      const served = HttpRouter.serve(assemble(options, hub), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => socket, {
            host: options.bind.hostname,
            port: options.bind.port,
            gracefulShutdownTimeout: shutdownTimeout
          })
        )
      )
      // Built after the socket, so its finalizer runs before the socket's:
      // the streams end and the drain is armed while the socket's own
      // finalizer is still to come, because that finalizer is the one that
      // waits.
      const closing = Layer.effectDiscard(
        Effect.flatMap(Events.Events, (events) =>
          Effect.addFinalizer(() => Effect.andThen(events.close, Effect.sync(() => drain(socket)))))
      ).pipe(Layer.provide(hub))
      // The socket's own failure says nothing an operator can act on, so it
      // is re-raised as one that does. It is the layer's failure and not a
      // defect, so the verb reports it the way it reports a refused bind.
      return Effect.succeed(
        Layer.provideMerge(closing, served).pipe(
          Layer.catchTag("ServeError", (error) =>
            bindFailed(new BindFailed({ message: bindFailure(options.bind, error.cause) })))
        )
      )
    })
  )

/** A layer of the served shape that fails with the bind's own words. */
const bindFailed = (error: BindFailed): Layer.Layer<HttpServer, BindFailed> => Layer.unwrap(Effect.fail(error))

/**
 * Hosts the server until the fiber is interrupted.
 *
 * `ready` runs once the socket is bound and the application is assembled,
 * which is where the banner belongs: printed before, it announced a server
 * on a port the socket then failed to take, and the documented acceptance
 * for R1, "the banner names the directory and the URL", passed on a server
 * that never bound.
 *
 * @param options how the server is assembled
 * @param ready what to do once it is listening
 * @category constructors
 * @since 1.0.0
 */
export const host = (
  options: Options,
  ready: Effect.Effect<void> = Effect.void
): Effect.Effect<never, BindFailed | BindRefused, Driver.Driver | Store.Store> =>
  Layer.launch(Layer.provideMerge(Layer.effectDiscard(ready), layer(options)))
