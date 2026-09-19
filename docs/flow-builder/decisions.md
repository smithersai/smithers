# Flow Builder & Monitor — Decisions

Append-only decision log. Each entry: the decision, who made it, the reasoning,
and what would falsify it. `OPEN` means nobody has decided yet. `PROPOSED` means
Claude proposed it and Will has not ruled. `RULED` means Will decided.

---

### D-001 — It is a *flow* builder, never a *workflow* builder. RULED (pre-existing)
Will's standing rule: no user-visible "workflow". Chrome is Wiki / Dispatcher /
Flows / Secrets / History / Account.
*Applies to:* product copy, node labels, URLs, package names.

### D-002 — The flow file stays the source of truth; the canvas is a projection. PROPOSED
Every criticism of n8n traces to canvas-as-truth: unmergeable diffs, no code
review, a complexity ceiling (research.md §1). Kestra's answer — one declarative
document, canvas edits *the document* — is the only architecture in the survey
that keeps git diffs, review and types (research.md §5, F2).
*Falsified if:* a canvas edit cannot be expressed as a deterministic edit to the
flow source, for a large enough class of edits that the canvas is read-only in
practice. Then we would need a separate persisted graph document that compiles
to a flow.

### D-003 — How a canvas edit becomes a TypeScript edit. OPEN — central risk
Kestra round-trips for free because YAML is structurally editable. Our flows are
TypeScript + Effect. `Flow.make({...})` is already a declarative manifest
(description, input, output, capabilities, flows, effects) which is promising,
but `Action` wiring is arbitrary Effect code.
Candidate answers, none chosen:
1. Canvas edits only the declarative manifest surface; bodies stay code-only.
2. A typed intermediate flow document (the thing the agent already emits) that
   compiles to TypeScript; the canvas edits the document.
3. Canvas emits an instruction to the agent; the agent edits the code and the
   canvas re-derives. (Slow, lossy, but zero new format.)
4. AST codemods over `Flow.make`/`Action.make` call sites.
*This decision gates the whole engineering doc.*

### D-004 — Ship the monitor before the builder. PROPOSED
Relay.app shut down Sept 2026; Flowise archived Aug 2026 — two canvas-first
products dead in one month. Engine-first, monitor-second products (Temporal,
Inngest, Dagster, BuildBuddy) did not die (research.md F7). We already have runs
happening today with no graph view; we do not have users blocked on authoring by
hand, because the agent authors.
*Falsified if:* user evidence shows people refuse to run agent-authored flows
they cannot edit visually first.

### D-005 — Render the graph that *happened*, with the plan as a ghost. PROPOSED
Our flows are dynamic: the agent decides the next step at runtime. Argo and n8n
draw a static graph and color it, which works only because their graph is fixed
before the run. Prefect refuses to draw a static graph at all. We need both
layers: planned nodes drawn dimmed, actual nodes materializing over them
(research.md §7, F4).
*Falsified if:* in practice our runs are statically shaped and the ghost layer is
always empty noise.

### D-006 — React Flow (xyflow) for the canvas unless a run exceeds ~500 nodes. PROPOSED
Our node counts are tens, not thousands, and our nodes must be live interactive
React (an agent card inside a node). React Flow's DOM ceiling is irrelevant at
our scale; Cytoscape/PixiJS buy performance we do not need at the cost of
interactive nodes (research.md §12).
*Falsified if:* a real run renders >500 simultaneous nodes, or per-node React
subtrees drop frames at 50 nodes.

### D-007 — Pin, fork-from-step and replay are table stakes, not the pitch. PROPOSED
n8n (pin + partial execution + debug-in-editor), LangGraph (checkpoint fork),
Temporal (replay debugger) all converged on it independently (research.md F1).
Ship it, do not market on it.

### D-008 — The agent edits the graph as a visible peer. PROPOSED
Presence, a live cursor and a reviewable diff, as shipped by Figma, Zed and
Cursor in 2026 (research.md §14, F8). Applied to a flow graph this appears
unoccupied. This is the candidate differentiator.
*Falsified if:* watching an agent edit a graph is noise, and users only want the
finished diff.

### D-009 — Docs live in `docs/flow-builder/` as Markdown. RULED (Claude, low stakes)
Follows `docs/jev-harness/` and `docs/mvp/` precedent. Markdown rather than HTML
because these are append-heavy and LLM-read. Mockups will be self-contained HTML
under `docs/flow-builder/mockups/` when we get there.

### D-010 — Emit OpenTelemetry `gen_ai.*`-shaped spans from run events. OPEN
Would make our runs exportable to Langfuse/Datadog/Arize. Attributes are
Development-stability and can change without a major bump (research.md §13).
Decide during the engineering doc, not before.

### D-011 — Name of the product surface. OPEN
Not yet named. Candidates that respect D-001: "Flows" (the existing chrome tab),
"Canvas", "Run graph". Do not ship a second noun if the existing Flows tab can
hold it.

---

## Things Will may want to overrule later
- D-002 vs. speed: a canvas that only *reads* the flow file ships much faster
  than one that writes it. The proposed sequence (monitor first) dodges this for
  one release but not two.
- D-004 orders monitor before builder. If the demo story needs the builder, that
  order flips and D-003 becomes urgent immediately.

---

## Round 2 — after the codebase survey (2026-09-18)

### D-012 — Re-light the deleted `GraphCard`; do not build a canvas from scratch. PROPOSED
`GraphCard.tsx` (452 lines, React Flow + dagre, deps ∪ rdeps focus, critical
edges, node drawer, run-status overlay, view state in the card payload) exists at
`jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCard.tsx`. It was
retired with the local backend, not because it was wrong. `@xyflow/react` and
`dagre` are still installed and unimported; the `react-flow` CSS prefix is still
whitelisted; `@smthrs/ui` ships a renderer-neutral `WorkflowCanvas` anatomy built
for exactly a ReactFlow layer, with the ARIA work already done.
*Falsified if:* the retired card's data model is bound to the local backend in a
way that cannot be repointed at the run journal.

### D-013 — Poll vs. stream for a live graph. OPEN — gates the design doc
The run monitor polls every 2500 ms (`workflow-pump.ts`, `context.ts:175`). The
gateway allowlist (`apps/server/src/gatewayRpc.ts:45`) **deliberately excludes**
`Watch` and `Projection.Subscribe`: "a stream belongs on the gateway's separately
authenticated WebSocket mounts." Temporal's stated property is liveness — "the
Workflow updates in real-time" — and a 2.5 s poll will read as lag on a graph
whose nodes light up.
Options: (a) ship on the poll and tighten the interval while a graph card is
open; (b) open the streaming mounts; (c) drive the graph off the already-live
turn NDJSON stream for the current turn and poll for the rest.
*Do not write liveness into the design doc before this is ruled.*

### D-014 — The first version is an experimental pane, not a shipped surface. PROPOSED
`apps/app/src/mainview/experimental/` already exists behind
`VITE_SMITHERS_EXPERIMENTAL`, with reserved panes `Plan`, `Flows`, `TimeTravel`,
`StepCache` that still read "Not drawn yet." Cost of a first canvas: one file
under `experimental/panes/`, one line in `Registry.ts`. Its own doc says "NO
INVENTION does not bind a mock the way it binds a shipped surface: a mock is a
proposal."

### D-015 — Revive the retired `graph` card kind rather than mint a new one. PROPOSED
Kinds `graph` and `run-timeline` still exist in the wire schema
(`packages/rpc/src/Cards.ts:2158-2220`) but route to a retired family that
renders `null`. Separately, TanStack DB type inference gives up past 30 union
members (`state/useCardRows.ts`), so widening the `Card` union has a real cost.
Alternative worth considering: no new kind at all — add `traceView: "graph"` to
the existing `run-trace` card, which already carries `traceView`, `selection`,
`cursorSeq`, `filter`, `liveTail` and `facet` in its payload.

### D-016 — What is actually missing is the graph and the act, not the monitor. RULED (fact, not preference)
`RunTraceCard.tsx` (797 lines) already ships a phase strip on a time axis, filter
chips, a span tree, a waterfall, a span detail pane and a child-run door, over a
span model (`RunTrace.ts`) with eleven span kinds folded from the journal. The
gap versus the survey is narrower than assumed: **a node-link view of the plan,
and the ability to act on a node** (pin, fork, re-run from here, steer this
step). This narrows D-004 — "monitor before builder" is nearly already true.

---

## Round 3 — after the engine survey (2026-09-18)

### D-017 — There is no loop node and there never will be. RULED (engine invariant)
`packages/smithers/flows/plan/src/Node.ts:6-9`: "A plan is always a DAG, so there
is no loop node here and never will be: repetition lives one level up, in what a
flow settles with." Repetition is either bounded unrolling inside the body (see
`examples/src/17-review-loop.ts`, which literally plans `maxRounds` review nodes)
or a `Flow.to()` handoff that ends the round and names the next — a new
`flows_runs` row with `lineage_id` + `round_ordinal`.
*Consequence:* an n8n-style "Loop" widget cannot exist on our canvas. Any looping
affordance must compile to one of those two, and the canvas must show a bounded
loop as N real nodes and a trampoline as a round boundary. This is a product
constraint, not an implementation detail.

### D-018 — The plan already contains both branch arms; D-005's "ghost" is narrower than assumed. RULED (engine fact)
`Graph.build` evaluates every continuation and branch arm exactly once against a
strict `Planned` placeholder and **both** arms expand into the plan
(`flows/flow/src/Graph.ts:6-37`). At run time `Interpretation.skipped`
(`Interpreter.ts:119`) names the arm not taken. So the static graph is real and
complete for a given payload; what "grows" is only append-only subgraph growth
(`Plan.append`, `flows.engine.subgraph-appended`) and new trampoline rounds.
*Revises D-005:* draw the built plan solid, grey the `skipped` arm, and reserve
the ghost treatment for appended generations and future rounds.

### D-019 — Revises D-013: the engine already streams; the gap is the app relay. RULED (fact)
The gateway serves `Projection.Subscribe` over `/projections/ws` with cursored
snapshot/row/delta frames and a 30 s heartbeat
(`packages/smithers/gateway/src/GatewaySchema.ts:444`,
`gateway/src/Projections.ts:56`), and `Watch` over `/rpc/ws`. What excludes them
is the product Worker's allowlist (`apps/server/src/gatewayRpc.ts:45`), by a
deliberate choice that "a stream belongs on the gateway's separately
authenticated WebSocket mounts." So liveness is an auth/relay problem in
`apps/server`, not an engine feature request.

### D-020 — The one thing genuinely missing: a plan-graph projection. PROPOSED
Seven projections are served today (`GatewaySchema.ts:171`): `workspace-runs`,
`run-summary`, `run-events`, `transcript`, `run-tree`, `approvals`,
`node-output`. None of them carries the plan's node ids and edges.
`RunTreeRow.nodeId` is "the ordinal the call opened on, because the emitter names
no node" (`GatewayProjection.ts:83-86`). The real graph lives in
`flows_plan_nodes` / `flows_plan_edges` and in the `flows.engine.node-scheduled`
/ `node-settled` / `node-invalidated` / `node-reconciled` journal events
(`engine-store/src/internal/JournalRecords.ts:212-248`), none of which the
gateway projects.
*The work:* one row in the `served` table and one fold in `Projections.ts` — the
selector union, name literals, snapshot/row/delta frames and `rowSchemaFor` all
derive from that table. This is the smallest change that makes a live DAG
possible, and it is the first engineering task.

### D-021 — The pitch candidate is the content-addressed re-run, not the watching. PROPOSED — needs Will
A node's step key is a function of what it consumes, so editing one node re-keys
that node and everything downstream of it **and nothing else**
(`flows/plan/src/Plan.ts:4-12`: "That is the entire invalidation mechanism").
Node ids never enter the hash, so renaming and repositioning are free
(`StepKey.ts:459-461`). Cache state is legible before a run
(`PlanNodeStatus = ["cached","run"]`, `ControlSchema.ts:198`) and after
(`Settlement.outcome ∈ {built, clean, failed, skipped, deferred}`,
`PlanScheduler.ts:125`).
This is Bazel's incrementality applied to agent runs, it is structural rather
than a UI trick, and n8n cannot copy it — their answer is manual pinning plus
partial execution (research.md §1). "Watch a graph run" is table stakes; "change
one step of a two-hour agent run and pay for one step" is not.
*Falsified if:* in practice most edits land near the root, so the cached suffix
is small and the saving is illusory.

### D-022 — Editing a node invalidates approvals bound to the plan digest. RULED (engine fact, must surface in UI)
Approvals bind to the keyed node graph: `ApprovalTarget` is `Plan{planId,
digest}` or `Node{...}` (`control/src/ControlSchema.ts:~140`), and the digest
comes from `Plan.compile` (`plan/src/Plan.ts:341`). Re-keying a node therefore
invalidates the approval that covered it.
*UI consequence:* a canvas edit must show which approvals it just voided, before
it is committed. This is a safety surface, not a nicety.

### D-023 — Approval and human-task rendering is already specified by the engine. RULED (fact)
`flows_runs.waiting_request` holds the question as JSON — `{task, name, kind,
prompt, attempt, maxAttempts, options?, schema?}` with `kind ∈ ask | confirm |
select | json` (`flows/flow/src/HumanTask.ts:70,505`,
`run-store/src/migrations/0004_waiting_request.ts`). `kind` picks the control,
`options` fills a select, `schema` validates a JSON answer. That is the render
spec, and it already matches THE FORM LAW in `apps/app/AGENTS.md`. Do not invent
a second approval schema.

---

## Round 4 — from building the mock (2026-09-18)

### D-024 — The camera follows the action; the graph is never shown unreadable. RULED (from the mock)
A 14-node flow is ~3,700px wide at readable density. Fitting it in a 1,000px
pane puts every node at 0.26 zoom, which is a picture of a graph rather than a
graph. The mock pans to the live node at ~0.94 and pulls back to ~0.62 only for
the cached/dirty boundary. n8n has the same constraint and answers it with
manual panning; following the run is strictly better and costs nothing.

### D-025 — No minimap. RULED (from the mock)
At this aspect ratio every node renders as a 2px sliver. It was built, looked
like noise, and was deleted. Revisit only if flows become genuinely 2-D.

### D-026 — Colour is never the only signal. RULED
Every node carries its state as a word as well as a colour (`waiting on you`,
`cache hit`, `will re-run`, `skipped`). This is the a11y contract `@smthrs/ui`'s
canvas anatomy already assumes, and it is also what makes a screenshot readable.

### D-027 — The third act is the product; the first two are setup. PROPOSED
The mock proves the ordering: drafting and running are recognisable from every
competitor, and the re-key preview is the only beat that has no analogue. If the
demo has to be cut to ninety seconds, cut acts 1 and 2, never act 3.

### D-028 — The mock shows the consequence of an edit, never the edit. NOTED
Deliberate. D-003 is unresolved, so the mock refuses to imply an answer: you see
what an edit re-keys, what it costs and what it voids, but the edit itself
happens off-screen. The next design round has to close D-003 or the builder
half of the product stays a promise.


---

## Round 5 — Will's rulings and a self-review (2026-09-18)

### D-029 — The vision: agent-led build, live run, incremental re-run, on one canvas. RULED (Will)
"Mostly just an agent walking you through building and potentially running the
workflow in real time with n8n animation and [the content-addressed re-run]."
This settles the question D-021 asked. D-004 ("monitor before builder") is
superseded: builder, monitor and re-key ship as one surface.

### D-030 — Flows predict how long things will take. RULED (Will)
Per-node expected duration before it runs, a run ETA over the critical path,
progress against prediction while running, and the re-key estimate. Source:
`flows_attempts.started_at_ms / finished_at_ms` grouped by action tag (stable
across re-keys, unlike the step key). Show p50 with the sample size; fall back to
a range when p90/p50 > 3; show nothing when there is no history — never a row
whose value is "not measured yet" (AGENTS.md MINIMAL TEXT). No predictor exists
in the engine today; this is new engineering work and needs a projection.

### D-031 — The trigger is not a plan node. RULED (engine fact, found in self-review)
A trigger is a Dispatcher registration. It has no step key, is never `built` or
`clean`, and a manual re-run does not re-fire it. On the canvas it is `armed` or
`fired`, joined to the plan by a UI-only `fires` edge, and excluded from every
count. The first mock got this wrong and called a trigger a cache hit.

### D-032 — Skipped nodes are not cache hits. RULED (self-review)
The first mock claimed "11 cache hits" by adding 2 `skipped` nodes and the
trigger to 8 `clean` ones. The honest figures for the demo flow are 13 plan
nodes, 11 executed, and after the edit 3 re-run / 8 clean / 2 skipped.

### D-033 — Code shown in the product must compile against the real API. RULED (self-review)
The first draft of the demo flow source misused four APIs: `Node.andThen` takes
a Node (not a thunk), `Node.catch` takes `{ onFailure }`, `Node.branch` takes a
Node as its subject, and a `Classifier` has `evaluate`/`evaluateAll`, not `call`
— a Jev decision becomes a plan node by wrapping it in an `Action` whose layer
calls the classifier. Fixed against `plan/src/Node.ts`. The graph also gained the
value edge the code implies (`repro → writetest`), which dagre routes on its own
row. Rule: every edge on the canvas must be derivable from the source shown in
the code tab, and vice versa.

---

## Round 6 — round-2 mock and the production map (2026-09-18)

### D-034 — The graph lays out top to bottom. RULED (from the mock)
Nodes are 228×88, so a rank costs 142px vertically and 314px horizontally. A
15-node unrolled `reviewLoop(maxRounds=3)` fits a square pane at a readable zoom
top-to-bottom and is a 0.3-zoom ribbon left-to-right. This also ends the wasted
vertical band the first mock had. n8n is left-to-right because its nodes are
square icons; ours are wide cards.

### D-035 — The drawer's tabs appear only when evidence exists. RULED
Kind-specific first tab (`Schedule` / `Frames` / `Questions` / `Question`), then
`Output · Input · Code · Key · Attempts · Events`. A tab with nothing behind it
is absent, never empty (MINIMAL TEXT). An agent node, a Jev node and an action
node are three different data shapes, so they are three different panels.

### D-036 — The production host serves no plan graph and no node events today. RULED (fact)
`NativeControl.durableFlow` has no `plan` hook, so `PlanCard.nodes` is always
`[]`; `PlanScheduler` (the only emitter of `node-*` records) has no production
caller, and the `Interpreter` that does run emits no journal records. "No mocks"
therefore requires two engine changes before any UI: the plan hook, and
Interpreter node events through a `FlowRuntime.recordNode` seam. Live status
then folds app-side from the `run-events` pages the pump already reads, which
supersedes D-020's separate `plan-graph` selector.

### D-037 — Code drill-in is not cut; it gets an engine lane. RULED (Claude, against the planner's cut line)
The planner cut file:line provenance because the engine keeps only a function
digest. Will asked for "a really high quality way of drilling into things and
seeing the actual code", so it ships: a non-hashed `declaredAt {path, line}`
captured where an Action/Flow is declared and called, carried beside the plan
(never inside `KeyMaterial`, or every edit would re-key everything), plus typed
edge reasons from `Graph.build`. Both ride an additive optional `graph` field on
the PlanCard, outside the digest an approval binds to. Dagster's
`LocalFileCodeReference` is the prior art (research.md R2).

### D-038 — Ship dark behind `flowBuilder`, then flip. PROPOSED
Every `jj bookmark set main` is a production deploy and the Stop-hook autodeploy
does not gate on typecheck. The feature lands behind `VITE_SMITHERS_FLOW_BUILDER`
with the flag off byte-for-byte identical, and the flip is a one-line change Will
makes after testing.

### D-039 — External blocker: cloud workspaces run a *released* @smthrs. NOTED — Will's action
The engine half reaches real cloud workspaces only after a publish, and the
publish campaign is blocked on an `NPM_TOKEN` 401 that only Will can remint.
Until then the feature is fully real on the local stack (one command) and shows
`nodes: []` against production boxes.

---

## Round 7 — what the two critics caught (2026-09-18)

### D-040 — A node is headed by its action tag; titles are not engine data. RULED (fact)
`Plan.PlanNode` is `{id, kind, key, material, effects, dependsOn, conflicts,
strategy, runtime, priority, generation}` and an `Action` has a tag, not a title.
The mock's friendly titles ("Reproduce the bug") were invented. Cards are now
headed by the tag with the plan node id beneath. A human title can return only
as a real, non-hashed annotation on the declaration, next to `declaredAt`.

### D-041 — The state word is `clean`, not "cache hit". RULED (fact)
`PlanScheduler.ts:104-107`: `clean` means a recorded result served the node and
no executor ran, which includes same-run durable replay as well as a cross-run
cache hit. The re-key card may still count "cache hits", because after an edit
that is exactly what the unchanged nodes are. Note also `NodeOutputRow.outcome`
is only `success | failure`; the five settlement words come from `node-settled`.

### D-042 — Only verbs the engine has. RULED
`Pin output` and `Re-run from here` are gone from the mock: the engine's pin is a
pinned read snapshot, not n8n's pin-data, and `runs.rerun-from <runId> <nodeId>`
exists nowhere. D-007 stands as a goal, but it is engine work for a later
milestone, not a button. Cut for the same reason: sticky notes, placement lanes,
conflict edges, a `parked on quota` trigger state, drag-to-wire.

### D-043 — A trigger is a cron schedule. RULED (fact)
`Trigger` is `{id, flowId, input, ...Schedule.fields, enabled}` and
`Schedule.cron` is a required `NonEmptyString`; `@smthrs/triggers` has no event
kind. Factory rules (`FactoryRule.event`) are a different object and are not
drawn as a trigger node. `describeSchedule` narrates five-field cron only.

---

## Round 11 — what wave 4 settled (2026-09-19)

### D-056 — The Code tab landed inline, and a refused read is written on the card. RULED
The tab renders through `CodeSurface` over the file card, anchored at
`declaredAt.line`, for both the run graph and (through the additive
`PlanGraph.nodes: [{id, declaredAt?}]`, outside the approval digest) the plan
card. `withToast` holds a 300 ms debounce, so a read the repository refuses in
40 ms resolved a toast that was never shown: the failure was silent. The refusal
is now `codeError {path, message}` on the card, drawn where the file would be,
cleared by a read that succeeds, with `Open file` as the retry door. The path
relativiser moved to `@smthrs/journal` beside the `DeclaredAt` schema, so the
engine's node records and the control plan card refuse an absolute path by the
same rule.

### D-057 — A plan drawer has no Attempts or Output, and that is correct. RULED (fact)
A plan is what *would* run; it carries no run records. Only the run drawer shows
Attempts and Output. Attempt rows carry ordinal, state and timing and no error
text, because `flows.engine.attempt-finished` records none; the one bounded
typed error the engine keeps is the node settlement's, shown on Output.

### D-058 — Dimming is done with colour, never opacity. RULED (from the a11y review)
`opacity: 0.72` on pending and skipped nodes composited the state word down to
3.07:1. Settled-quiet states are now drawn with muted tokens at full opacity.
The mock's 38%-opacity skipped node was wrong for the same reason.

### D-059 — Known gaps at hand-off. NOTED
- **No axe scan.** `axe-core` is in no lockfile and lanes may not touch
  `pnpm-lock.yaml`; the spec asserts accessible name, role, keyboard reach and
  contrast by hand instead, and `apps/E2E-CANARY-CHECKLIST.md` E13.11 records
  the gap. One lockfile entry closes it.
- **No typed fault class on the plan card's workspace failures.** The relay
  answers `provisioning | no-capacity | quota-exceeded | no-cloud-identity |
  no-cloud-repo`, but `provisionWorkspaceImpl` collapses them to their message
  before the card sees them. That is pre-existing app plumbing shared with every
  launch, and changing its contract is its own lane.
- **An older box cannot refuse an unknown selector with a code**: it dies in its
  request decoder. Silence ("no rows, no chips") is the only honest rendering.
- Cross-run cache hits (D-044, D-049) and trigger editing (D-051) are absent by
  engine truth, and the manual test guide says so.
