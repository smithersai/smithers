/**
 * `smithers opencode`: the OpenCode protocol server over the agent loop, for
 * the hosted OpenCode app.
 *
 * The verb serves one directory on one socket. The bind rule is `serve`'s:
 * loopback needs nothing, anything else needs `--listen` and a password in
 * `OPENCODE_SERVER_PASSWORD`. The server changes into the directory it
 * serves, because a shell call inherits the process working directory.
 *
 * Every turn runs on the durable engine under `<directory>/.smithers`, on
 * the seat `--seat` names, else `SMITHERS_SEAT`, else the first provider
 * whose key is set. `--scripted` replays a recorded turn instead, so the
 * hosted app can be driven end to end without a model.
 *
 * Running a model needs two keys, not one. `AI_GATEWAY_API_KEY` is the
 * second: the harness asks Jev whether a completion describes what the run
 * did, a completion nothing judged fails the run, and a claim the record does
 * not support fails it too once the run has had its frames to prove it. The
 * verb refuses to start without it rather than serving a session that breaks
 * at the first real task. `--scripted` runs no model and needs neither key.
 *
 * One directory is one server's. A second verb over a directory a live server
 * already holds refuses to start and names that server, because the two would
 * share the directory's store and not their events. The claim is
 * `@smthrs/opencode`'s `Ownership`, and it is taken before the driver opens
 * the store.
 *
 * @since 1.0.0
 */
import type * as Undici from "@effect/platform-node/Undici"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Auth from "@smthrs/opencode/Auth"
import * as DemoScript from "@smthrs/opencode/DemoScript"
import type * as Driver from "@smthrs/opencode/Driver"
import * as EngineDriver from "@smthrs/opencode/EngineDriver"
import * as Ownership from "@smthrs/opencode/Ownership"
import * as Pricing from "@smthrs/opencode/Pricing"
import * as ScriptedDriver from "@smthrs/opencode/ScriptedDriver"
import * as Serve from "@smthrs/opencode/Serve"
import * as Store from "@smthrs/opencode/Store"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import type * as Scope from "effect/Scope"
import { resolve } from "node:path"
import type * as Bridge from "../cli/ControlBridge.ts"
import * as CliError from "../CliError.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Providers from "../Providers.ts"
import { packageVersion } from "../Version.ts"
import * as Globals from "./Globals.ts"

/**
 * The typed options the parser produces.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly directory?: string | undefined
  readonly port: number
  readonly hostname: string
  readonly listen: boolean
  readonly cors: ReadonlyArray<string>
  readonly seat?: string | undefined
  readonly maxFrames: number
  readonly scripted: boolean
}

/**
 * The seat the scripted driver labels its turns with.
 *
 * @category constants
 * @since 1.0.0
 */
export const scriptedSeat = "scripted:demo"

/**
 * The bind the options ask for.
 *
 * @category constructors
 * @since 1.0.0
 */
export const bind = (options: Options, environment: Readonly<Record<string, string | undefined>>): Serve.Bind => ({
  hostname: options.hostname,
  port: options.port,
  listen: options.listen,
  cors: options.cors,
  credentials: Auth.fromEnvironment(environment)
})

/**
 * The seat a turn runs on: `--seat`, else `SMITHERS_SEAT`, else the starter
 * seat of the first provider whose key is set, else nothing.
 *
 * @category getters
 * @since 1.0.0
 */
export const seatOf = (
  options: Pick<Options, "seat">,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const named = options.seat ?? environment["SMITHERS_SEAT"]
  if (named !== undefined && named !== "") return named
  return Providers.starterSeats.find(([variable]) => (environment[variable] ?? "") !== "")?.[1]
}

/**
 * The host the engine driver runs turns on: the CLI's guarded platform over
 * the directory, its seat resolver over the environment, and the project's
 * flow registry.
 *
 * The seats run on the same replaceable model transport `smithers run` uses,
 * because a server is the host that most needs it. A provider can destroy the
 * HTTP/2 session under the connection pool, and waiting does not bring it back:
 * every attempt that reuses that pool fails identically, so the whole retry
 * ladder is spent on a socket that is not coming back and the turn ends
 * "stopped: the model call failed" with one frame and no spend. The server this
 * host serves is long-lived, so the pool it was left holding was the same one
 * every later turn reused: two servers lost three and two consecutive turns to
 * that on 2026-09-19 while a third on the same key and the same machine
 * answered normally, and only Ctrl-C fixed them.
 *
 * `NodeControl.layerRebuildableRequestExecutor` gives the executor a pool it
 * can throw away. Three consecutive transport failures are one `execute`, and
 * the next one is made on a pool the host built fresh, so the model step's own
 * ladder meets a working transport on its second rung and the turn that found
 * the dead session is the last one that suffers it.
 *
 * `dispatcher` is how that pool is built. The default reads the served
 * environment, so a proxy the operator exported is honoured here exactly as it
 * is for `smithers run`; a test passes a scripted dispatcher.
 *
 * @category constructors
 * @since 1.0.0
 */
export const nodeHost = (
  directory: string,
  environment: Readonly<Record<string, string | undefined>>,
  dispatcher: Effect.Effect<Undici.Dispatcher, never, Scope.Scope> = NodeControl.environmentDispatcher(environment)
): EngineDriver.Host => {
  const platform = NodeControl.layerGuardedPlatform(directory)
  return {
    platform: KernelChildProcessSpawner.layer.pipe(
      Layer.provide(NodeControl.layerGrantStore(directory)),
      Layer.provideMerge(platform)
    ),
    seats: NodeControl.layerSeatResolver(environment).pipe(
      Layer.provide(NodeControl.layerRebuildableRequestExecutor(dispatcher))
    ),
    registry: NodeControl.layerRegistry(directory)
  }
}

/**
 * Serves the directory until the process is interrupted. A SIGINT or
 * SIGTERM ends it cleanly: the shutdown line, no failure.
 *
 * @category constructors
 * @since 1.0.0
 */
export const host = async (
  options: Options,
  globals: Globals.Options,
  connection: Bridge.ConnectionOptions,
  config: Bridge.Runtime = {}
): Promise<void> => {
  if (connection.remote !== undefined) {
    throw new CliError.UnsupportedError({
      message: "opencode serves the directory on this host; --remote is not supported"
    })
  }
  const environment = config.environment ?? globals.environment ?? process.env
  const seat = options.scripted ? scriptedSeat : seatOf(options, environment)
  if (seat === undefined) {
    throw new CliError.UsageError({
      message:
        "No model seat: pass --seat provider:model, set SMITHERS_SEAT or a provider key such as CEREBRAS_API_KEY, or pass --scripted to replay the recorded turn."
    })
  }
  // The harness fails any run whose completion nothing judged, so a server
  // with no evaluator behind it answers a conversation and breaks on the
  // first real task. Refuse here instead, an hour earlier, with the way out.
  // A scripted replay runs no model and reaches no completion brake.
  if (!options.scripted) {
    const refusal = EngineDriver.evaluatorRefusal({ environment })
    if (refusal !== undefined) throw new CliError.UsageError({ message: refusal })
  }
  const requested = bind(options, environment)
  const refused = Serve.refusal(requested)
  if (refused !== undefined) throw new CliError.UnsupportedError({ message: refused })
  const directory = resolve(options.directory ?? process.cwd())
  // A shell call inherits the process working directory (composition brief,
  // trap 6); one server serves one directory, so it moves there once.
  process.chdir(directory)
  const driver: Layer.Layer<Driver.Driver | Store.Store, unknown> = options.scripted
    ? Layer.mergeAll(
      ScriptedDriver.layer({ script: DemoScript.script }),
      Store.layerSqlite(Serve.databasePath(directory))
    )
    : EngineDriver.layer({
      directory,
      seat,
      maxFrames: options.maxFrames,
      host: nodeHost(directory, environment),
      environment
    })
  // The words and the brake have to agree, and what the brake refuses is
  // narrower than what it reads. Jev reads every completion; a claim it finds
  // thin is handed back for a frame and then stands; a claim reporting a
  // command or a result the run never recorded ends the turn instead of
  // standing as its answer. See `CompletionClaim` and the runbook.
  const judge = options.scripted
    ? "No model runs; the recorded turn replays."
    : "Jev judges every completion; a claim reporting work the run never recorded ends the turn."
  const result = await Effect.runPromiseExit(
    Effect.gen(function*() {
      // The guard samples the directory before the driver creates
      // `.smithers/opencode.sqlite` under it, so a clean checkout is never
      // told it holds 0.x state.
      yield* Globals.guard(globals)
      // One directory is one server's, and the claim is taken before the
      // driver opens the store: a second server that got that far would have
      // re-driven the turn the first one has open. The banner is printed
      // after it, so a server refused the directory never says it is serving
      // it.
      yield* Ownership.claim({ directory, url: Serve.url(requested) })
      if (!connection.quiet) {
        yield* Effect.sync(() =>
          process.stderr.write(`${Serve.banner(requested, directory)} Seat: ${seat}. ${judge}\n`)
        )
      }
      return yield* Serve.host({
        directory,
        bind: requested,
        version: packageVersion,
        seat,
        maxFrames: options.maxFrames,
        pricing: Pricing.pricingOf(seat)
      }).pipe(Effect.provide(driver))
    }).pipe(
      Effect.scoped,
      Effect.provide(RedactedLogger.layer()),
      Effect.provideService(Logger.LogToStderr, true)
    ),
    { signal: config.signal }
  )
  if (Exit.isSuccess(result)) return
  // A signal aborts the runtime signal, which interrupts the server's
  // fiber: that is the operator stopping the server, not a failure. The
  // guard would otherwise report the interruption as `command_failed`
  // with "All fibers interrupted without error" on stderr.
  if (!Cause.hasInterruptsOnly(result.cause)) {
    const failure = Cause.squash(result.cause)
    // A directory another live server holds is the operator's mistake, not a
    // broken server: it exits the way the missing key does.
    if (failure instanceof Ownership.ClaimRefused) throw new CliError.UsageError({ message: failure.message })
    throw failure
  }
  if (!connection.quiet) process.stderr.write(`Stopped serving ${directory}.\n`)
}
