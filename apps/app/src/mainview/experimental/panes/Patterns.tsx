/*
 * Mock: Patterns. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.patterns`. Self-contained on purpose — see ../Pane.ts.
 *
 * Every pattern declares the work as a graph before any of it runs, which is
 * the whole reason a budget, a reviewer or a scheduler can read the worst case
 * in advance — and today nothing shows that graph. So this is a gallery: the
 * rail is `@smthrs/patterns`' modules, and the selected one is drawn as the
 * topology its `make` expands eagerly, beside the bound that sized it and the
 * PatternError codes it can refuse with.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Graph, Rail, Section, Split } from "../Primitives"

type PatternNode = { readonly id: string; readonly label: string; readonly depth: number; readonly lane: number; readonly tone: "ok" | "warn" | "bad" | "info" | "muted" }
type Edges = ReadonlyArray<readonly [string, string]>

interface Shape {
  readonly nodes: ReadonlyArray<PatternNode>
  readonly edges: Edges
}

// A module whose interior this mock does not draw yet still declares a body
// between its input and its settled value, so the generic shape says that and
// nothing more.
const generic = (label: string): Shape => ({
  nodes: [
    { id: "in", label: "input", depth: 0, lane: 0, tone: "muted" },
    { id: "body", label, depth: 1, lane: 0, tone: "info" },
    { id: "settled", label: "settled", depth: 2, lane: 0, tone: "muted" }
  ],
  edges: [["in", "body"], ["body", "settled"]]
})

// maxRounds 3 expands to six declared calls, and every review can short
// circuit to Approved.
const REVIEW_LOOP: Shape = {
  nodes: [
    { id: "produce", label: "produce", depth: 0, lane: 1, tone: "info" },
    { id: "review1", label: "review 1", depth: 1, lane: 1, tone: "info" },
    { id: "revise1", label: "revise 1", depth: 2, lane: 1, tone: "muted" },
    { id: "review2", label: "review 2", depth: 3, lane: 1, tone: "info" },
    { id: "revise2", label: "revise 2", depth: 4, lane: 1, tone: "muted" },
    { id: "review3", label: "review 3", depth: 5, lane: 1, tone: "info" },
    { id: "approved", label: "Approved", depth: 6, lane: 0, tone: "ok" },
    { id: "exhausted", label: "Exhausted", depth: 6, lane: 2, tone: "warn" }
  ],
  edges: [
    ["produce", "review1"],
    ["review1", "revise1"],
    ["revise1", "review2"],
    ["review2", "revise2"],
    ["revise2", "review3"],
    ["review1", "approved"],
    ["review2", "approved"],
    ["review3", "approved"],
    ["review3", "exhausted"]
  ]
}

// `ordered` sorts by descending priority at declaration time; the queue owns
// the concurrency, not the members.
const MERGE_QUEUE: Shape = {
  nodes: [
    { id: "ordered", label: "ordered", depth: 0, lane: 1, tone: "info" },
    { id: "m1", label: "cli#744 · 2000", depth: 1, lane: 0, tone: "ok" },
    { id: "m2", label: "api#812 · 1000", depth: 1, lane: 1, tone: "ok" },
    { id: "m3", label: "docs#801 · 1000", depth: 2, lane: 0, tone: "bad" },
    { id: "m4", label: "web#690 · 500", depth: 2, lane: 2, tone: "ok" },
    { id: "landed", label: "Landed ×3", depth: 3, lane: 1, tone: "ok" },
    { id: "quarantined", label: "Quarantined ×1", depth: 3, lane: 2, tone: "warn" }
  ],
  edges: [
    ["ordered", "m1"],
    ["ordered", "m2"],
    ["m1", "m3"],
    ["m2", "m4"],
    ["m1", "landed"],
    ["m2", "landed"],
    ["m4", "landed"],
    ["m3", "quarantined"]
  ]
}

// The ladder: each rung's escalateIf either accepts and settles Reached, or
// climbs. A spent ladder falls through to fallback, then Exhausted.
const ESCALATION: Shape = {
  nodes: [
    { id: "r0", label: "rung 0 · haiku", depth: 0, lane: 1, tone: "info" },
    { id: "e0", label: "escalateIf", depth: 1, lane: 1, tone: "muted" },
    { id: "r1", label: "rung 1 · sonnet", depth: 2, lane: 1, tone: "info" },
    { id: "e1", label: "escalateIf", depth: 3, lane: 1, tone: "muted" },
    { id: "r2", label: "rung 2 · opus", depth: 4, lane: 1, tone: "info" },
    { id: "fallback", label: "fallback", depth: 5, lane: 2, tone: "warn" },
    { id: "reached", label: "Reached", depth: 5, lane: 0, tone: "ok" },
    { id: "exhausted", label: "Exhausted", depth: 6, lane: 2, tone: "bad" }
  ],
  edges: [
    ["r0", "e0"],
    ["e0", "r1"],
    ["r1", "e1"],
    ["e1", "r2"],
    ["e0", "reached"],
    ["e1", "reached"],
    ["r2", "reached"],
    ["r2", "fallback"],
    ["fallback", "exhausted"]
  ]
}

// Forward actions on the top lane, compensations unwinding in reverse on the
// bottom one.
const SAGA: Shape = {
  nodes: [
    { id: "reserve", label: "reserve", depth: 0, lane: 0, tone: "ok" },
    { id: "charge", label: "charge", depth: 1, lane: 0, tone: "ok" },
    { id: "ship", label: "ship", depth: 2, lane: 0, tone: "bad" },
    { id: "completed", label: "Completed", depth: 3, lane: 0, tone: "ok" },
    { id: "compCharge", label: "comp charge", depth: 3, lane: 1, tone: "warn" },
    { id: "compReserve", label: "comp reserve", depth: 4, lane: 1, tone: "warn" },
    { id: "compensated", label: "Compensated", depth: 5, lane: 1, tone: "bad" }
  ],
  edges: [
    ["reserve", "charge"],
    ["charge", "ship"],
    ["ship", "completed"],
    ["ship", "compCharge"],
    ["compCharge", "compReserve"],
    ["compReserve", "compensated"]
  ]
}

const DELEGATION_CHAIN: Shape = {
  nodes: [
    { id: "refine", label: "refine", depth: 0, lane: 1, tone: "info" },
    { id: "plan", label: "plan", depth: 1, lane: 1, tone: "info" },
    { id: "derisk", label: "derisk ×2", depth: 2, lane: 1, tone: "muted" },
    { id: "leafA", label: "execute · cheap", depth: 3, lane: 0, tone: "ok" },
    { id: "leafB", label: "execute · deep", depth: 3, lane: 2, tone: "ok" },
    { id: "review", label: "review", depth: 4, lane: 1, tone: "info" },
    { id: "settle", label: "settle", depth: 5, lane: 1, tone: "ok" }
  ],
  edges: [
    ["refine", "plan"],
    ["plan", "derisk"],
    ["derisk", "leafA"],
    ["derisk", "leafB"],
    ["leafA", "review"],
    ["leafB", "review"],
    ["review", "settle"],
    ["review", "plan"]
  ]
}

const SCAN_FIX_VERIFY: Shape = {
  nodes: [
    { id: "scan", label: "scan", depth: 0, lane: 1, tone: "info" },
    { id: "fix1", label: "fix ×4", depth: 1, lane: 0, tone: "info" },
    { id: "fix2", label: "fix ×4", depth: 1, lane: 2, tone: "info" },
    { id: "verify", label: "verify", depth: 2, lane: 1, tone: "info" },
    { id: "rescan", label: "scan 2", depth: 3, lane: 1, tone: "muted" },
    { id: "clean", label: "resolved", depth: 4, lane: 0, tone: "ok" },
    { id: "spent", label: "maxRetries", depth: 4, lane: 2, tone: "warn" }
  ],
  edges: [
    ["scan", "fix1"],
    ["scan", "fix2"],
    ["fix1", "verify"],
    ["fix2", "verify"],
    ["verify", "clean"],
    ["verify", "rescan"],
    ["rescan", "spent"]
  ]
}

const CHECK_SUITE: Shape = {
  nodes: [
    { id: "in", label: "input", depth: 0, lane: 1, tone: "muted" },
    { id: "types", label: "typecheck", depth: 1, lane: 0, tone: "ok" },
    { id: "lint", label: "lint", depth: 1, lane: 1, tone: "bad" },
    { id: "tests", label: "tests", depth: 1, lane: 2, tone: "ok" },
    { id: "verdict", label: "all-pass", depth: 2, lane: 1, tone: "bad" }
  ],
  edges: [["in", "types"], ["in", "lint"], ["in", "tests"], ["types", "verdict"], ["lint", "verdict"], ["tests", "verdict"]]
}

const MAP_REDUCE: Shape = {
  nodes: [
    { id: "shards", label: "shards ×6", depth: 0, lane: 1, tone: "muted" },
    { id: "m0", label: "map 0", depth: 1, lane: 0, tone: "info" },
    { id: "m1", label: "map 1", depth: 1, lane: 1, tone: "info" },
    { id: "m2", label: "map 2", depth: 1, lane: 2, tone: "info" },
    { id: "reduce", label: "reduce", depth: 2, lane: 1, tone: "ok" }
  ],
  edges: [["shards", "m0"], ["shards", "m1"], ["shards", "m2"], ["m0", "reduce"], ["m1", "reduce"], ["m2", "reduce"]]
}

interface Entry {
  readonly id: string
  readonly label: string
  readonly note: string
  readonly tone: "ok" | "warn" | "bad" | "info" | "muted"
  readonly calls: string
  readonly shape: Shape
  readonly bounds: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly codes: ReadonlyArray<string>
}

const PATTERNS: ReadonlyArray<Entry> = [
  {
    id: "ReviewLoop",
    label: "ReviewLoop",
    note: "maxRounds 3",
    tone: "info",
    calls: "6 calls",
    shape: REVIEW_LOOP,
    bounds: [
      { label: "maxRounds", value: "3" },
      { label: "stages", value: "produce · review · revise" },
      { label: "settles", value: "Approved | Exhausted" }
    ],
    codes: ["invalid_decorator", "exhausted"]
  },
  {
    id: "MergeQueue",
    label: "MergeQueue",
    note: "concurrency 2",
    tone: "info",
    calls: "4 calls",
    shape: MERGE_QUEUE,
    bounds: [
      { label: "members", value: "4" },
      { label: "concurrency", value: "2" },
      { label: "priority", value: "descending · DefaultPriority 1000" },
      { label: "failurePolicy", value: "quarantine" }
    ],
    codes: ["quarantined", "invalid_input"]
  },
  {
    id: "Escalation",
    label: "Escalation",
    note: "rungs 3",
    tone: "info",
    calls: "5 calls",
    shape: ESCALATION,
    bounds: [
      { label: "rungs", value: "haiku → sonnet → opus" },
      { label: "accept", value: "declared" },
      { label: "fallback", value: "declared" },
      { label: "settles", value: "Reached | Exhausted" }
    ],
    codes: ["exhausted", "invalid_input"]
  },
  {
    id: "Saga",
    label: "Saga",
    note: "steps 3",
    tone: "info",
    calls: "6 calls",
    shape: SAGA,
    bounds: [
      { label: "steps", value: "reserve · charge · ship" },
      { label: "onFailure", value: "compensate" },
      { label: "unwind", value: "reverse declaration order" },
      { label: "settles", value: "Completed | Compensated" }
    ],
    codes: ["compensation_failed", "invalid_input"]
  },
  {
    id: "DelegationChain",
    label: "DelegationChain",
    note: "maxDepth 3",
    tone: "info",
    calls: "7 calls",
    shape: DELEGATION_CHAIN,
    bounds: [
      { label: "maxDepth", value: "3" },
      { label: "maxDeriskRounds", value: "2" },
      { label: "maxAttempts", value: "3" },
      { label: "tierOrder", value: "cheap · deep" },
      { label: "budget", value: "maxUsd 12 · maxMinutes 45" }
    ],
    codes: ["exhausted", "recursion_bound"]
  },
  {
    id: "ScanFixVerify",
    label: "ScanFixVerify",
    note: "maxIssues 8",
    tone: "info",
    calls: "12 calls",
    shape: SCAN_FIX_VERIFY,
    bounds: [
      { label: "maxRetries", value: "2" },
      { label: "maxIssues", value: "8" },
      { label: "concurrency", value: "4" }
    ],
    codes: ["exhausted", "invalid_input"]
  },
  {
    id: "CheckSuite",
    label: "CheckSuite",
    note: "all-pass",
    tone: "info",
    calls: "3 calls",
    shape: CHECK_SUITE,
    bounds: [
      { label: "checks", value: "typecheck · lint · tests" },
      { label: "strategy", value: "all-pass" },
      { label: "concurrency", value: "3" },
      { label: "continueOnFail", value: "true" }
    ],
    codes: ["invalid_input"]
  },
  {
    id: "MapReduce",
    label: "MapReduce",
    note: "concurrency 3",
    tone: "info",
    calls: "4 calls",
    shape: MAP_REDUCE,
    bounds: [
      { label: "concurrency", value: "3" },
      { label: "onEmpty", value: "reduce" }
    ],
    codes: ["invalid_input"]
  },
  {
    id: "Bounded",
    label: "Bounded",
    note: "concurrency 4",
    tone: "muted",
    calls: "6 calls",
    shape: generic("all"),
    bounds: [{ label: "members", value: "6" }, { label: "concurrency", value: "4" }, { label: "priority", value: "highest first" }],
    codes: ["invalid_input"]
  },
  {
    id: "Debate",
    label: "Debate",
    note: "rounds 3",
    tone: "muted",
    calls: "7 calls",
    shape: generic("debate"),
    bounds: [{ label: "rounds", value: "3" }, { label: "sides", value: "proponent · opponent" }, { label: "judge", value: "declared" }],
    codes: ["invalid_input"]
  },
  {
    id: "DriftDetector",
    label: "DriftDetector",
    note: "baseline",
    tone: "muted",
    calls: "3 calls",
    shape: generic("driftDetector"),
    bounds: [{ label: "stages", value: "capture · compare · alert" }],
    codes: ["invalid_input"]
  },
  {
    id: "Intervene",
    label: "Intervene",
    note: "approval",
    tone: "muted",
    calls: "4 calls",
    shape: generic("intervene"),
    bounds: [{ label: "stages", value: "read · propose · apply · report" }, { label: "approval", value: "optional" }],
    codes: ["invalid_input"]
  },
  {
    id: "Kanban",
    label: "Kanban",
    note: "columns 3",
    tone: "muted",
    calls: "9 calls",
    shape: generic("kanban"),
    bounds: [{ label: "columns", value: "3" }, { label: "concurrency", value: "per column" }],
    codes: ["invalid_input"]
  },
  {
    id: "Loop",
    label: "Loop",
    note: "maxIterations 8",
    tone: "muted",
    calls: "16 calls",
    shape: generic("loop"),
    bounds: [{ label: "maxIterations", value: "8" }, { label: "until", value: "declared" }, { label: "onMaxReached", value: "succeed" }],
    codes: ["exhausted", "invalid_decorator"]
  },
  {
    id: "Optimizer",
    label: "Optimizer",
    note: "target 0.9",
    tone: "muted",
    calls: "9 calls",
    shape: generic("optimizer"),
    bounds: [{ label: "stages", value: "generate · evaluate · improve" }, { label: "target", value: "0.9" }],
    codes: ["exhausted", "invalid_input"]
  },
  {
    id: "Panel",
    label: "Panel",
    note: "members 5",
    tone: "muted",
    calls: "6 calls",
    shape: generic("panel"),
    bounds: [{ label: "members", value: "5" }, { label: "aggregate", value: "deterministic" }],
    codes: ["invalid_input"]
  },
  {
    id: "Quarantine",
    label: "Quarantine",
    note: "continue-on-fail",
    tone: "muted",
    calls: "5 calls",
    shape: generic("settle"),
    bounds: [{ label: "members", value: "5" }, { label: "policy", value: "continue on failure" }],
    codes: ["quarantined"]
  },
  {
    id: "Recursion",
    label: "Recursion",
    note: "fuel 24",
    tone: "muted",
    calls: "24 calls",
    shape: generic("recurse"),
    bounds: [{ label: "fuel", value: "24" }, { label: "depth", value: "3" }, { label: "fanout", value: "3" }],
    codes: ["recursion_bound", "envelope_conflict"]
  },
  {
    id: "Runbook",
    label: "Runbook",
    note: "risk-gated",
    tone: "muted",
    calls: "6 calls",
    shape: generic("runbook"),
    bounds: [{ label: "steps", value: "6" }, { label: "risk", value: "gates the approval" }, { label: "onDeny", value: "skip" }],
    codes: ["invalid_input"]
  },
  {
    id: "Sidecar",
    label: "Sidecar",
    note: "shadow",
    tone: "muted",
    calls: "3 calls",
    shape: generic("sidecar"),
    bounds: [{ label: "arms", value: "primary · shadow" }, { label: "measure", value: "delta" }],
    codes: ["invalid_input"]
  },
  {
    id: "Supervisor",
    label: "Supervisor",
    note: "workers 4",
    tone: "muted",
    calls: "10 calls",
    shape: generic("supervisor"),
    bounds: [{ label: "workers", value: "4" }, { label: "retries", value: "review-declared only" }],
    codes: ["exhausted", "invalid_input"]
  },
  {
    id: "Trellis",
    label: "Trellis",
    note: "fuel 32",
    tone: "muted",
    calls: "32 calls",
    shape: generic("trellis"),
    bounds: [{ label: "fuel", value: "32" }, { label: "depth", value: "4" }, { label: "fanout", value: "4" }, { label: "author", value: "model" }],
    codes: ["recursion_bound", "envelope_conflict"]
  },
  {
    id: "TryCatchFinally",
    label: "TryCatchFinally",
    note: "boundary",
    tone: "muted",
    calls: "3 calls",
    shape: generic("tryCatchFinally"),
    bounds: [{ label: "arms", value: "body · catch · finally" }, { label: "finalizer", value: "every path" }],
    codes: ["finalizer_failed"]
  },
  {
    id: "WithApproval",
    label: "WithApproval",
    note: "run-local",
    tone: "muted",
    calls: "2 calls",
    shape: generic("withApproval"),
    bounds: [{ label: "scope", value: "run-local" }, { label: "settles", value: "Approved | denied" }],
    codes: ["invalid_decorator"]
  },
  {
    id: "WithCache",
    label: "WithCache",
    note: "ttl 600 s",
    tone: "muted",
    calls: "1 call",
    shape: generic("withCache"),
    bounds: [{ label: "ttlMs", value: "600 000" }, { label: "version", value: "3" }, { label: "effects", value: "hermetic, sealed tier" }],
    codes: ["invalid_decorator"]
  },
  {
    id: "WithRetry",
    label: "WithRetry",
    note: "attempts 3",
    tone: "muted",
    calls: "3 calls",
    shape: generic("withRetry"),
    bounds: [{ label: "attempts", value: "3" }, { label: "backoff", value: "exponential" }],
    codes: ["invalid_decorator", "exhausted"]
  }
]

export const Pane = pane({
  id: "patterns",
  title: "Patterns",
  summary: "The composition patterns, each as the graph it declares",
  packages: ["@smthrs/patterns"],
  render: (context) => <PatternsBody {...context} />
})

function PatternsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const pattern = typeof props.pattern === "string" ? props.pattern : "ReviewLoop"
  const node = typeof props.node === "string" ? props.node : ""
  const selected = PATTERNS.find((row) => row.id === pattern) ?? PATTERNS[0]
  if (selected === undefined) return null
  const focused = selected.shape.nodes.find((row) => row.id === node)
  return (
    <Split
      left={
        <Section title="Patterns" right={<Badge tone="muted">{PATTERNS.length}</Badge>}>
          <Rail
            items={PATTERNS.map((row) => ({ id: row.id, label: row.label, note: row.note, tone: row.tone }))}
            selected={pattern}
            onSelect={(id) => {
              runCommandSet("pattern", id)
              runCommandSet("node", "")
            }}
          />
        </Section>
      }
      right={
        <>
          <Section title={selected.id} right={<Badge tone="info">{selected.calls} declared</Badge>}>
            <Graph nodes={selected.shape.nodes} edges={selected.shape.edges} selected={node} onSelect={(id) => runCommandSet("node", id)} />
          </Section>
          <Section title="Bounds">
            <Facts rows={selected.bounds.map((row) => ({ label: row.label, value: row.value, mono: true }))} />
          </Section>
          <Section title="PatternError">
            <Facts rows={[{
              label: "codes",
              value: <>{selected.codes.map((code) => <Badge key={code} tone="bad">{code}</Badge>)}</>
            }]} />
          </Section>
          {focused === undefined ? null : (
            <Section title="Node">
              <Facts rows={[
                { label: "id", value: focused.id, mono: true },
                { label: "label", value: focused.label, mono: true },
                { label: "depth", value: String(focused.depth), mono: true },
                { label: "lane", value: String(focused.lane), mono: true }
              ]} />
            </Section>
          )}
        </>
      }
    />
  )
}
