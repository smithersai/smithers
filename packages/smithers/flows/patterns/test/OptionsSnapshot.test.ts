import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as PlanNode from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Bounded from "../src/Bounded.vibe"
import * as CheckSuite from "../src/CheckSuite.vibe"
import * as Debate from "../src/Debate.vibe"
import * as DelegationChain from "../src/DelegationChain.vibe"
import * as DriftDetector from "../src/DriftDetector.vibe"
import * as Escalation from "../src/Escalation.vibe"
import * as Intervene from "../src/Intervene.vibe"
import * as MapReduce from "../src/MapReduce.vibe"
import * as Optimizer from "../src/Optimizer.ts"
import * as Panel from "../src/Panel.vibe"
import * as Pattern from "../src/Pattern.vibe"
import * as Quarantine from "../src/Quarantine.vibe"
import * as Recursion from "../src/Recursion.vibe"
import * as ReviewLoop from "../src/ReviewLoop.vibe"
import * as Runbook from "../src/Runbook.ts"
import * as ScanFixVerify from "../src/ScanFixVerify.vibe"
import * as Sidecar from "../src/Sidecar.vibe"
import * as Trellis from "../src/Trellis.vibe"

// Every field any pattern here hands a member, as the one struct a
// `@smthrs/flow` flow states. Two flows a plan can tell apart: a flow's tag
// and capabilities enter the key material of every call to it, so a swapped
// collaborator is a changed graph whenever the swap reaches the declaration.
const memberFields = {
  input: Schema.optional(Schema.Unknown),
  previous: Schema.optional(Schema.Unknown),
  iteration: Schema.optional(Schema.Unknown),
  value: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  level: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  review: Schema.optional(Schema.Unknown),
  round: Schema.optional(Schema.Unknown),
  issue: Schema.optional(Schema.Unknown),
  index: Schema.optional(Schema.Unknown),
  issues: Schema.optional(Schema.Unknown),
  fixes: Schema.optional(Schema.Unknown),
  baseline: Schema.optional(Schema.Unknown),
  snapshot: Schema.optional(Schema.Unknown),
  comparison: Schema.optional(Schema.Unknown),
  phase: Schema.optional(Schema.Unknown),
  context: Schema.optional(Schema.Unknown),
  proposal: Schema.optional(Schema.Unknown),
  applied: Schema.optional(Schema.Unknown),
  dryRun: Schema.optional(Schema.Unknown),
  step: Schema.optional(Schema.Unknown),
  risk: Schema.optional(Schema.Unknown),
  elevated: Schema.optional(Schema.Unknown),
  goal: Schema.optional(Schema.Unknown),
  seat: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.Unknown),
  prompt: Schema.optional(Schema.Unknown),
  plan: Schema.optional(Schema.Unknown),
  leaves: Schema.optional(Schema.Unknown),
  leaf: Schema.optional(Schema.Unknown),
  stage: Schema.optional(Schema.Unknown),
  tier: Schema.optional(Schema.Unknown),
  budget: Schema.optional(Schema.Unknown),
  deriskExhausted: Schema.optional(Schema.Unknown),
  shard: Schema.optional(Schema.Unknown),
  mapped: Schema.optional(Schema.Unknown),
  check: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Unknown),
  position: Schema.optional(Schema.Unknown),
  transcript: Schema.optional(Schema.Unknown),
  proponent: Schema.optional(Schema.Unknown),
  opinions: Schema.optional(Schema.Unknown),
  role: Schema.optional(Schema.Unknown),
  column: Schema.optional(Schema.Unknown),
  item: Schema.optional(Schema.Unknown),
  items: Schema.optional(Schema.Unknown),
  board: Schema.optional(Schema.Unknown),
  primary: Schema.optional(Schema.Unknown),
  shadow: Schema.optional(Schema.Unknown),
  children: Schema.optional(Schema.Unknown),
  reason: Schema.optional(Schema.Unknown),
  scope: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown)
}

const flowNamed = (name: string) =>
  Flow.make(name, {
    payload: memberFields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    capabilities: [name],
    // Captured, so two fixtures built from the same name key the same way: a
    // bare arrow takes process-local `sha256-source-ephemeral/v4` identity and
    // a declaration rebuilt from fresh options would never match the first.
    body: PlanNode.capture({ name }, ({ input }: { readonly input?: unknown }) => PlanNode.succeed(input))
  })

const step = flowNamed("step")
const other = flowNamed("other")

const runtimeStep = step
const runtimeOther = other

// An approval member answers the literal `Pattern.Approved`, and states
// exactly the payload the approval slot declares, because `Pattern.bind`
// compares the two schemas.
const approving = (name: string) =>
  Flow.make(name, {
    payload: { input: Schema.Unknown, reason: Schema.String, scope: Schema.String },
    success: Pattern.Approved,
    error: Schema.Unknown,
    body: PlanNode.capture({ name }, () => PlanNode.succeed("approved" as const))
  })

// Every node's kind and key material body, which is where a changed option has
// to show up. `implementation` is dropped because a decorator a pattern builds
// inside `make` can carry a per-instance body digest that never matches across
// two calls.
const shape = (flow: Flow.Any, input: unknown): unknown =>
  JSON.parse(
    JSON.stringify(
      Graph.nodes(Graph.build(flow, input)).map((node) => [node.kind, node.draft.material.body]),
      (key, value: unknown) => key === "implementation" ? undefined : value
    )
  )

interface Declaration {
  readonly name: string
  /** Builds the declaration from fresh options and hands back the edit to make afterwards. */
  readonly declare: () => { readonly shape: () => unknown; readonly mutate: () => void }
  /** The shape of the declaration built from fresh options. */
  readonly fresh: () => unknown
  /** The shape of the declaration built from options that already carry the edit. */
  readonly edited: () => unknown
}

const snapshotted = <O, F>(
  name: string,
  input: unknown,
  options: () => O,
  make: (options: O) => F,
  mutate: (options: O) => void,
  shape: (flow: F, input: unknown) => unknown
): Declaration => ({
  name,
  declare: () => {
    const live = options()
    const flow = make(live)
    return { shape: () => shape(flow, input), mutate: () => mutate(live) }
  },
  fresh: () => shape(make(options()), input),
  edited: () => {
    const live = options()
    mutate(live)
    return shape(make(live), input)
  }
})

/** A pattern declaration, read off `@smthrs/flow`'s graph. */
const ported = <O, F extends Flow.Any>(
  name: string,
  input: unknown,
  options: () => O,
  make: (options: O) => F,
  mutate: (options: O) => void
): Declaration => snapshotted(name, input, options, make, mutate, shape)

const tree = { input: "root", children: [{ input: "left" }, { input: "right" }] }

// Every edit a caller can make after `make` returned: swapped collaborator
// flows, re-pointed nested records, widened or narrowed bounds, and changed
// policies. Each case's edit is one the declaration reacts to, which the test
// proves by building the edited options fresh.
const declarations: ReadonlyArray<Declaration> = [
  ported(
    "Debate.make",
    { input: "topic" },
    () => ({ proponent: runtimeStep, opponent: runtimeStep, judge: runtimeStep, rounds: 1 }),
    (options) => Debate.make(options),
    (options) => {
      options.proponent = runtimeOther
      options.opponent = runtimeOther
      options.judge = runtimeOther
      options.rounds = 2
    }
  ),
  ported(
    "Panel.make",
    { input: "question" },
    () => ({
      panelists: { a: runtimeStep, b: runtimeStep } as Record<string, typeof runtimeStep>,
      moderator: runtimeStep,
      roles: { a: "critic" } as Record<string, string>,
      concurrency: 1
    }),
    (options) => Panel.make(options),
    (options) => {
      options.panelists.a = runtimeOther
      options.panelists.c = runtimeOther
      options.moderator = runtimeOther
      options.roles.a = "fan"
      options.roles.b = "judge"
      options.concurrency = 2
    }
  ),
  ported(
    "Escalation.make",
    { input: "request" },
    () => ({
      rungs: [{ flow: step, escalateIf: step }, step] as Array<
        { flow: typeof step; escalateIf: typeof step } | typeof step
      >,
      accept: step,
      fallback: step
    }),
    (options) => Escalation.make(options),
    (options) => {
      const first = options.rungs[0] as { flow: typeof step; escalateIf: typeof step }
      first.flow = other
      first.escalateIf = other
      options.rungs.push(other)
      options.accept = other
      options.fallback = other
    }
  ),
  ported(
    "ReviewLoop.make",
    { input: "draft" },
    () => ({ produce: step, review: step, revise: step, maxRounds: 1 }),
    (options) => ReviewLoop.make(options),
    (options) => {
      options.produce = other
      options.review = other
      options.revise = other
      options.maxRounds = 2
    }
  ),
  ported(
    "MapReduce.make",
    { shards: ["a", "b"] },
    () => ({
      map: runtimeStep,
      reduce: runtimeStep,
      concurrency: 1,
      onEmpty: "reduce" as MapReduce.OnEmpty
    }),
    (options) => MapReduce.make(options),
    (options) => {
      options.map = runtimeOther
      options.reduce = runtimeOther
      options.concurrency = 2
      options.onEmpty = "succeed"
    }
  ),
  ported(
    "Recursion.recurse",
    { input: tree },
    () => ({ child: runtimeStep, fuel: 4, depth: 2, fanout: 2 }),
    (options) => Recursion.recurse(options),
    (options) => {
      options.child = runtimeOther
      options.fuel = 8
      options.depth = 3
      options.fanout = 3
    }
  ),
  ported(
    "Optimizer.make",
    { input: "seed" },
    () => ({
      generate: step,
      evaluate: step,
      targetScore: 1,
      maxIterations: 1,
      onMaxReached: "return-last" as Optimizer.OnMaxReached
    }),
    (options) => Optimizer.make(options),
    (options) => {
      options.generate = other
      options.evaluate = other
      options.targetScore = 2
      options.maxIterations = 2
    }
  ),
  ported(
    "ScanFixVerify.make",
    { input: "tree" },
    () => ({ scan: step, fix: step, verify: step, maxRetries: 1, maxIssues: 1, concurrency: 1 }),
    (options) => ScanFixVerify.make(options),
    (options) => {
      options.scan = other
      options.fix = other
      options.verify = other
      options.maxRetries = 2
      options.maxIssues = 2
      options.concurrency = 2
    }
  ),
  ported(
    "DriftDetector.make",
    { input: { target: "config" } },
    () => ({ capture: step, compare: step, alert: step, baseline: { checksum: "a" } as unknown }),
    (options) => DriftDetector.make(options),
    (options) => {
      options.capture = other
      options.compare = other
      options.alert = other
      options.baseline = { checksum: "b" }
    }
  ),
  ported(
    "Sidecar.make",
    { input: "question" },
    () => ({ primary: runtimeStep, shadow: runtimeStep, score: runtimeStep }),
    (options) => Sidecar.make(options),
    (options) => {
      options.primary = runtimeOther
      options.shadow = runtimeOther
      options.score = runtimeOther
    }
  ),
  ported(
    "Intervene.make",
    { input: "target" },
    () => ({
      read: step,
      propose: step,
      apply: step,
      report: step,
      dryRun: false,
      approval: approving("gate"),
      reason: "apply the fix"
    }),
    (options) => Intervene.make(options),
    (options) => {
      options.read = other
      options.propose = other
      options.apply = other
      options.report = other
      options.dryRun = true
      options.approval = approving("other-gate")
      options.reason = "apply something else"
    }
  ),
  ported(
    "CheckSuite.make",
    { input: "tree" },
    () => ({
      checks: { lint: runtimeStep } as Record<string, typeof runtimeStep>,
      strategy: "all-pass" as CheckSuite.Strategy,
      concurrency: 1,
      continueOnFail: false
    }),
    (options) => CheckSuite.make(options),
    (options) => {
      options.checks.lint = runtimeOther
      options.checks.test = runtimeOther
      options.strategy = "any-pass"
      options.concurrency = 2
      options.continueOnFail = true
    }
  ),
  ported(
    "Runbook.make",
    { input: "target" },
    () => ({
      steps: [
        { id: "backup", flow: step, risk: "safe" as Runbook.Risk },
        { id: "deploy", flow: step, risk: "risky" as Runbook.Risk }
      ],
      approval: approving("gate"),
      onDeny: "fail" as Runbook.OnDeny,
      reason: "run the step"
    }),
    (options) => Runbook.make(options),
    (options) => {
      options.steps[0]!.id = "renamed"
      options.steps[0]!.risk = "critical"
      options.steps[0]!.flow = other
      options.steps.push({ id: "late", flow: other, risk: "safe" })
      options.approval = approving("other-gate")
      options.reason = "run something else"
    }
  ),
  ported(
    "Trellis.make",
    { input: "prompt" },
    () => ({
      author: step,
      leaf: step,
      envelope: { fuel: 2, depth: 2, fanout: 2 },
      continue: undefined as typeof step | undefined
    }),
    (options) => Trellis.make(options),
    (options) => {
      options.author = other
      options.leaf = other
      options.continue = other
      options.envelope.fuel = 3
    }
  ),
  ported(
    "DelegationChain.make",
    { input: "prompt" },
    () => ({
      refine: step,
      plan: step,
      derisk: step,
      execute: { weak: step, strong: step } as Record<string, typeof step>,
      review: step,
      settle: step,
      tierOrder: ["weak", "strong"],
      maxDepth: 1,
      maxDeriskRounds: 1,
      budget: { maxMinutes: 5 } as { maxMinutes?: number | undefined }
    }),
    (options) => DelegationChain.make(options),
    (options) => {
      options.refine = other
      options.plan = other
      options.derisk = other
      options.execute.weak = other
      options.review = other
      options.settle = other
      options.tierOrder.reverse()
      options.maxDepth = 2
      options.maxDeriskRounds = 2
      options.budget.maxMinutes = 9
    }
  )
]

const recorder = () => {
  const trace: Array<string> = []
  const record = (label: string) => () =>
    Effect.sync(() => {
      trace.push(label)
      return label
    })
  return { trace, record }
}

describe("options are snapshotted at the call", () => {
  for (const entry of declarations) {
    it(`${entry.name} declares from the snapshot it took of its options`, () => {
      const { mutate, shape } = entry.declare()
      const before = shape()
      mutate()

      expect(shape()).toEqual(before)
      expect(before).toEqual(entry.fresh())
      // The edit is one the declaration reacts to, so the equality above is
      // not vacuous.
      expect(entry.edited()).not.toEqual(before)
    })
  }

  it.effect("Bounded.run runs the members and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const members: Record<string, Effect.Effect<string>> = { a: record("a")() }
      const options = { concurrency: 1, priority: 1, priorities: { a: 2 } as Record<string, number> }
      const running = Bounded.run(members, options)

      members.a = record("swapped")()
      members.late = record("late")()
      options.concurrency = 0
      options.priorities.late = 5

      expect(yield* running).toEqual({ a: "a" })
      expect(trace).toEqual(["a"])
    }))

  it.effect("Quarantine.run runs the members and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const members: Record<string, Effect.Effect<string>> = { a: record("a")() }
      const options = { policy: "quarantine" as const, concurrency: 1 }
      const running = Quarantine.run(members, options)

      members.a = record("swapped")()
      members.late = record("late")()
      ;(options as { policy: Quarantine.Policy }).policy = "halt"
      options.concurrency = 0

      expect(yield* running).toEqual({ a: { _tag: "Succeeded", member: "a", value: "a" } })
      expect(trace).toEqual(["a"])
    }))

  it.effect("Panel.run runs the panelists and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const panelists: Record<string, (input: string) => Effect.Effect<string>> = { a: record("a") }
      const options = {
        panelists,
        moderator: (args: { readonly input: string; readonly opinions: Readonly<Record<string, string>> }) =>
          Effect.sync(() => {
            trace.push("moderate")
            return args.opinions
          }),
        concurrency: 1
      }
      const running = Panel.run("question", options)

      panelists.a = record("swapped")
      panelists.late = record("late")
      options.moderator = () =>
        Effect.sync(() => {
          trace.push("swapped moderator")
          return {}
        })
      options.concurrency = 0

      expect(yield* running).toEqual({ a: "a" })
      expect(trace).toEqual(["a", "moderate"])
    }))

  it.effect("Debate.run runs the participants and rounds it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        rounds: 1,
        proponent: record("proponent"),
        opponent: record("opponent"),
        judge: record("judge")
      }
      const running = Debate.run("topic", options)

      options.rounds = 3
      options.proponent = record("swapped proponent")
      options.opponent = record("swapped opponent")
      options.judge = record("swapped judge")

      expect(yield* running).toBe("judge")
      expect(trace).toEqual(["proponent", "opponent", "judge"])
    }))

  it.effect("Escalation.run runs the rungs and deciders it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const rung = { run: record("rung"), escalateIf: () => Effect.succeed(false) }
      const options = {
        rungs: [rung] as Array<typeof rung>,
        accept: () => Effect.succeed(true),
        fallback: record("fallback")
      }
      const running = Escalation.run("job", options)

      rung.run = record("swapped rung")
      rung.escalateIf = () => Effect.succeed(true)
      options.rungs.push({ run: record("late"), escalateIf: () => Effect.succeed(false) })
      options.accept = () => Effect.succeed(false)
      options.fallback = record("swapped fallback")

      expect(yield* running).toEqual({ level: 0, result: "rung", exhausted: false })
      expect(trace).toEqual(["rung"])
    }))

  it.effect("ReviewLoop.run runs the callbacks and bound it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        produce: record("produce"),
        review: () => Effect.succeed(true),
        revise: record("revise"),
        maxRounds: 1
      }
      const running = ReviewLoop.run("draft", options)

      options.produce = record("swapped produce")
      options.review = () => Effect.succeed(false)
      options.revise = record("swapped revise")
      options.maxRounds = 3

      expect(yield* running).toEqual({ _tag: "Approved", output: "produce" })
      expect(trace).toEqual(["produce"])
    }))

  it.effect("MapReduce.run runs the shards and callbacks it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const input = { shards: ["a"] as Array<string> }
      const options = {
        map: ({ shard }: { readonly shard: string }) =>
          Effect.sync(() => {
            trace.push(`map ${shard}`)
            return shard
          }),
        reduce: ({ mapped }: { readonly mapped: ReadonlyArray<string> }) =>
          Effect.sync(() => {
            trace.push("reduce")
            return mapped
          }),
        concurrency: 1,
        onEmpty: "reduce" as MapReduce.OnEmpty
      }
      const running = MapReduce.run(input, options)

      input.shards.push("b")
      options.map = record("swapped map")
      options.reduce = () => Effect.sync(() => (trace.push("swapped reduce"), []))
      options.concurrency = 0
      options.onEmpty = "fail"

      expect(yield* running).toEqual(["a"])
      expect(trace).toEqual(["map a", "reduce"])
    }))

  it.effect("DriftDetector.run runs the callbacks and baseline it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        baseline: "a",
        capture: record("capture"),
        compare: () => Effect.succeed(true),
        alertIf: undefined as ((comparison: boolean) => boolean) | undefined,
        alert: record("alert")
      }
      const running = DriftDetector.run("config", options)

      options.baseline = "b"
      options.capture = record("swapped capture")
      options.compare = () => Effect.succeed(false)
      options.alertIf = () => false
      options.alert = record("swapped alert")

      expect(yield* running).toEqual({ snapshot: "capture", comparison: true, drifted: true, alert: "alert" })
      expect(trace).toEqual(["capture", "alert"])
    }))

  it.effect("Sidecar.run runs the primary, shadow, and scorer it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        primary: record("primary"),
        shadow: record("shadow"),
        score: () => Effect.succeed({ primary: 1, shadow: 1 })
      }
      const running = Sidecar.run("question", options)

      options.primary = record("swapped primary")
      options.shadow = record("swapped shadow")
      options.score = () => Effect.succeed({ primary: 0, shadow: 5 })

      expect(yield* running).toEqual({
        primary: "primary",
        shadow: { quarantined: false, value: "shadow" },
        delta: { primary: 1, shadow: 1, difference: 0, cheaperWins: true }
      })
      expect([...trace].sort()).toEqual(["primary", "shadow"])
    }))

  it.effect("CheckSuite.run runs the checks and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const checks: Record<string, (input: string) => Effect.Effect<string>> = { lint: record("lint") }
      const options = { checks, strategy: "all-pass" as CheckSuite.Strategy, concurrency: 1, continueOnFail: false }
      const running = CheckSuite.run("tree", options)

      checks.lint = record("swapped lint")
      checks.late = record("late")
      options.strategy = "any-pass"
      options.concurrency = 0
      options.continueOnFail = true

      expect(yield* running).toEqual({ passed: ["lint"], failed: [], errors: {}, strategy: "all-pass", verdict: true })
      expect(trace).toEqual(["lint"])
    }))

  it.effect("Intervene.run runs the callbacks and mode it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        read: record("read"),
        propose: record("propose"),
        apply: record("apply"),
        report: ({ applied, dryRun }: { readonly applied: string | undefined; readonly dryRun: boolean }) =>
          Effect.sync(() => {
            trace.push("report")
            return { applied, dryRun }
          }),
        dryRun: false,
        approval: () => Effect.succeed("approved")
      }
      const running = Intervene.run("target", options)

      options.read = record("swapped read")
      options.propose = record("swapped propose")
      options.apply = record("swapped apply")
      options.report = () => Effect.sync(() => (trace.push("swapped report"), { applied: undefined, dryRun: true }))
      options.dryRun = true
      options.approval = () => Effect.succeed("denied")

      expect(yield* running).toEqual({ applied: "apply", dryRun: false })
      expect(trace).toEqual(["read", "propose", "apply", "report"])
    }))

  it.effect("Runbook.run runs the steps and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const steps: Array<{ id: string; risk: Runbook.Risk; run: () => Effect.Effect<string> }> = [
        { id: "a", risk: "safe", run: record("a") }
      ]
      const options = { steps, approve: () => Effect.succeed("approved"), onDeny: "fail" as Runbook.OnDeny }
      const running = Runbook.run("target", options)

      steps[0]!.id = "renamed"
      steps[0]!.risk = "critical"
      steps[0]!.run = record("swapped")
      steps.push({ id: "late", risk: "safe", run: record("late") })
      options.approve = () => Effect.succeed("denied")
      options.onDeny = "skip"

      expect(yield* running).toEqual({ outputs: { a: "a" }, ran: ["a"], skipped: [] })
      expect(trace).toEqual(["a"])
    }))

  it.effect("Trellis.execute runs the plan and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const plan: { sequence: [Trellis.Plan, ...Array<Trellis.Plan>] } = { sequence: [{ agent: { goal: "a" } }] }
      const options = { leaf: record("leaf"), concurrency: 1 }
      const running = Trellis.execute(plan, options)

      plan.sequence.push({ agent: { goal: "late" } })
      options.leaf = record("swapped leaf")
      options.concurrency = 0

      expect(yield* running).toEqual(["leaf"])
      expect(trace).toEqual(["leaf"])
    }))

  it.effect("DelegationChain.run runs the callbacks and bounds it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const execute: Record<string, (work: DelegationChain.Work) => Effect.Effect<string>> = {
        weak: (work) =>
          Effect.sync(() => {
            trace.push(`weak ${work.budget?.maxMinutes}`)
            return "weak"
          })
      }
      const options = {
        refine: record("refine"),
        plan: () =>
          Effect.sync(() => {
            trace.push("plan")
            return { agent: { goal: "goal" } }
          }),
        derisk: () =>
          Effect.sync(() => {
            trace.push("derisk")
            return true
          }),
        execute,
        review: ({ stage }: { readonly stage: string }) =>
          Effect.sync(() => {
            trace.push(`review ${stage}`)
            return true
          }),
        settle: (settlement: DelegationChain.Settlement) =>
          Effect.sync(() => {
            trace.push("settle")
            return settlement.leaves
          }),
        tierOrder: ["weak"],
        maxDepth: 1,
        maxDeriskRounds: 1,
        budget: { maxMinutes: 1 } as { maxMinutes?: number | undefined },
        concurrency: 1
      }
      const running = DelegationChain.run("prompt", options)

      options.refine = record("swapped refine")
      options.plan = () => Effect.sync(() => (trace.push("swapped plan"), { agent: { goal: "swapped" } }))
      options.derisk = () => Effect.sync(() => (trace.push("swapped derisk"), false))
      execute.weak = record("swapped weak")
      options.review = () => Effect.sync(() => (trace.push("swapped review"), false))
      options.settle = () => Effect.sync(() => (trace.push("swapped settle"), []))
      options.tierOrder[0] = "missing"
      options.maxDepth = 0
      options.maxDeriskRounds = 0
      options.budget.maxMinutes = 9
      options.concurrency = 0

      expect(yield* running).toEqual(["weak"])
      expect(trace).toEqual(["refine", "plan", "derisk", "weak 1", "review leaf", "review chain", "settle"])
    }))
})
