/**
 * `smthrs runner`: run a host's external agent jobs on this machine.
 *
 * `token` makes the runner's token and prints only its SHA-256, for an admin
 * to register the runner. `serve` claims jobs from the host its
 * `runner.json` names and does each one as a durable `runner/Job` on the
 * runner's own journal (`<state>/engine.db`). See `src/runner/` for the
 * pieces and `docs/reference/cli/runner.md` for the file.
 *
 * @since 1.0.0
 */

import { NodeRuntime } from "@smthrs/platform-node"
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { Cli, z } from "incur"
import { join } from "node:path"
import type * as Bridge from "../cli/ControlBridge.ts"
import * as Presentation from "../cli/Presentation.ts"
import * as Config from "../runner/Config.ts"
import * as Host from "../runner/Host.ts"
import * as Job from "../runner/Job.ts"
import * as Serve from "../runner/Serve.ts"
import type * as Session from "../runner/Session.ts"

/**
 * Serves the runner the configuration at `path` describes, until the process
 * is stopped.
 *
 * @category constructors
 * @since 1.0.0
 */
export const serve = (path: string) =>
  Effect.gen(function*() {
    const config = yield* Config.load(path)
    const token = yield* Config.readToken(config.stateDir)
    const controls = new Map<string, Session.Control>()
    const host = Host.layer({ origin: config.origin, token }).pipe(Layer.provide(FetchHttpClient.layer))
    const engine = NodeRuntime.layerHost(
      {
        filename: join(config.stateDir, "engine.db"),
        workspaceRoot: config.stateDir,
        owner: { hostId: `runner-${config.name}` },
        shutdownTimeoutMs: 10_000
      },
      Job.registration(config, controls).pipe(Layer.provide(host))
    )
    yield* Effect.logInfo("runner.serve").pipe(
      Effect.annotateLogs({
        runner: config.name,
        capacity: config.capacity,
        profiles: Object.keys(config.profiles).length
      })
    )
    return yield* Serve.loop(config, controls).pipe(Effect.provide(Layer.merge(engine, host)))
  })

/**
 * Builds the `runner` command group.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createRunnerCli = (_config: Bridge.Runtime = {}) =>
  Cli.create("runner", { description: "Run a host's external agent jobs on this machine" })
    .command("token", {
      description: "Make this runner's token and print its SHA-256 for an admin to register",
      mcp: false,
      options: z.object({
        state: z.string().optional().describe("The runner's state directory (default ~/.smithers/runner)"),
        rotate: z.boolean().default(false).describe("Replace an existing token")
      }),
      run: (context) =>
        Presentation.guard(
          context,
          () =>
            Effect.runPromise(
              Config.makeToken(context.options.state ?? Config.defaultStateDir(), { rotate: context.options.rotate })
                .pipe(
                  Effect.map(({ sha256 }) => ({ sha256 }))
                )
            ),
          { render: (made) => ({ human: made.sha256 }) }
        )
    })
    .command("serve", {
      description: "Claim and run jobs from the host runner.json names, until stopped",
      mcp: false,
      options: z.object({
        config: z.string().describe("Path to runner.json")
      }),
      run: (context) => Presentation.guard(context, () => Effect.runPromise(serve(context.options.config)))
    })
