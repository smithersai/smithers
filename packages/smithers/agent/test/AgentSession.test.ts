/**
 * The composition root, end to end: control → executor → durable engine.
 *
 * One scenario carries the definition of done. A planned agent flow is
 * approved and run through the real `Control` service; the production
 * executor accepts the launch and executes the cell loop on the real durable
 * engine; frame zero makes a tool call through the real QuickJS sandbox; an
 * operator steer admitted through `Control.steer` is delivered at the frame
 * boundary; frame one's `ask` parks the run as `waiting-approval`, is
 * approved through `Control.approve` with the exact payload the executor
 * journaled, and the resumed run replays its settled prefix and completes.
 *
 * The scenario runs twice: once against a scripted model that records every
 * provider request, and once against `RecordedModel` replaying that fixture —
 * which proves the composition is deterministic enough to be driven entirely
 * from a recording, and that the recording is consumed in full.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Control, ControlError, ControlExecutor, ControlLive, ControlRuntime, ControlSchema } from "@smthrs/control"
import * as CoreFlow from "@smthrs/core/Flow"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Cell from "@smthrs/harness/Cell"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import type * as Fixture from "@smthrs/testing/Fixture"
import type * as ModelLike from "@smthrs/testing/ModelLike"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import { Cause, Deferred, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import { confident as confidentEvaluator } from "./fixtures/evaluator.ts"
import legacyCompaction from "./fixtures/legacyCompaction.json" with { type: "json" }
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/notes",
  description: "The notes agent.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/notes/flow.md",
    baseDirectory: "/flows/agents/notes",
    contentDigest: "a".repeat(64)
  }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("anthropic:test-model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/notes",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

/** A flow that declares its own reasoning effort, overriding the host default. */
const effortDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/effort",
  path: "/flows/agents/effort",
  frontmatter: { effort: "low" }
})

const moduleDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/module",
  body: new Descriptor.BodyRefModule({ path: "/flows/agents/module/flow.ts", contentDigest: "b".repeat(64) }),
  path: "/flows/agents/module",
  model: Option.none(),
  flows: ["test/Module"]
})

/**
 * A prompt flow that declares no seat.
 *
 * This is the `smithers init` scaffold as rc.0 first shipped it: a markdown
 * body with no `model:` line. No agent host can ever run it, so the launch
 * refuses rather than answering `pending` and leaving the run accepted.
 */
const seatlessDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/seatless",
  model: Option.none(),
  path: "/flows/agents/seatless"
})

const descriptors = new Map([
  [agentDescriptor.name, agentDescriptor],
  [effortDescriptor.name, effortDescriptor],
  [moduleDescriptor.name, moduleDescriptor],
  [seatlessDescriptor.name, seatlessDescriptor]
])

const registryService = Registry.makeNoop({
  list: () => Effect.succeed([agentDescriptor, effortDescriptor, moduleDescriptor, seatlessDescriptor]),
  visible: () => Effect.succeed([]),
  get: (name) =>
    descriptors.has(name)
      ? Effect.succeed(descriptors.get(name)!)
      : Effect.flatMap(Registry.makeNoop().get(name), () => Effect.die("unreachable")),
  getOption: (name) => Effect.succeed(Option.fromNullishOr(descriptors.get(name))),
  loadBody: (name) =>
    Effect.succeed(
      name === moduleDescriptor.name
        ? new Descriptor.FlowBodyModule({ path: "/flows/agents/module/flow.ts" })
        : new Descriptor.FlowBodyPrompt({ text: "Keep the note log tidy.", baseDirectory: "/flows/agents/notes" })
    )
})

const memoryFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/notes",
    executionDigest: Descriptor.executionDigest(agentDescriptor),
    description: "The notes agent.",
    deployClass: false,
    // One valid wildcard, one valid exact pattern, and three malformed
    // entries the composition must drop rather than widen: no resource, a
    // pattern-less name, and an action outside the vocabulary.
    envelope: {
      capabilities: ["*:**", "fs:read:**", "fs:read", "single", "zz:yy:**"],
      flows: [],
      budget: {}
    }
  },
  {
    flowId: "agents/effort",
    executionDigest: Descriptor.executionDigest(effortDescriptor),
    description: "The notes agent, with its own declared reasoning effort.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  },
  {
    flowId: "agents/module",
    executionDigest: Descriptor.executionDigest(moduleDescriptor),
    description: "An agent seat over a module body, which the harness refuses.",
    deployClass: false,
    envelope: { capabilities: ["fs:read:**"], flows: ["test/Module"], budget: {} }
  },
  {
    flowId: "agents/seatless",
    executionDigest: Descriptor.executionDigest(seatlessDescriptor),
    description: "A prompt flow with no model seat.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  },
  {
    flowId: "system/idle",
    description: "A flow no executor composition can run.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  }
]

const noteFlow = CoreFlow.make({
  name: "note/save",
  description: "Save one line to the run's note log.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ saved: Schema.Number }),
  effects: { reads: [], writes: ["/notes/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

const checkFlow = CoreFlow.make({
  name: "project/check",
  description: "Run the project's own check and report its exit code.",
  input: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ exitCode: Schema.Number }),
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

const frameZero = `await ctx.call("project/check", { command: "npm test" })
const saved = await ctx.call("note/save", { text: "frame zero note" })
console.log("note saved")`

const frameOne = `const decision = await ctx.call("ask", { question: "publish the log?", options: ["yes", "no"] })
ctx.done("approved=" + decision.approved)`

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

interface Captured {
  readonly request: ModelRequest.ModelRequest
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
}

/** A scripted model that records the exact provider request of every frame. */
const capturing = (captured: Array<Captured>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const source = captured.length === 0 ? frameZero : frameOne
        const events = cellEvents(source, `cell-${captured.length}`)
        captured.push({ request, events })
        return Stream.fromIterable(events)
      })
  })

const principal: ControlSchema.Principal = { id: "operator", kind: "test", stampedAt: 1 }

const steerBody = "steer: mention the weather"

interface StackOptions {
  readonly modules?: {
    readonly catalog: Executable.Catalog
    readonly layer: Layer.Layer<never, never, Executable.Registration>
  } | undefined
  /** The scripted resolver installed as the composition's `SeatResolver`. */
  readonly resolve: SeatResolver.Service["resolve"]
  readonly notes: Array<string>
  /** Commands the project-check flow was actually asked to run. */
  readonly checks?: Array<string> | undefined
  readonly gate: Deferred.Deferred<void>
  /** Completes when the test tool enters its gate, before its side effect. */
  readonly toolStarted?: Deferred.Deferred<void> | undefined
  /** Omit the host flow sources entirely, exercising the executor's default. */
  readonly maxFrames?: number | undefined
  readonly promptRunner?: CellCalls.PromptRunner | undefined
  readonly registry?: Registry.Registry | undefined
  readonly bare?: boolean | undefined
  /** The host's reasoning-effort default, beneath a flow's own `effort:`. */
  readonly reasoningEffort?: ModelRequest.ReasoningEffort | undefined
}

/**
 * The full production stack: the live control plane, the real executor, and
 * the SQLite-backed durable engine composed by `flows/NodeRuntime`. The
 * control test journal remains deterministic, while the executor-facing flow
 * runtime uses the same production storage and startup ordering as NodeControl.
 */
const stack = (options: StackOptions) => {
  const root = mkdtempSync(join(tmpdir(), "flows-agent-session-"))
  engineRoots.add(root)
  const journal = TestJournal.layer()
  const notifications = NotificationQueue.layer.pipe(Layer.provide(journal))
  const runtime = ControlRuntime.layerMemory({ flows: memoryFlows }).pipe(Layer.provide(NodeCrypto.layer))
  const registry = Layer.succeed(Registry.Registry)(options.registry ?? registryService)
  const noteSource = FlowBinding.source("test/notes", [
    FlowBinding.make({
      flow: noteFlow,
      handler: (input) =>
        (options.toolStarted === undefined ? Effect.void : Deferred.succeed(options.toolStarted, void 0)).pipe(
          Effect.andThen(Deferred.await(options.gate)),
          Effect.andThen(Effect.sync(() => {
            options.notes.push(input.text)
            return { saved: options.notes.length }
          }))
        )
    })
  ])
  const checkSource = FlowBinding.source("test/check", [
    FlowBinding.make({
      flow: checkFlow,
      handler: (input) =>
        Effect.sync(() => {
          options.checks?.push(input.command)
          return { exitCode: 0 }
        })
    })
  ])
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    budget: Safety.budget,
    flows: options.bare === true ? undefined : [noteSource, checkSource],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: options.maxFrames ?? 4,
    promptRunner: options.promptRunner,
    reasoningEffort: options.reasoningEffort
  }).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provide(
      options.modules === undefined ? Layer.empty : Layer.merge(
        Layer.succeed(Executable.Catalog, options.modules.catalog),
        options.modules.layer
      )
    ),
    // The agent and the seat resolver are the executor's own dependencies;
    // everything else in its `Services` union comes from the engine stack.
    Layer.provide(
      Layer.mergeAll(Agent.layer, SeatResolver.layer({ resolve: options.resolve }), confidentEvaluator).pipe(
        Layer.provide(Safety.layer)
      )
    )
  )
  let snapshot = 0
  const jj = Jj.layerNoop({
    snapshot: () => Effect.succeed({ changeId: `snapshot-${snapshot++}` }),
    restore: () => Effect.void,
    diff: () => Effect.succeed("")
  })
  const engine = NodeRuntime.layer(
    {
      filename: join(root, "engine.db"),
      workspaceRoot: root,
      owner: { hostId: "agent-session-test" },
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(Layer.provide([NodeFileSystem.layer, NodeCrypto.layer, jj]))
  return ControlLive.layer.pipe(
    Layer.provideMerge(engine),
    Layer.provideMerge(Layer.mergeAll(runtime, journal, notifications, registry)),
    Layer.provide(Action.layerImplementations)
  )
}

const engineRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...engineRoots].map((root) => rm(root, { recursive: true, force: true })))
  engineRoots.clear()
})

const seat = (model: Model.Model): SeatResolver.Service["resolve"] => (id) =>
  Effect.succeed(
    Seat.make({
      id,
      modelId: "test-model",
      model,
      route,
      contextWindowTokens: SeatResolver.contextWindowTokensFor("test-model")
    })
  )

/**
 * Waits for a run to reach a status by yielding, bounded by a count of turns.
 *
 * The bound is a hang detector, not a schedule: every attempt is one in-memory
 * read plus a microtask, so a generous count still fails a genuinely stuck run
 * in milliseconds. Five hundred was not generous enough — the two-run failure
 * case below needs roughly four times that on an unloaded machine and had been
 * failing outright — and a poll budget that a correct run can exhaust reports a
 * red the code did not earn.
 */
const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  status: ControlSchema.RunStatus,
  attempts = 20_000
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (run.status === status) return
    if (attempts <= 0) {
      return yield* Effect.die(`run ${runId} never reached ${status} (still ${run.status})`)
    }
    yield* Effect.yieldNow
    return yield* awaitStatus(runtime, runId, status, attempts - 1)
  })

interface Outcome {
  readonly runId: string
  readonly requestedQuestion: string
  readonly grantTokens: ReadonlyArray<string>
  readonly agentTrail: ReadonlyArray<JournalEvent.Entry>
}

/**
 * Drives one complete run: plan → approve → run → steer → park on the ask →
 * approve the in-run request → resume → completed.
 *
 * The gate releases the frame-zero tool call only after the steer is
 * admitted, so the frame-boundary drain deterministically sees it.
 */
const drive = (
  gate: Deferred.Deferred<void>,
  decision: "approve" | "deny" = "approve",
  legacy = false,
  changedOnResume?: Descriptor.FlowDescriptor
): Effect.Effect<Outcome, unknown, Control.Control | ControlRuntime.ControlRuntime | Journal.Journal> =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const runtime = yield* ControlRuntime.ControlRuntime
    const journal = yield* Journal.Journal

    const card = yield* control.plan({ flowId: "agents/notes", input: { topic: "standups" } })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:notes"
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die("expected an accepted run")
    }
    const runId = receipt.runId

    yield* control.steer({
      runId,
      message: { messageId: "steer-1", runId, body: steerBody, principal, createdAt: 1 },
      idempotencyKey: "steer:1"
    })
    yield* Deferred.succeed(gate, void 0)

    // Frame one's ask parks the run and journals the exact approval payload
    // an operator replays through `smithers approve`.
    const requested = yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.approval.requested"),
      Stream.take(1),
      Stream.runCollect
    )
    const requestedPayload = requested[0]?.payload as {
      readonly question: string
      readonly payload: unknown
    }
    yield* awaitStatus(runtime, runId, "waiting-approval")

    const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(requestedPayload.payload)
    if (legacy) {
      // Put the incompatible record beyond the first page of session history.
      for (let index = 0; index < 1_000; index++) {
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("legacy-fixture"),
            eventType: "telemetry",
            payload: { index }
          })
        )
      }
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: JournalEvent.SourceId.make("legacy-fixture"),
          ...legacyCompaction
        })
      )
    }
    if (changedOnResume !== undefined) descriptors.set(agentDescriptor.name, changedOnResume)
    yield* decision === "approve" ? control.approve(approval) : control.deny(approval)
    yield* control.resume({ runId, idempotencyKey: "resume:1" })
    yield* awaitStatus(runtime, runId, legacy || changedOnResume !== undefined ? "failed" : "completed")

    const grants = yield* runtime.grants
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 10_000 })
    return {
      runId,
      requestedQuestion: requestedPayload.question,
      grantTokens: grants.map((grant) => grant.tokenId),
      agentTrail: page.entries.filter((entry) =>
        entry.eventType.startsWith("control.agent.") || entry.eventType === "control.run.failed"
      )
    }
  })

/**
 * Two frames that each stop on an `ask`, so one run parks twice and every
 * resume replays a longer prefix than the one before it.
 */
const askFrames = [
  `const first = await ctx.call("ask", { question: "publish the log?" })
console.log("first=" + first.approved)`,
  `const second = await ctx.call("ask", { question: "publish the report?" })
ctx.done("second=" + second.approved)`
]

/**
 * A scripted model that answers each frame the provider is actually asked for.
 *
 * A replayed frame never reaches the provider, so the number of recorded calls
 * is the frame index: the model hands back frame zero's cell once, frame one's
 * cell once, and the run's third incarnation asks it for nothing at all.
 */
const scripted = (sources: ReadonlyArray<string>, captured: Array<Captured>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const events = cellEvents(sources[captured.length] ?? sources.at(-1)!, `cell-${captured.length}`)
        captured.push({ request, events })
        return Stream.fromIterable(events)
      })
  })

/**
 * Approves the nth in-run request of a run and resumes it.
 *
 * `watch` replays the run's committed history before it follows, so taking
 * `index` requests and reading the last is what names the request this park is
 * waiting on rather than the one the previous park already answered.
 */
const approvePark = (
  control: Control.Service,
  runtime: ControlRuntime.Service,
  runId: string,
  index: number
): Effect.Effect<string, unknown> =>
  Effect.gen(function*() {
    const requested = yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.approval.requested"),
      Stream.take(index),
      Stream.runCollect
    )
    const requestedPayload = requested[index - 1]?.payload as {
      readonly question: string
      readonly payload: unknown
    }
    yield* awaitStatus(runtime, runId, "waiting-approval")
    yield* control.approve(Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(requestedPayload.payload))
    yield* control.resume({ runId, idempotencyKey: `resume:${index}` })
    return requestedPayload.question
  })

/** Drives one run through two parks and two resumes, then reads its trail. */
const driveTwoParks: Effect.Effect<
  { readonly questions: ReadonlyArray<string>; readonly agentTrail: ReadonlyArray<JournalEvent.Entry> },
  unknown,
  Control.Control | ControlRuntime.ControlRuntime | Journal.Journal
> = Effect.gen(function*() {
  const control = yield* Control.Control
  const runtime = yield* ControlRuntime.ControlRuntime
  const journal = yield* Journal.Journal

  const card = yield* control.plan({ flowId: "agents/notes", input: {} })
  yield* control.approve(card.approval)
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "run:two-parks"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  const runId = receipt.runId
  const first = yield* approvePark(control, runtime, runId, 1)
  const second = yield* approvePark(control, runtime, runId, 2)
  yield* awaitStatus(runtime, runId, "completed")

  yield* journal.flush
  const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1_000 })
  return {
    questions: [first, second],
    agentTrail: page.entries.filter((entry) => entry.eventType.startsWith("control.agent."))
  }
})

const textOf = (request: ModelRequest.ModelRequest): string =>
  request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")

describe("AgentSession", () => {
  it.each([false, true])("settles a bounded run with markdown child=%s", async (child) => {
    const rendered: Array<string> = []
    const childDescriptor = new Descriptor.FlowDescriptor({
      ...agentDescriptor,
      name: "review",
      modelInvocable: true
    })
    const childRegistry = Registry.makeNoop({
      ...registryService,
      visible: () => Effect.succeed([childDescriptor]),
      getOption: (name) =>
        name === "review"
          ? Effect.succeed(Option.some(childDescriptor))
          : registryService.getOption(name),
      runPrompt: (_name, input) => Effect.succeed(`Review ${input.args}`)
    })
    const model = Model.make({
      stream: () =>
        Stream.fromIterable(cellEvents(
          child
            ? `const answer = await ctx.call("review", { args: "notes" }); ctx.done(String(answer))`
            : `console.log("continue")`,
          "bounded"
        ))
    })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const journal = yield* Journal.Journal
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:bounded"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          // Wait for either terminal state so the pre-fix regression reports
          // the incorrect status directly instead of timing out.
          const terminal = (): Effect.Effect<ControlSchema.RunStatus, unknown> =>
            Effect.gen(function*() {
              const run = yield* runtime.getRun(receipt.runId!)
              if (run.status === "completed" || run.status === "failed") return run.status
              yield* Effect.sleep(Duration.millis(10))
              return yield* terminal()
            })
          const status = yield* terminal().pipe(Effect.timeout(Duration.seconds(20)))
          yield* journal.flush
          const page = yield* journal.entries({ runId: JournalEvent.RunId.make(receipt.runId), limit: 100 })
          return { runId: receipt.runId, status, entries: page.entries }
        }).pipe(Effect.provide(stack({
          resolve: seat(model),
          notes: [],
          gate,
          bare: true,
          maxFrames: 1,
          registry: childRegistry,
          promptRunner: ({ text }) =>
            Effect.sync(() => {
              rendered.push(text)
              return new Cell.CallResult({ outcome: "success", value: "reviewed" })
            })
        })))
      }).pipe(Effect.scoped)
    )
    expect(rendered).toEqual(child ? ["Review notes"] : [])
    expect(result.status).toBe(child ? "completed" : "failed")
    if (!child) {
      const failure = result.entries.find((entry) => entry.eventType === "control.run.failed")
      expect(JSON.stringify(failure)).toContain("ended without a completed answer")
      expect(JSON.stringify(failure)).toContain("FramesExhausted")
      // Read the durable settlement after scope closure, not just the control status.
      const database = new DatabaseSync(join([...engineRoots][0]!, "engine.db"), { readOnly: true })
      try {
        const row = database.prepare("SELECT state_json FROM flows_runs WHERE run_id = ?").get(result.runId)
        const state = JSON.parse(String(row?.state_json))
        expect(state.result).toMatchObject({ _tag: "Complete", exit: { _tag: "Failure" } })
        expect(JSON.stringify(state.result)).toContain("\"_tag\":\"FramesExhausted\"")
        expect(JSON.stringify(state.result)).toContain("\"frames\":1")
      } finally {
        database.close()
      }
    }
  })

  for (
    const [change, descriptor] of [
      [
        "prompt",
        new Descriptor.FlowDescriptor({
          ...agentDescriptor,
          body: new Descriptor.BodyRefMarkdown({
            path: agentDescriptor.body.path,
            baseDirectory: agentDescriptor.path,
            contentDigest: "b".repeat(64)
          })
        })
      ],
      ["model", new Descriptor.FlowDescriptor({ ...agentDescriptor, model: Option.some("openai:another-model") })],
      ["parameters", new Descriptor.FlowDescriptor({ ...agentDescriptor, frontmatter: { effort: "high" } })]
    ] as const
  ) {
    it(`refuses changed ${change} on resume before another model call or side effect`, async () => {
      const captured: Array<Captured> = []
      const notes: Array<string> = []
      try {
        const outcome = await Effect.runPromise(
          Effect.gen(function*() {
            const gate = yield* Deferred.make<void>()
            return yield* drive(gate, "approve", false, descriptor).pipe(
              Effect.provide(stack({ resolve: seat(capturing(captured)), notes, gate }))
            )
          }).pipe(Effect.scoped) as Effect.Effect<Outcome>
        )
        expect(captured).toHaveLength(2)
        expect(notes).toEqual(["frame zero note"])
        const failed = outcome.agentTrail.find((entry) => entry.eventType === "control.run.failed")
        expect(JSON.stringify(failed?.payload)).toContain("create and approve a new plan")
      } finally {
        descriptors.set(agentDescriptor.name, agentDescriptor)
      }
    })
  }

  it("refuses a pre-user-summary journal on resume before another live model call", { timeout: 30_000 }, async () => {
    const captured: Array<Captured> = []
    const notes: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* drive(gate, "approve", true).pipe(
          Effect.provide(stack({ resolve: seat(capturing(captured)), notes, gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )
    expect(captured).toHaveLength(2)
    expect(notes).toEqual(["frame zero note"])
    const failed = outcome.agentTrail.find((entry) => entry.eventType === "control.run.failed")
    expect(JSON.stringify(failed?.payload)).toContain("/harness/HarnessError")
    expect(JSON.stringify(failed?.payload)).toContain("predates harness journal format 2")
  })
  it("resumes a newly forked execution under the child's identity even when the copied parent is terminal", async () => {
    let modelCalls = 0
    const model = Model.make({
      stream: () => {
        modelCalls++
        return Stream.fromIterable(cellEvents("ctx.done(\"child complete\")", "fork-cell"))
      }
    })
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const runs = yield* RunStore.RunStore
          const executor = yield* ControlExecutor.ControlExecutor
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          const parent = yield* runtime.launch(card.planId, card.digest, card.envelope)
          const child = yield* runtime.launch(card.planId, card.digest, card.envelope)
          if (parent._tag !== "Started" || child._tag !== "Started") return yield* Effect.die("expected approved runs")
          yield* runtime.writeStatus(parent.run.runId, yield* runtime.claimFence(parent.run.runId), "completed")
          yield* runtime.writeStatus(child.run.runId, yield* runtime.claimFence(child.run.runId), "parked")
          yield* runs.create(
            child.run.runId,
            JSON.stringify({
              version: 1,
              flowName: "agent/run",
              payload: { runId: parent.run.runId, planId: card.planId }
            })
          )
          // An operator resume claims its control row before delegating to the
          // executor; a fresh fork itself has no parkedBy process identity.
          yield* runtime.resume(child.run.runId)
          expect(yield* executor.resumeRun({ runId: child.run.runId })).toBe("resuming")
          yield* awaitStatus(runtime, child.run.runId, "completed")
          return { parent: yield* runtime.getRun(parent.run.runId), child: yield* runtime.getRun(child.run.runId) }
        }).pipe(Effect.provide(stack({ resolve: seat(model), notes: [], gate })))
      }).pipe(Effect.scoped)
    )
    expect(modelCalls).toBe(1)
    expect(outcome.parent.status).toBe("completed")
    expect(outcome.child.status).toBe("completed")
    expect(outcome.child.runId).not.toBe(outcome.parent.runId)
  })
  it("waits through an accepted control row before driving the engine", async () => {
    let reads = 0
    await expect(Effect.runPromise(
      AgentSession.waitForRunning(
        () => Effect.sync(() => (reads++ === 0 ? "accepted" : "running")),
        "run-wait",
        1,
        Effect.yieldNow
      )
    )).resolves.toBe(true)
    expect(reads).toBe(2)
    await expect(
      Effect.runPromise(AgentSession.waitForRunning(() => Effect.succeed("cancelled"), "run-cancelled", 1))
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(AgentSession.waitForRunning(() => Effect.succeed("accepted"), "run-stuck", 0))
    ).rejects.toMatchObject({ code: "launch_failed", runId: "run-stuck" })
  })

  it("waits for a parked execution publication before resuming it", async () => {
    let polls = 0
    const parked = await Effect.runPromise(
      AgentSession.waitForParked(
        () => Effect.sync(() => (++polls === 1 ? Option.none() : Option.some({ _tag: "Suspended" }))),
        1
      )
    )
    expect(parked).toBe(true)
    expect(polls).toBe(2)
    await expect(Effect.runPromise(AgentSession.waitForParked(() => Effect.succeed(Option.none()), 0)))
      .resolves.toBe(false)
  })

  it("keeps cancellation and registration failures contained at the executor boundary", async () => {
    await expect(Effect.runPromise(AgentSession.preserveDriverInterrupt(() => Effect.fail("interrupted"))))
      .resolves.toBeUndefined()
    const interruptExit = await Effect.runPromiseExit(
      AgentSession.preserveDriverInterrupt(() => Effect.interrupt)
    )
    expect(Exit.isFailure(interruptExit) && Cause.hasInterruptsOnly(interruptExit.cause)).toBe(true)
    const failure = await Effect.runPromise(
      Effect.flip(AgentSession.registerDriver(() => Effect.fail("missing run"), "run-registration"))
    )
    expect(failure).toMatchObject({
      runId: "run-registration",
      message: "The run driver could not be registered for cancellation",
      cause: "missing run"
    })
    let failedDetail = ""
    await expect(Effect.runPromise(AgentSession.settleDriverFailure(
      Cause.fail("engine failed"),
      "run-failed",
      (detail) => Effect.sync(() => void (failedDetail = detail))
    )))
      .resolves.toBeUndefined()
    expect(failedDetail).toContain("engine failed")
    const statusFailure = await Effect.runPromiseExit(
      AgentSession.settleDriverFailure(
        Cause.fail("engine failed"),
        "run-failed",
        () => Effect.fail("status unavailable")
      )
    )
    expect(statusFailure).toMatchObject({ _tag: "Failure" })
    const interrupted = await Effect.runPromiseExit(
      AgentSession.settleDriverFailure(Cause.interrupt(1), "run-interrupted", () => Effect.void)
    )
    expect(interrupted._tag).toBe("Failure")
  })

  it("drives a 2-frame run through control → executor → engine, then replays it from the recorded fixture", {
    timeout: 30_000
  }, async () => {
    // Pass one: a scripted model records the exact request of every frame.
    const captured: Array<Captured> = []
    const notes: Array<string> = []
    const checks: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* drive(gate).pipe(
          Effect.provide(stack({ resolve: seat(capturing(captured)), notes, checks, gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    // Two provider calls, one per frame, and the resumed attempt replayed
    // both as sealed steps instead of asking the provider again.
    expect(captured).toHaveLength(2)
    // The host check flow ran exactly once, from the cell that called it: the
    // controller has no private way to run commands of its own.
    expect(checks).toEqual(["npm test"])
    // Per-call latency is journaled next to usage, so a benchmark can measure
    // seconds per call and not only per run.
    //
    // TWO calls, TWO rows. The park's resumed attempt re-executes both frames
    // and republishes every event in the replayed prefix, so this used to
    // journal four `model-settled` rows and a projection summing `usage`
    // over-counted a run's tokens once per park. Each trail event now carries
    // the identity `AgentSession.traceIdentity` derives from where it sits and
    // what it says: the frame, its ordinal within that frame, the frame's
    // cell, the event type, and the payload minus the observation metadata a
    // replay restamps. `UNIQUE (run_id, source_id, source_seq)` then refuses
    // the republished row. The divergent half of the same resume is asserted
    // below and is the property the fix turns on.
    //
    // The three routes recorded here before it stay closed:
    //
    // - Suppressing a replayed frame's events needs the harness to know a frame
    //   is replaying. `EngineLike.record` returns only the value, so the marker
    //   would need a port change, a probe boundary per frame, and a field on a
    //   published `AgentEvent`. It would still be wrong on the frame a
    //   resume lands in, which replays its model step and then produces genuinely
    //   new events after the steering drain that answered its park.
    // - A deterministic identity WITH a preflight read deadlocks. An explicit
    //   `sourceSeq` used to send `emitLossy` through `SqlJournal`'s
    //   `preflightExplicit`, which issued a SELECT before admission; the
    //   executor's exit flush runs inside the engine's write transaction, so
    //   that read waited on the writer that was waiting on it. Measured: 410 ms
    //   without the explicit sequence, no completion in 120 s with it. The
    //   identity was right and the plumbing was wrong: admission now reads
    //   nothing and the unique index answers at the insert, which is why this
    //   case runs in roughly the time it always did.
    // - A per-incarnation high-water count can read at the start of `body`,
    //   after activation commits and before `agent.run` opens a step
    //   transaction, so it does not reproduce that SELECT deadlock. Its
    //   ordinal premise is false, though. Emission is serial and deterministic
    //   only through the branch frontier. This parked attempt writes 21
    //   projected rows, while the resume shares only its first 18. Approval
    //   makes row 19 a new `cell-call-settled` instead of the old
    //   `permission-required`. The prototype skipped all 21: settlements fell
    //   from four to two, but the trail held 25 rows instead of the required
    //   28 and lost the new `cell-call-settled`, `cell-printed`, and
    //   `cell-settled`, including the only settled evidence for `ask`.
    const settled = outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.model-settled")
    expect(settled).toHaveLength(2)
    expect(
      settled.every((entry) =>
        typeof (entry.payload as { readonly durationMillis?: unknown }).durationMillis === "number"
      )
    ).toBe(true)
    // The resumed attempt's DIVERGENCE is journaled in full. The parked
    // attempt's frame one ended at `permission-required`; the approved attempt
    // answers the same `ask`, at the same ordinal of the same frame, with a
    // `cell-call-settled` and then runs the frame to its end. Both rows stand,
    // including the print and settlement the resumed frame produces.
    expect(outcome.agentTrail.map((entry) => entry.eventType)).toContain("control.agent.permission-required")
    const asks = outcome.agentTrail.filter((entry) =>
      entry.eventType === "control.agent.cell-call-settled" &&
      (entry.payload as { readonly flowName?: unknown }).flowName === "ask"
    )
    expect(asks).toHaveLength(1)
    // The live producer carries its durable dispatch identity through start,
    // permission park, replay and settlement; the control adapter must retain
    // it rather than correlating repeated flow names by timing.
    const callStarts = outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.cell-call-started")
    const callSettlements = outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.cell-call-settled")
    const ids = callStarts.map((entry) => (entry.payload as { readonly callId: string }).callId)
    expect(ids.every((id) => /^cell-call-v1:[0-9a-f]{64}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(callSettlements).toHaveLength(callStarts.length)
    for (const entry of callSettlements) {
      const settled = entry.payload as { readonly callId: string; readonly flowName: string }
      const matching = callStarts.filter((start) =>
        (start.payload as { readonly callId: string }).callId === settled.callId
      )
      expect(matching).toHaveLength(1)
      expect((matching[0]!.payload as { readonly flowName: string }).flowName).toBe(settled.flowName)
    }
    expect((asks[0]!.payload as { readonly value: { readonly approved: boolean } }).value.approved).toBe(true)
    for (const eventType of ["cell-printed", "cell-settled", "transition-applied"]) {
      expect(outcome.agentTrail.filter((entry) => entry.eventType === `control.agent.${eventType}`)).toHaveLength(2)
    }
    expect(outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.permission-required")).toHaveLength(
      1
    )
    expect(outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.steering-drained")).toHaveLength(2)
    // One row per identity: nothing was journaled twice, and nothing that the
    // resume produced was refused as a duplicate of something else.
    expect(new Set(outcome.agentTrail.map((entry) => entry.sourceSeq)).size)
      .toBe(outcome.agentTrail.length)
    // The steer admitted through Control.steer reached frame one's context at
    // the frame boundary, alongside the cell's own continuation insert.
    const frameOneText = textOf(captured[1]!.request)
    expect(frameOneText).toContain("note saved")
    expect(frameOneText).toContain(steerBody)
    // The QuickJS-sandboxed tool call executed exactly once across the park
    // and its resumed attempt.
    expect(notes).toEqual(["frame zero note"])
    // The in-run approval was requested with the question the cell asked, and
    // approving it installed the grant the resumed ask read.
    expect(outcome.requestedQuestion).toBe("publish the log?")
    expect(outcome.grantTokens.some((token) => token.startsWith(`ask/${outcome.runId}/`))).toBe(true)
    expect(outcome.agentTrail.length).toBeGreaterThan(0)
    expect(outcome.agentTrail.every((entry) => typeof (entry.payload as { readonly at?: unknown }).at === "number"))
      .toBe(true)

    // Pass two: the same scenario, driven entirely from the recording.
    const fixture: Fixture.Fixture = {
      calls: captured.map((call) => ({
        request: call.request as unknown as ModelLike.ModelRequestLike,
        model: "test-model",
        events: call.events as unknown as ReadonlyArray<ModelLike.ModelEventLike>
      }))
    }
    const replayNotes: Array<string> = []
    const replayed = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const replay = yield* RecordedModel.make(fixture)
        const model = Model.make({ stream: replay.model.stream as Model.Model["stream"] })
        const driven = yield* drive(gate).pipe(
          Effect.provide(stack({ resolve: seat(model), notes: replayNotes, gate }))
        )
        const unconsumed = yield* replay.controller.unconsumed()
        return { driven, unconsumed }
      }).pipe(Effect.scoped) as Effect.Effect<{
        driven: Outcome
        unconsumed: ReadonlyArray<Fixture.RecordedCall>
      }>
    )

    expect(replayNotes).toEqual(["frame zero note"])
    expect(replayed.driven.requestedQuestion).toBe("publish the log?")
    expect(replayed.driven.agentTrail.length).toBeGreaterThan(0)
    expect(
      replayed.driven.agentTrail.every((entry) => typeof (entry.payload as { readonly at?: unknown }).at === "number")
    ).toBe(true)
    // Every recorded call was matched and consumed: the recording drove the
    // whole loop, nothing was unscripted and nothing was left over.
    expect(replayed.unconsumed).toEqual([])
  })

  it("keeps one row per event across a second park, and journals what diverges", {
    timeout: 30_000
  }, async () => {
    const captured: Array<Captured> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        // Nothing in these frames touches the gated tool, so the gate is open
        // from the start.
        yield* Deferred.succeed(gate, void 0)
        return yield* driveTwoParks.pipe(
          Effect.provide(stack({ resolve: seat(scripted(askFrames, captured)), notes: [], gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<{
        questions: ReadonlyArray<string>
        agentTrail: ReadonlyArray<JournalEvent.Entry>
      }>
    )

    expect(outcome.questions).toEqual(["publish the log?", "publish the report?"])
    // Three incarnations, two provider calls: the second resume replays both
    // frames from their sealed steps and asks the provider for neither.
    expect(captured).toHaveLength(2)
    // The count a projection sums. Without a per-event identity this run
    // journals one `model-settled` for the first attempt, two more for the
    // attempt that answers the first ask, and two more again for the attempt
    // that answers the second: five rows for two calls, growing with every
    // park. A second resume is where a fix that only handles the first one
    // comes apart, so it is asserted separately from the single-park case.
    const settled = outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.model-settled")
    expect(settled).toHaveLength(2)
    expect(new Set(outcome.agentTrail.map((entry) => entry.sourceSeq)).size)
      .toBe(outcome.agentTrail.length)
    // Both asks were answered after their park, and both answers survived:
    // dedup by identity refuses a republished row without touching the rows a
    // divergent resume adds.
    const asks = outcome.agentTrail.filter((entry) =>
      entry.eventType === "control.agent.cell-call-settled" &&
      (entry.payload as { readonly flowName?: unknown }).flowName === "ask"
    )
    expect(asks).toHaveLength(2)
    expect(
      outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.permission-required")
    ).toHaveLength(2)
    expect(outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.resolved")).toHaveLength(1)
  })

  it("settles resume events for runs it never launched without holding the bridge", { timeout: 30_000 }, async () => {
    const notes: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* Effect.gen(function*() {
          const journal = yield* Journal.Journal
          // Three resume events for runs no executor in this process launched
          // — a paused system flow, another process's run in a shared control
          // database. Without the not-found fast path each would hold the
          // single-concurrency resume bridge for its whole retry budget,
          // starving the genuine resume below past its completion wait.
          for (const foreign of ["foreign-1", "foreign-2", "foreign-3"]) {
            yield* journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: JournalEvent.RunId.make(foreign),
                sourceId: JournalEvent.SourceId.make("/test/foreign-control"),
                eventType: "control.run.resume",
                payload: { runId: foreign, status: "accepted" }
              })
            )
          }
          return yield* drive(gate)
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    expect(outcome.requestedQuestion).toBe("publish the log?")
    expect(notes).toEqual(["frame zero note"])
  })

  it("accepts nothing it cannot execute: a flow without an agent body stays pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "system/idle", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:idle"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const events = yield* control.watch({ runId: receipt.runId }).pipe(
            Stream.take(2),
            Stream.runCollect
          )
          const run = yield* runtime.getRun(receipt.runId)
          return { kinds: events.map((event) => event.kind), status: run.status }
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<{ kinds: ReadonlyArray<string>; status: string }, unknown>
    )

    expect(result.kinds).toEqual(["control.run.accepted", "control.run.pending"])
    expect(result.status).toBe("accepted")
  })

  it("delivers a denial to the resumed ask instead of parking forever", async () => {
    const notes: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* drive(gate, "deny").pipe(
          Effect.provide(stack({ resolve: seat(capturing([])), notes, gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    // The denial resolved the token without installing a grant, so the
    // resumed ask answered `denied` and the run still completed.
    expect(outcome.grantTokens.some((token) => token.startsWith("ask/"))).toBe(false)
    expect(notes).toEqual(["frame zero note"])
  })

  it("durably cancels a driver blocked in a tool before its side effect runs", async () => {
    const notes: Array<string> = []
    const status = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const toolStarted = yield* Deferred.make<void>()
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:cancelled-tool"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          // Wait until the first cell has entered `note/save`'s gate. This
          // makes the driver interruption deterministic rather than racing
          // the executor's asynchronous launch.
          yield* Deferred.await(toolStarted)
          // Cancelling must reach the durable engine, not merely change the
          // control row.
          yield* control.cancel({ runId: receipt.runId, idempotencyKey: "cancel:blocked-tool" })
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, void 0)
          yield* awaitStatus(runtime, receipt.runId, "cancelled")
          return (yield* runtime.getRun(receipt.runId)).status
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate, toolStarted })))
      }).pipe(Effect.scoped) as Effect.Effect<string>
    )

    expect(status).toBe("cancelled")
    expect(notes).toEqual([])
  })

  it("refuses a prompt flow that declares no seat, instead of leaving the run accepted", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "agents/seatless", input: {} })
          yield* control.approve(card.approval)
          const outcome = yield* Effect.exit(control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:seatless"
          }))
          const listed = yield* control.list({ _tag: "runs" })
          const runId = listed._tag === "runs" ? listed.items[0]?.runId : undefined
          return {
            refusal: Exit.isFailure(outcome)
              ? String(Cause.squash(outcome.cause))
              : "the launch was accepted",
            status: runId === undefined ? "no run" : (yield* runtime.getRun(runId)).status
          }
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<{ refusal: string; status: string }, unknown>
    )

    // A flow with no seat can never run on any agent host, so the refusal
    // names the line to add rather than parking the run at `accepted` under an
    // owner nobody is running (release rehearsal, D1).
    expect(result.refusal).toContain("agents/seatless declares no model seat")
    expect(result.refusal).toContain("model:")
    expect(result.status).toBe("failed")
  })

  it("leaves a module pending when the host has no executable catalog", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "agents/module", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:module"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const run = yield* runtime.getRun(receipt.runId)
          return run.status
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<string, unknown>
    )

    expect(result).toBe("accepted")
  })

  it.each(["test/Module", "test/OutsideEnvelope"])(
    "checks a registered module's approved delegation to %s",
    async (delegate) => {
      const seen: Array<unknown> = []
      const Read = Action.make("test/ModuleRead", {
        payload: { input: Schema.Json },
        success: Schema.Json,
        error: Schema.Never
      })
      const flow = Flow.make("agents/module", {
        payload: Executable.Payload,
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: ({ input }) => Read.call({ input: input ?? null }).pipe(Node.map((value) => ({ value })))
      })
      const catalog: Executable.Catalog = {
        executables: [{
          descriptor: moduleDescriptor,
          delegate,
          lowered: { cache: undefined, placement: undefined, priority: undefined },
          invocation: (input) => ({
            flow: moduleDescriptor.name,
            input,
            prompt: "",
            model: null,
            placement: null,
            placementOptions: null,
            capabilities: [],
            flows: ["test/Module"]
          }),
          flow,
          layer: Interpreter.layer(flow)
        }],
        refused: []
      }
      const registration = Layer.merge(
        Interpreter.layer(flow),
        Read.toLayer(({ input }) =>
          Effect.gen(function*() {
            seen.push(input)
            return input
          })
        )
      )
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const gate = yield* Deferred.make<void>()
          return yield* Effect.gen(function*() {
            const control = yield* Control.Control
            const runtime = yield* ControlRuntime.ControlRuntime
            const card = yield* control.plan({ flowId: "agents/module", input: { plan: { changes: ["native"] } } })
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: "run:native-module"
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die("expected admission")
            }
            const terminal = (): Effect.Effect<ControlSchema.RunStatus, unknown> =>
              Effect.gen(function*() {
                const run = yield* runtime.getRun(receipt.runId!)
                if (run.status === "completed" || run.status === "failed") return run.status
                yield* Effect.sleep("10 millis")
                return yield* terminal()
              })
            return yield* terminal().pipe(Effect.timeout("20 seconds"))
          }).pipe(Effect.provide(stack({
            gate,
            notes: [],
            resolve: () => Effect.die("a module must not resolve a model seat"),
            modules: { catalog, layer: registration }
          })))
        }).pipe(
          Effect.scoped,
          Effect.catch((error) => {
            if (delegate === "test/Module") return Effect.fail(error)
            expect(error).toMatchObject({ message: expect.stringContaining("outside the approved flow envelope") })
            return Effect.succeed("refused")
          })
        )
      )
      expect(result).toBe(delegate === "test/Module" ? "completed" : "refused")
      expect(seen).toEqual(delegate === "test/Module" ? [{ plan: { changes: ["native"] } }] : [])
    },
    30_000
  )

  it("journals a bounded cause when the model fails, for an empty and an absent input", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        const failing = Model.make({
          stream: () =>
            Stream.fail(
              new ModelError.ModelError({ code: "authentication", message: "invalid credential ".repeat(400) })
            )
        })
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const journal = yield* Journal.Journal
          const results: Array<{ readonly status: string; readonly failed: JournalEvent.Entry }> = []
          // One empty-object input and one null input: both render the bare
          // prompt, and both runs settle as failed when the provider errors.
          for (const input of [{}, null]) {
            const card = yield* control.plan({ flowId: "agents/notes", input })
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: `run:failing:${card.planId}`
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die("expected an accepted run")
            }
            yield* awaitStatus(runtime, receipt.runId, "failed")
            const page = yield* journal.entries({
              runId: JournalEvent.RunId.make(receipt.runId),
              limit: 100
            })
            const failed = page.entries.find((entry) => entry.eventType === "control.run.failed")
            if (failed === undefined) return yield* Effect.die("the failed run was not journaled")
            results.push({ status: (yield* runtime.getRun(receipt.runId)).status, failed })
          }
          return results
        }).pipe(Effect.provide(stack({ resolve: seat(failing), notes, gate, bare: true })))
      }).pipe(Effect.scoped) as Effect.Effect<
        ReadonlyArray<{ readonly status: string; readonly failed: JournalEvent.Entry }>,
        unknown
      >
    )

    expect(results.map((result) => result.status)).toEqual(["failed", "failed"])
    for (const result of results) {
      const payload = result.failed.payload as { readonly cause?: unknown }
      expect(typeof payload.cause).toBe("string")
      expect((payload.cause as string).length).toBe(4_096)
    }
  })

  it("requests the flow's declared effort, and the host default where a flow declares none", async () => {
    const requests: Array<ModelRequest.ModelRequest> = []
    // A model that records its request and then refuses: the effort travels
    // in the first frame's request, so the run never has to complete.
    const recording = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          requests.push(request)
          return Stream.fail(new ModelError.ModelError({ code: "authentication", message: "no credential" }))
        })
    })

    await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          for (const flowId of ["agents/notes", "agents/effort"]) {
            const card = yield* control.plan({ flowId, input: {} })
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: `run:effort:${flowId}`
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die("expected an accepted run")
            }
            // The durable event is the synchronization point. A bounded
            // `yieldNow` polling loop can exhaust while the run fiber is still
            // publishing its terminal projection on a busy test worker.
            yield* control.watch({ runId: receipt.runId }).pipe(
              Stream.filter((event) => event.kind === "control.run.failed"),
              Stream.take(1),
              Stream.runDrain
            )
            expect((yield* runtime.getRun(receipt.runId)).status).toBe("failed")
          }
        }).pipe(
          Effect.provide(
            stack({ resolve: seat(recording), notes, gate, bare: true, reasoningEffort: "medium" })
          )
        )
      }).pipe(Effect.scoped) as Effect.Effect<void, unknown>
    )

    expect(requests.map((request) => request.params.reasoningEffort)).toEqual(["medium", "low"])
  })

  it("refuses a launch whose seat cannot be resolved", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        const resolve: SeatResolver.Service["resolve"] = (seatId) =>
          Effect.fail(new Seat.SeatUnresolved({ seat: seatId, message: "No API key is configured" }))
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          return yield* Effect.flip(control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:unresolved"
          }))
        }).pipe(Effect.provide(stack({ resolve, notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<unknown>
    )

    expect(error).toBeInstanceOf(ControlError.LaunchFailed)
    expect((error as ControlError.LaunchFailed).message).toBe("No API key is configured")
  })
})
