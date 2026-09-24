/**
 * The agent host: one in-process Smithers cell harness bound to a directory.
 *
 * A turn is one `Agent.run` executed as one durable flow on an in-memory
 * engine. Every `AgentEvent` the run emits reaches `onEvent` as it happens,
 * so the UI renders cells while the model is still writing them.
 *
 * The agent has no tools. It writes JavaScript cells that call flows through
 * `ctx.call`; the standard filesystem and shell flows are the catalog here.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import * as Capability from "@smthrs/capability/Capability"
import type * as Permission from "@smthrs/capability/Permission"
import * as NodeControl from "@smthrs/cli/NodeControl"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Steering from "@smthrs/harness/Steering"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Classifier from "@smthrs/model/Classifier"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { delegateModels } from "./models.ts"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import * as NativeSearch from "@smthrs/std/NativeSearch"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Schema, Scope, Stream } from "effect"
import * as ServiceContext from "effect/Context"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Approvals from "./approvals.ts"
import * as Changes from "./changes.ts"
import * as Context from "./context.ts"
import * as Monitors from "./monitors.ts"
import * as Panels from "./panels.ts"
import * as Replay from "./replay.ts"
import * as Runtime from "./runtime.ts"
import * as Subprocess from "./subprocess.ts"
import * as Transcript from "./transcript.ts"

/** How a turn ended. */
export type Outcome =
  | { readonly _tag: "done"; readonly answer: string }
  | { readonly _tag: "failed"; readonly message: string; readonly detail: string }
  | { readonly _tag: "cancelled" }

export interface TurnInput {
  readonly prompt: string
  readonly role?: "coordinator" | "worker"
  readonly runtime?: Runtime.Ports
  readonly workerSeat?: string
  readonly background?: string
  readonly onCaption?: (prose: string) => void
  readonly onPatch?: (receipt: Changes.Receipt) => void
  readonly seat: string
  /** Who waits on an approval: `chat` (the default) or a worker tab id. */
  readonly source?: string
  readonly history: ReadonlyArray<Context.Entry>
  /** Where messages typed mid-turn wait for the next cell boundary. */
  readonly steering?: Steering.Source
  /** Reasoning effort; the provider's default when absent. */
  readonly thinking?: ModelRequest.ReasoningEffort
  readonly onEvent: (event: AgentEvent.AgentEvent) => void
}

export interface Turn {
  readonly done: Promise<Outcome>
  readonly cancel: () => void
}

export interface Host {
  readonly cwd: string
  readonly compaction: (used: number, window: number) => Promise<number | undefined>
  /** A one-line tab description, asked of `seat`: the seat the task already goes to. */
  readonly describe?: (input: { title: string; prompt: string; seat: string }) => Promise<string>
  /** Jev judges a monitor's change; Luna writes its update. Absent on test fakes. */
  readonly monitor?: {
    readonly judge: (input: Monitors.Judged) => Promise<boolean>
    readonly compose: (input: Monitors.Judged) => Promise<string>
  }
  /** One short answer from `seat`, outside any turn; estimates, descriptions and monitor updates use it. */
  readonly complete?: (input: { system: string; prompt: string; seat: string }) => Promise<string>
  /** Whether Jev judges completions; false when `AI_GATEWAY_API_KEY` is unset. */
  readonly judged: boolean
  readonly run: (input: TurnInput) => Turn
  /** Absent on hosts that approve nothing, such as test fakes. */
  readonly approvals?: {
    readonly mode: Approvals.Mode
    readonly authorize: (requests: ReadonlyArray<Approvals.Request>, signal?: AbortSignal) => Promise<void>
    readonly pending: () => Promise<ReadonlyArray<Approvals.Pending>>
    /** Resolves with the store's error code when it refused the answer. */
    readonly reply: (
      request: Approvals.Pending,
      choice: Approvals.Choice
    ) => Promise<Permission.GrantStoreError["code"] | undefined>
  }
  readonly dispose: () => Promise<void>
}

/**
 * Bun's fetch is the transport. It honours `HTTPS_PROXY`/`NO_PROXY` itself;
 * the Undici client `smithers run` uses cannot run under Bun, which the
 * renderer requires.
 */
const executor = RequestExecutor.layer.pipe(
  Layer.provide(KernelHttpClient.layer),
  Layer.provide(GrantStore.layerNoop),
  Layer.provide(FetchHttpClient.layer)
)

const registry = Registry.makeNoop()

/**
 * Edits are compensable actions, and the engine admits them only under a
 * snapshot boundary. This one records the boundary and restores nothing,
 * like `smithers suggest`: the working tree's own VCS is the undo here.
 */
const snapshots = Layer.succeed(FlowEngine.SnapshotBoundary)({
  snapshot: (options) => Effect.succeed({ boundary: "smithers-tui", key: options.key }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(undefined)
})

const turnFlow = (index: number) =>
  Flow.make(`tui/turn-${index}`, {
    payload: {},
    success: Schema.Unknown,
    error: Schema.Unknown,
    // Inert: the registered handler below is the whole turn.
    body: () => Node.succeed(undefined)
  })

/** Builds a host for `cwd`. The runtime is shared by every turn. */
export const make = (options: {
  readonly cwd: string
  /** The credentials environment; see `models.ts` `detect`. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** How consequential flow calls are approved; see `approvals.ts`. Default `ask`. */
  readonly approvals?: Approvals.Mode
}): Host => {
  const approvalMode = options.approvals ?? "ask"
  const env = options.environment
  const judged = (env[Evaluator.environmentKey] ?? "").trim() !== ""
  const judge = judged
    ? Evaluator.layerFromEnvironment(env, "smithers-tui").pipe(Layer.provide(FetchHttpClient.layer))
    : Evaluator.layerUnavailable()
  const layer = Layer.mergeAll(
    Agent.layer.pipe(Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded()))),
    Agent.layerDefaults,
    NodeControl.layerSeatResolver(env).pipe(Layer.provide(executor)),
    judge,
    QuotaPolicy.layerDefault(),
    Budget.layerUnbounded(),
    FlowEngine.layerMemory,
    snapshots,
    // Measures the tree at both ends of every worker frame. Without it a sealed read
    // is keyed on no workspace digest and replays its first answer after an
    // edit: write "one", read, write "two", read returned "one" twice.
    NodeControl.layerObserver(options.cwd),
    // Model HTTP keeps the noop store `executor` provides; this one only
    // answers `authorize` below.
    Approvals.layer(options.cwd, approvalMode),
    NodeCrypto.layer,
    NodeServices.layer
  )
  const runtime = ManagedRuntime.make(layer)
  let turns = 0

  const compaction: Host["compaction"] = async (used, window) => {
    if (!judged || used <= 0 || window <= 0) return undefined
    const questions = {
      amount: Classifier.choice({
        instructions: "How much of the used context should be compacted? Choose 0 if no compaction is needed. Consider the current occupancy and leave enough context for the next turn.",
        criteria: { "0": "none", "25": "a quarter", "50": "half", "75": "three quarters" }
      })
    }
    try {
      const response = await runtime.runPromise(Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        return yield* evaluator.evaluate({ state: { used, window }, questions })
      }))
      const answers = await Effect.runPromise(Classifier.decodeAnswers(questions, response.answers))
      return Math.round(used * Number(answers.amount.value) / 100)
    } catch {
      return undefined
    }
  }

  const complete: NonNullable<Host["complete"]> = ({ system, prompt, seat: id }) => runtime.runPromise(
    Effect.gen(function*() {
      const seat = yield* (yield* SeatResolver.SeatResolver).resolve(id)
      const events = Array.from(yield* Stream.runCollect(seat.model.stream(ModelRequest.ModelRequest.make({
        // The seat's own model id: the full `provider:model` seat is refused as a model name.
        modelId: seat.modelId,
        system: [ModelRequest.SystemPart.make({ text: system })],
        messages: [ModelRequest.Message.user([ModelRequest.TextPart.make({ text: prompt })])],
        tools: [],
        toolChoice: "none",
        // No token budget: the ChatGPT-subscription route refuses `maxTokens`
        // (`OpenAIResponses.chatgptFromRequest`) and no seat says which routes
        // honor one. The system prompt bounds the answer instead.
        params: ModelRequest.GenerationParams.make({})
      }))))
      if (ModelEvent.ModelEvent.settledMessage(events).message.stopReason !== "stop") throw new Error("Answer incomplete")
      return events.flatMap((event) => event.type === "text-delta" ? [event.text] : []).join("")
    })
  )

  const monitor: NonNullable<Host["monitor"]> = {
    judge: Monitors.jev((request) =>
      runtime.runPromise(Effect.gen(function*() {
        return yield* (yield* Evaluator.Evaluator).evaluate(request)
      }))
    ),
    compose: (input) => complete({ system: Monitors.composeSystem, prompt: Monitors.composeText(input), seat: delegateModels.luna })
  }

  const describeTab: NonNullable<Host["describe"]> = ({ title, prompt, seat }) =>
    complete({
      system: "Summarize this background agent task in one short line (at most 80 characters). Reply with only the description.",
      prompt: `Title: ${title}\nTask: ${prompt}`,
      seat
    })

  const run = (input: TurnInput): Turn => {
    const index = ++turns
    const program = Effect.gen(function*() {
      const seat = input.seat.startsWith("replay:")
        ? Replay.seat({
          file: input.seat.slice("replay:".length),
          holdMs: Number(env.SMITHERS_TUI_REPLAY_HOLD_MS ?? 0),
          speed: Number(env.SMITHERS_TUI_REPLAY_SPEED ?? 1)
        })
        : yield* (yield* SeatResolver.SeatResolver).resolve(input.seat)
      const agent = yield* Agent.Agent
      const engine = yield* FlowRuntime.FlowRuntime
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner>()
      const grants = yield* GrantStore.GrantStore
      const flow = turnFlow(index)
      const settled = Deferred.makeUnsafe<string, unknown>()
      let answer = ""
      let reply = ""
      const maxFrames = input.role === "coordinator" ? 8 : 40
      // Only the coordinator: its completion demands are all disarmed, so a
      // budget ending never carries a bounced answer this would drop.
      const receipts = input.role === "coordinator" ? Runtime.ledger(maxFrames) : (event: AgentEvent.AgentEvent) => event
      const body = agent.run({
        session: `tui-${process.pid}-${index}`,
        seat,
        prompt: input.prompt,
        system: [
          ...Context.system(options.cwd, input.history),
          ...(input.runtime === undefined ? [] : [Panels.teaching]),
          ...(input.role === "coordinator"
            ? [
              Runtime.coordinatorTeaching + (input.workerSeat ?? input.seat),
              `Background tabs: ${input.background ?? "[]"}`
            ]
            : [
              "Start each cell with a short purpose sentence. Split independent work with agent.delegate, then use agent.wait({ids}) and aggregate the child answers. Children can delegate to depth 3; depth 4 is refused. End with one sentence and essential evidence. Never claim unobserved tests passed."
            ])
        ],
        ...((input.thinking ??
            (input.role === "coordinator" && input.seat.startsWith("cerebras:") ? "low" : undefined)) === undefined
          ? {}
          : { modelParams: ModelRequest.GenerationParams.make({ reasoningEffort: input.thinking ?? "low" }) }),
        registry,
        plugins: Runtime.plugins(input.runtime),
        // `rg` searches this repository in seconds; the in-process walk took
        // longer than grep's 120 s ceiling. It stays the fallback without rg.
        flows: [
          ...(input.role === "coordinator" ? [] : [
            Changes.capture(
              StandardFlows.filesystem(services, Subprocess.which("rg") === null ? undefined : NativeSearch.make(services)),
              options.cwd,
              input.onPatch ?? (() => {})
            ),
            Changes.capture(StandardFlows.shell(services), options.cwd, input.onPatch ?? (() => {}))
          ]),
          ...(input.runtime === undefined ? [] : [Runtime.source(input.runtime)])
        ],
        capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
        ...(approvalMode === "all"
          ? {}
          : { authorize: Approvals.authorize(grants, { cwd: options.cwd, source: input.source ?? "chat" }) }),
        // The same explicit cell budget `smithers run` uses; never unlimited.
        limits: { memoryBytes: 256 * 1024 * 1024, steps: 50_000_000 },
        // A person reads every answer here, so without a gateway key the one
        // brake that needs Jev is disarmed instead of failing every turn.
        ...(input.role === "coordinator"
          ? { unmovedCap: 0, narrowingCap: 0, unresolvedCap: 0, claimCap: 0 }
          : judged
          ? {}
          : { claimCap: 0 }),
        maxFrames
      }).pipe(
        Stream.provideService(Steering.Source, input.steering ?? Steering.makeNoop()),
        Stream.runForEach((journaled) =>
          Effect.sync(() => {
            const event = receipts(journaled)
            if (event._tag === "resolved") answer = text(event.message.content)
            if (event._tag === "model-requested") reply = ""
            if (event._tag === "model-delta" && event.delta.type === "text-delta") reply += event.delta.text
            input.onEvent(event)
            if (event._tag === "cell-produced") input.onCaption?.(Transcript.split(reply).prose)
          })
        ),
        // The coordinator has no filesystem or shell flow, so nothing it runs
        // moves the tree. Measuring anyway walked the checkout twice a turn:
        // a one-line `ctx.done()` answer showed 8 s late in this repository.
        (effect) => (input.role === "coordinator" ? unobserved(effect) : effect)
      )
      const scope = yield* Effect.scope
      yield* engine.register(flow, () =>
        Effect.onExit(body, (exit) =>
          Exit.isSuccess(exit)
            ? Deferred.succeed(settled, answer)
            : Deferred.failCause(settled, exit.cause))).pipe(Scope.provide(scope))
      yield* engine.execute(flow, { executionId: `tui-${index}`, payload: {}, discard: true })
      return yield* Deferred.await(settled)
    }).pipe(Effect.scoped)

    const fiber = runtime.runFork(program)
    const done = new Promise<Outcome>((resolve) => {
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) return resolve({ _tag: "done", answer: exit.value })
        if (Cause.hasInterruptsOnly(exit.cause)) return resolve({ _tag: "cancelled" })
        resolve({ _tag: "failed", message: describe(exit.cause), detail: Cause.pretty(exit.cause) })
      })
    })
    return { done, cancel: () => void runtime.runFork(Fiber.interrupt(fiber)) }
  }

  const approvals: NonNullable<Host["approvals"]> = {
    mode: approvalMode,
    authorize: (requests, signal) => approvalMode === "all" ? Promise.resolve() :
      runtime.runPromise(Effect.flatMap(GrantStore.GrantStore, (grants) => Approvals.check(grants, requests)), { signal }),
    pending: () =>
      runtime.runPromise(Effect.gen(function*() {
        return Approvals.pending(yield* (yield* GrantStore.GrantStore).list)
      })),
    reply: (request, choice) =>
      runtime.runPromise(Effect.gen(function*() {
        return yield* Approvals.answer(yield* GrantStore.GrantStore, request, choice, options.cwd)
      }))
  }

  return {
    cwd: options.cwd,
    judged,
    compaction,
    run,
    approvals,
    describe: describeTab,
    monitor,
    complete,
    dispose: () => runtime.dispose()
  }
}

/**
 * Runs `effect` without the workspace observer.
 *
 * On the effect, not the stream: `Stream.updateContext` does not reach the
 * effect `Agent.run` resolves its services in. The cast is sound because the
 * run reads the observer with `serviceOption`, so it is never a requirement.
 */
const unobserved = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateContext(
    effect,
    (context: ServiceContext.Context<R>) =>
      ServiceContext.omit(WorkspaceObservation.Observer)(context) as ServiceContext.Context<R>
  )

const text = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string =>
  content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("")

/** The innermost message: "The cell frame failed" wraps the provider's own words. */
const describe = (cause: Cause.Cause<unknown>): string => {
  let error: unknown = Cause.squash(cause)
  let message = Cause.pretty(cause)
  while (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string" && error.message !== "") message = error.message
    error = "cause" in error ? error.cause : undefined
  }
  return message
}
