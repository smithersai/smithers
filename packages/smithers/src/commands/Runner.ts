/**
 * `smthrs runner`: run a host's external agent jobs on this machine.
 *
 * `token` makes the runner's token and prints only its SHA-256, for an admin
 * to register the runner. `serve` claims jobs from the host its
 * `runner.json` names and does each one as a durable `runner/Job` on the
 * runner's own journal (`<state>/engine.db`). With no `origin`, the runner is
 * its own host: `serve` also hosts its lanes as control runs under the lanes
 * root, over the runner's own job store (`LocalJobs`), and `start` queues a
 * lane for it. See `src/runner/` for the pieces and
 * `docs/reference/cli/runner.md` for the file.
 *
 * @since 1.0.0
 */

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import { Control } from "@smthrs/control"
import { NodeRuntime } from "@smthrs/platform-node"
import { Cause, Context, Deferred, Effect, FileSystem, Layer, Logger, Option, Schema, Stream } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import { Cli, z } from "incur"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import type * as Bridge from "../cli/ControlBridge.ts"
import * as Presentation from "../cli/Presentation.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Config from "../runner/Config.ts"
import * as Host from "../runner/Host.ts"
import * as Job from "../runner/Job.ts"
import * as Lane from "../runner/Lane.ts"
import * as LaneIntake from "../runner/LaneIntake.ts"
import * as LocalJobs from "../runner/LocalJobs.ts"
import type * as Machine from "../runner/Machine.ts"
import * as Serve from "../runner/Serve.ts"
import type * as Session from "../runner/Session.ts"
import * as StatusPage from "../runner/StatusPage.ts"
import * as Workstreams from "../runner/Workstreams.ts"
import * as RunnerJobs from "../RunnerJobs.ts"

/**
 * Serves the runner the configuration at `path` describes, until the process
 * is stopped. `read` replaces how it reads its machine (a test's readings).
 *
 * @category constructors
 * @since 1.0.0
 */
export const serve = (path: string, options: { readonly read?: () => Machine.Reading } = {}) =>
  Effect.gen(function*() {
    const config = yield* Config.load(path)
    if (config.origin === undefined) return yield* serveLocal(config, options.read)
    const token = yield* Config.readToken(config.stateDir)
    const controls = new Map<string, Session.Control>()
    const host = Host.layer({ origin: config.origin, token }).pipe(Layer.provide(FetchHttpClient.layer))
    const engine = jobEngine(config, controls, host)
    yield* Effect.logInfo("runner.serve").pipe(
      Effect.annotateLogs({
        runner: config.name,
        capacity: config.capacity,
        profiles: Object.keys(config.profiles).length
      })
    )
    return yield* Serve.loop(config, controls, options.read).pipe(Effect.provide(Layer.merge(engine, host)))
  })

/** `runner/Job`'s engine: the runner's own journal, `<state>/engine.db`, registering `runner/Job` over `host`. */
const jobEngine = <E>(
  config: Config.Checked,
  controls: Map<string, Session.Control>,
  host: Layer.Layer<Host.Host, E>
) =>
  NodeRuntime.layerHost(
    {
      filename: join(config.stateDir, "engine.db"),
      workspaceRoot: config.stateDir,
      owner: { hostId: `runner-${config.name}` },
      shutdownTimeoutMs: 10_000
    },
    Job.registration(config, controls).pipe(Layer.provide(host))
  )

/**
 * The runner as its own host: its job store (`LocalJobs`) is both the claim
 * loop's host and the lanes' job store; a run-capable control host under the
 * lanes root runs each lane, and admits the requests `runner start` queued.
 */
const serveLocal = (config: Config.Checked, read: (() => Machine.Reading) | undefined) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    // The control host the lanes run on, once it is built: a job's run that ends cancelled or failed stops the job.
    const lanes = yield* Deferred.make<Control.Service>()
    const store = yield* LocalJobs.make(config.stateDir, {
      runEnded: (runId) =>
        Deferred.await(lanes).pipe(
          Effect.flatMap((control) =>
            control.watch({ runId, follow: true }).pipe(
              Stream.filter((event) =>
                event.kind === "control.run.cancelled" || event.kind === "control.run.failed" ||
                event.kind === "control.run.completed"
              ),
              Stream.runHead
            )
          ),
          // A run that completed has nothing left to stop; one whose events can't be read is left to its own end.
          Effect.flatMap((ended) =>
            Option.isSome(ended) && ended.value.kind !== "control.run.completed" ? Effect.void : Effect.never
          ),
          Effect.catch(() =>
            Effect.logWarning("runner.lane").pipe(
              Effect.annotateLogs({ run: runId, outcome: "unwatched" }),
              Effect.andThen(Effect.never)
            )
          )
        )
    })
    const services = Layer.merge(
      Layer.succeed(AgentRunner.AgentJobs, store.jobs),
      Layer.succeed(Host.Host, store.host)
    )
    // The lane module's descriptor, which discovery reads under the lanes root; rewritten only when it differs, so a
    // run's pinned source stays the bytes it was approved with.
    const descriptor = join(config.lanesRoot, ".smithers", "flows", Lane.MODULE, "flow.ts")
    const written = (yield* fs.exists(descriptor)) ? yield* fs.readFileString(descriptor) : undefined
    if (written !== Lane.DESCRIPTOR_SOURCE) {
      yield* fs.makeDirectory(dirname(descriptor), { recursive: true })
      yield* fs.writeFileString(descriptor, Lane.DESCRIPTOR_SOURCE)
    }
    const control = yield* Layer.build(
      NodeControl.layer(
        { root: config.lanesRoot, startsRuns: true },
        Lane.registration(config).pipe(Layer.provide(services))
      )
    )
    yield* Deferred.succeed(lanes, Context.get(control, Control.Control))
    // The requests `runner start` queued, admitted as lanes every poll, after a restart too, and the job requests flow
    // hosts in other processes wrote (`RunnerJobs`). A pass that fails anyhow is logged and the next one goes on.
    yield* LaneIntake.admitAll(config.stateDir).pipe(
      Effect.andThen(RunnerJobs.admitAll(config.stateDir, store.jobs)),
      Effect.provideContext(control),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("runner.lane").pipe(Effect.annotateLogs({ outcome: "intake_failed" }))
      ),
      Effect.andThen(Effect.sleep(`${config.pollSeconds} seconds`)),
      Effect.forever,
      Effect.forkScoped
    )
    const controls = new Map<string, Session.Control>()
    yield* Effect.logInfo("runner.serve").pipe(
      Effect.annotateLogs({
        runner: config.name,
        capacity: config.capacity,
        profiles: Object.keys(config.profiles).length,
        host: "local"
      })
    )
    return yield* Serve.loop(config, controls, read).pipe(
      Effect.provide(Layer.merge(jobEngine(config, controls, services), services))
    )
  })).pipe(Effect.provide(NodeServices.layer))

/**
 * What `runner start` asks for.
 *
 * @category models
 * @since 1.0.0
 */
export interface StartOptions {
  readonly brief: string
  readonly config: string
  readonly profile: string
  readonly repository: string
  readonly base?: string | undefined
  readonly standing: boolean
  readonly maxHours: number
  readonly restarts: number
  readonly workstream?: string | undefined
  readonly task?: string | undefined
  readonly title?: string | undefined
}

/**
 * The most a lane round's change may hold: what its result carries back.
 *
 * @category constants
 * @since 1.0.0
 */
export const LANE_LIMITS: AgentRunner.Limits = { files: 1000, bytes: 16 * 1024 * 1024 }

/**
 * Queues a lane for the runner the configuration at `options.config` names,
 * which must be its own host (no `origin`): checks the profile, the
 * repository and the brief, resolves the base (the mirror's `main` unless
 * set) and the workstream task, when named, and writes the request for the
 * runner's daemon, up or not. Answers the request's id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const start = (options: StartOptions) =>
  Effect.gen(function*() {
    const config = yield* Config.load(options.config)
    if (config.origin !== undefined) {
      return yield* new Config.RunnerConfigError({ message: "runner start needs a runner.json with no origin" })
    }
    if (config.profiles[options.profile] === undefined) {
      return yield* new Config.RunnerConfigError({ message: `no profile ${options.profile} in runner.json` })
    }
    const repository = config.repositories[options.repository]
    if (repository === undefined) {
      return yield* new Config.RunnerConfigError({ message: `no repository ${options.repository} in runner.json` })
    }
    const task = yield* laneTask(config, options)
    const fs = yield* FileSystem.FileSystem
    const brief = yield* fs.readFileString(options.brief).pipe(
      Effect.mapError(() => new Config.RunnerConfigError({ message: "the brief file can't be read" }))
    )
    if (brief.trim() === "") return yield* new Config.RunnerConfigError({ message: "the brief file is empty" })
    const follow = options.base ?? "main"
    const base = yield* Lane.resolveBase(repository.mirror, follow)
    const input = yield* Effect.try({
      try: () =>
        Lane.decodeInput({
          brief,
          profile: options.profile,
          repository: options.repository,
          base,
          limits: LANE_LIMITS,
          maxHours: options.maxHours,
          restarts: options.restarts,
          standing: options.standing,
          // A standing lane's next rounds start from the same revision, resolved again.
          ...(options.standing ? { follow } : {}),
          ...(task === undefined ? {} : { task })
        }),
      catch: () =>
        new Config.RunnerConfigError({
          message: `--max-hours is 1 to ${AgentRunner.MAX_HOURS} and --restarts 0 to ${AgentRunner.MAX_RESTARTS}`
        })
    })
    const request = yield* LaneIntake.submit(config.stateDir, input).pipe(
      Effect.mapError(() => new Config.RunnerConfigError({ message: "the lane request can't be written" }))
    )
    return { request, base, standing: options.standing }
  }).pipe(Effect.provide(NodeServices.layer))

/** The workstream task `options` names: none, or one of a workstream `config` declares. */
const laneTask = (config: Config.Checked, options: StartOptions) =>
  Effect.gen(function*() {
    if (options.workstream === undefined && options.task === undefined) {
      return options.title === undefined
        ? undefined
        : yield* new Config.RunnerConfigError({ message: "--title needs --workstream and --task" })
    }
    if (options.workstream === undefined || options.task === undefined) {
      return yield* new Config.RunnerConfigError({ message: "--workstream and --task go together" })
    }
    if (config.workstreams?.[options.workstream] === undefined) {
      return yield* new Config.RunnerConfigError({ message: `no workstream ${options.workstream} in runner.json` })
    }
    return yield* Schema.decodeUnknownEffect(Lane.Task)({
      workstream: options.workstream,
      id: options.task,
      ...(options.title === undefined ? {} : { title: options.title })
    }).pipe(
      Effect.mapError(() =>
        new Config.RunnerConfigError({
          message: "--task is lowercase letters, digits and -, and --title is not empty"
        })
      )
    )
  })

/**
 * The workstreams of the runner the configuration at `path` names, which
 * must be its own host: each one's tasks, the lanes on them and its
 * progress, read from the lanes' runs on the lanes root.
 *
 * @category constructors
 * @since 1.0.0
 */
export const status = (path: string) =>
  Effect.gen(function*() {
    const config = yield* Config.load(path)
    if (config.origin !== undefined) {
      return yield* new Config.RunnerConfigError({ message: "runner status needs a runner.json with no origin" })
    }
    return yield* Workstreams.read(config, NodeControl.layer({ root: config.lanesRoot, startsRuns: false }))
  }).pipe(Effect.provide(NodeServices.layer))

/**
 * `runner status --port`: the status page and `workstreams.json` on
 * `127.0.0.1:<port>` (0 picks one), each request read again from the
 * runner the configuration at `path` names. Loopback only: the page has no
 * login, so reach it from another machine through a tunnel.
 *
 * @category layers
 * @since 1.0.0
 */
export const statusServer = (path: string, port: number) =>
  HttpRouter.serve(StatusPage.routes(status(path)), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }))
  )

/**
 * Serves {@link statusServer} until the process is stopped, and logs the
 * page's URL once it is bound.
 *
 * @category constructors
 * @since 1.0.0
 */
export const serveStatus = (path: string, port: number) =>
  Effect.gen(function*() {
    const { address } = yield* HttpServer.HttpServer
    yield* Effect.logInfo("runner.status").pipe(
      Effect.annotateLogs({ outcome: "serving", url: HttpServer.formatAddress(address) })
    )
    return yield* Effect.never
  }).pipe(
    Effect.provide(statusServer(path, port)),
    // The control plane's own logs go to stderr too.
    Effect.provideService(Logger.LogToStderr, true)
  )

/**
 * The text `runner status` prints for people: one block per workstream, one
 * line per task with the lanes on it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const renderStatus = (workstreams: ReadonlyArray<Workstreams.Workstream>): string =>
  workstreams.length === 0
    ? "No workstreams. Declare them under workstreams in runner.json."
    : workstreams.map((workstream) =>
      [
        `${workstream.title} (${workstream.id})  ${workstream.status}  ${workstream.progress.done}/${workstream.progress.total} tasks`,
        ...(workstream.goal === undefined ? [] : [`  goal: ${workstream.goal}`]),
        ...workstream.tasks.map((task) =>
          `  ${task.status.padEnd(7)} ${task.title} (${task.id})  ${
            task.owners.length === 0
              ? "no lane"
              : task.owners.map((owner) =>
                [owner.runId ?? owner.request, owner.profile, owner.status].filter((part) => part !== undefined).join(
                  " "
                )
              ).join(", ")
          }`
        )
      ].join("\n")
    ).join("\n\n")

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
    .command("start", {
      description: "Queue a lane for this runner's own host (a runner.json with no origin)",
      mcp: false,
      args: z.object({ brief: z.string().describe("The file whose text the lane's agent is prompted with") }),
      options: z.object({
        config: z.string().describe("Path to runner.json"),
        profile: z.string().describe("The runner.json profile that runs the agent"),
        repository: z.string().describe("The runner.json repository the lane works in"),
        base: z.string().optional().describe("The revision its checkout starts from (default: the mirror's main)"),
        standing: z.boolean().default(false).describe("Start a new round after each one, until cancelled"),
        maxHours: z.number().int().default(4).describe("Hours each round's agent may work"),
        restarts: z.number().int().default(1).describe("Replacement generations after a retryable end"),
        workstream: z.string().optional().describe("The runner.json workstream the lane works toward"),
        task: z.string().optional().describe("The workstream task the lane works on"),
        title: z.string().optional().describe("The task's title, for a task the workstream's plan doesn't list")
      }),
      run: (context) =>
        Presentation.guard(
          context,
          () => Effect.runPromise(start({ brief: context.args.brief, ...context.options })),
          { render: (queued) => ({ human: queued.request }) }
        )
    })
    .command("status", {
      description: "Show each workstream's tasks, the lanes on them and its progress, read from the lanes' runs",
      mcp: false,
      options: z.object({
        config: z.string().describe("Path to runner.json"),
        port: z.number().int().min(0).max(65_535).optional().describe(
          "Serve the status page on 127.0.0.1 at this port, read again on every request, until stopped"
        )
      }),
      run: (context) =>
        Presentation.guard(
          context,
          () =>
            context.options.port !== undefined
              ? Effect.runPromise(serveStatus(context.options.config, context.options.port))
              : Effect.runPromise(
                status(context.options.config).pipe(
                  Effect.map((workstreams) => ({ workstreams })),
                  // The control plane's own logs go to stderr: stdout is the document.
                  Effect.provideService(Logger.LogToStderr, true)
                )
              ),
          { render: (read) => ({ human: renderStatus(read.workstreams) }) }
        )
    })
