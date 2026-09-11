/**
 * One pipeline flow run, projected onto a single `flow-run` card.
 *
 * `POST /api/flows/run` answers with an execution id and nothing else, so this
 * is where the run's progress becomes visible. Every step transition rewrites
 * the same card and emits it as a `card.update` frame. `AppSession` persists
 * each version under the card's id, so `GET /api/session?id=` always returns
 * the latest one and a shell that reloads mid-run sees where the run got to.
 *
 * The card id is the execution id. A run therefore owns exactly one card for
 * its whole life, which is what makes `card.update` the right frame: the shell
 * replaces a card it already has rather than growing the transcript per step.
 *
 * Like `turnImpl.ts`, this ships only the mock path.
 * `env.APP_MOCK_TURN !== "0"` walks the stages without calling a model; `"0"`
 * asks for the live path, which does not run under workerd yet, so the card
 * settles `failed` with the reasons `liveRuntimeUnsupported` in
 * `worker/turnImpl.ts` states.
 */
import type { AgentSpec, AnyFlowSpec, SandboxSpec, ToolsSpec } from "@smthrs/create-app/app"
import type { FlowRunCard } from "@smthrs/create-app/ui"
import type { FlowRunRequest, TurnFrame } from "../src/api.ts"
import type { Env } from "./env.ts"
import { liveRuntimeUnsupported } from "./turnImpl.ts"

/** How a run ended, which is what the session's row in the Recent column reports. */
export type Phase = FlowRunCard["phase"]

/** One row of the card's step list. */
export type Step = FlowRunCard["steps"][number]

/** One routed flow, as `routes.gen.ts` records it. */
export interface FlowRoute {
  readonly id: string
  readonly spec: AnyFlowSpec
  readonly agent: AgentSpec
  readonly sandbox: SandboxSpec
  readonly tools: ToolsSpec
}

/**
 * Loads the routed flows a run resolves `flowId` against.
 *
 * Injectable for the reason `TurnLoader` is (`worker/turn.ts`): `routes.gen.ts`
 * imports every flow module, every layer file, and every tool module the app
 * declares — the chain tools and their `tevm` dependency included — so a test of
 * what a run emits would otherwise need the whole app's dependency tree
 * installed, and this module is the one place the API's own suite could not
 * reach without it. `AppSession` passes nothing and gets the generated table
 * through the default, which is a dynamic import for the same reason
 * `AppSession` imports this module dynamically: the table is only needed once a
 * run starts.
 */
export type RoutesLoader = () => Promise<ReadonlyArray<FlowRoute>>

const generatedRoutes: RoutesLoader = async () =>
  (await import("../routes.gen.ts")).flows as unknown as ReadonlyArray<FlowRoute>

export interface FlowRunOptions {
  readonly env: Env
  readonly request: FlowRunRequest
  /** The card id as well as the run id; see the module comment. */
  readonly executionId: string
  /** Aborted by `POST /api/agent/turn/cancel`. */
  readonly signal: AbortSignal
  readonly emit: (frame: TurnFrame) => void
  /** Defaults to the generated table; see {@link RoutesLoader}. */
  readonly routes?: RoutesLoader | undefined
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * The one card a run writes, and the only thing that writes it.
 *
 * Steps are held here rather than rebuilt per frame because a step's status
 * moves twice (pending to running to settled) and the frame has to carry the
 * whole list each time: `card.update` replaces a card, it does not patch one.
 */
class RunCard {
  private steps: Array<Step> = []

  constructor(
    private readonly flowId: string,
    private readonly executionId: string,
    private readonly emit: (frame: TurnFrame) => void
  ) {}

  /** Declares the steps up front, all pending, so the shell can size the list. */
  plan(names: ReadonlyArray<string>): void {
    this.steps = names.map((name) => ({ name, status: "pending" }))
    this.update("running")
  }

  /** Moves one step to a new status and republishes the card. */
  step(name: string, status: Step["status"]): void {
    const index = this.steps.findIndex((step) => step.name === name)
    if (index === -1) this.steps.push({ name, status })
    else this.steps[index] = { name, status }
    this.update("running")
  }

  /**
   * Ends the run.
   *
   * A step still marked `running` when the run ends would leave a spinner the
   * shell has no way to clear, so an unsettled step inherits the run's fate.
   */
  settle(phase: Phase, extra: { readonly result?: unknown; readonly error?: string } = {}): Phase {
    const settled: Step["status"] = phase === "completed" ? "done" : "failed"
    this.steps = this.steps.map((step) =>
      step.status === "pending" || step.status === "running" ? { name: step.name, status: settled } : step
    )
    this.update(phase, extra)
    return phase
  }

  /** Replaces the whole card. `steps` is copied so a later mutation cannot reach it. */
  private update(phase: Phase, extra: { readonly result?: unknown; readonly error?: string } = {}): void {
    this.emit({
      type: "card.update",
      card: {
        kind: "flow-run",
        id: this.executionId,
        flowId: this.flowId,
        executionId: this.executionId,
        phase,
        steps: [...this.steps],
        ...(extra.result === undefined ? {} : { result: extra.result }),
        ...(extra.error === undefined ? {} : { error: extra.error })
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Runs one pipeline flow and returns the phase it ended on.
 *
 * The caller (`AppSession.driveFlow`) turns that phase into the session's
 * status. A throw from here is the caller's to render, and it writes its own
 * failed card for it; every path this function handles itself settles the card
 * before returning.
 */
export const runFlowRun = async (options: FlowRunOptions): Promise<Phase> => {
  const card = new RunCard(options.request.flowId, options.executionId, options.emit)
  const routes = await (options.routes ?? generatedRoutes)()
  const route = routes.find((candidate) => candidate.id === options.request.flowId)
  // The router refuses an unrouted flow before the object is woken
  // (`worker/router.ts`, `flowRunRefusal`). This repeats the check because
  // `AppSession.runFlow` is also reachable from a Durable Object stub call,
  // which does not pass through the router.
  if (route === undefined) {
    return card.settle("failed", { error: `No flow is routed as "${options.request.flowId}".` })
  }
  // `APP_MOCK_TURN=0` is refused rather than started, for the same reasons
  // the turn path names. A run that dies inside the sandbox
  // loader tells a deployer nothing; the shared message tells them what to
  // wait for.
  if (options.env.APP_MOCK_TURN === "0") {
    return card.settle("failed", { error: liveRuntimeUnsupported })
  }
  return mockRun(options, route, card)
}

// ---------------------------------------------------------------------------
// The mock run
// ---------------------------------------------------------------------------

/**
 * The stages a mock run walks, per flow.
 *
 * A flow spec declares no stage list. The build pipeline names its stages in
 * `flows/build/AGENT.ts` and returns them in `BuildPlan.steps`, so they are
 * repeated here; any other flow gets a single step named after itself.
 *
 * TODO(milestone-3): this table goes away with the mock path. A live run reads
 * its steps from the flow's own output, as `BuildPlan.steps` declares them.
 */
const MOCK_STEPS: Readonly<Record<string, ReadonlyArray<string>>> = {
  build: ["describe", "plan", "generate", "validate", "smoke"]
}

const mockSteps = (flowId: string): ReadonlyArray<string> => MOCK_STEPS[flowId] ?? [flowId]

/**
 * The milestone-1 run: every stage settles, no model is called.
 *
 * It exists so the Recent column, the `flow-run` card, and cancel are all
 * reachable before the agent path lands. Cancellation is checked between
 * stages, which is the same granularity the live path gets from the engine.
 */
const mockRun = async (options: FlowRunOptions, route: FlowRoute, card: RunCard): Promise<Phase> => {
  const names = mockSteps(route.id)
  card.plan(names)
  for (const name of names) {
    if (options.signal.aborted) return card.settle("cancelled")
    card.step(name, "running")
    card.step(name, "done")
  }
  return card.settle("completed", {
    result: { flowId: route.id, payload: options.request.payload, steps: names }
  })
}
