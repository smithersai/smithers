/**
 * `smithers opencode`: the OpenCode protocol server over the agent loop, for
 * the hosted OpenCode app.
 *
 * The verb serves one directory on one socket. The bind rule is `serve`'s:
 * loopback needs nothing, anything else needs `--listen` and a password in
 * `OPENCODE_SERVER_PASSWORD`. The server changes into the directory it
 * serves, because a shell call inherits the process working directory.
 *
 * Until the engine driver lands, `--scripted` is the only driver: it
 * replays a recorded turn so the hosted app can be driven end to end
 * without a model.
 *
 * @since 1.0.0
 */
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as Auth from "@smthrs/opencode/Auth"
import * as ScriptedDriver from "@smthrs/opencode/ScriptedDriver"
import * as DemoScript from "@smthrs/opencode/DemoScript"
import * as Serve from "@smthrs/opencode/Serve"
import { Cause, Effect, Exit, Logger } from "effect"
import { resolve } from "node:path"
import type * as Bridge from "../cli/ControlBridge.ts"
import * as CliError from "../CliError.ts"
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
  if (!options.scripted) {
    throw new CliError.UnsupportedError({
      message: "The engine driver is not available yet: pass --scripted to serve the recorded turn."
    })
  }
  const environment = config.environment ?? process.env
  const requested = bind(options, environment)
  const refused = Serve.refusal(requested)
  if (refused !== undefined) throw new CliError.UnsupportedError({ message: refused })
  const directory = resolve(options.directory ?? process.cwd())
  const seat = options.seat ?? scriptedSeat
  // A shell call inherits the process working directory (composition brief,
  // trap 6); one server serves one directory, so it moves there once.
  process.chdir(directory)
  if (!connection.quiet) process.stderr.write(`${Serve.banner(requested, directory)}\n`)
  const result = await Effect.runPromiseExit(
    Effect.gen(function*() {
      yield* Globals.guard(globals)
      return yield* Serve.host({ directory, bind: requested, version: packageVersion, seat })
    }).pipe(
      Effect.provide(ScriptedDriver.layer({ script: DemoScript.script })),
      Effect.provide(RedactedLogger.layer()),
      Effect.provideService(Logger.LogToStderr, true)
    ),
    { signal: config.signal }
  )
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
}
