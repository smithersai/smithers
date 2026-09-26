/**
 * `serve`: runs an organization host in the foreground on a
 * loopback port, with its durable state in the state directory.
 *
 * Startup order: read and check the settings; create the engine's execution
 * root (an empty jj repository in the state directory) on first start; reap
 * the microVMs a dead host process of this installation left behind, except
 * the workspace machines of runs the engine database says are unfinished,
 * which those runs reattach when they resume; build the host; serve the
 * gateway; and, when both Slack tokens are set, run the Slack intake beside
 * it. Runs a previous process parked (an approval gate, a model call cut
 * short) resume from the engine database; Ctrl-C stops the process and leaves
 * them parked.
 */
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Control } from "@smthrs/control"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Effect, Logger, References } from "effect"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import * as Workspace from "../../packages/smithers/agent/organization/src/Workspace.ts"
import * as SlackConfig from "../../packages/smithers/agent/integrations/src/slack/Config.ts"
import * as MicrosandboxSandbox from "../../packages/smithers/flows/sandbox/src/MicrosandboxSandbox/index.ts"
import { executionDatabasePath } from "../../packages/smithers/src/internal/ExecutionDatabasePath.ts"
import type * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import type { Control as ControlPort } from "./client.ts"
import { ControlRefused } from "./client.ts"
import { executionRoot, layer } from "./host.ts"
import type { Settings } from "./settings.ts"
import * as SetupMicrosandbox from "./setup/microsandbox.ts"
import * as Subscriptions from "./setup/subscriptions.ts"
import * as SlackIntake from "./slack.ts"

/** The host's own control plane as the {@link ControlPort} the Slack intake uses. */
export const inProcess = (control: Control.Control["Service"]): ControlPort => {
  const methods = {
    Plan: control.plan,
    Approve: control.approve,
    Run: control.run,
    List: control.list,
    Signal: control.signal
  } as const
  return {
    call: (tag, payload) => {
      const method = methods[tag] as (input: unknown) => Effect.Effect<unknown, { _tag: string; message: string }>
      return Effect.runPromise(
        method(payload).pipe(Effect.mapError((error) => new ControlRefused(error._tag, tag, error.message)))
      )
    }
  }
}

/**
 * The host's log: a failed run is one line, `<run> failed: <reason>`, since
 * its receipt and run status keep the whole cause; every other entry is
 * written as Effect's default logger writes it.
 */
export const hostLogger = (log: (line: string) => void) =>
  Logger.make((options) => {
    const first: unknown = Array.isArray(options.message) ? options.message[0] : options.message
    if (first !== "An agent run failed") return Logger.defaultLogger.log(options)
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
    const reason = String(annotations.cause ?? "").split("\n", 1)[0]!.replace(/^organization\/DeliveryFailed: /, "")
    log(`${String(annotations.runId ?? "a run")} failed: ${reason}`)
  })

/** Whether a holder label names a live process on this machine. */
export const holderAlive = (holder: string): boolean => {
  const [host, pid] = holder.split(":")
  if (host !== hostname() || pid === undefined || !/^\d+$/.test(pid)) return host !== hostname()
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The executions the engine database records as not finished (pending,
 * running, or suspended): what a restarted host resumes. Empty before the
 * first start.
 */
export const unfinished = (platform: NativeControl.Platform, stateDir: string): Promise<ReadonlySet<string>> => {
  const file = executionDatabasePath(stateDir)
  if (!existsSync(file)) return Promise.resolve(new Set())
  return Effect.runPromise(Effect.gen(function*() {
    const catalog = yield* RunCatalogRead.make()
    const ids = new Set<string>()
    for (const status of ["pending", "running", "suspended"] as const) {
      let cursor: string | undefined
      do {
        const page = yield* catalog.listRuns({ filters: { status }, ...(cursor === undefined ? {} : { cursor }) })
        for (const run of page.runs) ids.add(run.runId)
        cursor = page.cursor ?? undefined
      } while (cursor !== undefined)
    }
    return ids
  }).pipe(Effect.scoped, Effect.provide(platform.database(file))))
}

/** Options for {@link start}. */
export interface StartOptions {
  readonly settings: Settings
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly platform: NativeControl.Platform
  /** An offline composition's seats; the environment's otherwise. */
  readonly seats?: SeatResolver.Service | undefined
  /** A fixture's plaintext Slack socket. */
  readonly allowPlaintextSocket?: boolean | undefined
  readonly log?: ((line: string) => void) | undefined
}

/** Starts a host and serves until interrupted. */
export const start = async (options: StartOptions) => {
  const { settings, environment } = options
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  // Subscription mode: no API key in this process can take precedence over
  // the owner's logins, whichever component reads the process environment.
  if (Subscriptions.modeOf(environment) === "subscription") {
    for (const name of Subscriptions.apiKeyVariables) delete process.env[name]
  }
  const execution = executionRoot(settings)
  if (!existsSync(join(execution, ".jj"))) {
    mkdirSync(execution, { recursive: true, mode: 0o700 })
    const created = spawnSync("jj", ["git", "init", "--quiet", execution], { encoding: "utf8" })
    if (created.status !== 0) {
      throw new Error(`the execution root ${execution} could not be created with \`jj git init\`: ${
        created.error?.message ?? created.stderr.trim()
      }`)
    }
  }
  const install = SetupMicrosandbox.locate()
  if (install === undefined) throw new Error("the microsandbox SDK is not installed; run pnpm install")
  const sdk = await SetupMicrosandbox.sdkOf(install)
  sdk.setDefaultBackend("local")
  const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  // A workspace machine whose run resumes keeps the work the run recorded
  // against it; the resumed run reattaches it, and relabels it as this
  // process's.
  const resuming = await unfinished(options.platform, settings.stateDir)
  const reaped = await Effect.runPromise(MicrosandboxSandbox.reap({
    sdk,
    owner: settings.installation,
    isAlive: (label) => Effect.succeed(holderAlive(label)),
    retain: (labels) => {
      const key = labels[Workspace.workspaceLabel]
      return Effect.succeed(key !== undefined && resuming.has(Actions.executionOfWorkspace(key)))
    }
  }))
  if (reaped.length > 0) log(`reaped ${reaped.length} machine(s) a stopped host left behind`)
  const slack = (environment.SMITHERS_SLACK_BOT_TOKEN ?? "") !== "" && (environment.SMITHERS_SLACK_APP_TOKEN ?? "") !== ""
  // Refuses a policy that admits nobody before anything opens.
  const policy = slack ? SlackConfig.policy(environment) : undefined
  const bind: Serve.Bind = { host: settings.host, port: settings.port, listen: false, credential: undefined }
  const refusal = Serve.refuse(bind)
  if (refusal !== undefined) throw refusal
  const program = Effect.gen(function*() {
    if (policy !== undefined) {
      const control = yield* Control.Control
      yield* Effect.forkScoped(SlackIntake.run({
        control: inProcess(control),
        policy,
        stateDir: settings.stateDir,
        environment,
        allowPlaintextSocket: options.allowPlaintextSocket
      }).pipe(Effect.catchCause((cause) => Effect.logError("organization Slack intake stopped", cause))))
    }
    log(`organization host on http://${settings.host}:${settings.port} (state ${settings.stateDir}; Slack ${slack ? "on" : "off"})`)
    return yield* Serve.host(bind, settings.root)
  }).pipe(
    Effect.scoped,
    Effect.provide(layer(options.platform, { settings, sdk, holder, slack, environment }, options.seats)),
    Effect.provide(Logger.layer([hostLogger(log), Logger.tracerLogger]))
  )
  return program
}
