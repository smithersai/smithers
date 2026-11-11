/**
 * Steve Yegge's Gas Town on 1.0: a mayor plans beads, polecats work them in parallel, a refinery merges the results.
 *
 * Port of the 0.x `gastown.jsx`. The mayor agent breaks the goal into a convoy
 * of beads. The convoy and every bead are written to the beads tracker, then
 * one polecat agent per bead works it, `maxAgents` at a time (default 5), with
 * one retry, and a polecat that still fails drops only its own result. When a
 * polecat left no result, the witness agent patrols beads + 2 times. The
 * refinery lands each completed polecat's branch through a serial merge queue:
 * it writes a ready merge request, then the refinery agent merges it with one
 * retry. Once every merge settles as merged or rejected, the convoy is closed
 * with its counts, and a report agent summarizes the run.
 *
 * 0.x's static-row tasks (`convoy-create`, `sling-*`, `mr-create-*`, `convoy-close`) are writes to the beads tracker, so they are declared actions a host implements.
 * 0.x worked each polecat in its own `<Worktree>`; worktree and sandbox placement are the host's (see `40-sandbox-placement.ts`), and the prompt still names the branch.
 * 0.x rendered each fan-out once its input landed; here the dispatch and the refinery are `.child()` flows whose bodies plan over the real beads and results.
 * 0.x's `<MergeQueue maxConcurrency={1}>` is a chain where each landing waits for the one before and a failed merge fails the run; the refinery declares that chain directly.
 * 0.x's `<Loop until={allPolecatsDone}>` could never end once the polecats had finished, so it always ran its bound; the plan unrolls exactly that bound.
 * 0.x's mayor prompt ended by spelling out its JSON reply; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `read`, `write`, `edit`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** Bead status: Gas Town's issue lifecycle. */
export const BeadStatus = Schema.Literals(["open", "in_progress", "hooked", "closed", "staged_ready"])

/** Gas Town's custom issue types. */
export const BeadType = Schema.Literals(["task", "bug", "feature", "convoy", "merge-request", "agent", "molecule"])

/** Polecat lifecycle states, from `polecat/types.go`. */
export const PolecatState = Schema.Literals(["working", "idle", "done", "stuck", "zombie"])

/** The refinery's merge-request phases, from `refinery/types.go`. */
export const MRPhase = Schema.Literals([
  "ready",
  "claimed",
  "preparing",
  "prepared",
  "merging",
  "merged",
  "rejected",
  "failed"
])

/** Witness protocol message types, from `witness/protocol.go`. */
export const ProtocolType = Schema.Literals([
  "polecat_done",
  "lifecycle_shutdown",
  "help",
  "merged",
  "merge_failed",
  "merge_ready",
  "dispatch_attempt",
  "dispatch_ok",
  "dispatch_fail"
])

const Priority = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 4 }))

/** A bead as the flow slings it, before the tracker stamps it. */
export const Sling = Schema.Struct({
  id: Schema.String.annotate({ description: "e.g. gt-abc12" }),
  title: Schema.String,
  description: Schema.String,
  status: BeadStatus,
  type: BeadType,
  priority: Priority.annotate({ description: "P0-P4" }),
  assignee: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
  children: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  hookBead: Schema.optional(Schema.String),
  agentState: Schema.optional(PolecatState),
  acceptanceCriteria: Schema.optional(Schema.String),
  convoyId: Schema.optional(Schema.String)
})

/** A bead as the tracker stores it, with the two timestamps the tracker stamps. */
export const Bead = Schema.Struct({ ...Sling.fields, createdAt: Schema.String, updatedAt: Schema.String })

/** A convoy: one batch of tracked beads. */
export const Convoy = Schema.Struct({
  id: Schema.String.annotate({ description: "e.g. hq-cv-abc12" }),
  title: Schema.String,
  status: Schema.Literals(["open", "closed", "staged_ready"]),
  trackedBeads: Schema.Array(Schema.String),
  mergeStrategy: Schema.Literals(["direct", "mr", "local"]),
  totalTasks: Schema.Number,
  completedTasks: Schema.Number,
  failedTasks: Schema.Number
})

/** One bead the mayor plans. */
export const PlannedBead = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  files: Schema.Array(Schema.String),
  priority: Schema.Number,
  acceptanceCriteria: Schema.String
})

/** The mayor's plan. */
export const Plan = Schema.Struct({ convoyId: Schema.String, beads: Schema.Array(PlannedBead) })

/** One polecat's result. */
export const PolecatResult = Schema.Struct({
  beadId: Schema.String,
  polecatName: Schema.String,
  branch: Schema.String.annotate({ description: "e.g. polecat/Toast/gt-abc12" }),
  state: PolecatState,
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
  commitCount: Schema.Number,
  exitType: Schema.Literals(["completed", "escalated", "deferred"])
})

/** A refinery merge request. */
export const MergeRequest = Schema.Struct({
  id: Schema.String,
  branch: Schema.String,
  worker: Schema.String,
  issueId: Schema.String,
  targetBranch: Schema.String,
  phase: MRPhase,
  closeReason: Schema.optional(Schema.Literals(["merged", "rejected", "conflict", "superseded"])),
  error: Schema.optional(Schema.String),
  gateResults: Schema.optional(Schema.Struct({
    build: Schema.optional(Schema.Boolean),
    typecheck: Schema.optional(Schema.Boolean),
    lint: Schema.optional(Schema.Boolean),
    test: Schema.optional(Schema.Boolean)
  }))
})

/** One witness patrol report. */
export const WitnessEvent = Schema.Struct({
  type: ProtocolType,
  source: Schema.String,
  target: Schema.optional(Schema.String),
  summary: Schema.String,
  severity: Schema.optional(Schema.Literals(["critical", "high", "medium"])),
  suggestTo: Schema.optional(Schema.Literals(["deacon", "mayor", "overseer"])),
  timestamp: Schema.String
})

/** The convoy report the flow settles with. */
export const Report = Schema.Struct({
  convoyId: Schema.String,
  totalBeads: Schema.Number,
  merged: Schema.Number,
  rejected: Schema.Number,
  failed: Schema.Number,
  deferred: Schema.Number,
  summary: Schema.String,
  mergeLog: Schema.Array(Schema.Struct({ branch: Schema.String, phase: Schema.String, result: Schema.String }))
})

type Plan = typeof Plan.Type
type PlannedBead = typeof PlannedBead.Type
type PolecatResult = typeof PolecatResult.Type
type MergeRequest = typeof MergeRequest.Type
type WitnessEvent = typeof WitnessEvent.Type

/** Writes a convoy row to the beads tracker, at creation and at close. */
export const WriteConvoy = Action.make("examples/Gastown/WriteConvoy", { payload: Convoy, success: Convoy })

/** Writes a slung bead to the tracker, which stamps and returns it. */
export const WriteBead = Action.make("examples/Gastown/WriteBead", { payload: Sling, success: Bead })

/** Writes a merge request to the tracker. */
export const WriteMergeRequest = Action.make("examples/Gastown/WriteMergeRequest", {
  payload: MergeRequest,
  success: MergeRequest
})

/** The mayor: decomposes the goal into a convoy of beads. */
export const Mayor = AgentAction.make("examples/Gastown/Mayor", {
  payload: { directory: Schema.String, goal: Schema.String, maxAgents: Schema.optional(Schema.Number) },
  output: Plan,
  seat,
  system: [
    `You are the Mayor — Gas Town's global coordinator.

Your job:
1. Analyze the codebase and break the user's goal into independent beads (issues)
2. Create a convoy to track the batch of work
3. Each bead should have:
   - A unique ID in format "gt-XXXXX" (5 random alphanumeric chars)
   - Clear acceptance criteria
   - A list of files to focus on
   - Priority (0=critical, 4=low)
   - Non-overlapping scope with other beads

Keep tasks small enough for a single polecat to complete in one pass.
Prefer many small beads over few large ones.`
  ],
  prompt: ({ directory, goal, maxAgents }) =>
    `Analyze the Smithers workspace at "${directory}" and break this goal
into independent, parallelizable beads (issues):

Goal: ${goal}

Create a convoy ID (format: "hq-cv-XXXXX") and assign each bead to it.
Each bead needs:
- id: "gt-XXXXX" format
- title: short description
- description: detailed instructions
- files: array of file paths to focus on
- priority: 0-4 (0=critical)
- acceptanceCriteria: what "done" looks like

${maxAgents ? `Target ${maxAgents} beads max for parallel execution.` : "Keep to 3-8 beads."}`
})

/** A polecat: works one bead through the mol-polecat-work formula. */
export const Polecat = AgentAction.make("examples/Gastown/Polecat", {
  payload: PlannedBead,
  output: PolecatResult,
  seat,
  timeout: "5 minutes",
  system: [
    `You are a Polecat — a self-cleaning worker agent.

## Polecat Contract
1. You receive work via your hook (a bead with acceptance criteria)
2. You work through the formula steps in order
3. You complete and self-clean: push branch, report result, you're done

## mol-polecat-work Formula Steps
1. **load-context**: Read the bead, understand requirements
2. **branch-setup**: Create feature branch, fetch & rebase on main
3. **implement**: Do the work. Commit frequently. Follow codebase conventions.
4. **commit-changes**: Ensure ALL work is committed (HARD GATE)
5. **self-review**: Review your own diff for bugs, security, style
6. **build-check**: Run build/tests if configured

## Rules
- Make atomic, focused commits with conventional prefixes (feat:, fix:, etc.)
- Do NOT fix unrelated issues — create new beads for discovered work
- If stuck >15 min, report status "stuck" and exit type "escalated"
- You do NOT push to main. The Refinery merges from the merge queue.
- You do NOT close your own bead. The Refinery closes after merge.`
  ],
  prompt: (bead) =>
    `## Bead Assignment: ${bead.id}

**Title:** ${bead.title}
**Priority:** P${bead.priority}

## Description
${bead.description}

## Files to Focus On
${bead.files.join("\n")}

## Acceptance Criteria
${bead.acceptanceCriteria}

## mol-polecat-work Steps
Work through these in order:
1. Read and understand the bead requirements
2. Create branch: polecat/${bead.id}
3. Implement the solution - atomic commits with "feat:", "fix:", etc.
4. HARD GATE: Verify all changes are committed (git status = clean)
5. Self-review: git diff main...HEAD - check for bugs, security, style
6. Build check: run any configured build/test commands

Report your result with:
- beadId: "${bead.id}"
- polecatName: "${bead.id}"
- branch: "polecat/${bead.id}"
- state: your final state (working/done/stuck)
- exitType: completed/escalated/deferred
- filesChanged: list of files you modified
- commitCount: number of commits made`
})

/** The witness: checks polecat health after the polecats ran. */
export const Witness = AgentAction.make("examples/Gastown/Witness", {
  payload: { polecatResults: Schema.Array(PolecatResult), beads: Schema.Array(PlannedBead) },
  output: WitnessEvent,
  seat,
  system: [
    `You are the Witness — Gas Town's polecat monitor.

## Protocol Messages You Handle
- POLECAT_DONE <name>: Work completion
- HELP: <topic>: Polecat requesting intervention
- MERGED <name>: Refinery confirms branch merged
- MERGE_FAILED <name>: Refinery reporting merge failure

## Your Patrol
1. Check each polecat's state (working, idle, done, stuck, zombie)
2. Detect stalled polecats (no activity for >30min)
3. Detect zombie sessions (session exists but worktree missing)
4. Escalate critical issues to the Mayor

## Health Assessment
For stuck agents, classify:
- Category: decision | help | blocked | failed | emergency
- Severity: critical | high | medium
- SuggestTo: deacon | mayor | overseer

Report a summary of all agent health status.`
  ],
  prompt: ({ beads, polecatResults }) =>
    `## Witness Patrol

Check the status of all polecats in this convoy.

### Polecat Results So Far
${
      JSON.stringify(polecatResults.map((r) => ({
        name: r.polecatName,
        state: r.state,
        exitType: r.exitType,
        branch: r.branch
      })))
    }

### Expected Polecats
${beads.map((bead) => `- ${bead.id}: "${bead.title}"`).join("\n")}

### Completed: ${polecatResults.length}/${beads.length}

Report protocol message type, any stuck/zombie agents, and overall health.
If all polecats are done, report type "polecat_done".
If any are stuck, report type "help" with severity and escalation target.`
})

/** The refinery: claims, gates and merges one merge request. */
export const Refinery = AgentAction.make("examples/Gastown/Refinery", {
  payload: { result: PolecatResult, targetBranch: Schema.String },
  output: MergeRequest,
  seat,
  system: [
    `You are the Refinery — Gas Town's merge queue processor.

## MR Phase State Machine
ready → claimed → preparing → prepared → merging → merged
                 ↓                        ↓
              failed ────────────────────↘

## Process for each MR
1. **Claim**: Take the MR from the queue
2. **Prepare**: Rebase onto target branch, run quality gates
   - Build check
   - Type check
   - Lint
   - Tests (if configured)
3. **Merge**: Fast-forward merge + push to target
4. **Report**: Update MR phase to merged or failed

## Failure Handling
- conflict → reject, label "needs-rebase", assign back to worker
- tests_fail → reject, label "needs-fix", assign back to worker
- push_fail → retry once, then fail

You do NOT write code. You merge, gate, and report.`
  ],
  prompt: ({ result, targetBranch }) =>
    `## Refinery: Process MR for ${result.beadId}

**Branch:** ${result.branch}
**Worker:** ${result.polecatName}
**Target:** ${targetBranch}
**Changes:** ${result.summary}
**Files:** ${result.filesChanged.join(", ")}
**Commits:** ${result.commitCount}

## Phase State Machine
Execute these phases in order:
1. **Claim** (ready -> claimed): Take ownership of this MR
2. **Prepare** (claimed -> preparing): Rebase onto target, run quality gates
3. **Merge** (prepared -> merging -> merged): Fast-forward merge + push

If any gate fails:
- conflict -> phase=rejected, closeReason="conflict"
- tests_fail -> phase=rejected, closeReason="rejected"
- push_fail -> phase=failed (eligible for retry)

Report the final MR state with phase and any errors.`
})

/** The report agent: summarizes the convoy. */
export const Summarize = AgentAction.make("examples/Gastown/Report", {
  payload: {
    convoyId: Schema.String,
    goal: Schema.String,
    beads: Schema.Array(PlannedBead),
    polecatResults: Schema.Array(PolecatResult),
    mergeRequests: Schema.Array(MergeRequest),
    witnessEvents: Schema.Array(WitnessEvent)
  },
  output: Report,
  seat,
  system: [
    `Summarize a Gas Town convoy's results.
Include: convoy ID, total beads, merged/rejected/failed/deferred counts,
a merge log showing each branch's phase and result, and a brief narrative.`
  ],
  prompt: ({ beads, convoyId, goal, mergeRequests, polecatResults, witnessEvents }) =>
    `## Gas Town Convoy Report

**Convoy:** ${convoyId}
**Goal:** ${goal}

### Beads
${beads.length > 0 ? beads.map((bead) => `- ${bead.id}: ${bead.title} (P${bead.priority})`).join("\n") : "No beads"}

### Polecat Results
${
      JSON.stringify(polecatResults.map((r) => ({
        bead: r.beadId,
        polecat: r.polecatName,
        exitType: r.exitType,
        commits: r.commitCount,
        files: r.filesChanged.length
      })))
    }

### Merge Queue Results
${
      JSON.stringify(mergeRequests.map((r) => ({
        branch: r.branch,
        phase: r.phase,
        closeReason: r.closeReason,
        error: r.error
      })))
    }

### Witness Events
${JSON.stringify(witnessEvents.map((e) => ({ type: e.type, source: e.source, severity: e.severity })))}

Provide a complete convoy summary with merge log.`
})

/** 0.x's `retries={1}`: a failed call runs once more. */
const retriedOnce = <A, R>(call: () => Node.Node<A, AgentAction.AgentFailure, R>) =>
  Node.catch(call(), { onFailure: () => call() })

const convoyRow = (plan: Plan, goal: string): typeof Convoy.Type => ({
  id: plan.convoyId,
  title: goal,
  status: "open",
  trackedBeads: plan.beads.map((b) => b.id),
  mergeStrategy: "mr",
  totalTasks: plan.beads.length,
  completedTasks: 0,
  failedTasks: 0
})

const slingRow = (plan: Plan, bead: PlannedBead): typeof Sling.Type => ({
  id: bead.id,
  title: bead.title,
  description: bead.description,
  status: "hooked",
  type: "task",
  priority: bead.priority,
  assignee: `gastown/polecats/${bead.id}`,
  hookBead: bead.id,
  agentState: "working",
  acceptanceCriteria: bead.acceptanceCriteria,
  convoyId: plan.convoyId,
  children: [],
  dependsOn: [],
  labels: []
})

/** The witness bound: 0.x's `maxIterations={plan.beads.length + 2}`. */
export const patrolsFor = (beads: number) => beads + 2

type WitnessCall = Node.Node<
  ReadonlyArray<WitnessEvent>,
  AgentAction.AgentFailure,
  Action.Requirement<"examples/Gastown/Witness">
>

/** `count` patrols in a row, each waiting for the one before it. */
const patrol = (
  count: number,
  payload: {
    readonly polecatResults: Planned.Planned<ReadonlyArray<PolecatResult>>
    readonly beads: ReadonlyArray<PlannedBead>
  },
  events: ReadonlyArray<Planned.Planned<WitnessEvent>>
): WitnessCall =>
  count === 0
    ? Node.succeed(events)
    : Node.bindPlanned(Witness.call(payload), (event: Planned.Planned<WitnessEvent>) =>
      Node.andThen(Node.succeed(event), patrol(count - 1, payload, [...events, event])))

type DispatchTag = `examples/Gastown/${"WriteConvoy" | "WriteBead" | "Polecat" | "Witness"}`

/**
 * Opens the convoy, slings every bead, runs the polecats and, when a polecat
 * left no result, the witness. It runs as a child, so its body reads the real
 * plan.
 */
export const Dispatch = Flow.make("examples/Gastown/Dispatch", {
  payload: { plan: Plan, goal: Schema.String, maxAgents: Schema.Int.check(Schema.isGreaterThan(0)) },
  success: Schema.Struct({ results: Schema.Array(PolecatResult), witnessEvents: Schema.Array(WitnessEvent) }),
  error: AgentAction.AgentFailure,
  body: ({ goal, maxAgents, plan }) => {
    const opened = WriteConvoy.call(convoyRow(plan, goal))
    if (plan.beads.length === 0) {
      return Node.andThen(opened, Node.succeed({ results: [], witnessEvents: [] }))
    }
    const slung = Node.all(
      Object.fromEntries(plan.beads.map((bead) => [`sling-${bead.id}`, WriteBead.call(slingRow(plan, bead))]))
    )
    // 0.x `continueOnFail` after `retries={1}`: a polecat that fails twice settles as null.
    const polecats = Object.fromEntries(plan.beads.map((bead) => [
      `polecat-${bead.id}`,
      Node.catch(retriedOnce(() => Polecat.call(bead)), { onFailure: () => Node.succeed(null) })
    ]))
    const joined = Bounded.all(polecats, { concurrency: maxAgents })
    const worked = Node.map(joined, (settled) => Object.values(settled).filter(Schema.is(PolecatResult)))
    const dispatched: Node.Node<
      { readonly results: ReadonlyArray<PolecatResult>; readonly witnessEvents: ReadonlyArray<WitnessEvent> },
      AgentAction.AgentFailure,
      Action.Requirement<DispatchTag>
    > = Node.bindPlanned(worked, (results: Planned.Planned<ReadonlyArray<PolecatResult>>) =>
      Node.bindPlanned(
        Node.branch(Node.succeed(results), {
          if: (settled) => settled.length < plan.beads.length,
          then: () => patrol(patrolsFor(plan.beads.length), { polecatResults: results, beads: plan.beads }, []),
          else: () => Node.succeed([])
        }),
        (witnessEvents: Planned.Planned<ReadonlyArray<WitnessEvent>>) => Node.succeed({ results, witnessEvents })
      ))
    return Node.andThen(opened, Node.andThen(slung, dispatched))
  }
})

/** What one landing records: the ready request and the refinery's result. */
interface Landing {
  readonly opened: MergeRequest
  readonly merged: MergeRequest
}

type RefineTag = `examples/Gastown/${"WriteMergeRequest" | "Refinery" | "WriteConvoy"}`

/** Writes the ready request, then merges it once the write lands. */
const land = (
  result: PolecatResult,
  targetBranch: string
): Node.Node<Landing, AgentAction.AgentFailure, Action.Requirement<RefineTag>> =>
  Node.bindPlanned(
    WriteMergeRequest.call({
      id: `mr-${result.beadId}`,
      branch: result.branch,
      worker: result.polecatName,
      issueId: result.beadId,
      targetBranch,
      phase: "ready"
    }),
    (opened: Planned.Planned<MergeRequest>) =>
      Node.andThen(
        Node.succeed(opened),
        Node.bindPlanned(
          retriedOnce(() => Refinery.call({ result, targetBranch })),
          (merged: Planned.Planned<MergeRequest>) => Node.succeed({ opened, merged })
        )
      )
  )

/** Every merge settled as merged or rejected: 0.x's `allMergesDone`. */
const allMergesDone = (merged: ReadonlyArray<MergeRequest>, completed: number) =>
  completed > 0 && merged.filter((mr) => mr.phase === "merged" || mr.phase === "rejected").length >= completed

/**
 * Lands every completed polecat's branch through the serial merge queue, then
 * closes the convoy when every merge settled. It runs as a child, so its body
 * reads the real results.
 */
export const Refine = Flow.make("examples/Gastown/Refine", {
  payload: { plan: Plan, goal: Schema.String, results: Schema.Array(PolecatResult), baseBranch: Schema.String },
  success: Schema.Array(MergeRequest),
  error: AgentAction.AgentFailure,
  body: ({ baseBranch, goal, plan, results }) => {
    const completed = results.filter((r) => r.exitType === "completed")
    if (completed.length === 0) return Node.succeed([])
    // Each landing starts only once the one before it settled, and a failed
    // landing fails the queue, so nothing behind it lands.
    const queue = (
      index: number,
      landed: ReadonlyArray<Planned.Planned<Landing>>
    ): Node.Node<ReadonlyArray<Landing>, AgentAction.AgentFailure, Action.Requirement<RefineTag>> => {
      const next = completed[index]
      if (next === undefined) return Node.succeed(landed)
      return Node.bindPlanned(
        land(next, baseBranch),
        (pair: Planned.Planned<Landing>) => Node.andThen(Node.succeed(pair), queue(index + 1, [...landed, pair]))
      )
    }
    return Node.bindPlanned(queue(0, []), (pairs: Planned.Planned<ReadonlyArray<Landing>>) => {
      const requests = Node.map(Node.succeed(pairs), (real) => real.flatMap(({ merged, opened }) => [opened, merged]))
      return Node.branch(Node.map(Node.succeed(pairs), (real) => real.map((p) => p.merged)), {
        if: (merged) => allMergesDone(merged, completed.length),
        then: (merged) =>
          Node.bindPlanned(
            Node.map(Node.succeed(merged), (real): typeof Convoy.Type => ({
              ...convoyRow(plan, goal),
              status: "closed",
              completedTasks: real.filter((mr) => mr.phase === "merged").length,
              failedTasks: real.filter((mr) => mr.phase === "rejected" || mr.phase === "failed").length
            })),
            (closed: Planned.Planned<typeof Convoy.Type>) => Node.andThen(WriteConvoy.call(closed), requests)
          ),
        else: () => requests
      })
    })
  }
})

/** The flow: plan, dispatch, refine, report. */
export const Gastown = Flow.make("examples/Gastown", {
  payload: {
    directory: Schema.String,
    goal: Schema.String,
    maxAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    baseBranch: Schema.optional(Schema.String)
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ baseBranch = "main", directory, goal, maxAgents }) =>
    Node.bindPlanned(
      Mayor.call({ directory, goal, ...(maxAgents === undefined ? {} : { maxAgents }) }),
      (plan: Planned.Planned<Plan>) =>
        Node.bindPlanned(
          Dispatch.child({ plan, goal, maxAgents: maxAgents ?? 5 }),
          (dispatched: Planned.Planned<typeof Dispatch.successSchema.Type>) =>
            Node.bindPlanned(
              Refine.child({ plan, goal, results: dispatched.results, baseBranch }),
              (mergeRequests: Planned.Planned<ReadonlyArray<MergeRequest>>) =>
                Summarize.call({
                  convoyId: plan.convoyId,
                  goal,
                  beads: plan.beads,
                  polecatResults: dispatched.results,
                  mergeRequests,
                  witnessEvents: dispatched.witnessEvents
                })
            )
        )
    )
})

/**
 * The agent steps and the two child flows. `WriteConvoy`, `WriteBead` and
 * `WriteMergeRequest` are the host's: it supplies `toLayer` implementations
 * over its beads tracker.
 */
export const layer = Layer.mergeAll(
  Mayor.layer,
  Polecat.layer,
  Witness.layer,
  Refinery.layer,
  Summarize.layer,
  Interpreter.layer(Dispatch),
  Interpreter.layer(Refine)
)
