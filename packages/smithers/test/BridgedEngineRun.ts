/**
 * The gateway read path over a run the engine executes AND reports.
 *
 * `@smthrs/gateway` `test/RealEngineRun.ts` is the nearest stack: a real
 * control plane, a real `@smthrs/flows` `NodeRuntime` engine, two SQLite
 * files. It deliberately omits the bridge between the two journals and its
 * suite asserts that absence, so a client watching one of its runs sees the
 * control lifecycle and none of the engine's own records.
 *
 * A deployed host does wire that bridge. `@smthrs/cli` `NativeControl` builds
 * an `EngineJournalSupervisor` over the engine journal and the control journal
 * and wraps the executor in it, which copies the engine's `flows.engine.*`
 * records into the control journal as `control.engine.event` envelopes. That
 * is the only reason node status can move on a card. This stack is that
 * topology, with a fixture flow chosen so the shapes a graph has to render are
 * all present in one run: a fan-out and a merge, a failure arm, a `HumanTask`
 * gate, an action that fails its first attempt, and a cacheable node.
 *
 * Why it lives in `@smthrs/cli` rather than beside `RealEngineRun.ts`:
 * `EngineJournalSupervisor` is `@smthrs/cli` `src/internal`, which the package
 * blocks from export (`"./internal/*": null`), and `@smthrs/gateway` cannot
 * depend on `@smthrs/cli`, which already depends on it. The supervisor is the
 * subject, so the suite moved to the supervisor.
 *
 * What is real: the control plane, the engine, both journals, both databases,
 * the bridge, the projections, and the ordering between them. Nothing is
 * stubbed below the control plane and no event is hand-journaled. What is not
 * real: the flow is a real `@smthrs/flow` `Flow` over real `Action`s rather
 * than an agent flow, because an agent flow needs a provider credential and a
 * stack that needed one could not run in the environments this proof matters
 * in.
 *
 * @since 1.0.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, HumanTask, Interpreter, RetryPolicy } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as Projections from "@smthrs/gateway/Projections"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import { NotificationQueue } from "@smthrs/notifications"
import * as Node from "@smthrs/plan/Node"
import * as Plan from "@smthrs/plan/Plan"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import * as TriggersDispatchReader from "@smthrs/triggers/DispatchReader"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import type * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Context, Effect, Layer, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as SourceRevision from "../src/internal/SourceRevision.ts"
import { makeAuthoringFixture, ScriptedAuthor } from "./AuthoringFixture.ts"

/**
 * The repository this fixture is declared in.
 *
 * A node record carries where its action was written, and the writer strips
 * this prefix before it journals the path (`@smthrs/engine-store`
 * `NodeJournal.relativePath`). The default prefix is the process working
 * directory, and this stack is started from three of them: `packages/smithers`
 * under vitest, `apps/app` under `scripts/flow-graph-e2e-host.ts`, and the
 * repository root under a bare `node`. Taking the default would record a
 * different path per caller, and from `apps/app` no path at all, because this
 * file is not under it. The root is therefore this file's own: two directories
 * up from `packages/smithers/test/`, which is the repository, so every host
 * records `packages/smithers/test/BridgedEngineRun.ts` and a reader can open
 * it.
 *
 * @since 1.0.0
 * @category constants
 */
export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")

/**
 * The revision this checkout is at, read once.
 *
 * A node record says where its action was declared; only this says which
 * bytes were at that line, and the stack records it beside every site it
 * reports — on the plan card's graph and on every page the engine journals —
 * exactly as a deployed host does (`@smthrs/cli` `NativeControl`). A checkout
 * under no version control names none, and then a reader is shown no code
 * rather than a file it cannot bind (D-068).
 *
 * Read lazily and kept, because it is a fact about this process: the modules
 * this stack drives were loaded from this tree at startup, and an edit
 * afterwards changes neither them nor this.
 *
 * @since 1.0.0
 * @category constructors
 */
let readRevision: { readonly value: string | undefined } | undefined
export const sourceRevision = (): string | undefined =>
  (readRevision ??= { value: SourceRevision.read(repositoryRoot) }).value

/**
 * The record the bridge writes once it has drained an execution's journal
 * after the engine's terminal commit.
 *
 * A suite waits for this rather than for the run's status: the status is
 * written by the control plane's own observation, and the copy runs on its own
 * fiber afterwards, so a read taken on the status races the records it is
 * about to assert over.
 *
 * @since 1.0.0
 * @category models
 */
export const bridgeSettledKind = EngineJournalSupervisor.settledKind

/**
 * The identity a call that crossed the relay arrives under.
 *
 * The browser holds no gateway credential; the relay holds it, and
 * `NativeGateway.layerAuth` stamps every request carrying it with this
 * principal. A decision a card makes therefore reaches the control plane as
 * the gateway, never as the local operator, which is what {@link stack}'s
 * approval authority has to know about.
 *
 * @since 1.0.0
 * @category models
 */
export const relayPrincipal = { ...NodeGateway.bearerPrincipal, stampedAt: 0 }

/**
 * The question the gate asks. A suite reads it back off the approvals row, so
 * it is exported rather than repeated.
 *
 * @since 1.0.0
 * @category models
 */
export const gatePrompt = "Merge the fan-out?"

/**
 * The flow the control plane plans, and the graph the plan hook keys.
 *
 * @since 1.0.0
 * @category models
 */
export const flowId = "gateway/GraphFixture"

/** One step that always succeeds: the fan-out's steady arm. */
const Steady = Action.make("gateway/graph/Steady", {
  payload: { label: Schema.String },
  success: Schema.String
})

/**
 * The step that fails its first attempt.
 *
 * The counter is injected by {@link stack}, so the failure is a property of
 * the composition under test rather than of a clock, a file, or the machine.
 */
const Flaky = Action.make("gateway/graph/Flaky", {
  payload: { label: Schema.String },
  success: Schema.String,
  error: Schema.String,
  retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 })
})

/** The step whose typed failure the catch arm recovers from. */
const Doomed = Action.make("gateway/graph/Doomed", {
  payload: { label: Schema.String },
  success: Schema.String,
  error: Schema.String
})

/**
 * The cacheable step, eligible by the engine's own rule.
 *
 * `@smthrs/engine-store` `CacheAdmission.declaration` admits a declaration to
 * the step cache on two facts and no others: the `sealed` tier, which
 * `Action.make` defaults to, and a `fileBoundary` whose `boundaryMode` is
 * `hard`. An idempotency key alone is not one of them — without the boundary
 * the declaration is `Disabled` for `missing-boundary` and
 * `ActionPersistence` never calls `cache.get` for it, so a fixture that
 * declared only the key would never reach the cache at all. The empty read and
 * write sets are what this step touches: nothing.
 *
 * `implementationVersion` is the semantic identity of the body behind that
 * key: `Interpreter.layerWithImplementations` refuses a sealed keyed action
 * without one, because such a declaration can reuse recorded content, and the
 * interpreter checks that the layer attests the same string either way.
 */
const Cacheable = Action.make("gateway/graph/Cacheable", {
  payload: { label: Schema.String },
  success: Schema.String,
  implementationVersion: "1",
  fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" },
  idempotencyKey: ({ label }: { readonly label: string }) => `gateway/graph/Cacheable:${label}`
})

/**
 * The gate, three `.child()` boundaries down, as
 * `NestedHumanWaitAcrossDatabases.test.ts` composes it: the wait is held by an
 * execution the control plane's database has never heard of, which is the
 * whole difficulty a card's approval row has to survive.
 */
const Ask = Flow.make("gateway/graph/Ask", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => HumanTask.action.call({ name: "graph-gate", kind: "ask", prompt: gatePrompt, maxAttempts: 3 })
})

const Gate = Flow.make("gateway/graph/Gate", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => Ask.child({})
})

/** Joins the fan-out's four arms into the run's one result. */
const merge = Node.capture(
  { separator: " " },
  function(members: {
    readonly steady: string
    readonly retried: string
    readonly recovered: string
    readonly cached: string
  }) {
    return [members.steady, members.retried, members.recovered, members.cached].join(this.separator)
  }
)

/**
 * The fixture graph: a gate, then a fan-out whose arms cover a retry, a
 * recovered failure and a cacheable step, then a merge.
 *
 * @since 1.0.0
 * @category models
 */
export const GraphFixture = Flow.make(flowId, {
  payload: { label: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ label }) =>
    Gate.child({}).pipe(
      Node.andThen(
        Node.all({
          steady: Steady.call({ label }),
          retried: Flaky.call({ label }),
          recovered: Doomed.call({ label }).pipe(
            Node.catch({ error: Schema.String, onFailure: () => Node.succeed("recovered") })
          ),
          cached: Cacheable.call({ label })
        }).pipe(Node.map(merge))
      )
    )
})

/**
 * The wrapper execution the control plane's run id names.
 *
 * `EngineJournalSupervisor` refuses to observe an execution that is not the
 * control run's recorded wrapper, and its identity test is exactly this shape:
 * the engine row's flow is `agent/run`, its payload carries the approved
 * `planId`, and it has no parent. `@smthrs/agent` `AgentSession` drives the
 * same wrapper for every agent run, so a fixture that skipped it would be
 * observed by nothing.
 */
const Wrapper = Flow.make("agent/run", {
  payload: { runId: Schema.String, planId: Schema.String, label: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ label }) => GraphFixture.child({ label })
})

/**
 * The schedule this host's dispatcher holds.
 *
 * A trigger is a Dispatcher registration and not a plan node (D-031), so it
 * lives in a trigger store rather than in the flow, and
 * `Control.list { _tag: "triggers" }` is the only way a client reads one. The
 * cron is a fixed daily occurrence in UTC, so the five upcoming fires a reader
 * computes from it are always in the future and never depend on when the suite
 * runs. Nothing polls it: this composition hosts no scheduler, so the schedule
 * is armed and stays armed, which is the state a card must be able to draw.
 *
 * @since 1.0.0
 * @category models
 */
export const fixtureSchedule: Trigger.Trigger = {
  id: "graph-fixture-nightly",
  flowId,
  input: { label: "nightly" },
  cron: "0 3 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 0,
  enabled: true
}

/** The control input the card is planned from. */
interface FixtureInput {
  readonly label: string
}

const inputOf = (input: unknown): FixtureInput => ({
  label: typeof (input as FixtureInput | undefined)?.label === "string" ? (input as FixtureInput).label : "fixture"
})

/**
 * The plan hook the flow record carries: build the graph, key it, report every
 * node as `run`.
 *
 * Planning performs no I/O, so this is a pure function of the input, which is
 * what `MemoryFlow.plan` asks for. The statuses are omitted rather than
 * guessed: this composition holds no step cache to read a `cached` verdict off,
 * and a guessed verdict is a claim about work nothing measured.
 *
 * @since 1.0.0
 * @category constructors
 */
export const plan = (input: unknown, planId: string) =>
  Plan.compile({
    planId,
    flow: flowId,
    nodes: Graph.drafts(Graph.build(GraphFixture, inputOf(input)))
  })

/**
 * The built graph as a plan card may carry it: the labelled edges, and where
 * each node was declared.
 *
 * `PlanNode.dependsOn` is one unlabelled edge set, so a card built from it
 * alone cannot tell a value dependency from the catch arm, and carries no
 * declaration site at all — which is why a plan node had no Code tab on this
 * host while the run's graph of the same flow had one. A deployed host
 * reports both (`@smthrs/cli` `NativeControl.buildPlanGraph`), and this is
 * the same two lines under the same rule: the path is made relative to
 * {@link repositoryRoot} with `@smthrs/journal`'s own rule, and a site that
 * rule cannot place is omitted rather than guessed at. Structural nodes the
 * builder synthesised (`root.flow.then.map` and its kin) were declared
 * nowhere and carry none, so their Code tab stays absent.
 *
 * @since 1.0.0
 * @category constructors
 */
export const planGraph = (input: unknown): {
  readonly edges: ReadonlyArray<Graph.Edge>
  readonly nodes: ReadonlyArray<
    { readonly id: string; readonly declaredAt?: { readonly path: string; readonly line: number } }
  >
  readonly sourceRevision?: string
} => {
  const built = Graph.build(GraphFixture, inputOf(input))
  const revision = sourceRevision()
  return {
    edges: Graph.edges(built),
    nodes: Graph.nodes(built).map((node) => {
      const path = node.declaredAt === undefined
        ? undefined
        : EngineEvent.relativePath(repositoryRoot, node.declaredAt.path)
      return { id: node.id, ...(path === undefined ? {} : { declaredAt: { path, line: node.declaredAt!.line } }) }
    }),
    /* The tree those sites were read out of, when this checkout names one. */
    ...(revision === undefined ? {} : { sourceRevision: revision })
  }
}

/**
 * The plan the card reports, built outside the control plane.
 *
 * A suite compares two of these to read `@smthrs/plan` `PlanDiff`'s verdict on
 * whether the same input keys the same graph.
 *
 * @since 1.0.0
 * @category constructors
 */
export const planOf = (
  input: FixtureInput,
  planId: string
): Effect.Effect<Plan.Plan, unknown, never> =>
  plan(input, planId).pipe(Effect.provide(NodeCrypto.layer)) as Effect.Effect<Plan.Plan, unknown, never>

/**
 * The host policy that lets a relayed decision through.
 *
 * `NativeControl.ts:429-431` installs exactly this pair whenever its gateway
 * is configured with a credential: the local operator keeps its decisions, and
 * the gateway's authenticated identity is delegated the same ones. A stack
 * that kept `ApprovalAuthority.local` would plan, list and run over the relay
 * and refuse the one call that launches anything.
 */
const approvalAuthority = Effect.runSync(ApprovalAuthority.make([
  { principal: { id: "local", kind: "operator" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] },
  { principal: NodeGateway.bearerPrincipal, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
]))

/** The one flow the control plane may plan, declared the way a host declares it. */
const durableFlow: DurableFlow = {
  flowId,
  description: "The flow graph suite's fixture flow",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  plan: (input, planId) =>
    plan(input, planId).pipe(
      Effect.map((compiled) => ({ plan: compiled, graph: planGraph(input) })),
      Effect.provide(NodeCrypto.layer),
      Effect.orDie
    )
}

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; this graph's actions are sealed, so a stub keeps the wiring honest
 * without requiring a `jj` binary on the machine running the suite.
 */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "graph-fixture" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** A fresh directory holding both SQLite files, removed when the scope closes. */
const databaseDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "smthrs-flow-graph-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
)

/** Journal, run store and writer over one real SQLite file. */
const controlStorage = (filename: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 4096, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        Layer.merge(JournalMigrations.layer, RunStoreMigrations.layer),
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
      )
    )
  )

/**
 * The ENGINE's database: its own file, its own migrations, its own singletons.
 *
 * `Layer.fresh` wraps the whole storage graph for the reason `NativeControl`
 * gives: every store layer here is a singleton, and one shared memo map would
 * otherwise hand the engine the control plane's instances over the other
 * database, which is one database again and not the topology under test.
 */
const engineStorage = (filename: string) =>
  Layer.fresh(
    Layer.mergeAll(
      SqlJournal.layer({ capacity: 4096, overflow: "reject" }),
      RunStore.layer,
      AttemptStore.layer,
      CacheStore.layer,
      DurableEngineState.layer
    ).pipe(
      Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
      Layer.provideMerge(
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename })).pipe(
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

/**
 * What each fixture action did, so a suite reads dispatch counts rather than
 * inferring them from timing.
 *
 * @since 1.0.0
 * @category models
 */
export interface Dispatches {
  /** How many times each action's implementation was entered, by action name. */
  readonly counts: Map<string, number>
}

/**
 * The engine, reachable from the control plane's side and nothing else.
 *
 * Only these closures cross back, as only the executor crosses back in a host
 * composition. The engine's `RunStore` and `DurableEngineState` stay inside: a
 * control plane that could see them would not be the topology under test.
 *
 * @since 1.0.0
 * @category models
 */
export class Engine extends Context.Service<Engine, {
  /** Starts the wrapper execution under `runId`, the way a driver starts one. */
  readonly start: (runId: string, planId: string, label: string) => Effect.Effect<void>
  /** The engine's own journal, which the bridge reads and nothing else may. */
  readonly journal: Journal.Service
  /** The engine's own run store, which the bridge reads wrapper identity from. */
  readonly runs: RunStore.Service
  /** The engine's own durable state, which the bridge reads lineage from. */
  readonly state: DurableEngineState.Service
  /** The production observation port, over both stores. */
  readonly observe: (runId: string) => Effect.Effect<ControlExecutor.ExecutionObservation>
  /** The production signal port. */
  readonly deliverSignal: (input: ControlExecutor.Signal) => Effect.Effect<ControlExecutor.SignalDelivery>
  /** Polls until an execution BELOW `runId` is parked on a human wait. */
  readonly parkedBelow: (runId: string) => Effect.Effect<DurableEngineState.WaitingRow>
  /** Polls until the wrapper execution reaches a terminal status, and reports it. */
  readonly settled: (runId: string) => Effect.Effect<string>
  /** The event kinds the ENGINE journaled for one execution. */
  readonly kinds: (executionId: string) => Effect.Effect<ReadonlyArray<string>>
  /** How many times each fixture action ran. */
  readonly dispatches: Dispatches
}>()("smithers/test/GraphFixtureEngine") {}

/** Counts a dispatch and returns what the action produces. */
const counted = (dispatches: Dispatches, name: string): number => {
  const next = (dispatches.counts.get(name) ?? 0) + 1
  dispatches.counts.set(name, next)
  return next
}

/** The fixture's action implementations, over one shared dispatch counter. */
const implementations = (dispatches: Dispatches) =>
  Layer.mergeAll(
    Steady.toLayer(({ label }: { readonly label: string }) =>
      Effect.sync(() => {
        counted(dispatches, "steady")
        return `steady:${label}`
      })
    ),
    // The first attempt fails; the retry policy admits a second, which
    // succeeds. The counter is what decides, so the failure is reproducible.
    Flaky.toLayer(({ label }: { readonly label: string }) =>
      Effect.suspend(() =>
        counted(dispatches, "flaky") === 1
          ? Effect.fail("the first attempt always fails")
          : Effect.succeed(`flaky:${label}`)
      )
    ),
    Doomed.toLayer(({ label }: { readonly label: string }) =>
      Effect.suspend(() => {
        counted(dispatches, "doomed")
        return Effect.fail(`doomed:${label}`)
      })
    ),
    Cacheable.toLayer(
      ({ label }: { readonly label: string }) =>
        Effect.sync(() => {
          counted(dispatches, "cacheable")
          return `cacheable:${label}`
        }),
      // The declaration's version, attested. A mismatch is refused before the
      // graph is dispatched, so the pair has to be written together.
      { implementationVersion: "1" }
    )
  )

/**
 * What a host declares about itself, and the one thing a cross-run cache hit
 * needs that no host in this repo wires today.
 *
 * `@smthrs/engine` `FlowEngine/ActionKey.actionKey` folds the execution id
 * into every sealed keyed dispatch while `Action.CurrentCacheEnvironment` is
 * absent, so the row one run records is addressed by an identity no later run
 * can spell. Declaring the environment is what turns that key from `run` into
 * `cache`. It is complete-or-absent by contract, so this is a value a
 * composition supplies, never one the fixture invents.
 *
 * @since 1.0.0
 * @category models
 */
export interface StackOptions {
  /** The complete runtime environment this composition declares. Absent by default. */
  readonly cacheEnvironment?: Action.CacheEnvironment | undefined
  /** Add the source-writing fixture in an isolated, owned workspace. */
  readonly authoring?: boolean
}

/*
 * WHY THE AUTHORING HALF STILL HAS A WRAPPER.
 *
 * Not the loader. D-076 closed that: discovery and `Executable` accept an
 * agent-authored `@smthrs/flow` graph, and the plan a production host answers
 * with for one is the file's own nodes. What this stack cannot do is REGISTER
 * one. Its engine layer registers every flow when it is built, so a flow
 * discovered after startup has nowhere to go; a production host composes
 * `Executable.layerRefreshable`, which registers a rebuilt body into a
 * running runtime, and this fixture composes its flows by hand. Replacing the
 * wrapper therefore means giving this stack that registration, not deleting
 * three lines.
 */
const engineLayer = (filename: string, dispatches: Dispatches, options: StackOptions, authoring?: ReturnType<typeof makeAuthoringFixture>) => {
  const wrapper = authoring === undefined ? Wrapper : Flow.make("agent/run", {
    payload: { runId: Schema.String, planId: Schema.String, label: Schema.String }, success: Schema.Unknown, error: Schema.Unknown,
    body: ({ planId, label }) => authoring.node(planId) ?? GraphFixture.child({ label })
  })
  return Layer.effect(Engine)(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const journal = yield* Journal.Journal
      const runs = yield* RunStore.RunStore
      const services = yield* Effect.context<Effect.Services<ReturnType<typeof Wrapper.execute>>>()
      const settled = (runId: string, attempts = 20_000): Effect.Effect<string> =>
        Effect.gen(function*() {
          // Control accepts before the forked engine launch creates its row.
          // Absence is still launching, not a failed execution or a reason to
          // repeat the launch. Other storage errors must remain failures.
          const row = yield* runs.get(runId).pipe(Effect.catch(error =>
            error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.die(error)))
          if (row !== undefined && !["suspended", "running", "pending"].includes(row.status)) return row.status
          if (attempts <= 0) return yield* Effect.die(`execution ${runId} did not settle`)
          yield* Effect.sleep("2 millis")
          return yield* settled(runId, attempts - 1)
        })
      const parkedBelow = (
        runId: string,
        attempts = 20_000
      ): Effect.Effect<DurableEngineState.WaitingRow> =>
        Effect.gen(function*() {
          const open = yield* state.waitingTree(runId)
          const human = open.find((row) => row.reason === "approval" && row.runId !== runId)
          if (human !== undefined) return human
          if (attempts <= 0) return yield* Effect.die(`no execution below ${runId} parked on a human wait`)
          yield* Effect.sleep("2 millis")
          return yield* parkedBelow(runId, attempts - 1)
        })
      return {
        start: (runId: string, planId: string, label: string) =>
          Effect.provideContext(
            Effect.asVoid(wrapper.execute({ runId, planId, label }, { executionId: runId, discard: true })),
            services
          ) as Effect.Effect<void>,
        observe: (runId: string) =>
          Effect.orDie(
            AgentSession.readExecution(runId).pipe(
              Effect.provideService(RunStore.RunStore, runs),
              Effect.provideService(DurableEngineState.DurableEngineState, state)
            )
          ) as Effect.Effect<ControlExecutor.ExecutionObservation>,
        deliverSignal: (input: ControlExecutor.Signal) =>
          Effect.orDie(AgentSession.deliverSignal(input)) as Effect.Effect<ControlExecutor.SignalDelivery>,
        parkedBelow,
        settled,
        journal,
        runs,
        state,
        kinds: (executionId: string) =>
          journal.entries({ runId: executionId as never, limit: 2000 }).pipe(
            Effect.map((page) => page.entries.map((entry) => entry.eventType)),
            Effect.orDie
          ),
        dispatches
      }
    })
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        HumanTask.layer,
        Interpreter.layer(wrapper),
        ...(authoring === undefined ? [] : [Interpreter.layer(ScriptedAuthor)]),
        Interpreter.layer(GraphFixture),
        Interpreter.layer(Gate),
        Interpreter.layer(Ask)
      ).pipe(
        Layer.provideMerge(Layer.merge(implementations(dispatches), authoring?.implementations ?? Layer.empty)),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(
          EngineStore.layer({
            owner: { hostId: "graph-fixture-suite" },
            journalSource: "graph-fixture-suite",
            declarationRoot: repositoryRoot,
            // The same revision the plan carries: this stack drives the
            // modules it loaded from this tree (D-068).
            sourceRevision: sourceRevision(),
            isAlive: () => Effect.succeed(false)
          })
        ),
        Layer.provideMerge(Layer.mergeAll(authoring?.filesystem ?? StepBoundary.layerTest(), stubJj, OwnerIdentity.layer)),
        // The declaration a host makes about the machine its results were
        // computed on, or nothing at all. `Dispatch.ts:69` reads it off the
        // context the engine captures here, so it has to sit under the engine
        // rather than beside it.
        Layer.provideMerge(
          options.cacheEnvironment === undefined
            ? Layer.empty
            : Action.layerCacheEnvironment(options.cacheEnvironment)
        ),
        Layer.provideMerge(engineStorage(filename))
      )
    )
  )
}

/**
 * The acceptance and observation ports, answered by the engine and observed by
 * the bridge.
 *
 * `NativeControl` composes exactly this: build the supervisor over the two
 * journals, fork its recovery, and return the executor it wraps. The wrap is
 * what starts an observation for each accepted launch, and the observation is
 * what copies the engine's records into the control journal.
 */
const executor = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const engine = yield* Engine
    const scope = yield* Effect.scope
    // The bridge's engine side comes off the `Engine` service rather than the
    // ambient context, for the reason `NestedHumanWaitAcrossDatabases.test.ts`
    // gives: only the executor crosses back in a host composition, and an
    // ambient `Journal` or `RunStore` here is the CONTROL plane's.
    const supervisor = yield* EngineJournalSupervisor.make({
      engineJournal: engine.journal,
      controlJournal: yield* Journal.Journal,
      engineState: engine.state,
      runs: engine.runs,
      control: yield* ControlRuntime
    })
    yield* Effect.forkScoped(supervisor.recover)
    return supervisor.wrap(ControlExecutor.makeNoop({
      readExecution: (runId) => engine.observe(runId),
      deliverSignal: (input) => engine.deliverSignal(input),
      // Started and not awaited, as a host starts an accepted launch: the run
      // parks on its gate, and acceptance is not its settlement.
      launch: (input) =>
        Effect.as(
          Effect.forkIn(
            engine.start(
              input.run.runId,
              input.run.planId ?? "",
              inputOf((input.plan as { readonly decodedInput?: unknown }).decodedInput).label
            ),
            scope
          ),
          "accepted" as const
        )
    }))
  })
)

/**
 * The dispatcher this host serves: a real trigger store over the control
 * plane's own database, holding {@link fixtureSchedule}.
 *
 * `Control.list` answers `triggers` and `fires` through
 * `@smthrs/control` `DispatchReader`, and a composition that provides none
 * REFUSES both listings rather than answering an empty page — an empty page
 * would say this host has no schedules, which is a different statement from
 * "this host cannot read whether it has any". The adapter is
 * `@smthrs/triggers`' own, over the same store the CLI's scheduler writes, so
 * the rows a client reads here are the rows a deployed box answers with.
 */
const dispatcher = TriggersDispatchReader.layer.pipe(
  Layer.provide(
    Layer.effectDiscard(
      Effect.flatMap(TriggerStore.TriggerStore, (store) => Effect.orDie(store.register(fixtureSchedule)))
    ).pipe(Layer.provideMerge(Layer.orDie(SqlTriggerStore.layer)))
  )
)

/**
 * The bridged stack: the gateway read path, a control plane whose executor is
 * the engine, and the supervisor that copies the engine's journal into the
 * control journal.
 *
 * Each call builds its own pair of databases and its own dispatch counter, so
 * a suite that wants two of them gets two independent hosts.
 *
 * @since 1.0.0
 * @category layers
 */
export const stackWith = (options: StackOptions = {}) =>
  Layer.unwrap(
    Effect.map(databaseDirectory, (directory) => {
      const dispatches: Dispatches = { counts: new Map<string, number>() }
      const authoring = options.authoring ? makeAuthoringFixture(join(directory, "workspace")) : undefined
      return Projections.layerWith({ heartbeatMillis: 50 }).pipe(
        Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
        Layer.provideMerge(ControlLive.layer),
        // The executor reads the control plane it observes: `ControlRuntime` for
        // the bridge's wrapper identity check and the CONTROL journal for the
        // records a client watching the run reads. Sibling layers cannot see
        // each other, so it is provided them rather than merged beside them.
        Layer.provideMerge(
          executor.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                SqlControlRuntime.layer({ flows: [durableFlow, ...(authoring?.flows ?? [])], approvalAuthority }).pipe(Layer.orDie),
                NotificationQueue.layer,
                Registry.layerNoop(),
                dispatcher
              ).pipe(Layer.provideMerge(Layer.merge(controlStorage(join(directory, "control.db")), NodeCrypto.layer)))
            )
          )
        ),
        Layer.provideMerge(engineLayer(join(directory, "engine.db"), dispatches, options, authoring))
      )
    })
  )

/**
 * The bridged stack as every host in this repo composes it: no declared cache
 * environment, so every sealed key is scoped to its run.
 *
 * @since 1.0.0
 * @category layers
 */
export const stack = stackWith()
