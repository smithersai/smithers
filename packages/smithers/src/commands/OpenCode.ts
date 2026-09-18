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
 * @since 1.0.0
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Auth from "@smthrs/opencode/Auth"
import * as DemoScript from "@smthrs/opencode/DemoScript"
import type * as Driver from "@smthrs/opencode/Driver"
import * as EngineDriver from "@smthrs/opencode/EngineDriver"
import * as ScriptedDriver from "@smthrs/opencode/ScriptedDriver"
import * as Serve from "@smthrs/opencode/Serve"
import * as Store from "@smthrs/opencode/Store"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
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
 * @category constructors
 * @since 1.0.0
 */
export const nodeHost = (
  directory: string,
  environment: Readonly<Record<string, string | undefined>>
): EngineDriver.Host => {
  const platform = NodeControl.layerGuardedPlatform(directory)
  return {
    platform: KernelChildProcessSpawner.layer.pipe(
      Layer.provide(NodeControl.layerGrantStore(directory)),
      Layer.provideMerge(platform)
    ),
    seats: NodeControl.layerSeatResolver(environment).pipe(
      Layer.provide(RequestExecutor.layer.pipe(Layer.provide(NodeHttpClient.layerUndici)))
    ),
    registry: NodeControl.layerRegistry(directory)
  }
}

/**
 * Serves the directory until the process is interrupted.
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
      host: nodeHost(directory, environment)
    })
  if (!connection.quiet) process.stderr.write(`${Serve.banner(requested, directory)} Seat: ${seat}.\n`)
  const result = await Effect.runPromiseExit(
    Effect.gen(function*() {
      yield* Globals.guard(globals)
      return yield* Serve.host({
        directory,
        bind: requested,
        version: packageVersion,
        seat,
        maxFrames: options.maxFrames
      })
    }).pipe(
      Effect.provide(driver),
      Effect.provide(RedactedLogger.layer()),
      Effect.provideService(Logger.LogToStderr, true)
    ),
    { signal: config.signal }
  )
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
}
