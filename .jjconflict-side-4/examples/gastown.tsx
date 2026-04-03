/**
 * Gas Town Clone — A faithful recreation of Steve Yegge's multi-agent
 * orchestration framework, built on Smithers primitives.
 *
 * Gas Town concepts → Smithers mapping:
 *   Beads (issue tracker)     → Zod schemas + SQLite tables + useBeads() hook
 *   Mayor (orchestrator)      → Planning Task that creates beads
 *   Polecats (workers)        → Parallel + Worktree + mol-polecat-work steps
 *   Refinery (merge queue)    → MergeQueue with phase state machine
 *   Witness (health monitor)  → Loop with health-check Task
 *   Formulas (TOML workflows) → JSX component composition
 *   Convoys (work batches)    → Convoy bead tracking related work
 *   gt done (self-clean)      → Task completion + merge request creation
 */
import { Sequence, Parallel, Loop, MergeQueue, Branch, Worktree } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import MayorPrompt from "./prompts/gastown/mayor.mdx";
import PolecatPrompt from "./prompts/gastown/polecat.mdx";
import WitnessPatrolPrompt from "./prompts/gastown/witness-patrol.mdx";
import MergePrompt from "./prompts/gastown/merge.mdx";
import ReportPrompt from "./prompts/gastown/report.mdx";

// ═══════════════════════════════════════════════════════════════════════════
// BEADS — Gas Town's persistent issue tracking, implemented as Zod schemas.
// Each schema becomes a durable SQLite table. Together they form the "Beads
// database" — the single source of truth for all work state.
// ═══════════════════════════════════════════════════════════════════════════

/** Bead status — mirrors Gas Town's issue lifecycle */
const BeadStatus = z.enum([
  "open",
  "in_progress",
  "hooked",       // Attached to an agent's hook (GUPP: you have work, you run it)
  "closed",
  "staged_ready", // Convoy staged without warnings
]);

/** Bead types — Gas Town's custom issue types */
const BeadType = z.enum([
  "task", "bug", "feature",       // Standard
  "convoy",                        // Work batch tracking
  "merge-request",                 // Refinery MR
  "agent",                         // Agent identity
  "molecule",                      // Work decomposition
]);

/** Polecat lifecycle states — from polecat/types.go */
const PolecatState = z.enum([
  "working",  // Session active, doing assigned work
  "idle",     // Work completed, sandbox preserved for reuse
  "done",     // Called gt done, transient cleanup state
  "stuck",    // Explicitly requested help
  "zombie",   // Session exists but worktree missing
]);

/** MR phase state machine — from refinery/types.go */
const MRPhase = z.enum([
  "ready",      // Queued and available for claiming
  "claimed",    // Refinery instance claimed it
  "preparing",  // Quality gates running (rebase, tests)
  "prepared",   // Gates completed
  "merging",    // ff-merge + push in progress
  "merged",     // Successfully merged
  "rejected",   // Rejected after diagnosis
  "failed",     // Transient error, eligible for retry
]);

/** Witness protocol message types — from witness/protocol.go */
const ProtocolType = z.enum([
  "polecat_done",
  "lifecycle_shutdown",
  "help",
  "merged",
  "merge_failed",
  "merge_ready",
  "dispatch_attempt",
  "dispatch_ok",
  "dispatch_fail",
]);

// ── Bead Schema (the core issue) ──────────────────────────────────────────

const beadSchema = z.object({
  id: z.string(),                           // e.g. "gt-abc12"
  title: z.string(),
  description: z.string(),
  status: BeadStatus,
  type: BeadType,
  priority: z.number().min(0).max(4),       // P0-P4
  assignee: z.string().optional(),          // e.g. "gastown/polecats/Toast"
  parent: z.string().optional(),            // Parent bead ID
  children: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  hookBead: z.string().optional(),          // Work pinned to agent's hook
  agentState: PolecatState.optional(),
  acceptanceCriteria: z.string().optional(),
  convoyId: z.string().optional(),          // Convoy tracking
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ── Convoy Schema (batch tracking) ────────────────────────────────────────

const convoySchema = z.object({
  id: z.string(),                           // e.g. "hq-cv-abc12"
  title: z.string(),
  status: z.enum(["open", "closed", "staged_ready"]),
  trackedBeads: z.array(z.string()),        // Bead IDs in this convoy
  mergeStrategy: z.enum(["direct", "mr", "local"]).default("mr"),
  totalTasks: z.number(),
  completedTasks: z.number(),
  failedTasks: z.number(),
});

// ── Mayor Plan Schema ─────────────────────────────────────────────────────

const planSchema = z.object({
  convoyId: z.string(),
  beads: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    files: z.array(z.string()),
    priority: z.number(),
    acceptanceCriteria: z.string(),
  })),
});

// ── Polecat Result Schema (worker output) ─────────────────────────────────

const polecatResultSchema = z.object({
  beadId: z.string(),                       // Which bead was worked on
  polecatName: z.string(),
  branch: z.string(),                       // e.g. "polecat/Toast/gt-abc12"
  state: PolecatState,
  summary: z.string(),
  filesChanged: z.array(z.string()),
  commitCount: z.number(),
  exitType: z.enum(["completed", "escalated", "deferred"]),
});

// ── Merge Request Schema (Refinery) ───────────────────────────────────────

const mergeRequestSchema = z.object({
  id: z.string(),
  branch: z.string(),
  worker: z.string(),
  issueId: z.string(),
  targetBranch: z.string().default("main"),
  phase: MRPhase,
  closeReason: z.enum(["merged", "rejected", "conflict", "superseded"]).optional(),
  error: z.string().optional(),
  gateResults: z.object({
    build: z.boolean().optional(),
    typecheck: z.boolean().optional(),
    lint: z.boolean().optional(),
    test: z.boolean().optional(),
  }).optional(),
});

// ── Witness Event Schema ──────────────────────────────────────────────────

const witnessEventSchema = z.object({
  type: ProtocolType,
  source: z.string(),                       // Agent that sent it
  target: z.string().optional(),            // Agent it's about
  summary: z.string(),
  severity: z.enum(["critical", "high", "medium"]).optional(),
  suggestTo: z.enum(["deacon", "mayor", "overseer"]).optional(),
  timestamp: z.string(),
});

// ── Final Report Schema ───────────────────────────────────────────────────

const reportSchema = z.object({
  convoyId: z.string(),
  totalBeads: z.number(),
  merged: z.number(),
  rejected: z.number(),
  failed: z.number(),
  deferred: z.number(),
  summary: z.string(),
  mergeLog: z.array(z.object({
    branch: z.string(),
    phase: z.string(),
    result: z.string(),
  })),
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATE SMITHERS — Schema → typed API + durable SQLite tables
// ═══════════════════════════════════════════════════════════════════════════

const { Workflow, Task, smithers, outputs, useCtx } = createExampleSmithers({
  bead: beadSchema,
  convoy: convoySchema,
  plan: planSchema,
  polecatResult: polecatResultSchema,
  mergeRequest: mergeRequestSchema,
  witnessEvent: witnessEventSchema,
  report: reportSchema,
});

// ═══════════════════════════════════════════════════════════════════════════
// useBeads() — React hook for Gas Town's issue tracking system.
// Provides typed access to beads state within any Smithers component.
// ═══════════════════════════════════════════════════════════════════════════

function useBeads() {
  const ctx = useCtx();
  const allBeads: z.infer<typeof beadSchema>[] = ctx.outputs.bead ?? [];
  const allConvoys: z.infer<typeof convoySchema>[] = ctx.outputs.convoy ?? [];

  return {
    /** All beads in the system */
    beads: allBeads,

    /** Find a bead by ID */
    get: (id: string) => allBeads.find((b) => b.id === id),

    /** Find beads by status */
    byStatus: (status: z.infer<typeof BeadStatus>) =>
      allBeads.filter((b) => b.status === status),

    /** Find beads by type */
    byType: (type: z.infer<typeof BeadType>) =>
      allBeads.filter((b) => b.type === type),

    /** Find beads assigned to a specific agent */
    hooked: (assignee: string) =>
      allBeads.filter((b) => b.assignee === assignee && b.status === "hooked"),

    /** Get the convoy for a bead */
    convoyFor: (beadId: string) => {
      const bead = allBeads.find((b) => b.id === beadId);
      if (!bead?.convoyId) return undefined;
      return allConvoys.find((c) => c.id === bead.convoyId);
    },

    /** All convoys */
    convoys: allConvoys,

    /** Check if all beads in a convoy are closed */
    isConvoyComplete: (convoyId: string) => {
      const convoy = allConvoys.find((c) => c.id === convoyId);
      if (!convoy) return false;
      return convoy.trackedBeads.every((id) => {
        const bead = allBeads.find((b) => b.id === id);
        return bead?.status === "closed";
      });
    },

    /** Get open work — beads ready for dispatch */
    openWork: () => allBeads.filter(
      (b) => b.status === "open" && b.type === "task"
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENTS — Gas Town's role hierarchy
// ═══════════════════════════════════════════════════════════════════════════

/** Mayor: town-level orchestrator that decomposes goals into beads */
const mayorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are the Mayor — Gas Town's global coordinator.

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
Prefer many small beads over few large ones.`,
});

/**
 * Polecat: worker agent following the mol-polecat-work formula.
 * Each polecat gets its own git worktree and works through the formula steps:
 *   load-context → branch-setup → implement → commit → self-review → build-check → submit
 */
const polecatAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, edit, bash, grep },
  instructions: `You are a Polecat — a self-cleaning worker agent.

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
- You do NOT close your own bead. The Refinery closes after merge.`,
});

/**
 * Refinery: merge queue processor with phase state machine.
 * Processes MRs through: ready → claimed → preparing → merging → merged
 */
const refineryAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are the Refinery — Gas Town's merge queue processor.

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

You do NOT write code. You merge, gate, and report.`,
});

/** Witness: monitors polecat health and dispatches protocol messages */
const witnessAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are the Witness — Gas Town's polecat monitor.

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

Report a summary of all agent health status.`,
});

/** Report agent: synthesizes convoy results */
const reportAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `Summarize a Gas Town convoy's results.
Include: convoy ID, total beads, merged/rejected/failed/deferred counts,
a merge log showing each branch's phase and result, and a brief narrative.`,
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW — The Gas Town orchestration loop
// ═══════════════════════════════════════════════════════════════════════════

export default smithers((ctx) => {
  // ── Derived state ──
  const plan = ctx.outputMaybe("plan", { nodeId: "mayor" });
  const polecatResults: z.infer<typeof polecatResultSchema>[] =
    ctx.outputs.polecatResult ?? [];
  const mergeRequests: z.infer<typeof mergeRequestSchema>[] =
    ctx.outputs.mergeRequest ?? [];
  const witnessEvents: z.infer<typeof witnessEventSchema>[] =
    ctx.outputs.witnessEvent ?? [];

  // Which polecats completed successfully?
  const completedPolecats = polecatResults.filter(
    (r) => r.exitType === "completed"
  );

  // Has the witness found all polecats healthy/done?
  const latestWitness = ctx.latest("witnessEvent", "witness-patrol");
  const allPolecatsDone =
    plan != null &&
    polecatResults.length >= plan.beads.length;

  // Are all merges done?
  const allMergesDone =
    completedPolecats.length > 0 &&
    mergeRequests.filter((mr) => mr.phase === "merged" || mr.phase === "rejected")
      .length >= completedPolecats.length;

  return (
    <Workflow name="gastown">
      <Sequence>
        {/* ═══ MAYOR: Decompose goal → convoy of beads ═══ */}
        <Task id="mayor" output={outputs.plan} agent={mayorAgent}>
          <MayorPrompt
            directory={ctx.input.directory}
            goal={ctx.input.goal}
            maxAgents={ctx.input.maxAgents}
          />
        </Task>

        {/* ═══ CONVOY TRACKING: Create convoy bead ═══ */}
        {plan && (
          <Task id="convoy-create" output={outputs.convoy}>
            {{
              id: plan.convoyId,
              title: ctx.input.goal,
              status: "open" as const,
              trackedBeads: plan.beads.map((b) => b.id),
              mergeStrategy: "mr" as const,
              totalTasks: plan.beads.length,
              completedTasks: 0,
              failedTasks: 0,
            }}
          </Task>
        )}

        {/* ═══ SLING: Create beads and hook them to polecats ═══ */}
        {plan && (
          <Parallel>
            {plan.beads.map((bead) => (
              <Task
                key={bead.id}
                id={`sling-${bead.id}`}
                output={outputs.bead}
              >
                {{
                  id: bead.id,
                  title: bead.title,
                  description: bead.description,
                  status: "hooked" as const,
                  type: "task" as const,
                  priority: bead.priority,
                  assignee: `gastown/polecats/${bead.id}`,
                  hookBead: bead.id,
                  agentState: "working" as const,
                  acceptanceCriteria: bead.acceptanceCriteria,
                  convoyId: plan.convoyId,
                  children: [],
                  dependsOn: [],
                  labels: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }}
              </Task>
            ))}
          </Parallel>
        )}

        {/* ═══ POLECATS: Parallel workers in isolated worktrees ═══
            Each polecat follows mol-polecat-work:
            load-context → branch-setup → implement → commit → review → build → submit */}
        {plan && (
          <Parallel maxConcurrency={ctx.input.maxAgents ?? 5}>
            {plan.beads.map((bead) => (
              <Worktree
                key={bead.id}
                path={`.worktrees/${bead.id}`}
                branch={`polecat/${bead.id}`}
              >
                <Task
                  id={`polecat-${bead.id}`}
                  output={outputs.polecatResult}
                  agent={polecatAgent}
                  retries={1}
                  timeoutMs={300_000}
                  continueOnFail
                >
                  <PolecatPrompt
                    beadId={bead.id}
                    title={bead.title}
                    priority={bead.priority}
                    description={bead.description}
                    files={bead.files}
                    acceptanceCriteria={bead.acceptanceCriteria}
                  />
                </Task>
              </Worktree>
            ))}
          </Parallel>
        )}

        {/* ═══ WITNESS: Monitor polecat health ═══ */}
        {plan && !allPolecatsDone && (
          <Loop
            until={allPolecatsDone}
            maxIterations={plan.beads.length + 2}
            onMaxReached="return-last"
          >
            <Task id="witness-patrol" output={outputs.witnessEvent} agent={witnessAgent}>
              <WitnessPatrolPrompt
                polecatResults={polecatResults}
                beads={plan.beads}
              />
            </Task>
          </Loop>
        )}

        {/* ═══ REFINERY: Serialized merge queue ═══
            Phase state machine: ready → claimed → preparing → merging → merged */}
        {completedPolecats.length > 0 && (
          <MergeQueue id="refinery" maxConcurrency={1}>
            {completedPolecats.map((result) => (
              <Sequence key={result.branch}>
                {/* Create MR bead */}
                <Task
                  id={`mr-create-${result.beadId}`}
                  output={outputs.mergeRequest}
                >
                  {{
                    id: `mr-${result.beadId}`,
                    branch: result.branch,
                    worker: result.polecatName,
                    issueId: result.beadId,
                    targetBranch: ctx.input.baseBranch ?? "main",
                    phase: "ready" as const,
                  }}
                </Task>

                {/* Process the merge */}
                <Task
                  id={`merge-${result.beadId}`}
                  output={outputs.mergeRequest}
                  agent={refineryAgent}
                  retries={1}
                >
                  <MergePrompt
                    beadId={result.beadId}
                    branch={result.branch}
                    polecatName={result.polecatName}
                    targetBranch={ctx.input.baseBranch ?? "main"}
                    summary={result.summary}
                    filesChanged={result.filesChanged}
                    commitCount={result.commitCount}
                  />
                </Task>
              </Sequence>
            ))}
          </MergeQueue>
        )}

        {/* ═══ CONVOY COMPLETION: Update convoy status ═══ */}
        {allMergesDone && plan && (
          <Task id="convoy-close" output={outputs.convoy}>
            {{
              id: plan.convoyId,
              title: ctx.input.goal,
              status: "closed" as const,
              trackedBeads: plan.beads.map((b) => b.id),
              mergeStrategy: "mr" as const,
              totalTasks: plan.beads.length,
              completedTasks: mergeRequests.filter((mr) => mr.phase === "merged").length,
              failedTasks: mergeRequests.filter(
                (mr) => mr.phase === "rejected" || mr.phase === "failed"
              ).length,
            }}
          </Task>
        )}

        {/* ═══ FINAL REPORT: Convoy summary ═══ */}
        <Task id="report" output={outputs.report} agent={reportAgent}>
          <ReportPrompt
            convoyId={plan?.convoyId ?? "unknown"}
            goal={ctx.input.goal}
            beads={plan?.beads ?? []}
            polecatResults={polecatResults}
            mergeRequests={mergeRequests}
            witnessEvents={witnessEvents}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
