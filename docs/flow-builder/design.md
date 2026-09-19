# Flow Builder & Monitor — Design

Stage: **a mock exists; the one-line product sentence is still unruled.**

Open it: `open docs/flow-builder/mockups/flow-builder.html`
Notes: `mockups/README.md`

## One sentence (placeholder)
> PENDING — one sentence describing what the user sees and touches.

---

## What the mock fixes in place

**One surface, three acts.** Chat on the left, canvas on the right, the same
graph throughout. Drafting, running and re-keying are modes of one artifact, not
three screens. This is the answer to research.md F3.

**The camera follows the action.** A 14-node flow is ~3,700px wide; fitting it
makes every node unreadable. So the canvas pans to the live node at ~0.94 zoom
during a run, and pulls back to ~0.62 at the cached/dirty boundary for the
re-key story. Nothing is ever shown at a zoom where its text cannot be read.

**Node anatomy** (following `@smthrs/ui`'s `sui-canvas-*`):
kind rail · glyph · title · irreversible lock · status dot ·
`Action` tag in mono · live caption while running · kind chip · seat or model ·
state word · duration or `0ms` for a cache hit.

**Status ramp.** Idle dashed → running brand ring + shimmer → waiting amber
breathing → failed danger shake → built green → clean green dimmed with `0ms` →
skipped 38% dashed → dirty amber dashed. Every state also carries a word, so
colour is never the only signal.

**Edges.** `value` solid, `continuation` solid, `failure` dashed danger with a
`CATCH` label; branch arms labelled `THEN` / `ELSE`. Active edges animate
marching dashes. Edges into a `skipped` node drop to 28% opacity.

**The inspector** is schema-derived, not hand-written: payload fields with their
types, `Planned` references drawn as `← upstream.field`, the success and error
schemas, the declared effects, and the step key with its re-key shown as
`old → new`.

**The re-key HUD** is the product. Before an edit is applied: which nodes
re-key, how many are cache hits, the new estimate against the old wall clock,
and how many approvals the digest change voids.

## Deliberately absent
- No minimap: at this aspect ratio it renders as slivers and reads as noise.
- No legend: every node states its own status in words.
- No loop widget: the engine has no loop node (decisions.md D-017).

## Still to design
- Editing a node in place — the mock shows the *consequence* of an edit, never
  the edit. That is decisions.md D-003 and it is still open.
- The agent editing the graph while a human also edits it (decisions.md D-008).
- Empty, error and permission states.
- Multi-round flows: what a `Flow.to()` trampoline boundary looks like.


---

# Round 2 — surface specs (from five design lanes, 2026-09-18)

Written against the six research lanes in research.md R2.*. The mock implements a subset; the production lanes build from these. Where a spec and `decisions.md` disagree, `decisions.md` wins.

## Canvas & Run Rail — flow-builder mock v2 (the graph band, its per-node/per-edge affordances, and the bottom run rail)

The canvas pane stops being a 202px band floating in 812px of empty dots: it splits into a graph region that carries n8n's hover toolbar, context menu, edge peek and issues badge — all re-pointed at a content-addressed DAG where an edge carries one typed value — and a resizable run rail below it that is `RunTraceCard`'s waterfall on a shared time axis.

### Layout

```
CANVAS PANE = 1124 x 812 inside the 1600 x 900 shell (Chat keeps its 476px left column).
It splits into two stacked regions with one drag handle. This split IS the vertical-space fix.

┌ Canvas pane 1124 x 812 ───────────────────────────────────────────────────────┐
│┌ GRAPH REGION 1124 x 452 (56%) ──────────────────────────────────────────────┐│
││ ┌ flow panel (12,12) ───────────┐      ┌ HUD top-centre, 420 wide ────────┐ ││
││ │ morning-triage │ key1_9f3c2ab7 │      │ Editing `checks` re-keys 3 nodes │ ││
││ │ re-key                         │      │ 8 clean · 2 skipped · 4.9s       │ ││
││ └───────────────────────────────┘      └──────────────────────────────────┘ ││
││   96px top inset (band is TOP-aligned, not centred)                          ││
││          ┌ hover toolbar 4 btns, 28px tall, 8px above node ┐                 ││
││          │  ▶   📌   </>   …                               │                 ││
││   ▢──────▣──────◈──────▢──────▢──────▢     ← rank 0..n, dagre LR             ││
││   issues        └─ELSE─▢ (skipped, 38%)                                      ││
││              ┌ edge peek 220 x 64, midpoint, 250ms dwell ┐                   ││
││              │ repro → test        value                 │                   ││
││              │ Reproduction                              │                   ││
││              │ 41 KB              built · 14m 20s        │                   ││
││              └───────────────────────────────────────────┘                   ││
││ ┌ zoom controls (12, bottom) ┐                                               ││
│└──────────────────────────────────────────────────────────────────────────────┘│
│ ══════════════ drag handle, 8px, cursor row-resize ═══════════════════════════ │
│┌ RUN RAIL 1124 x 360 (44%) ──────────────────────────────────────────────────┐│
││ [Steps│Events]   ● Live   ▢ Errors only   ▢ Sync selection with canvas    ⌄ ││
││ ├ issues      call    █                          1.4s      [▶ on hover]     ││
││ ├ triage      model   █                          0.9s                       ││
││ ├ repro       agent   ████████████               14m 20s                    ││
││ │  └ attempt 1  frame    ███                                                ││
││ ├ test        call     ██   attempt 2            2m 5s                      ││
││ ├ approve     approval  ░░░░░░  waiting on you   3m 40s                     ││
││ └ writetest   agent    ██████████████████████    41m 12s                    ││
││                                     [zoom ──●──────  0 .. 1, step 0.05]     ││
│└──────────────────────────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────────┘

DRILL-IN DRAWER (when a node is open) overlays the RIGHT 420px of the whole canvas
pane — both regions, full 812px height. A side pane, never a modal: D-024 has the
camera following the run, and an n8n-style NDV modal would fight it. The graph
region's camera re-centres on the selected node with a 420px right inset so the
node is never under the drawer.

SNAP HEIGHTS (drag handle, or `E` / `W`), persisted as `railHeight`:
  "closed" → graph 780 / rail 32 (header only)
  "open"   → graph 452 / rail 360   ← default
  "full"   → graph 120 / rail 692   (graph collapses to a one-rank strip)

THE ARITHMETIC THIS FIXES. Today the graph is one dagre LR band. `NODE_HEIGHT = 88`,
`nodesep: 26`; `morning-triage`'s tallest rank is 2 nodes (`branch → {repro, defer}`),
so the tallest column of real content is 88 + 26 + 88 = 202px. At the run camera's
0.94 zoom that is 190px inside an 812px pane — 23% used, 77% dots. Splitting the pane
puts 202px of content into a 452px frame (enough for the 36px toolbar above a node and
the 64px edge peek below one) and gives the other 360px to a second axis the data
actually has: time.

LANES (`L`, off by default) — the graph region's own vertical budget. When on, dagre
gets a per-node rank-align constraint from `PlanNode.material.placement`, drawing four
horizontal bands top to bottom: `remote` / `sandbox` / `local` / `client`, each named
once in 10px mono in a 64px left gutter. A chain flow with three placements becomes
three rows instead of one. Off by default because a single-placement flow would render
one band with an empty title, which is a MINIMAL TEXT violation.

REJECTED vertical fixes, so nobody re-proposes them: serpentine/snake wrap (dagre has
no such mode, a hand-rolled fold breaks edge monotonicity, and the reader has to learn
which end of row 2 follows row 1 — it makes a picture, not a graph); a minimap (D-025);
growing the node card to 160px to fill space (buys fill with words nobody asked for);
a 2-D grid of an acyclic chain (same defect as serpentine).
```

### Anatomy

- **Node hover toolbar — container** — Four buttons, 28px tall, centred 8px above the node's top edge. Composed from `@smthrs/ui`'s `WorkflowToolbar` (`data-slot="workflow-toolbar"`, `.sui-canvas-toolbar`), which already ships the ARIA toolbar contract: one tab stop in, then Arrow/Home/End roving tabindex, disabled items never roved. _(Counter-scaled against zoom — `transform: scale(var(--canvas-zoom-compensation-factor, 1))`, n8n's `CanvasEdge.vue` trick — so it is 28px tall at every zoom. Does NOT render below zoom 0.45: D-024 already says a node is never shown at a zoom where its text cannot be read, so a toolbar there would be a target without a label. Renders on pointer hover AND on keyboard focus of the node.)_
- **Toolbar button 1 — Re-run from here** — Icon: play triangle. Tooltip: `Re-run from here · 8 cache hits · 4.9s`. Disabled while the node is `running` or `queued`, with tooltip `Wait for this node to settle`. _(Fed by: `Plan.compile` of the same flow with this node's `WithCache.Options.version` bumped → a new `Plan.digest`; `PlanDiff(from, to)` gives `{added, removed, rekeyed, unchanged}` and the counts are `rekeyed.length` / `unchanged.length`. The estimate is D-030's predictor (p50 over `flows_attempts.started_at_ms`/`finished_at_ms` grouped by action tag). NO FLOW ID EXISTS: `runs.rerun <runId>` re-runs the whole run. This needs a new one, `runs.rerun-from <runId> <nodeId>`. That is the single new command in this spec.)_
- **Toolbar button 2 — Pin output** — Icon: pin. Tooltip: `Pin output · this key always settles clean`. When already pinned: `Unpin output`. _(Fed by: nothing today. The engine's `pin` is a pinned READ snapshot (`PlanScheduler.ts:774` `pinned`/`unpinned`), not n8n's pin-data. A pin here compiles to a step-cache entry published under the node's `key_digest` with `WithCache.Scope = "shared"` and no `ttlMs`, read back as `flows.engine.cache-provenance {keyDigest, recordedRunId, recordedEventSeq}`. Badge it as a proposal in the drawer; do not imply the engine has it.)_
- **Toolbar button 3 — Open code** — Icon: `</>`. Tooltip: `Open code`. _(Opens the drill-in drawer's Code tab. Three strata, in order: (a) the agent's cell source from `control.agent.cell-produced {text, language}`, rendered through the app's shipping `CodeFileView` (`@smthrs/ui/adapters/code-view`, Shiki); (b) `flows/<Plan.flow>/flow.ts` or `flow.mdx` (the filenames `Doctor.ts:155-194` probes), opened via `files.read <path>`, with the node id as a segmented AST path and no fake line marker; (c) neither: `Node.FunctionIdentity {algorithm, digest}` and the sentence `Source is not persisted — only its digest.`)_
- **Toolbar button 4 — More actions** — Icon: horizontal ellipsis. Tooltip: `More actions`. Opens the context menu at the button. _(n8n's `overflow-node-button` is always last; keep that.)_
- **Toolbar — what is deliberately NOT in it** — No Deactivate. No Delete. No Duplicate. _(RULING TO WRITE INTO decisions.md: deactivating a node changes what its consumers consume, so it re-keys that node and everything downstream (`Plan.ts:4-12`) and voids every approval bound to the plan digest (D-022). It is an edit, not a toggle, and it can only reach the canvas through the re-key HUD. The word `deactivate` is banned from this surface.)_
- **Node context menu** — In order, with n8n's ellipsis convention (`…` opens a dialog or the HUD; no ellipsis acts now): `Open` · `Re-run from here…` · `Pin output` / `Unpin output` · `Copy step key` · `Copy node id` · `Copy for AI` · ─── · `Select downstream` · `Select upstream` · ─── · `Add note`. _(Multi-select rewrites the subject n8n-style: `Re-run from 4 nodes…`, `Copy 4 step keys`. `Copy step key` copies `key1_8f77ac30` (`flows_plan_nodes.key_digest`); `Copy node id` copies the structural address `root.andThen.branch.then.map`; `Copy for AI` is Trigger.dev's verb, verbatim, and emits the node's evidence as markdown. NO mutation of the flow source appears here — no Rename, Delete, Duplicate, Replace — because D-003 is open and D-028 says the mock shows the consequence of an edit, never the edit.)_
- **Node status slot — issues badge** — A warning triangle `▲` replaces the status dot; the state-word slot reads `issues`. Tooltip is a titled list headed `Issues:` with one row per diagnostic, deduped as `<message> (x2)`. _(Fed by `Graph.diagnostics(graph): ReadonlyArray<GraphBuildError>`, matched to the node by `GraphBuildError.node`; `path` appends to the address (`node: "root.andThen"`, `path: ["since"]` → `root.andThen.since`). Only TWO codes ever reach here: `invalid_continuation` and `unstable_callback`. Everything else throws from `Graph.build` and is the whole-canvas refusal below.)_
- **Canvas-level issues consequence** — The flow panel's Run button is disabled, never hidden, with the tooltip `2 nodes have issues — this graph cannot compile`. _(This is engine-exact, not a nicety: `Graph.drafts(graph)` throws the first diagnostic, and it is the only path to the drafts `Plan.compile` needs. A graph with diagnostics is inspectable and NOT compilable. Disabled-with-tooltip over hidden matches the agent-parity rule.)_
- **Whole-canvas build refusal card** — Replaces the graph region entirely, 520px centred:
H: `This flow does not build`
Row: `planned_value_computed` (mono, danger) · `at root.andThen.since`
Body: the verbatim `GraphBuildError.message`
Action: `Open flows/morning-triage/flow.ts` _(Fed by a thrown `GraphBuildError` from `Graph.build`. Ten codes reach here: `planned_value_computed`, `invalid_all_member`, `recursion_requires_boundary`, `placement_requires_boundary`, `cyclic_payload`, `payload_too_deep`, `graph_too_deep`, `duplicate_node`, `invalid_priority`, `invalid_payload`. There are no nodes to badge, because there is no graph — that is why this is a whole-region state and not a node decoration. The message already states the fix (`GraphBuildError.ts:5-9`), so the card adds no prose of its own.)_
- **Edge — resting state** — Stroke only. `value` and `continuation` solid; `failure` dashed danger. A LABEL is drawn only for `THEN`, `ELSE` and `CATCH`. A `value` edge carries no label at rest. _(Why no type name at rest: at the re-key camera's 0.62 zoom (D-024) thirteen edges with type names is noise, and the type is one hover away. Labels are zoom-counter-scaled so they stay 10px mono at every zoom (n8n's `--canvas-zoom-compensation-factor`).)_
- **Edge peek card (hover)** — 220 x 64 at the edge midpoint, after a 250ms dwell, closing instantly on pointer-out. Three rows:
`repro → test` (mono, 10px) ······ `value` (the EdgeReason word)
`Reproduction` (the declared type, 12px)
`41 KB` ······ `built · 14m 20s` _(Row 1 reason: DERIVED, see the classification rule below. Row 2 type: from the consumer's declared `Action.payloadSchema` at that member — NOT persisted, so it needs D-020's projection to carry it or a client-side `Graph.build`. Row 3 left: byte length of `NodeOutputRow.output`, which is `Schema.String`; an item count would be a lie so there is none. Row 3 right: `Settlement.outcome` + (`flows_attempts.finished_at_ms - started_at_ms`). Before the producer settles, row 3 reads `[settles during the run]` — n8n's `[evaluated during execution]` in our vocabulary. The peek is not clickable; a click on the edge selects both endpoints.)_
- **Edge classification rule (the whole answer to 'is edge reason a fourth column?')** — No new column. Every edge and every label the canvas draws folds out of `flows_plan_nodes` alone:
• `value` iff the consumer's `material.inputs` holds `Ref{from: X, path}`.
• `continuation` iff `X ∈ dependsOn` and the only reference to X is `Pending{from: X}`, or there is none — the ordering edge `Plan.ts` says is deliberately not part of the key.
• `failure` iff the consumer's structural id ends `.recover` / `.failure` / `.protected` (`Graph.ts:1359-1362,1383-1384`).
• Label `THEN` iff the id ends `.then`; `ELSE` iff `.else` (`Graph.ts:1306,1315`). _(`flows_plan_edges` really is three columns `(plan_id, from_node, to_node)` with no reason, and `Plan.Plan` has no `edges` field at all — only `nodes`. This fold is therefore the shipping path; a `reason` column is a later cleanup, not a blocker. `KeyMaterial.InputRef` is the tagged union `Literal{value} | Ref{from, path} | Pending{from}`, and the tag is hashed, so the distinction is load-bearing in the engine, not a UI convention.)_
- **Conflict edge (hover/selection only)** — A dotted grey edge between two nodes that no dependency path orders, drawn only while either endpoint is hovered or selected, labelled with one word: `serialize` / `lane` / `fail`. _(Fed by `PlanNode.conflicts: ReadonlyArray<ConflictAnnotation>` = `{with, paths, strategy, runtime}` — real, persisted, per-node. This is a second graph relation n8n structurally cannot have, it uses the vertical space honestly, and it is the only place `PairStrategy` and `RuntimeStrategy` (`delay-rebase` | `stop-merge`) are visible in the product. Hover shows `paths` in the peek card.)_
- **Pinned node state** — 2px accent border, a pin glyph in the kind rail, state word `pinned`. The drawer's Output tab carries the ribbon `Pinned — this key settles clean without running.` with an inline `Unpin`. _(Colour is never the only signal (D-026), hence the word and the glyph. Guard on re-run: dialog `Unpin this output?` / body `Re-running replaces the pinned value.` / confirm `Unpin and re-run`. For an agent-invented value, the honest confirm, adapted from n8n's best copy: `Pin a value the model made up?` / `It is not a real result. Everything downstream consumes it as if it were.` / confirm `Pin anyway`.)_
- **Pinned-and-re-keyed node state (the anti-n8n beat)** — The pin chip greys and the node reads:
`Pinned at key1_8f77ac30 · this node now keys key1_d12e64b9` _(Fed by comparing the pin's recorded `keyDigest` against the node's current `PlanNode.key`. n8n's pin goes silently stale and lies; ours states the exact moment it stopped applying. That one row is the whole argument against pin-as-transport, and it costs a string comparison.)_
- **Sticky note** — A 220px note, anchored to a node or free on the canvas, max 280 chars, no colour picker. `⇧S` creates one at the pointer; `Esc` commits; empty on commit deletes it. _(UI-only and it must stay that way: nothing in `flows_plan_nodes` holds free text, and adding a field would either re-key every node or be silently ignored. It lives in the card payload beside `selection` / `cursorSeq` / `filter` / `liveTail` / `traceView` (`Cards.ts:1026-1057`), as `notes?: ReadonlyArray<{id, anchor: {nodeId} | {x, y}, text}>`. HONEST RANKING: this is the least defensible item in the spec. Ship it last, cut it first.)_
- **Selection model** — `WorkflowCanvas role="listbox"` owning `WorkflowNode role="option" aria-selected`. Selected node: brand ring, 3px, from `.sui-canvas-node[data-selected='true']`. _(BUG IN THE CURRENT MOCK: `FlowNode.tsx` already sets `role="option"` and `aria-selected` with no listbox ancestor — `WorkflowCanvas.tsx:127-140` states the contract explicitly, and an orphaned option is stripped from the accessibility tree. Fix while doing this work: pass `role="listbox"` to the ReactFlow viewport wrapper.)_
- **Selection toolbar (multi-select)** — Replaces the hover toolbar, pinned to the selection's bounding-box top-centre. Exactly two verbs: `Re-run from 4 nodes…` and `Copy for AI`. _(Everything else in the single-node toolbar is singular-only. A selection is also a shareable fact: widen the payload's `selection: string` to a comma list so the view round-trips in a URL (Trigger.dev's instinct, and D-002 already wants the canvas to be a projection).)_
- **Run rail — header** — 32px. Left: a segment control `Steps` | `Events`. Then a live dot + `Live`. Then a switch `Errors only`. Then a switch `Sync selection with canvas`. Right: a chevron (collapse/expand). _(`Steps`/`Events` maps onto the payload's existing `facet: "steps" | "transcript" | "events"`. No title text — the drawer is obviously the run rail, and a title would be a word that does not help you act. `Live` renders only while `flows_runs.status ∈ {accepted, running}` and DISAPPEARS on settle, so a finished run carries no stale live chrome.)_
- **Run rail — 'Sync selection with canvas', disabled** — The switch renders disabled with the tooltip `Not joined yet — the plan graph and the trace name nodes differently`. _(This is the most important honest row in the spec. The canvas draws plan node ids (`root.andThen.map`); the rail draws spans whose ids come from `run-tree`, where `RunTreeRow.nodeId` is documented as "the ordinal the call opened on, because the emitter names no node" (`GatewayProjection.ts:83-86`). They are two namespaces. The disabled control with a stated reason IS the argument for building D-020's plan-graph projection, and it is better product than a join that silently mismatches.)_
- **Run rail — body** — `RunTraceCard`'s existing waterfall, forced to `traceView: "timeline"`, one row per span over `RunTrace.ts`'s eleven `SpanKind`s (`run|frame|model|cell|call|approval|resolved|event|fork|execution|attempt`). Row: indent guides · kind word · bar · duration. Hover reveals one button: `Re-run from here`. _(This is NOT new code. `RunTraceCard.tsx` is 797 lines already shipping the phase strip, filter chips, span tree, waterfall and detail pane (D-016). The rail adds exactly two things: the per-row act, and the sync switch above.)_
- **Run rail — zoom slider** — Bottom-right, `min 0 max 1 step 0.05`, driving the TIME scale of the waterfall, not the canvas. _(Trigger.dev's control, and it is the readable-density lever D-024 argues for: a 61-minute run whose longest span is 41 minutes needs a scale control or every short span is a 1px tick.)_
- **Run rail — empty state** — One line: `Nothing has run yet.` and a `Run` button. _(n8n's is two sentences ("Nothing to display yet. Execute the workflow to see execution logs."). MINIMAL TEXT: a button beats the second sentence.)_
- **Liveness policy (settles D-013)** — Poll at 2500ms. Tighten to 1000ms while the rail is open AND any node is unsettled. Stop entirely when the run settles. _(Trigger.dev ships `RUNS_POLL_INTERVAL_MS = 3000` with in-place row patching and stops polling when `!hasActiveRuns`, which falsifies the worry in D-013 that a poll reads as lag. Take option (a). D-019 already established that the gateway serves `Projection.Subscribe` over `/projections/ws` and the gap is `apps/server`'s allowlist — that stays a later upgrade, not a prerequisite for this surface.)_
- **Drag handle** — 8px, `cursor: row-resize`, `role="separator"` `aria-orientation="horizontal"` `aria-valuenow`, keyboard ↑/↓ to move between snaps. _(Three snaps only (`closed` / `open` / `full`), persisted as `railHeight` in the card payload. Free-form pixel dragging snaps to the nearest on release.)_
- **Lanes gutter (L)** — 64px left gutter, one 10px mono label per band: `remote` · `sandbox` · `local` · `client`. A hairline separates bands. _(Fed by `PlanNode.material.placement`, which is `Schema.optional(Schema.Unknown)` on `KeyMaterial` — opaque by design. In practice a flow declares one of the four literals (`Markdown.ts:41-57`). When the value is not one of the four, or the whole flow is one placement, the toggle is disabled with tooltip `One placement — nothing to lane`.)_

### States

- **No plan yet (drafting, act 1)** — Graph region holds the nodes the agent has drafted so far, each `idle` dashed, with the agent's presence cursor on the one it is writing (D-008). Rail is at `closed` (32px header) with the empty line `Nothing has run yet.` behind the chevron. No hover toolbar on an idle node except `Open code`; `Re-run from here` and `Pin output` are disabled with tooltip `Nothing has run yet`.
- **Build refused (fatal GraphBuildError)** — Graph region is replaced entirely by the 520px refusal card. There is no graph, so there are no nodes to badge. Rail collapses to its header and shows nothing. Flow panel's digest slot reads `— no plan —` instead of a key.
- **Built with diagnostics** — Graph draws normally. Affected nodes carry `▲` in the status slot and the word `issues`; the tooltip lists each `GraphBuildError.message` deduped `(x2)`. Run button disabled: `2 nodes have issues — this graph cannot compile`. Every other affordance (hover, peek, drill-in) works, because a graph with diagnostics is inspectable.
- **Planned, nothing run** — All nodes `idle` (dashed). Nodes whose key already hits the cache carry the word `cached` from `PlanNodeStatus` — this is legible BEFORE the run, which is the whole pitch. Edges are stroke-only. HUD shows the predicted run: `13 nodes · 8 cached · 1h 1m estimated`.
- **Running** — Camera follows the live node at 0.94. That node has a brand ring plus an 8px marching-tile texture (survives a screenshot; hue-independent). Its inbound edges animate marching dashes at 1.1s/cycle. Settled upstream nodes are green with a duration. The rail's `Live` dot pulses; polling is at 1000ms. Hover toolbar's `Re-run from here` is disabled on the running node only.
- **Waiting on you (waiting-approval)** — Node breathes amber, word `waiting on you`, and the drill-in drawer auto-opens on its Output tab rendering the question from `flows_runs.waiting_request` — `kind` picks the control, `options` fills a select, `schema` validates a JSON answer (D-023). Rail row shows a hollow bar. Escape hatches, labelled as manual, adapted from Trigger.dev's waitpoint: `Answer for the run…` and `Force timeout`.
- **Parked** — Node dimmed with the word `parked` and, when the park is a quota park, a wake time: `parked · wakes 14:32`. Fed by `flows.agent.quota-parked.v1 {wakeAt, source}` where `source ∈ reset|retry-after|text|default`. Polling drops back to 2500ms.
- **Failed** — Node danger-ringed, word `failed`, a single shake on transition. The taken `failure` edge goes danger-SOLID (a taken catch arm is a real edge, not a dashed possibility) and its `CATCH` label stays. The rail auto-filters to `Errors only`. Beneath the error, one prefilled chip: `What happened here?`
- **Completed** — Every executed node green with its duration; `skipped` arms at 38% with dashed inbound edges at 28%. `Live` chrome is gone entirely. Camera fits the whole graph at ≤0.92. HUD: `Completed · 11 nodes · 1h 1m`.
- **Re-key preview (act 3)** — Camera pulls to 0.62. The 3 re-keyed nodes go amber-dashed with the word `will re-run`; the 8 untouched go green-dimmed with `cache hit` and `0ms`; the 2 arms stay `skipped`. Edges into a dirty node go amber-dashed. HUD carries the whole pitch in four numbers plus the approval consequence.
- **Cache-hit replay** — A `clean` node keeps its normal hue and changes its GLYPH (Trigger.dev's choice: same hue, different glyph, so cached and fresh read as the same kind), word `cache hit`, duration `0ms`. Its drill-in Output tab shows no re-rendered value — one clickable line, `served from run r_8c21 · event #1447`, from `flows.engine.cache-provenance {recordedRunId, recordedEventSeq}`.
- **Multi-select** — Every selected node rings; the hover toolbar is replaced by the 2-verb selection toolbar at the bounding box's top-centre; the context menu's subject pluralises. `⇧→` from one node selects the exact re-key suffix, so the selection IS the preview.
- **Rail closed / full** — `closed`: 32px header only, graph gets 780px, useful when the flow has deep ranks. `full`: graph collapses to a 120px one-rank strip that still shows the live node (camera keeps following), rail gets 692px — the debugging posture.
- **Lanes on (L)** — Nodes re-rank into up to four horizontal bands by `material.placement`, gutter labelled once per band. Edges cross bands; that crossing is the information ("this hands off from the sandbox VM to a remote worker"). Disabled when the flow has one placement.
- **Offline / polling stopped** — No spinner, no toast. The `Live` dot is simply absent and the rail header shows nothing in its place. A run that settled looks identical to one whose poll stopped, which is correct: both are not moving.

### Data shape

```ts
```ts
import type * as Plan from "@smthrs/plan/Plan"
import type * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import type { GraphBuildError } from "@smthrs/plan/GraphBuildError"
import type { EdgeReason } from "@smthrs/flow/Graph"
import type { Outcome, ResolvedInput, Settlement } from "@smthrs/engine-store/PlanScheduler"
import type { PlanNodeStatus } from "@smthrs/control/ControlSchema"
import type { PlanDiff } from "@smthrs/plan/PlanDiff"
import type { SpanKind } from "../cards/RunTrace.ts"

/**
 * One row of the plan-graph projection D-020 asks for. Every field is read off
 * `flows_plan_nodes.node_json` (which decodes to `Plan.PlanNode`) or off the
 * four `flows.engine.node-*` journal records. Nothing here is invented.
 */
export interface PlanGraphRow {
  readonly planId: string
  /** id, kind ("step"|"agent"|"merge"), key, material, effects, dependsOn,
   *  conflicts, strategy, runtime, priority, generation. */
  readonly node: Plan.PlanNode
  /** `smithers plan`'s verdict BEFORE anything runs: "cached" | "run". */
  readonly status: PlanNodeStatus
  /** flows.engine.node-settled — absent until it settles. */
  readonly settlement?: Settlement          // { nodeId, planKey, dispatchKey, outcome, attempts, rebases }
  /** flows.engine.node-scheduled { attempt, priority, waited }. */
  readonly scheduledAtMs?: number
  readonly waited?: boolean
  /** flows_attempts (run_id, step_key_digest, attempt). */
  readonly startedAtMs?: number
  readonly finishedAtMs?: number
  /** flows.engine.node-invalidated — the only reason the engine emits. */
  readonly invalidated?: {
    readonly from: string
    readonly to: string
    readonly reason: "measured-inputs-changed"
  }
  /** NodeInput.inputs: material `Ref` inputs resolved through the same
   *  projection the dispatch key digests. Feeds the edge peek's value row.
   *  `Pending` ordering deps are deliberately absent from this array. */
  readonly inputs?: ReadonlyArray<ResolvedInput>   // { from, path, value }
}

/**
 * Edges are NOT a persisted object: `Plan.Plan` has only `{planId, flow,
 * generation, baseDigest, digest, nodes}`, and `flows_plan_edges` is three
 * columns with no reason. The canvas folds them out of node ids + key material.
 */
export interface CanvasEdge {
  readonly id: `${string}->${string}`
  readonly from: string
  readonly to: string
  /** Derived: Ref => "value"; Pending or bare dependsOn => "continuation";
   *  consumer id ending .recover/.failure/.protected => "failure". */
  readonly reason: EdgeReason
  /** Derived from the consumer's structural id suffix. */
  readonly label?: "THEN" | "ELSE" | "CATCH"
  /** The Ref that made it a value edge; feeds the peek's path + type row. */
  readonly ref?: Extract<KeyMaterial.InputRef, { readonly _tag: "Ref" }>
}

/** A non-dependency relation, drawn dotted on hover only. */
export interface ConflictEdge {
  readonly from: string
  readonly to: Plan.ConflictAnnotation["with"]
  readonly paths: Plan.ConflictAnnotation["paths"]
  readonly strategy: Plan.PairStrategy      // "serialize" | "lane" | "fail"
  readonly runtime: Plan.RuntimeStrategy    // "delay-rebase" | "stop-merge"
}

/** What the graph region renders. */
export interface CanvasModel {
  readonly plan: Plan.Plan
  readonly rows: ReadonlyArray<PlanGraphRow>
  readonly edges: ReadonlyArray<CanvasEdge>
  readonly conflicts: ReadonlyArray<ConflictEdge>
  /** Graph.diagnostics(graph) — recoverable only. Non-empty => not compilable. */
  readonly diagnostics: ReadonlyArray<GraphBuildError>
  /** Graph.build threw: there is no graph. Renders the refusal card. */
  readonly refusal?: GraphBuildError
  /** Present only in the re-key preview; drives the HUD and the dirty set. */
  readonly preview?: {
    readonly diff: PlanDiff                 // { added, removed, rekeyed, unchanged }
    readonly estimateMs: number             // D-030 predictor over action tags
    readonly voidedApprovals: ReadonlyArray<string>   // D-022
  }
}

/** UI-only view state. Lives in the card payload beside the run-trace card's
 *  existing `selection`, `cursorSeq`, `filter`, `liveTail`, `traceView`. */
export interface CanvasViewState {
  readonly selection: ReadonlyArray<string>           // plan node ids
  readonly railHeight: "closed" | "open" | "full"
  readonly railFacet: "steps" | "events"
  readonly railErrorsOnly: boolean
  readonly railTimeScale: number                      // 0..1, step 0.05
  readonly lanes: boolean
  readonly pins: ReadonlyArray<{ readonly nodeId: string; readonly keyDigest: string }>
  readonly notes?: ReadonlyArray<{
    readonly id: string
    readonly anchor: { readonly nodeId: string } | { readonly x: number; readonly y: number }
    readonly text: string
  }>
}

/** One rail row. Today these come from `run-tree`, whose `nodeId` is a call
 *  ordinal, NOT a plan node id — which is why `Sync selection with canvas`
 *  ships disabled until D-020 lands. */
export interface RailRow {
  readonly spanId: string
  readonly kind: SpanKind
  readonly label: string
  readonly startedAtMs: number
  readonly endedAtMs?: number
  readonly outcome?: Outcome
  readonly attempt?: number
  /** Only once the plan-graph projection names plan nodes on both sides. */
  readonly planNodeId?: string
}
```
```

### Interactions

- Hover a node for 120ms → the 4-button toolbar fades in 8px above it, zoom-counter-scaled. Below zoom 0.45 it does not render at all.
- Tab into the toolbar → one tab stop, then Arrow/Home/End rove between the four buttons (the ARIA contract `WorkflowToolbar` already implements). Modifier chords pass through untouched.
- Click `Re-run from here` (or `R`) → the re-key HUD opens with `PlanDiff`'s real counts and the submit button carries them: `Re-run 3 nodes · 8 cache hits · 4.9s`. Never fires without the HUD: it is consequential, so it confirms.
- Click `Pin output` (or `P`) → pins immediately. Re-running a pinned node first shows `Unpin this output?` / `Re-running replaces the pinned value.` / `Unpin and re-run`.
- Click `Open code` (or `C`) → the right-edge drill-in drawer opens on the Code tab and the camera re-centres with a 420px right inset so the node is never under the drawer.
- Hover an edge for 250ms → the peek card fades in at the midpoint. Pointer-out closes it with no delay, so a pan never leaves a trail of cards.
- Click an edge → selects BOTH endpoints (the edge is the relation, not a thing).
- Hover or select a node that has `conflicts` → its dotted conflict edges appear, labelled `serialize` / `lane` / `fail`.
- `Enter` opens the drawer; `Esc` closes the drawer, then clears the selection on a second press.
- `→` / `←` select the node downstream / upstream, first in `dependsOn` order when there are several. `↑` / `↓` select the sibling in the same rank.
- `⇧→` selects this node and everything downstream — the re-key suffix, selected in one gesture. `⇧←` the converse.
- `⇧click` adds to the selection, `⌘click` toggles, marquee-drag on empty canvas selects an area, `⌘A` selects all.
- With >1 selected, the hover toolbar is replaced by the selection toolbar: `Re-run from 4 nodes…` and `Copy for AI`. Nothing else is offered on a multi-selection.
- Right-click a node (or the toolbar ellipsis) → the context menu, subject-pluralised against the current selection.
- `1` zoom to fit, `0` reset to 0.94, `+`/`-` step zoom, `Space+drag` or `⌘+drag` pan — n8n muscle memory, free.
- `L` toggles placement lanes; disabled with `One placement — nothing to lane` when the flow has one.
- `E` / `W` expand / collapse the run rail through its three snaps; the drag handle does the same with the keyboard via ↑/↓ on the separator.
- `[` / `]` walk to the previous / next run in the filtered list you arrived from — turns a run list plus a detail pane into a triage queue.
- `⇧S` drops a sticky note at the pointer; typing edits it; `Esc` commits; committing it empty deletes it.
- Hover a rail row → a single `Re-run from here` button appears at its right edge, the same act as the node toolbar's first button.
- Toggle `Errors only` in the rail → filters rows to `Settlement.outcome === "failed"` plus any span with a recorded error. Better first filter than a chip row.
- Drag the rail's zoom slider (0..1, step 0.05) → rescales the waterfall's time axis only; the canvas zoom is untouched.
- A run settles → the `Live` dot and the poll both stop. Nothing announces it; the absence is the signal.
- Click `served from run r_8c21 · event #1447` on a `clean` node → navigates to that run with the originating node selected, GitHub-blame style. Walkable backwards again from there.

### Sample content

FLOW: `morning-triage` · repo `tevm/tevm-monorepo` · plan digest `key1_9f3c2ab7e015`
13 plan nodes · 11 executed · 2 skipped (D-032's honest figures).

FLOW PANEL (top-left):
  morning-triage  │  key1_9f3c2ab7e015  │  re-key

HUD (top-centre, act 3):
  Editing `checks` re-keys 3 nodes
  8 cache hits · 2 skipped · 0 other nodes touched
  4.9s     against 1h 1m
  1 approval voided — `approve` was taken on key1_9f3c2ab7e015

NODE, hovered, running (`repro`):
  ┌──────────────── ▶  📌  </>  …  ────────────────┐   ← toolbar, 8px above
  ▌ ◆  Reproduce the bug                        ●   ← kind rail, glyph, title, dot
  ▌ coding/reproduce                                ← mono Action tag
  ▌ ▸ writing packages/state/src/Cache.spec.ts      ← live caption
  ▌ agent · coding/implement · claude-opus-5        ← kind chip, seat, model
  ▌                                 running  14m 20s

NODE, cache hit (`writetest`, after the edit):
  ▌ ◆  Write the failing test                    ⟲   ← cached glyph, same hue
  ▌ coding/edit-atom
  ▌ agent · coding/implement           cache hit  0ms
  drawer Output tab → served from run r_8c21 · event #1447

NODE, issues:
  ▌ ▢  Triage each issue                         ▲
  ▌ triage/relevance
  ▌ jev · typesafe-ai/jev                    issues
  tooltip:  Issues:
            Node.bindPlanned at "root.then.andThen" no longer holds its
            continuation builder, so its continuation is missing from the graph.
            An AST that crossed a serialization boundary left that side table behind.

EDGE PEEK, hovering `repro → test`:
  repro → test                         value
  Reproduction
  41 KB                     built · 14m 20s

EDGE PEEK, hovering `test → approve` (a continuation, pre-run):
  test → approve                continuation
  CommandResult
  [settles during the run]

EDGE PEEK, hovering the conflict between `change` and `writetest`:
  change ⟷ writetest                serialize
  packages/state/**
  delay-rebase

CONTEXT MENU on `checks`, nothing else selected:
  Open
  Re-run from here…
  Pin output
  Copy step key
  Copy node id
  Copy for AI
  ───────────────
  Select downstream          ⇧→
  Select upstream            ⇧←
  ───────────────
  Add note                   ⇧S

CONTEXT MENU with `checks`, `pr`, `notify`, `approve` selected:
  Re-run from 4 nodes…
  Copy 4 step keys
  Copy for AI
  ───────────────
  Select downstream          ⇧→

BUILD REFUSAL CARD:
  This flow does not build
  planned_value_computed        at  root.andThen.since
  A body computed on a planned value. A plan cannot bake the result of a step
  that has not run; pass the Planned value along instead of reading it.
  [ Open flows/morning-triage/flow.ts ]

RUN RAIL, mid-run:
  [Steps│Events]   ● Live   ▢ Errors only   ▢ Sync selection with canvas    ⌄
  ├ issues       call      █                                  1.4s
  ├ triage       model     █                                  0.9s
  ├ repro        agent     ████████████                       14m 20s
  │   └ attempt 1  frame     ███
  ├ test         call      ██   attempt 2                     2m 5s
  ├ approve      approval  ░░░░░░  waiting on you              3m 40s
  └ writetest    agent     ████████████████████████████████   41m 12s
                                        [ ──●────────  0.35 ]

RUN RAIL, disabled sync tooltip:
  Not joined yet — the plan graph and the trace name nodes differently

RAIL EMPTY:
  Nothing has run yet.   [ Run ]

PINNED-AND-RE-KEYED, on `checks` after the edit:
  Pinned at key1_8f77ac30 · this node now keys key1_d12e64b9

DERIVED EDGE SET for morning-triage (13 edges, zero schema change):
  trigger→issues   value        (material.inputs: Ref{from:"trigger", path:["firedAt"]})
  issues→triage    value        (Ref{from:"issues"})
  triage→branch    value        (Ref{from:"triage"})
  branch→repro     value  THEN  (consumer id ends .then)
  branch→defer     value  ELSE  (consumer id ends .else)
  repro→test       value        (Ref{from:"repro", path:["workspace"]})
  test→bundle      failure CATCH(consumer id ends .recover)
  test→approve     continuation (Pending{from:"test"} — ordering only, not in the key)
  approve→change   value
  change→writetest value        (Ref{from:"change"})
  writetest→checks value        (Ref{from:"writetest", path:["diff"]})
  checks→pr        value        (Ref{from:"checks"})
  pr→notify        continuation (Pending{from:"pr"})

### Risks

- `Re-run from here` is the whole point of the surface and no flow id exists for it. `runs.rerun <runId>` re-runs the entire run. Building this spec without `runs.rerun-from <runId> <nodeId>` ships a toolbar whose first button is a mock. The engine mechanism is real (bump `WithCache.Options.version` on the node, recompile, let every unchanged key hit the step cache) — but somebody has to write the command.
- The edge peek's TYPE row is the one field in the whole spec not derivable from persisted data. `KeyMaterial.body` digests the schemas and does not carry them, so the type name needs D-020's projection to include it or a client-side `Graph.build`. If neither happens, the peek is two rows, not three, and it is noticeably weaker.
- `Sync selection with canvas` ships disabled, which means the run rail and the graph are two views that cannot talk. That is honest but it is also the single biggest hole in the surface: a user who clicks a node and sees nothing happen in the rail will read it as broken, not as principled. It needs a visible one-line explanation, not just a tooltip on a switch nobody hovers.
- Pinning has no engine primitive. The spec describes it as a step-cache publish under the node's `key_digest`, which is plausible but unbuilt. If it ships as UI-only state in the card payload, a pin will not survive a reload or apply to any other client, and the demo will break in exactly the way n8n's does.
- Conflict edges are drawn from `PlanNode.conflicts`, which is only populated when two declared write sets actually overlap with no dependency ordering them. Most demo flows have zero conflicts, so this — the one relation n8n structurally cannot draw — may never appear in a screenshot. Worth constructing one demo flow that has a real `serialize` pair.
- `unstable_callback` only enters `Graph.diagnostics` when the build was asked for `callbackIdentity: "stable"`. If the app's plan projection does not build with `stable`, every digest the canvas prints is process-local, the issues badge never fires for that code, and the whole re-key story stops surviving a restart. Verify before building.
- Placement lanes read `PlanNode.material.placement`, typed `Schema.optional(Schema.Unknown)`. A flow that puts something other than the four literals there will fall into an unnamed band. The fallback (one lane, toggle disabled) must be implemented first, not after someone hits it.
- The sticky note is the one item here nobody asked for in the engine's vocabulary, and it lives in a card payload that TanStack DB already struggles to type past 30 union members (D-015). It is the first thing to cut if the payload widens.
- Splitting the pane costs the graph 360px of height permanently. On a flow with four or more parallel ranks (a `CheckSuite` with six checks at concurrency 3) the graph region will need `full`-inverse — a snap that gives the graph everything — which this spec does not define. Add it, or that flow is unreadable at the default snap.
- The mock currently puts `role="option"` on nodes with no listbox ancestor, which strips the selection from the accessibility tree. Every keyboard and multi-select interaction in this spec assumes that is fixed first; building the shortcuts on the broken model would make the defect permanent.

## The model drill-in — canvas model chip, the model peek, and the streaming state

A node that called a model wears a colour-free chip naming which *kind* of model it is (chat / evaluation / agent-loop / scripted / unrouted), and clicking it widens the existing 336px inspector into a 720px "model peek" whose tab set is chosen by that kind — a chat call gets Overview·Stream·Tools·Request·Failure over the real 13 `ModelEvent` tags, a Jev call gets Overview·Questions·State·Request·Failure over typed questions, distributions and floors.

### Layout

```
CONTAINER RULING. No modal. n8n's NDV covers the canvas, which fights D-024 (the camera follows the action). The peek is the *same* right-hand pane the mock already ships (`.inspector`, 336px), widened in place: `.inspector[data-width="wide"]` → 720px. One container, two widths, no second noun (D-011). VS Code's escalation ladder: node chip (glance) → inspector (336, summary) → peek (720, drill-in) → full `file` card (the `CodeSurface` door).

DESKTOP ≥ 1640px — peek open:

┌ 56 ┬──────── chat 360 ────────┬───────── canvas flex, min 420 ─────────┬──────────── model peek 720 ────────────┐
│rail│ agent transcript          │        ▢──▢                            │ ⌁ claude-opus-5            [built]  ✕ │ 64
│    │                           │            ╲                           │ coding/implement → claude-opus-5       │
│Wiki│                           │             ▣ ◀ selected               │   → anthropic · anthropic-messages     │
│Disp│                           │              ╲                         ├────────────────────────────────────────┤
│Flow│                           │               ▢──▢                     │ Overview  Stream  Request  Failure     │ 38
│Secr│                           │                                        │ ────────                               │
│Hist│                           │                                        │ ┌ Seat ──────────────────── 1M ─────┐ │
│Acct│                           │                                        │ │ Seat   coding/implement           │ │ scroll
└────┴───────────────────────────┴────────────────────────────────────────┴────────────────────────────────────────┘
                                                                          │ Re-run from here…  Pin  Copy for AI  │ 52
                                                                          └────────────────────────────────────────┘

GRID. `.inspector { display: grid; grid-template-rows: auto 1fr auto }` today. Wide adds one row: `auto auto 1fr auto` = head 64 / tabstrip 38 / scroll 1fr / foot 52. Head and foot keep the existing 14px/12px padding; scroll gets 16px side gutters and 14px between sections.

CAMERA. Opening the peek steals 384px from the canvas. On open, `flow.setCenter` re-runs for the selected node at the same zoom with `lead = 40` (the mock's pulled-back lead), so the selected node stays at the visual centre of the *remaining* canvas. Closing re-centres back. Nothing is ever shown at a zoom where its text cannot be read (D-024).

BREAKPOINTS.
- < 1640px: the chat pane collapses to 0 before the canvas gives up a pixel. Chat returns when the peek closes.
- < 1100px: the peek becomes an overlay — `position: absolute; right: 0; width: min(720px, 100% - 56px)` over a 40%-alpha scrim, canvas untouched underneath. A 360px canvas is a picture of a graph, not a graph.
- Peek < 560px internal width: the Stream tab's two columns stack.

STREAM TAB INTERNAL GRID. `grid-template-columns: 320px 1fr; gap: 14px`. Left = the folded event list (mono, 11px, 22px rows). Right = the assembled parts, each a `Block`. Legend is a full-width wrapping row above both, 13 mono words, 28px tall.

QUESTIONS TAB INTERNAL GRID. Table full width (7 columns), then the selected question's distribution below it at full width, bars 18px tall with a 6px gap, labels left-aligned at 11px, probability right-aligned in mono.

NODE CHIP. Lives in the existing `.fl-node-foot` (228px node, min-height 80). Foot order is unchanged: `[kind chip] [model chip] [spacer] [attempt chip] [state word] [ms]`. The model chip replaces the current seat-or-model text chip and is `glyph 12 · label (max-width 92px, ellipsis) · protocol glyph 12`.
```

### Anatomy

- **Node model chip — chat** — ⌁ coding/implement  ▤ _(`.fl-model-chip[data-model-kind="chat"]`. Left glyph: a rounded rect with three descending lines (a transcript). Label slot rule: the chip carries the one fact `.fl-node-tag` does not already carry — on a chat/agent node the tag is the Action tag (`coding/edit-atom`), so the label is `Seat.Seat["id"]`, falling back to `modelId` when no seat is declared. Right glyph is the protocol, outlined, never coloured: anthropic-messages = a rounded rect with ONE horizontal bar; openai-responses = a rounded rect with a right chevron; openai-responses-chatgpt = the same chevron plus a corner dot; openai-chat-completions = two stacked bars. D-026: the kind is a shape, the protocol is a shape, colour adds nothing either needs.)_
- **Node model chip — evaluation (Jev)** — ▮▁▄ 3 questions _(`.fl-model-chip[data-model-kind="evaluation"]`. Glyph is three vertical bars of unequal height — a distribution, never a speech bubble. The label is the question count because `.fl-node-tag` already reads `triage/relevance`. NO protocol glyph: Jev has no `Protocol.id`. Its wire versions are `ai-gateway-protocol-version: 0.0.1` and `ai-evaluation-model-specification-version: 4`, and inventing a protocol id for it would be a lie.)_
- **Node model chip — scripted** — { } scripted _(`data-model-kind="scripted"`. `Evaluator.layerScripted` or `Model.makeNoop`. A fixture answered; no request left the process. The chip exists so a screenshot of a test run is never mistaken for a screenshot of a real one.)_
- **Node model chip — unrouted** — ⊘ no route _(`data-model-kind="unrouted"`. `Model.layerNoop` failed the stream with `ModelError` code `no_route`, message `no model route in this environment`. The chip is the only place that fact is visible before you open anything.)_
- **Node streaming caption — chat** — • …assertThrows(() => widen(3, "km")) _(`.fl-node-caption[data-stage]`, the existing blinking `.fl-node-caret` plus the live tail. `data-stage` is derived from the last `ModelEvent.type` and nothing else: no event yet → `opening`; `thinking-start|thinking-delta` → the tail prefixed `thinking`; `text-start|text-delta` → the raw tail, last 42 chars, left-ellipsed; `tool-call-start|tool-call-delta` → `calling <name>`; `retry` → `retry 2 of 3 · 1.0s`; `settle` → the node leaves the running state.)_
- **Node running texture** — (no copy) _(Keep `.fl-node-shimmer` for motion. ADD `.fl-node-rail[data-marching="true"]`: an 8px repeating-linear-gradient at 45° scrolling at 1s linear infinite, opacity 0.30. n8n's marching tiles survive a screenshot; a shimmer does not. It rides the 3px rail so it never fights the shimmer or the text.)_
- **Node deadline bar — evaluation only** — asking · 0.31s / 1.50s _(A Jev call has no stream, so it gets no caption and no shimmer. `.fl-node-deadline`: a 2px track flush to the bottom of `.fl-node-body`, filled `elapsedMs / timeoutMs` (`Evaluator.defaultTimeoutMs`, 1500). At full the node flips to `failed` with `EvaluatorError` code `timeout`. This is the surface's strongest single answer to "make the kinds of model legible at a glance": the two kinds do not even *run* the same way.)_
- **Node frame counter — agent-loop only** — f 62/100 _(`.fl-chip.fl-chip-quiet` in the foot, shown ONLY when `frames / DisciplineArmed.maxFrames >= 0.5`. A budget you are nowhere near is not information (MINIMAL TEXT). Default `maxFrames` is 100.)_
- **Peek header — chat** — claude-opus-5
coding/implement → claude-opus-5 → anthropic · anthropic-messages _(h2 is the resolved `modelId` in mono. Sub-line is the resolution chain, three arrows, ending in `routeId · protocolId`. This one line answers "the route/seat that chose the model". Right: a `Badge` carrying the settlement outcome word (`built`/`clean`/`failed`) or the live stage. Left: the 28px kind glyph in `.inspector-glyph[data-kind]`.)_
- **Peek header — Jev** — triage/relevance
Classifier · typesafe-ai/jev · 284 ms of 1500 ms _(h2 is the classifier id, which is the thing a human recognises; `typesafe-ai/jev` is the same on every Jev node and so belongs in the sub-line. Right badge: `3 answers`.)_
- **Peek tabstrip — chat** — Overview   Stream   Tools 4   Request   Failure _(Trigger.dev's `TabButton` with a shared-layout sliding underline and single-key shortcuts: Overview `o`, Stream `s`, Tools `t`, Request `r`, Failure `f`. Tools carries a count pill and is ABSENT when `ModelRequest.tools` is empty. Failure is ABSENT unless the call failed. A tab with nothing behind it must not appear.)_
- **Peek tabstrip — Jev** — Overview   Questions   State   Request   Failure _(Shortcuts: `o` `q` `s` `r` `f`. The two shapes never co-exist, so `s` means Stream on one and State on the other without collision.)_
- **Peek tabstrip — agent node** — Calls 23   Frames   Context   Budgets   Claim _(Shortcuts `c` `f` `x` `b` `j`. Opens on Calls. Each Calls row opens the chat peek for that one model call. Frames/Context/Budgets/Claim are the cell-loop pane's territory (`experimental/panes/CellLoop.tsx`) — this spec owns the join and the Calls list, not those three.)_
- **Overview › Seat section** — Seat               coding/implement
Model              claude-opus-5
Context window     1 000 000
Harness            claude · signed-in _(Words copied verbatim from `experimental/panes/Models.tsx` so the two surfaces do not diverge. `Context window` is `ModelCatalog.contextWindowTokensFor(modelId)` — a regex table, never zero, unknown ids answer 128 000. `Harness` row only on a role seat. Section `right` shows tokens used against the window as a `Bars` row.)_
- **Overview › Route section** — Route              anthropic
Protocol           anthropic-messages
Endpoint           POST https://api.anthropic.com/v1/messages
Credential         x-api-key ← ANTHROPIC_API_KEY
Header             anthropic-version: 2023-06-01
Framing            sse
Refreshable        no — a static credential stays terminal on a 401
Deferred tools     supported _(`right={<Badge tone="info">sse</Badge>}`. `Credential` names the header and the environment variable, never a value. `Refreshable` is `Auth.refresh !== undefined` and it is the one boolean that decides whether a 401 can heal; `Route.stream` refreshes and re-signs exactly once. `Deferred tools` is `Protocol.supportsDeferred(modelId)` against the exact-id allowlist — `openaiResponsesCompatible` force-overrides it to `false`.)_
- **Overview › Params section** — maxTokens          32000      set
thinkingBudget     8192       set
temperature        —          unset
topP               —          unset
topK               —          unset
stopSequences      —          unset
reasoningEffort    —          unset
toolChoice         —          unset _(One row per `GenerationParams` knob plus `toolChoice`. Exactly four state words, and a params panel that shows only the declared value hides three of them: `set` (sent); `defaulted` (omitted, the lowering substitutes — note copy `Anthropic Messages sends max_tokens: 4096 for an omitted maxTokens`); `dropped` (no wire field — note copy `openai-responses has no field for topK`); `refused` (note copy `maxTokens on openai-responses-chatgpt fails locally as invalid_request`). `ModelRequest`'s field declaration order is the stable sealed-step serialization order, so the rows render in that order and are never re-sorted.)_
- **Overview › Usage section** — Input             18 412 tokens
Output             1 106 tokens
Reasoning            842 tokens
Cache read       112 908 tokens
Total             19 518 tokens
Duration            42.1 s _(Six `ModelEvent.Usage` counters: `inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens`, `cacheWriteTokens`, `totalTokens`. HARD RULE from the schema doc — "A missing count is not a zero count": an absent counter renders as an ABSENT ROW, never `0`, never `—`. In the sample `cacheWriteTokens` is absent and the row is simply not there. `Duration` is `flows.harness.model-settled.v1.durationMillis`.)_
- **Overview › Usage section, derived rows** — Speed             26 tok/s
Cost               $0.42 _(Section `right={<Badge tone="muted">derived</Badge>}`. Cost is NOT an engine field — there is no price table in `@smthrs/model`. The Cost row renders only when a price table is bound and never as "not measured yet" (MINIMAL TEXT).)_
- **Overview › Request strip** — prepare  ›  sign  ›  attempt 1  ›  stream  ›  settle
41.2 KiB    x-api-key   200 · 312 ms   1 325 frames   stop · 19 518 tokens _(`Steps` from `Primitives.tsx`, verbatim the five stages `Models.tsx` already ships, so the two panes read as one product. The failure variant substitutes `refresh` for `stream`: `prepare › sign › attempt 1 › refresh › settle`.)_
- **Overview › Outcome section** — Stop reason        stop  ← end_turn
Response id        msg_01P9kqW7vR2mXe4dT8nAcB3y
Item ids           —
Parts              1 thinking · 1 text
Tools declared     none — the cell-first controller opens every turn with tools: [] and toolChoice: "none" _(`Stop reason` shows the normalized `StopReason` literal and, muted, the provider's own word it lowered from (`end_turn`→`stop`, `max_tokens`→`length`). `aborted` gets the sentence `no settle event — the stream was interrupted`; no provider reports it. The `Tools declared` row is ONE line and exists only to stop the missing Tools tab reading as a bug.)_
- **Stream tab › legend** — text-start  text-delta  text-end  thinking-start  thinking-delta  thinking-end  tool-call-start  tool-call-delta  tool-call-end  tool-result  usage  retry  settle _(All thirteen `ModelEvent` tags in the union's declaration order, always all thirteen. Tags present in this stream render at full opacity; absent tags at 38%. You read at a glance that this call had no `tool-call-*` and no `retry` — which is a fact, and a legend that hides its own absences is not.)_
- **Stream tab › folded event rows** — t+0.00s   thinking-start   signature present
t+0.00s   thinking-delta   ×214
t+7.90s   thinking-end
t+7.91s   text-start       id msg_01P9…_1
t+7.91s   text-delta       ×1106
t+41.9s   text-end
t+42.0s   usage            in 18 412 · out 1 106
t+42.1s   settle           stop _(FOLD RULE, stated in the tab: consecutive events with the same `type` and `id` collapse into one row carrying `×N`; click expands to the individual events. 1 325 raw events, 8 rows. Without the fold a 1 106-delta stream is unreadable; without the rule stated, the fold is a lie. `ThinkingStart.signature` presence is shown, the value never is.)_
- **Stream tab › assembled parts** — thinking   [signature]  echoed back unchanged on the next request
text       …
tool-call  files.read   {"path":"packages/state/src/Atom.ts"} _(`settledMessage(events).message.content` rendered as `Block`s, one per `AssistantContentPart`. The `signature` chip's caption is exact: the provider's attestation must be echoed back verbatim on a continuation.)_
- **Tools tab › tool stream rows** — files.read     assembling   {"path":"packages/state/src/Ato
 files.read     complete     {"path":"packages/state/src/Atom.ts"}   412 B
 files.read     aborted      partial text preserved verbatim _(Three `ToolStream` states. The tab footer carries the split rule in one line: `A live stream refuses argument text that is not a JSON object; the durable transcript preserves it.` The two real refusal messages are the failure copy: `Invalid JSON input for streamed tool call <name>` and `Received completion for unknown tool call <id>`. Header row: `immediate 3 · deferred 1 · activated files.edit` from `DeferredTools.resolve(request, native)`.)_
- **Request tab** — POST https://api.anthropic.com/v1/messages

anthropic-version: 2023-06-01
content-type: application/json

{…bodyText…}

Body               41 208 B
Sealed step key    key1_5c8b1f22
Credential         x-api-key — applied through Auth, not shown here _(This is `Route.PreparedRequest` and it is the honest answer to "see the actual code" for a model node: `{ routeId, protocolId, method, url, publicHeaders, body, bodyText }`. Headers are sorted; `content-type: application/json` is always injected. The guarantee line, once, under the block: `publicHeaders refuses any route header matching the credential matcher, so this view is credential-free by construction.` `bodyText` is the canonical-JSON decode and it is exactly what the engine digests into the sealed step key.)_
- **Failure tab** — [rate_limited]  retryable
message              This request would exceed your organization's rate limit
httpStatus           429
providerCode         rate_limit_error
requestId            req_011CSxQ2mHk9
path                 —
retryAfterMillis     20 000
resetAtEpochMillis   2026-09-18T14:22:31Z
resetSource          anthropic-ratelimit-requests-reset _(One code, not the catalogue — the twelve-code table lives in the Models pane and printing it here is MINIMAL TEXT violation by volume. `retryable` is the computed getter, not the code. `path` is a key path only (`messages[2].content[0].text`), never a value. `error.body` (≤16 KiB, `bodyTruncated`) opens behind a disclosure and is labelled as living outside the schema so no journal copies it.)_
- **Failure tab › the two retry ladders** — inner   attempt 2 of 3     waits 500 ms · 1 000 ms     budget 60 s
        transport failures 0 of 3 before the client is rebuilt
outer   re-issue 0 of 1    overrunTeaching not prepended _(A mock that shows one retry number is wrong. INNER is `RequestExecutor`: `MAX_RETRIES = 2` (three attempts), `BASE_DELAY_MS = 500`, cap 10 s per wait, `MAX_RETRY_DURATION_MS = 60_000` total, `rebuildAfter = 3` consecutive transport failures replaces the HTTP client. OUTER is `FlowEngineLike.recordModelStep`: `defaultModelOverruns = 1`, retrying only `provider_internal`/`transport`/`call_timeout`. A `Retry-After` header replaces the computed delay without jitter; a wait past the 60 s budget is NOT slept — the error surfaces with `resetAtEpochMillis` so the run parks durably.)_
- **Jev Overview** — Classifier         triage/relevance
Declared           agent/std/src/Classifiers.ts
Digest             9c41f0…7b2e
Questions          3 in one call
Latency            284 ms of 1500 ms
Input / Output     412 / 6 tokens
Zero data retention on
Retries            none — the caller decides whether a failure is worth a second request _(`Digest` is the SHA-256 of canonical `{ id, questions }`, and it carries one sentence: `a changed question never replays an old answer` — the same content-addressing idea as the plan's step key, one level down, and worth saying out loud exactly once.)_
- **Jev Questions tab › the table** — Question   Kind      Answer           Confidence           Floor   Verdict
relevant   boolean   true             0.88  reported       0.70    taken
role       choice    implementation   0.96  reported       0.70    taken
risk       score     low              0.55  reported       0.70    below the floor _(CONFIDENCE PROVENANCE IS NOT OPTIONAL. `Classifier.confidence` reads 1.00 when the transport sent no distribution, because the decoder makes it one-hot on the chosen option. Every confidence therefore carries `reported` or `one-hot`; `one-hot` also carries the sentence `no distribution was sent — confidence is 1.00 by construction`. A confidence bar that reads 1.00 for that reason is the single most misleading thing this surface could draw. Exactly three verdict words: `taken` (`Classifier.confident` returned `Option.some`), `below the floor` (`Option.none` — the value is still shown at 55% opacity with `the caller decides, not a model`), `flagged` (a declared named gate was crossed).)_
- **Jev Questions tab › distribution, choice and score** — implementation — code the task is about            ████████████████████  0.96
fixture — test data, setup, configuration          ▏                     0.03
unrelated — nothing in the excerpt bears on it     ▏                     0.01
                                   ┆ floor 0.70 _(One bar per criterion, the criterion's own declared text beside its key. A SOLID vertical hairline at the floor; bars at or above it filled, bars below hollow — colour-free, screenshot-safe, and it makes the floor a property of the picture rather than a number in a corner. A declared gate draws a second, DASHED hairline labelled with its constant: `disprovenAt 0.30`, `overclaimedAt 0.80`.)_
- **Jev Questions tab › distribution, boolean** — false ├──────────────┼────────●─────┤ true
      0            0.5        0.94   1
              ┆ 0.15      ┆ 0.85     floor 0.70 (two-sided) _(A boolean's confidence is `abs(p - 0.5) * 2`, so a floor of 0.70 in confidence space is TWO hairlines in probability space, at 0.15 and 0.85. Drawing it as a one-sided bar would misstate the mechanism. `value` is `probability >= 0.5`.)_
- **Jev Questions tab › provider confidence** — provider confidence   0.96 _(`Evaluator.Response.confidence[questionId]`, read from `providerMetadata.typesafe.confidence`. A DIFFERENT number from `Classifier.confidence` with the same name: present for choice and score, never for boolean. Renders as its own row, only when present, always under this label.)_
- **Jev State tab** — task      widen() drops the unit: test_keeps_unit expects 'km' and gets 'm'
file      src/units/widen.py
excerpt   def widen(value, unit): return value

218 B of 32 KiB _(The state as `Classifier.state` encoded it, then the raw JSON in a `Code` block with its byte count against the 32 KiB cap. A state the schema does not encode fails as `invalid_question` — that copy belongs here, not on the Failure tab.)_
- **Jev Failure tab** — [refused]  429
message   the gateway refused the evaluation _(Six codes, and only the one that happened: `unreachable` (no response) · `refused` (a status other than 200, kept in `status`) · `empty` (a 200 without answers) · `timeout` (past this call's 1500 ms deadline) · `invalid_answer` (an answer off the criteria, naming the question) · `invalid_question` (a 400 or 422, or a rejected question). There is no retry to show: the transport spends none.)_
- **Peek footer** — Re-run from here…      Pin output      Copy for AI _(Trigger.dev's ellipsis convention adopted verbatim: a trailing `…` means a dialog opens, no ellipsis means it acts now. `Re-run from here…` opens the re-key HUD because re-keying voids approvals (D-022) and must never be a button that just does it. `Copy for AI` formats the call for a prompt rather than a file — nearly free here, and it makes the drill-in end somewhere useful instead of at a wall of JSON.)_
- **Cache-hit line, above the footer** — served from run r_8c21 · event #1447 _(Rendered only on a `clean` settlement, from `flows.engine.cache-provenance` `{keyDigest, recordedRunId, recordedEventSeq}`. Clickable: opens that run's peek for the same node. Without it, `clean · 0ms` is a claim with nothing behind it.)_
- **Agent node › Calls tab rows** — frame   seat                model           stop       duration   in / out
7       coding/implement    claude-opus-5   stop       42.1 s     18 412 / 1 106
8       coding/implement    claude-opus-5   tool-calls 11.4 s      19 004 / 340
9       coding/implement    claude-opus-5   —          retry 2 of 3 _(One row per `flows.harness.model-settled.v1` in the node, folded with its `flows.harness.model-retried.v1` and `flows.harness.turn-opened.v1`. A row opens the chat peek for that call. Rejected cells (`cell-rejected-in-frame`) are real model calls and appear as their own rows under the frame that owns them, because hiding them undercounts spend.)_

### States

- **unrouted** — Chip `⊘ no route`. Peek opens on Failure with one code, `no_route`, message `no model route in this environment`, and no other tab. No Stream, no Request — nothing was prepared.
- **queued (prepared, not sent)** — Chip normal, node dashed. Peek Overview renders the Request strip with only `prepare` lit; `Request` tab is already full (bodyText exists before the socket opens). Stream tab shows the legend at 38% and the line `no events yet`.
- **streaming — writing** — Node: rail marching, shimmer, caption = the live text tail with a blinking caret. Peek header badge reads `writing`. Stream tab appends rows live; the last row pulses. Usage section is EMPTY, not zeroed — counters arrive on the `usage` event.
- **streaming — thinking** — Same, caption prefixed `thinking` and the tail at 72% opacity. Stream shows `thinking-start` with `signature present`. If the provider sends no text part before `thinking-end`, the caption never switches and the node reads `thinking` for the whole call, which is correct.
- **streaming — calling a tool** — Caption `calling files.read`. Tools tab appears mid-call with a count pill and the row in `assembling`, argument text growing. This is the only tab that can appear while the peek is open.
- **retrying** — Node word `retrying` (the mock's existing state), caption `retry 2 of 3 · 1.0s`, the attempt chip `attempt 2` in the foot. Peek header badge `retrying`. Stream shows a `retry` row `{attempt, code, delayMillis}`. Failure tab is NOT yet present — a retry is not a failure.
- **settled — stop** — Node `built` + duration. Peek header badge `built`. Outcome `stop ← end_turn`. Stream's last row is `settle`.
- **settled — length / tool-calls / content-filter** — Same shape, Outcome shows the literal. `length` additionally surfaces the `maxTokens` row in Params at the top with the note `the output hit this ceiling`.
- **settled — aborted** — Node `failed`. Outcome `aborted` with the sentence `no settle event — the stream was interrupted; no provider reports this value`. Assembled parts still render: partial tool-call argument text is preserved verbatim by `settledMessage` and `ToolStream.flushAborted`, so the transcript is truthful even though the live stream would have refused it.
- **failed — ModelError** — Node `failed` + shake. Peek opens on Failure. One code, `retryable` verdict, both retry ladders, `error.body` behind a disclosure.
- **asking (Jev, live)** — No shimmer, no caption. The 2px deadline bar fills left-to-right; caption line reads `asking · 0.31s / 1.50s`. Peek header badge `asking`. Questions tab shows the declared questions with empty Answer/Confidence cells and the Verdict column blank — the shape is known before the answer.
- **answered (Jev)** — Node `built` + latency. Questions table fills. Any question below its floor renders its Verdict as `below the floor` and its Answer at 55% opacity.
- **answered with a one-hot fallback (Jev)** — Identical table EXCEPT the provenance mark reads `one-hot` and the distribution panel replaces bars with a single filled bar at 1.00 plus the sentence `no distribution was sent — confidence is 1.00 by construction`. The `provider confidence` row is absent. This state must be visually distinguishable at a glance or the surface lies.
- **timeout (Jev)** — Deadline bar full, node `failed`, Failure tab `timeout`, copy `past 1500 ms`. No answers, no partial answers: the transport is one POST.
- **clean — a cache hit** — NO MODEL CALL HAPPENED IN THIS RUN. The peek must not render an empty Stream tab. Tabs collapse to Overview + Request. Overview's first line is `no model call in this run` and the cache-provenance line is promoted into the body: `served from run r_8c21 · event #1447`, clickable. Request still renders, because the prepared request is what keyed the step. A peek that shows a blank stream here is a bug, not an empty state.
- **skipped** — The arm was not taken. Node at 38% dashed. The model chip renders at 38% with its label intact, so you can still read which model WOULD have answered. Peek has one tab, Overview, with Seat/Route/Params and the line `this arm settled skipped`. No usage, no stream, no request bytes.
- **scripted** — Chip `{ } scripted`. Peek tabs: Overview + Script. Overview says `scripted — no request was sent`. Script shows the `Evaluator.layerScripted` / `Model` fixture verbatim. Route section is absent: there is no route.
- **agent node, live** — Caption `frame 62 · writing`, frame chip `f 62/100` (past the 50% rule). Calls tab grows a row per settled call; the newest row pulses.

### Data shape

```ts
```ts
// Real names. @smthrs/model: Classifier, Evaluator, Framing, ModelError,
// ModelEvent, ModelRequest, Protocol, Route. @smthrs/agent: Seat.
import type {
  Classifier, Evaluator, Framing, ModelError, ModelEvent, ModelRequest, Protocol, Route
} from "@smthrs/model"
import type { Seat } from "@smthrs/agent"

/** What the node chip says. The kind is a shape, never a colour (D-026). */
export interface ModelChip {
  readonly kind: "chat" | "evaluation" | "agent" | "scripted" | "unrouted"
  /** The one fact `.fl-node-tag` does not already carry. */
  readonly label: string
  /** Absent for `evaluation`: Jev has no `Protocol.id`. */
  readonly protocolId?: Protocol.Protocol["id"]
  readonly stage?: StreamStage
}

/** Derived from the last `ModelEvent.type` and nothing else. */
export type StreamStage =
  | { readonly _tag: "Opening" }
  | { readonly _tag: "Thinking"; readonly tail: string }
  | { readonly _tag: "Writing"; readonly tail: string }
  | { readonly _tag: "Calling"; readonly name: string }
  | { readonly _tag: "Retrying"; readonly attempt: number; readonly delayMillis: number }
  | { readonly _tag: "Asking"; readonly elapsedMs: number; readonly timeoutMs: number }
  | { readonly _tag: "Settled"; readonly stopReason: ModelRequest.StopReason }

/** Seat → model → route, the chain the peek header prints. */
export interface Resolution {
  readonly seat: Seat.Seat["id"]                    // the declared string; carries no credential
  readonly modelId: Seat.Seat["modelId"]
  readonly contextWindowTokens: Seat.Seat["contextWindowTokens"]  // ModelCatalog; never zero
  readonly routeId: Route.PreparedRequest["routeId"]
  readonly protocolId: Route.PreparedRequest["protocolId"]
  readonly framingId: Framing.Framing<unknown>["id"]              // "sse" | "ndjson"
  readonly credentialHeader: string                 // "x-api-key" | "Authorization" | …
  readonly credentialSource: string                 // the env var NAME, never its value
  readonly refreshable: boolean                     // Auth.refresh !== undefined
  readonly supportsDeferred: boolean                // Protocol.supportsDeferred(modelId)
  readonly harness?: { readonly id: string; readonly state: "signed-in" | "api-key" | "binary-only" }
}

/** One `GenerationParams` knob. Four states; a value alone hides three of them. */
export interface ParamRow {
  readonly name: keyof ModelRequest.GenerationParams | "toolChoice"
  readonly value: string
  readonly state: "set" | "defaulted" | "dropped" | "refused"
  readonly note?: string
}

/** Consecutive events of the same type and id fold into one row. */
export interface StreamRow {
  readonly type: ModelEvent.ModelEvent["type"]      // one of the thirteen tags
  readonly atMillis: number
  readonly count: number                            // 1 when unfolded
  readonly id?: string
  readonly detail?: string
  readonly events?: ReadonlyArray<ModelEvent.ModelEvent>
}

export interface ToolStreamRow {
  readonly toolCallId: string
  readonly name: string
  readonly state: "assembling" | "complete" | "aborted"
  readonly argumentsText: string
  readonly bytes: number
}

export interface ChatCall {
  readonly resolution: Resolution
  readonly request: Route.PreparedRequest           // { routeId, protocolId, method, url, publicHeaders, body, bodyText }
  readonly sealedStepKeyDigest: string              // flows_plan_nodes.key_digest
  readonly params: ReadonlyArray<ParamRow>
  readonly tools: ReadonlyArray<ModelRequest.ToolDefinition>
  readonly toolPartition: {                         // DeferredTools.resolve(request, native)
    readonly immediate: number
    readonly deferred: number
    readonly activatedNames: ReadonlyArray<string>
  }
  readonly stream: ReadonlyArray<StreamRow>
  readonly toolStreams: ReadonlyArray<ToolStreamRow>
  readonly message?: ModelRequest.AssistantMessage  // settledMessage(events).message
  readonly usage: ModelEvent.Usage                  // every counter optional; ABSENT ≠ 0
  readonly durationMillis: number                   // flows.harness.model-settled.v1
  readonly retries: ReadonlyArray<ModelEvent.Retry> // flows.harness.model-retried.v1
  readonly transportFailures: number                // toward RequestExecutor.rebuildAfter (3)
  readonly reissues: number                         // outer ladder vs defaultModelOverruns (1)
  readonly error?: ModelError.ModelError
  readonly cache?: { readonly recordedRunId: string; readonly recordedEventSeq: number }
}

export interface ChatCallSummary {
  readonly frame: number
  readonly seat: Seat.Seat["id"]
  readonly modelId: string
  readonly stopReason?: ModelRequest.StopReason
  readonly durationMillis: number
  readonly usage: ModelEvent.Usage
  readonly rejectedCells: number                    // flows.harness.cell-rejected-in-frame.v1
}

export interface EvaluationQuestionRow {
  readonly id: string
  readonly type: Evaluator.Question["type"]         // "boolean" | "choice" | "score"
  readonly instructions: string
  readonly criteria: ReadonlyArray<{
    readonly key: string
    readonly text?: string
    readonly probability?: number
  }>
  readonly answer:
    | Classifier.BooleanAnswer
    | Classifier.ChoiceAnswer<string>
    | Classifier.ScoreAnswer<string>
  readonly confidence: number                       // Classifier.confidence(answer)
  /** `one-hot` means the transport sent no distribution and confidence reads 1.00. */
  readonly provenance: "reported" | "one-hot"
  readonly providerConfidence?: number              // Evaluator.Response.confidence[id]
  readonly floor: number                            // the caller's Classifier.confident floor
  readonly gate?: { readonly name: string; readonly at: number; readonly side: "below" | "at-or-above" }
  readonly verdict: "taken" | "below the floor" | "flagged"
}

export interface EvaluationCall {
  readonly classifierId: string                     // Classifier.make(id, …)
  readonly digest: string                           // sha256 of canonical { id, questions }
  readonly description: string
  readonly declaredAt: string                       // the source file the classifier is declared in
  readonly stateJson: string
  readonly stateBytes: number
  readonly request: {
    readonly url: string                            // Evaluator.defaultBaseUrl
    readonly headers: Readonly<Record<string, string>>
    readonly bodyText: string
  }
  readonly questions: ReadonlyArray<EvaluationQuestionRow>
  readonly latencyMs: number                        // Evaluator.Response.latencyMs
  readonly timeoutMs: number                        // Evaluator.defaultTimeoutMs (1500)
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
  readonly zeroDataRetention: boolean
  readonly error?: Evaluator.EvaluatorError
}

/** What the peek renders. The tab set is chosen by this discriminant. */
export type ModelDrillIn =
  | { readonly _tag: "Chat"; readonly call: ChatCall }
  | { readonly _tag: "Evaluation"; readonly call: EvaluationCall }
  | { readonly _tag: "Agent"; readonly calls: ReadonlyArray<ChatCallSummary>; readonly frames: number; readonly maxFrames: number }
  | { readonly _tag: "Scripted"; readonly script: string }
  | { readonly _tag: "Unrouted"; readonly error: ModelError.ModelError }
  /** A `clean` settlement: no call happened in this run. */
  | { readonly _tag: "Cached"; readonly request: Route.PreparedRequest; readonly provenance: { readonly recordedRunId: string; readonly recordedEventSeq: number } }
  /** The arm settled `skipped`; the resolution is known, nothing else is. */
  | { readonly _tag: "Skipped"; readonly resolution: Resolution }
```
```

### Interactions

- Click a node's model chip → opens the peek directly on that node's drill-in, bypassing the 336px inspector. Click the node body → the 336px inspector, whose Model section has one door (`Open model call`).
- `Enter` on a selected node → inspector. `Enter` again, or `⌘↵` from the node → peek. `Esc` narrows one rung: peek → inspector → nothing. Never two rungs at once.
- Single-key tab shortcuts while the peek has focus: chat `o` `s` `t` `r` `f`; Jev `o` `q` `s` `r` `f`; agent `c` `f` `x` `b` `j`. The underline slides between tabs (shared-layout), which is free because the mock already runs React.
- The selected tab lives in the URL/card payload, so a tab is linkable — the same instinct as D-002's canvas-as-projection.
- Click a folded Stream row (`×1106`) → expands to the individual `ModelEvent`s, virtualized. Click again folds.
- Click a legend tag → filters the event list to that tag. Click again clears. Absent tags are not clickable.
- Click a Questions row → the distribution panel below switches to that question. Arrow up/down move between questions.
- Hover a distribution bar → the criterion's declared text in full, for criteria text longer than the row.
- Click the cache-provenance line on a `clean` node → opens the same node's peek in run `recordedRunId`. Walks backwards repeatedly, GitHub-blame style.
- Click an agent node's Calls row → replaces the peek content with that call's chat drill-in, with a back affordance to Calls. Same container, no new pane.
- `Copy for AI` → copies the whole call formatted for a prompt (resolution, params, folded stream, usage, outcome, error), not for a file. Acts immediately.
- `Pin output` → forces a cache hit at this step key. Acts immediately; the node gains a 2px accent border and the ribbon `pinned · 0ms`.
- `Re-run from here…` → opens the re-key HUD. It never acts directly: re-keying voids approvals bound to the plan digest (D-022), and the HUD's submit button states how many nodes re-run and how many are cache hits.
- Opening or closing the peek re-runs `flow.setCenter` on the selected node at the same zoom, so the node stays centred in the canvas that remains (D-024).
- Below 1100px the peek is an overlay over a scrim; a click on the scrim closes it.

### Sample content

═══ SAMPLE 1 — ANTHROPIC-PROTOCOL AGENT CALL ═══
Node `Write the failing test` · tag `coding/edit-atom` · kind `agent` · tier `compensable` · outcome `built`.
Frame 7 of 23 inside that node.

NODE FOOT:  [agent] [⌁ coding/implement ▤] ······ [built] [42.1s]

PEEK HEADER
  claude-opus-5                                                    [built]
  coding/implement → claude-opus-5 → anthropic · anthropic-messages

TABS:  Overview   Stream   Request        (no Tools tab, no Failure tab)

OVERVIEW › Seat                            right: 19 518 / 1 000 000
  Seat               coding/implement
  Model              claude-opus-5
  Context window     1 000 000
  Harness            claude · signed-in

OVERVIEW › Route                           right: [sse]
  Route              anthropic
  Protocol           anthropic-messages
  Endpoint           POST https://api.anthropic.com/v1/messages
  Credential         x-api-key ← ANTHROPIC_API_KEY
  Header             anthropic-version: 2023-06-01
  Framing            sse
  Refreshable        no — a static credential stays terminal on a 401
  Deferred tools     supported

OVERVIEW › Params
  maxTokens          32000     set
  thinkingBudget     8192      set
  temperature        —         unset
  topP               —         unset
  topK               —         unset
  stopSequences      —         unset
  reasoningEffort    —         unset
  toolChoice         —         unset

OVERVIEW › Usage
  Input              18 412 tokens
  Output              1 106 tokens
  Reasoning             842 tokens
  Cache read        112 908 tokens
  Total              19 518 tokens
  Duration             42.1 s
  (cacheWriteTokens is absent — the row is not rendered. A missing count is not a zero count.)

OVERVIEW › Request strip
  prepare › sign › attempt 1 › stream › settle
  41.2 KiB  x-api-key  200 · 312 ms  1 325 frames  stop · 19 518 tokens

OVERVIEW › Outcome
  Stop reason        stop  ← end_turn
  Response id        msg_01P9kqW7vR2mXe4dT8nAcB3y
  Item ids           —
  Parts              1 thinking · 1 text
  Tools declared     none — the cell-first controller opens every turn with
                     tools: [] and toolChoice: "none"

STREAM › legend (present at full opacity, absent at 38%)
  text-start  text-delta  text-end  thinking-start  thinking-delta
  thinking-end  tool-call-start  tool-call-delta  tool-call-end
  tool-result  usage  retry  settle

STREAM › rows (1 325 events, 8 rows)
  t+0.00s   thinking-start   signature present
  t+0.00s   thinking-delta   ×214
  t+7.90s   thinking-end
  t+7.91s   text-start       id msg_01P9…_1
  t+7.91s   text-delta       ×1106
  t+41.9s   text-end
  t+42.0s   usage            in 18 412 · out 1 106 · cache read 112 908
  t+42.1s   settle           stop

STREAM › assembled parts
  thinking  [signature]  echoed back unchanged on the next request
            The test has to fail for the right reason, so assert on the unit
            rather than the magnitude…
  text      ```javascript
            const before = await ctx.call("bash", { command: "pytest tests/test_widen.py -q" })
            await ctx.call("edit", { path: "tests/test_widen.py", … })
            ```

REQUEST
  POST https://api.anthropic.com/v1/messages

  anthropic-version: 2023-06-01
  content-type: application/json

  {"model":"claude-opus-5","max_tokens":32000,"system":[{"type":"text",
  "text":"You are a JavaScript REPL. Your bindings are ctx, console, and
  everything your earlier cells defined…"}],"messages":[{"role":"user",
  "content":[{"type":"text","text":"flow catalog (descriptor provenance
  follows)…"}]},{"role":"assistant","content":[{"type":"text","text":
  "```javascript\nconst hits = await ctx.call(\"grep\", { pattern: \"def
  widen\" })\n```"}]}],"stream":true,"thinking":{"type":"enabled",
  "budget_tokens":8192}}

  Body               41 208 B
  Sealed step key    key1_5c8b1f22
  Credential         x-api-key — applied through Auth, not shown here

  publicHeaders refuses any route header matching the credential matcher,
  so this view is credential-free by construction.

  ⚑ There is no `tools` key in this body. The Anthropic lowering omits an
    empty array, and the harness always sends one.

═══ SAMPLE 2 — JEV CALL ═══
Node `Triage each issue` · tag `triage/relevance` · kind `jev` · tier `sealed` · outcome `built`.

NODE FOOT:  [jev] [▮▁▄ 3 questions] ······ [built] [284ms]

PEEK HEADER
  triage/relevance                                             [3 answers]
  Classifier · typesafe-ai/jev · 284 ms of 1500 ms

TABS:  Overview   Questions   State   Request

OVERVIEW
  Classifier             triage/relevance
  Declared               packages/smithers/agent/std/src/Classifiers.ts
  Digest                 9c41f0…7b2e
                         a changed question never replays an old answer
  Questions              3 in one call
  Latency                284 ms of 1500 ms
  Input / Output         412 / 6 tokens
  Zero data retention    on
  Retries                none — the caller decides whether a failure is
                         worth a second request

QUESTIONS
  Question   Kind      Answer           Confidence         Floor   Verdict
  relevant   boolean   true             0.88  reported     0.70    taken
  role       choice    implementation   0.96  reported     0.70    taken
  risk       score     low              0.55  reported     0.70    below the floor

  selected: risk  ·  score  ·  value 1 · label low
  none                                  ██████████████▏         0.41
  low                                   ███████████████████▏    0.55
  medium                                ▏                       0.03
  high                                  ▏                       0.01
                                              ┆ floor 0.70

  provider confidence    0.55
  confident()            Option.none()
  Closest                low · 0.55
  the caller decides, not a model

  selected: relevant · boolean
  false ├──────────────┼────────────●─┤ true
        0            0.5          0.94  1
                ┆ 0.15        ┆ 0.85    floor 0.70 (two-sided)
  confidence  |0.94 − 0.5| × 2 = 0.88     provider confidence  —

STATE
  task      widen() drops the unit: test_keeps_unit expects 'km' and gets 'm'
  file      src/units/widen.py
  excerpt   def widen(value, unit): return value

  218 B of 32 KiB

REQUEST
  POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model

  ai-evaluation-model-specification-version: 4
  ai-gateway-auth-method: api-key
  ai-gateway-protocol-version: 0.0.1
  ai-model-id: typesafe-ai/jev
  authorization: Bearer <redacted>
  content-type: application/json

  {"state":{"task":"widen() drops the unit: test_keeps_unit expects 'km'
  and gets 'm'","file":"src/units/widen.py","excerpt":"def widen(value,
  unit): return value"},"questions":{"relevant":{"type":"boolean",
  "instructions":"Does this file need to change for the task?","criteria":
  {"true":"the fix or its test lives here","false":"unrelated or only
  imported"}},"role":{"type":"choice","instructions":"What is this file's
  role?","criteria":{"implementation":"code under test","fixture":"test
  data or setup","unrelated":"nothing to do with the task"}},"risk":
  {"type":"score","instructions":"How risky is editing this file?",
  "criteria":["none","low","medium","high"]}},"providerOptions":
  {"gateway":{"zeroDataRetention":true}}}

  Body               1 104 B
  Sealed step key    key1_a5f0c731
  Credential         authorization — applied through Auth, not shown here

### Risks

- The shipped monitor cannot fill the Usage section. `apps/app/src/mainview/cards/RunTrace.ts:843-858` folds `control.agent.model-settled` into a `model` span keeping ONLY `inputTokens`/`outputTokens`, and drops `reasoningTokens`, `cachedInputTokens`, `cacheWriteTokens`, `totalTokens`, the seat, the params and the context digest. Cache read/write are the two numbers that make the content-addressed pitch legible (D-021) and the card throws them away. Either widen that fold or the peek renders fixtures and says so.
- No projection carries model-call detail. The seven served projections (`workspace-runs`, `run-summary`, `run-events`, `transcript`, `run-tree`, `approvals`, `node-output`) have no frame/cell/model structure. The only source is `run-events` filtered on `flows.harness.*`, which is unfolded. This is the same shape of gap as D-020's plan-graph projection and should be decided at the same time, not after.
- `Classifier.confidence` reads 1.00 when the gateway sent no distribution, because the decoder makes it one-hot on the chosen option. If an implementer drops the `reported` / `one-hot` provenance mark to save a column, the surface will display total certainty for an answer nobody scored. This is the single highest-severity correctness risk in the spec.
- Two live meanings of "seat". `Seat.Seat` (declared string → modelId + route + contextWindowTokens) and `AgentRole` from `packages/rpc/src/AgentRoles.ts` (job → model → local harness CLI) are both called "seat" in `experimental/panes/Models.tsx`. The peek header's chain assumes `Seat.Seat`. Pick one and name the other, or the header lies for six of the nine seats that pane lists.
- Cost is not an engine field. There is no price table in `@smthrs/model`; the mock's `flow.ts` invents `cost: 8.06`. The Cost row must be gated on a bound price table or omitted entirely — a row whose value is "not measured yet" is a defect under AGENTS.md MINIMAL TEXT.
- The Tools tab will be absent on every harness-driven call, because the cell-first controller sends `tools: []` and `toolChoice: "none"` on every request. A reviewer who expects a tools list will read the absence as a bug. The one-line `Tools declared` row in Outcome is the entire mitigation and it must not be cut.
- Width arithmetic. rail 56 + chat 360 + peek 720 = 1136, leaving under 500px of canvas below 1640px — a zoom at which the graph is a picture of a graph, which D-024 forbids. The chat-collapses-first rule and the 1100px overlay breakpoint are load-bearing, not polish.
- Two component vocabularies for the same facts. The flow-builder mock is a standalone vite bundle with its own `.fl-*` CSS; the experimental panes compose `Primitives.tsx` (Section/Split/Facts/Table/Rail/Steps/Bars/Code/Badge) and write no CSS. This spec deliberately reuses `Models.tsx` and `Decisions.tsx` copy verbatim, but reuses none of their components. If the flow-builder lands as `experimental/panes/` (D-014) that duplication becomes the divergence the experimental README exists to prevent.
- `Evaluator.Response.confidence` is `Record<string, number>` keyed by question id and is a different number from `Classifier.confidence` with the same name. The spec renders both, under distinct labels, on adjacent rows. Any implementation that collapses them to one row is wrong in a way that is invisible until a choice question disagrees with itself.
- Protocol glyphs are four outlined shapes that must stay distinguishable at 12px in both themes. `openai-responses` and `openai-responses-chatgpt` differ only by a corner dot, which is the smallest defensible difference and the most likely to be lost to a renderer or a screenshot scale. Test them at 12px before committing to the corner dot.

## Node Inspector — the node detail view (drawer + maximized), replacing the current 336px right-hand Inspector in `docs/flow-builder/mockups/source/src/components/Inspector.tsx`

One component that shows everything the engine actually knows about a selected plan node — what it consumed, what it declared, what it settled, the code behind it, and the step key that decides whether it ever runs again — as a 420px right drawer that maximizes to full screen without changing component, data or tab.

### Layout

```
PRESENTATION 1 — DRAWER (default). Right edge, 420px, resizable 360–720 (drag handle on the left edge, width persisted per workspace). Canvas keeps `padding-right: <width>` so D-024's camera still fits the live node. Never overlays the canvas; never a modal (n8n's NDV covers the graph and fights the camera — rejected).

┌───────────────────────────────────────────────┐ 420px
│▌ ⬢  Write the failing test          ⤢    ×   │ 56  rail(4px)·glyph·title·maximize·close
│▌ root › then › andThen · coding/edit-atom     │ 20  AST path (segmented, copyable) · Action.name (mono)
│▌ compensable · agent · claude-opus-5 · ●built │ 24  chips · status dot + WORD (D-026)
│▌ 41m 12s · 612,400 tokens · $8.06 · attempt 1 │ 20  facts line (only facts that exist)
├───────────────────────────────────────────────┤
│ Input Declaration Output Frames Code Key Event│ 36  tab strip, x-scroll, sliding underline
├───────────────────────────────────────────────┤
│ [Schema][Table][JSON]               ⌕         │ 32  view bar — owned by the tab, absent where meaningless
│                                               │
│   single scrolling column, 16px gutters       │ flex
│                                               │
├───────────────────────────────────────────────┤
│ Re-run from here…   Pin output…  Open file  ⋯ │ 52  footer acts (never tabs)
└───────────────────────────────────────────────┘

PRESENTATION 2 — FULL (`m`, or ⤢). THE EMBED LAW: the same `<NodeInspector>` element, same React key, same props, same selected tab, same scroll offset. Only `data-presentation` flips `drawer` → `full`. No new data is fetched and no new component is mounted: the left rail is the canvas's existing selection model rendered as a list, and the right column is the drawer's header facts line promoted from one truncated row to persistent rows.

┌──────────────────────────────────────────────────────────────────────────────┐
│▌ ⬢ Write the failing test  root › then › andThen · coding/edit-atom   ⤡   × │ 56
│  compensable · agent · claude-opus-5 · ● built · 41m 12s · $8.06            │ 24
├───────────┬───────────────────────────────────────────────┬─────────────────┤
│ PLAN 240  │ Input Declaration Output Frames Code Key Events│ FACTS 300       │
│ ● issues  ├───────────────────────────────────────────────┤ planKey  key1_… │
│ ● triage  │ [Schema][Table][JSON]              ⌕          │ dispatchKey key…│
│ ◆ branch  │                                               │ tier compensable│
│ ● repro   │   tab body — 2 columns at ≥1200px, else 1     │ seat coding/impl│
│ ● test    │                                               │ effects reads **│
│▸⬢writetest│                                               │ ─────────────── │
│ ● checks  │                                               │ Downstream      │
│ ● pr      │                                               │ 3 re-key · 8 cl.│
│ ● notify  │                                               │ 1 approval void │
├───────────┴───────────────────────────────────────────────┴─────────────────┤
│ Re-run from here…   Pin output…   Open file        Copy for AI           ⋯  │
└──────────────────────────────────────────────────────────────────────────────┘

TRANSITION: 180ms, `transform` + `clip-path` from the drawer's rect to the viewport rect; the header keeps DOM identity so the title does not remount or reflow its text. `prefers-reduced-motion: reduce` → instant swap. Escape in `full` returns to `drawer`; Escape in `drawer` closes.

ADDRESSABILITY: selection and tab live in the URL — `?node=root.then.andThen&tab=key&view=full`. `y` copies that permalink. (Trigger.dev puts the inspector tab in a search param for exactly this; D-002 says the canvas is a projection, so its state belongs in the URL.)
```

### Anatomy

- **Kind rail** — 4px left edge, coloured by `Plan.PlanNode.kind` — step | agent | merge — plus the mock's UI kinds trigger | jev | human | branch. Carries identity, never status. _(Colour is identity here and status elsewhere; they never share a hue. An Action may never declare a colour (n8n's 400-hex canvas is the counter-example they are themselves walking back).)_
- **Glyph** — One per kind. `clean` swaps the glyph, never the hue (see Status dot).
- **Title** — The node's human title, e.g. `Write the failing test`. Editable inline in the builder; renaming is free and the drawer says so once, in the Declaration tab's `free` column — never as a sentence. _(`StepKey.ts:459-461` — ids never enter the hash.)_
- **AST path** — `root › then › andThen › map` — the node id segmented on `.`, mono, each segment copyable, whole path copyable. Tooltip: `Structural id. Not hashed.` _(This is the only source-shaped provenance that survives (`flows/flow/src/Graph.ts`: ids derive from traversal positions and do not enter the hashed value). It replaces the file:line we do not have.)_
- **Action name** — `coding/edit-atom` in mono, from `Action.name`. Click → filters the canvas to every node with this action.
- **Tier chip** — Exactly one of `sealed` `compensable` `irreversible`. `irreversible` additionally draws a lock glyph in the header. _(`Action.Tier`. Hover copy, one line each: sealed — `cacheable across runs`; compensable — `rolled back on failure`; irreversible — `approval gated`.)_
- **Kind chip** — `step` `agent` `merge` (plan kinds) or `trigger` `jev` `human` `branch` (UI kinds drawn from the action name).
- **Seat / model chip** — The declared seat string verbatim (`coding/implement`) and, when resolved, the model id (`claude-opus-5`). Two chips, not one: a seat is a declaration, a resolved seat is a capability. _(`Seat.Seat { id, modelId, model, route, contextWindowTokens }`. `provider:modelId` is the Node resolver's convention only; render the declared string as written.)_
- **Status dot + word** — Dot plus the word, always both: `idle` `queued` `running` `waiting on you` `retrying` `built` `cache hit` `failed` `skipped` `deferred` `will re-run`. _(D-026. `cache hit` keeps the built green and changes the glyph — it does not dim. Dimming collides with `skipped` at 38% and dies in a screenshot.)_
- **Facts line** — `41m 12s · 612,400 tokens · $8.06 · attempt 1`. Each fact is omitted when absent; a missing token count is never rendered as `0`. _(`Usage` counters are explicitly "a missing count is not a zero count". Omission, not zeroes. (AGENTS.md MINIMAL TEXT: no row whose value is "not measured yet".))_
- **Live marker** — While the run is active: `Live` in brand with a 2px pulsing dot, and an 8px marching-tile texture on the header rail. Both vanish the instant the node settles — a finished node carries no live chrome. _(Trigger.dev's `LiveReloadingStatus` returns null once the root span completes; their partial-span tile texture survives a screenshot where a shimmer does not.)_
- **Maximize / restore** — ⤢ / ⤡, `m`. aria-label `Maximize` / `Restore`. _(THE EMBED LAW.)_
- **Close** — ×, `Escape`. aria-label `Close`.
- **Prev / next node** — `[` and `]` walk the plan in topological order, respecting whatever filter the canvas currently applies. aria-labels `Previous node` / `Next node`. _(Trigger.dev's prev/next walk the filtered list you arrived from; that is what turns a list plus a detail pane into a triage queue.)_
- **Tab strip** — `Input` `Declaration` `Output` `Frames` `Questions` `Code` `Key` `Attempts` `Events`. Order fixed. Sliding underline between tabs. Single-key shortcuts: i d o f q c k a e. Frames/Questions/Attempts are evidence-gated and simply absent when their evidence cannot exist. _(A tab with nothing behind it must not appear (MINIMAL TEXT). Output is never gated: before a run it shows the declared success/error schema, which is real content.)_
- **Tab set by node kind** — step → Input·Declaration·Output·Code·Key·[Attempts]·Events. agent → adds Frames after Output. jev → adds Questions. human → adds Questions (the HumanTask form). merge/branch → base set. trigger → Schedule·Declaration·Fires·Events ONLY: a trigger has no step key, is never built or clean, and a re-run never re-fires it. _(D-031. Per-kind tab sets is the one mechanism Trigger.dev proves in production (task span vs AI span vs prompt span have different tabs and different metric sets).)_
- **View bar** — `[Schema] [Table] [JSON]` segment control, Schema first and default, plus a `⌕` filter field. Present on Input and Output only. _(n8n's three words exactly. We reject their Table semantics (an n8n edge carries an item array); ours is one typed value, so Table means the field rows.)_
- **Input tab — row** — Per declared input: field name · type · source badge (`Literal` `Ref` `Pending`) · origin (`← repro.workspace`) · value (truncated to 120 chars, `⌄` expands). _(`KeyMaterial.InputRef = Literal{value} | Ref{from,path} | Pending{from}`; the resolved side is `PlanScheduler.ResolvedInput { from, path, value }`.)_
- **Input tab — Pending row** — Value cell reads `—`; a quiet suffix reads `ordering only · not part of the key`. _(`PlanScheduler.NodeInput.inputs` doc: "Ordering (`Pending`) dependencies and unprojected sibling fields are deliberately absent." Showing a value here would be an invention.)_
- **Input tab — unsettled Ref** — Value cell reads `[evaluated during execution]`. _(n8n's `expressionModalInput.evaluatedDuringExecution`, verbatim — it is exactly what a `Planned` reference is before its producer settles.)_
- **Input tab — header count** — `4 inputs · 3 keyed · 1 ordering`
- **Declaration tab — keyed/free column** — Every declaration row carries `keyed` or `free`. Keyed: tier (`kind`), `body`, `inputs`, `layers`, `capabilities`, `effects`, `placement`, `nondeterministic`. Free: id, title, description, priority, lane, annotations. Section header: `13 fields · 8 keyed · 5 free`. _(The builder half of the pitch, and nobody else has it: the Declaration tab tells you which edits cost a re-run BEFORE you make one. Derived from the `KeyMaterial` struct field list, not guessed.)_
- **Declaration tab — rows** — `name` `implementationVersion` `tier` `idempotencyKey` `nondeterministic` `retryPolicy` `fileBoundary` (`mode: hermetic|expected`, `onConflict: serialize|lane|fail`, reads, writes) `capabilities` `layers` `placement` `successSchema` `errorSchema`. Agent adds `seat`, `maxFrames`, `corrections`, budgets. Jev adds `floor`, `timeoutMs`, `zeroDataRetention`. _(All real `Action` interface members (`flows/flow/src/Action/Action.ts:209-250`).)_
- **Declaration tab — model knob state** — For an agent node, each `GenerationParams` knob is tagged one of four words: `set` `defaulted` `dropped` `refused`. e.g. `maxTokens — defaulted 4096 (anthropic-messages)`, `topK — dropped (openai-responses)`. _(Four distinct states per knob; showing only the declared value hides three of them.)_
- **Output tab — header** — The settlement outcome verbatim as the first word: `built` `clean` `failed` `skipped` `deferred`. Never a synonym. _(`PlanScheduler.Outcome = "built" | "clean" | "failed" | "skipped" | "deferred"`.)_
- **Output tab — clean provenance line** — `served from run r_8c21f0 · event #1447` — the run id is a link, and a `Jump to the run that built this` button sits beside it. The cached value renders below, badged `from cache`. _(`flows.engine.cache-provenance { keyDigest, recordedRunId, recordedEventSeq }` — the module's own words: "A cache hit is otherwise invisible in the journal." Without this line the cache story is a number with nothing behind it.)_
- **Output tab — Effects section** — Three columns: `declared` / `changed` / `deviation`, one row per path, plus `bundleIdentity` and `rebases`. Per-path `Open diff` runs `files.open-diff`. A `hard-violation` renders as a refusal banner above; an `expected-set-deviation` as a warning row. _(`flows.engine.diff-bundle-captured { runId, stepKeyDigest, attempt, bundleIdentity, changedPaths, deviations }`. Declared-vs-actual write set is a table no competitor can draw.)_
- **Output tab — failure** — Typed error: `_tag`, `code`, `message`, `path` (key path only, e.g. `messages[2].content[0].text`, never a value), `retryable` as a word, cause chain nested. _(`ModelError` fields; `path` is documented as "a key path only … never a value". A 12-code union with a computed `retryable` is an exhaustive failure surface.)_
- **Code tab — stratum badge** — One of three, stated at the top of the tab, never implied: `cell` · `flow file` · `digest only`. _(The whole honesty mechanism. See `states` for each one's copy.)_
- **Code tab — call decorations (stratum A)** — Each `ctx.call(...)` in the cell text gets a gutter chip: `#3 proc/spawn · ok · 2m 5s`. Click scrolls the Frames tab to that call. _(Honest because `Cell.CallIdentity { session, frame, cell, ordinal, declaration, layers }` is lexical — re-executing the cell reaches the same call in the same order. This is the one place a line marker tells the truth.)_
- **Code tab — the gap line (stratum B)** — `No line: the engine hashes this node's source and keeps only the digest.` Beside it, a working fallback: `Find "proc/spawn"` (repo search for the Action name). _(`functionIdentity` does `Function.prototype.toString.call(operation)` then returns `{_tag, algorithm, digest}` — the source text is read and discarded. There is no `filename`, `lineno` or `abs_path` anywhere in `plan/` or `flow/`. A mock that draws `flow.ts:42` is lying.)_
- **Code tab — ephemeral warning** — When `algorithm === "sha256-source-ephemeral/v4"`: `Process-local digest — a per-process nonce is folded in.` _(Two processes hashing the same function disagree unless `Graph.build` ran with `callbackIdentity: "stable"`. Without this line every digest in the Key tab is a process-local number.)_
- **Code tab — gestures** — Pointer at rest runs `code.hover <path>:<line>:<col> <repo>`; ⌘/Ctrl-click runs `code.definition`. Diagnostics render under their lines with `✖ ▲ · ·`. _(Already shipping in `apps/app/src/mainview/cards/CodeSurface.tsx` via `CodeFileView` from `@smthrs/ui/adapters/code-view`. The Code tab MUST be that component, not a new one.)_
- **Key tab — the two keys** — `planKey` above `dispatchKey`, both `key1_…`, both copyable, with one word each: plan-time / execution. _(`PlanScheduler.Settlement { nodeId, planKey, dispatchKey, outcome, attempts, rebases }` — they are different keys and the difference is what a cache hit turns on.)_
- **Key tab — material** — The literal `StepKey.content({ body, inputs, layers, capabilities, environment, hermetic })` block, rendered exactly as `apps/app/src/mainview/experimental/panes/Plan.tsx` already draws it. _(Reuse verbatim. A second visual vocabulary for the same fact is a defect.)_
- **Key tab — re-key** — `key1_8f77ac30 → key1_d12e64b9` with `changed: ["input[0]"]` printed as engine labels, never prose. _(`PlanDiff.Rekeyed { id, from, to, changed }`; the doc calls `changed` "a report for a human… deliberately not part of any digest".)_
- **Key tab — consequence block** — `3 re-key · 8 clean · 2 skipped` with the node lists, `4.9s instead of 1h 1m`, and `1 approval voided`. _(D-022: re-keying invalidates the approval bound to the plan digest (`ApprovalTarget = Plan{planId, digest}`). D-032: skipped nodes are NOT cache hits and are counted separately.)_
- **Attempts tab — rows** — `attempt · state · started · finished · duration`, `error_json` expandable under the row. `flows.engine.node-invalidated { from, to, reason: "measured-inputs-changed" }` interleaved in sequence order. _(`flows_attempts` PRIMARY KEY `(run_id, step_key_digest, attempt)`.)_
- **Attempts tab — previous key disclosure** — `3 attempts under the previous key` — collapsed, expands to the old key's rows. _(Attempts are keyed by `step_key_digest`, not node id, so a re-keyed node's history is still reachable. This is a real, free affordance.)_
- **Events tab** — `seq · eventType · payload`, one row per journal record whose `sourceId` starts `node/<id>/`. `[Compact] [JSON]` toggle. _(sourceIds are `node/<id>/<attempt>`, `node/<id>/settled`, `node/<id>/<attempts>/invalidated`, `node/<id>/reconciled/<n>` — one prefix query, no new index. `Compact`/`JSON` are Temporal's words.)_
- **Frames tab — spine** — Per frame, five stages in a fixed rail: `model → cell → realm → calls → transition`. _(`CellTurn.ts` header, verbatim. Anything that draws "model call → tool call → model call" is drawing a different engine.)_
- **Frames tab — rejections** — In-frame rejections are sibling rows, never hidden: `attempt 1 · compile_failed · Unexpected token '}' at line 7`. _(A frame with 3 rejections is 4 model calls. Hiding them undercounts spend, and spend is what this product claims to make legible.)_
- **Frames tab — call ledger** — Columns `#` `flow` `subject` `ok` `digest` `bytes` `mutates`. _(`CallLedger.Entry { ordinal, flow, subject, ok, digest, bytes, mutates, payloadBytes, signature }`, bound 30. It carries no payloads by design: `stdout=4096b`, never the four kilobytes.)_
- **Frames tab — budgets** — One gauge per armed ceiling, consumed against cap: `frames 6 / 100`, `read-only streak 0 / 12`, `calls 11 / 64`, `model call 41m / 5m0s`. _(`flows.harness.discipline-armed.v1` is the positive record — it says what was armed before anything fired, so "armed but never reached" is distinguishable from "never armed".)_
- **Frames tab — brakes** — A brake renders as a marked row at its `nextFrame` with the demand's own first clause, e.g. `read-only demanded · 12 frames made no write`. _(Six named brakes, each its own event, each carrying `nextFrame` so it anchors precisely.)_
- **Frames tab — completion claim** — Last card: `complete 0.94 · overclaims 0.06 · accepted`, with the four facts sent (`task`, `claim`, `treeMoved`, `lastCheck`). _(`completion/claim` thresholds `disprovenAt = 0.3`, `overclaimedAt = 0.8`. It never falls back: an unjudged completion ends the run as `completion_unjudged`.)_
- **Questions tab (jev)** — Per question: id · `type` (`boolean|choice|score`) · instructions · criteria · answer · probability bar · confidence chip · floor marker. _(Confidence chip MUST carry provenance: `0.92 reported` or `1.00 one-hot`. `Classifier.confidence` reads 1.00 when the gateway sent no distribution — a full bar with no label is the single most misleading thing a decision UI can draw.)_
- **Questions tab (jev) — footer facts** — `latency 312ms / 1500ms · in 1,204 tok · out 38 tok · zeroDataRetention true`
- **Questions tab (human)** — The real control, chosen by `kind`: `ask` → text field; `confirm` → Approve / Deny; `select` → radio list from `options`; `json` → editor validated against `schema`. Above it: `attempt 1 of 10`. _(D-023 / THE FORM LAW: `flows_runs.waiting_request` holds `{task, name, kind, prompt, attempt, maxAttempts, options?, schema?}` and `kind` picks the control. Never a JSON box for a `confirm` (that is Trigger.dev's waitpoint failure mode and the reason their human-in-the-loop story is weak).)_
- **Footer — primary** — `Re-run from here…` — the ellipsis is load-bearing: it opens the re-key HUD, it never acts. `Pin output…` also opens a dialog. `Open file` acts now. _(Trigger.dev's convention adopted verbatim: `…` opens a dialog, no `…` acts. Consequential acts confirm (agent-parity rule).)_
- **Footer — overflow ⋯** — `Copy for AI` · `Copy node id` · `Copy step key` · `Jump to the run that built this` · `Download · JSON Lines` _(`Copy for AI` formats the node's evidence for a prompt rather than a file; our trace already feeds agents, so it is nearly free.)_
- **Footer — cancel** — `Cancel run…`, danger styling, key `C`, rendered only while the run is unfinished. Without permission it renders disabled with tooltip `You don't have permission to cancel runs` — never hidden. _(Disabled-with-tooltip over hidden matches the agent-parity rule.)_

### States

- **no selection** — Nothing is rendered. The drawer is absent, not empty — no 420px column of grey. Canvas padding returns to 0.
- **opening (data in flight)** — The drawer opens immediately with a complete header, because the canvas node already carries title, kind, tier, action name, status word and duration. Only the tab body skeletons (3 shimmer rows). No spinner in the header, ever. Acknowledge now, load in the background (AGENTS.md).
- **idle — nothing has run** — Default tab `Declaration`. Status word `idle`; header facts line carries only the prediction when one exists (`~2m 5s p50 · n=14`), and nothing at all when there is no history. Input shows every row as `[evaluated during execution]` except literals. Output shows the declared `successSchema` / `errorSchema` under the header `Not run yet`. Key shows `planKey` only, with `dispatchKey —`. Attempts and Events are absent. Footer: `Re-run from here…` disabled, tooltip `Nothing upstream has settled`.
- **queued** — Status word `queued`. Header facts line: `waiting on 2 upstream`, naming them as links. Tab set unchanged from idle.
- **running** — Status word `running`, `Live` + pulsing dot, 8px marching tiles on the header rail. Default tab `Output` (step) or `Frames` (agent). Output streams the partial value; Frames appends rows. Poll at 3000ms; tighten to 1000ms while this drawer is open; stop entirely when the node settles. New frames append silently; new *nodes* on the canvas need consent (`N new runs` pattern) — a drawer never re-points itself.
- **waiting on you** — Status word `waiting on you`, amber, breathing. `Questions` tab is added and is the default. The body renders the control `kind` names, prefixed `attempt 1 of 10`. Escape hatches present and labelled manual: `Force timeout` and `Skip this wait` under a `⋯`. Chat, canvas and every other tab stay usable — the drawer never traps the user behind the form.
- **retrying** — Status word `retrying`. Header facts line: `attempt 2 of 3 · next in 4.2s`, and for a model step also `re-issue 1 of 1`. Attempts tab appears and is the default. Two ladders are shown as two counters because they are two budgets: inner `MAX_RETRIES = 2` (three attempts, 60s total), outer `defaultModelOverruns = 1`.
- **built** — Status word `built`, green. Default tab `Output`. Facts line carries duration, tokens, cost, attempt. Effects section present when a diff bundle exists.
- **cache hit (clean)** — Status word `cache hit`, the SAME green as built, a distinct glyph, and `0ms` in the facts line. Default tab `Output`, whose first line is `served from run r_8c21f0 · event #1447` beside `Jump to the run that built this`; the value below is badged `from cache`. Attempts and Effects for this run are empty, so instead of two empty tabs the Key tab carries one line — `3 attempts, 2 files · in the run that built this` — linking to the origin. PROPOSED, needs a ruling: showing the origin's evidence means the drawer reads two runs; it is the only way a cache hit is auditable.
- **failed** — Status word `failed`, danger. Default tab `Output`, showing the typed error first: `_tag`, `code`, `message`, `path`, `retryable`, cause chain. Attempts tab present. A single chip beside the error: `What happened here?` — one click, prefilled, into the chat on the left. Footer primary becomes `Re-run from here…`.
- **skipped** — Status word `skipped`, 38% dashed. Default tab `Output`; body is one line: `Not taken · branch chose THEN` with the branch node linked. No value, no attempts, no effects, no events beyond the settlement. Input still renders (the arm's declared inputs are real). Key still renders — a skipped node has a key and will be `clean` next time.
- **deferred** — Status word `deferred`. Output body: `Deferred · runnable, postponed by a scheduling guess. Never a pass.` Distinct from skipped and said so in the one line, because PlanScheduler's own doc makes the distinction.
- **will re-run (dirty)** — Status word `will re-run`, amber dashed. Default tab `Key`. Key shows `key1_8f77ac30 → key1_d12e64b9`, `changed: ["input[0]"]`, the downstream consequence block, and the voided approvals. Output still shows the PREVIOUS settlement, badged `previous run`, so the user sees what they are about to discard. Footer primary: `Re-run from here…` with the count on the button: `Re-run from here · 3 re-run · 8 clean`.
- **trigger — armed** — Reduced tab set: `Schedule` · `Declaration` · `Fires` · `Events`. No Key, no Input, no Output, no Attempts. Schedule tab: `CRON pattern (UTC)` with its live sentence (`Valid pattern: At 08:00 AM, Monday through Friday`), `Timezone`, the DST hint, and `Next 5 runs` in TWO columns when the zone is not UTC. Status word `armed`. Excluded from every plan count.
- **trigger — fired** — Same tab set. `Fires` tab lists the last firings as `Last 5 runs`, each a link. Status word `fired`. A manual re-run of the flow never re-fires it, and the footer says so by simply not offering `Re-run from here…`.
- **permission required** — Status word `waiting on you`. Body renders `PermissionRequired { capability, tier, meta }` as a form — the exact adapter request, never a wildcard — with `allow` / `deny` / `ask` as the three decisions. Same law as HumanTask: the engine specifies the render.
- **quota parked** — Status word `parked`. Body: `Parked until 14:08 · source: reset`. The four sources (`reset` `retry-after` `text` `default`) are shown as a word, because "the provider told us" and "we guessed from a message" are different facts. Never `rate limited, retrying`.
- **Code tab — stratum A (cell)** — Badge `cell`. Header `cell · javascript · f4c1a9…`. Shiki-highlighted cell text through `CodeFileView`. Every `ctx.call` decorated with its ordinal, flow, outcome and duration. This is the only stratum with a truthful line marker.
- **Code tab — stratum B (flow file)** — Badge `flow file`. Header `flows/morning-triage/flow.ts`. Full file, Shiki, diagnostics, hover and go-to-definition — and NO line marker of any kind. Under the header, one line: `No line: the engine hashes this node's source and keeps only the digest.` beside a working `Find "proc/spawn"` button. Breadcrumb `root › then › andThen`. Footer `Open file` escalates to the full `file` card.
- **Code tab — stratum C (digest only)** — Badge `digest only`. Two facts and one sentence: `algorithm sha256-source-captures/v4`, `digest 0f31c8…7a42`, and `The source is not persisted.` When the algorithm is `sha256-source-ephemeral/v4`, a second line: `Process-local digest — a per-process nonce is folded in.` No file list, no guess, no placeholder editor.
- **Code tab — markdown flow** — Badge `flow file`. For `flow.mdx` the whole body IS the prompt, so the tab is complete: frontmatter rendered as facts (`name, description, model, flows, capabilities, effects, placement`) and the markdown body below. The gap line is absent, because there is no gap.
- **Input tab — empty** — Header `No inputs`. One line: `This node consumes nothing declared.` (a root node). Not a blank panel, not a table with zero rows.
- **Events tab — projection missing** — One line: `The gateway does not project plan nodes yet.` No button, no retry, no explanation of the roadmap. (This is the live state today: none of the seven served projections carries plan node ids. D-020.)
- **Output tab — value too large** — `Value is 4.2 MB. Showing the first 64 KB.` plus `Download · JSON Lines`. The stream budgets are real (`defaultMaxRecordBytes` 4 MiB, `defaultMaxResponseBytes` 64 MiB) and a truncation is stated, never silent.
- **maximized (full)** — Identical content, three columns, plan rail on the left with the selected node marked `▸`, facts column on the right. The live state word stays in the header so a user in full screen never loses the run the canvas was following. Escape returns to drawer at the same tab and scroll.
- **narrow (<520px viewport)** — The drawer becomes a bottom sheet at 70vh with the same tab strip; `full` is the only other presentation. 16px side gutters, no horizontal page scroll.

### Data shape

```ts
// Every type below is real and exported today. Nothing here is invented except
// the three fields marked PROPOSED, which are named as proposals in the UI too.

import type * as Plan from "@smthrs/plan/Plan"              // PlanNode, NodeKind
import type * as KeyMaterial from "@smthrs/plan/KeyMaterial" // KeyMaterial, InputRef
import type * as StepKey from "@smthrs/plan/StepKey"         // ContentIdentity
import type * as PlanDiff from "@smthrs/plan/PlanDiff"       // Rekeyed, PlanDiff
import type * as PlanScheduler from "@smthrs/engine-store/PlanScheduler" // Outcome, Settlement, ResolvedInput
import type * as Action from "@smthrs/flow/Action"           // Action, Tier
import type * as HumanTask from "@smthrs/flow/HumanTask"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"            // Source, CallIdentity, CallFailureCode, RejectionCode
import type * as CallLedger from "@smthrs/harness/CallLedger" // Entry
import type * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as ModelError from "@smthrs/model/ModelError"
import type * as Seat from "@smthrs/agent/Seat"

/** Which tab is showing. `frames` only for agent, `questions` for jev|human. */
export type InspectorTab =
  | "input" | "declaration" | "output" | "frames" | "questions"
  | "code" | "key" | "attempts" | "events"
  | "schedule" | "fires"   // trigger only

export type Presentation = "drawer" | "full"

/** The canvas's own state word. Superset of PlanScheduler.Outcome. */
export type NodeUiState =
  | "idle" | "queued" | "running" | "waiting" | "retrying"
  | PlanScheduler.Outcome            // "built" | "clean" | "failed" | "skipped" | "deferred"
  | "dirty"
  | "armed" | "fired"                // trigger only (D-031)

export interface NodeInspectorModel {
  readonly presentation: Presentation
  readonly tab: InspectorTab
  readonly state: NodeUiState

  /** The plan row. `kind` is "step" | "agent" | "merge"; `material` carries the InputRefs. */
  readonly node: Plan.PlanNode
  /** Present once the node has settled in this run. */
  readonly settlement: PlanScheduler.Settlement | undefined
  /** The declaration this node compiled from. */
  readonly action: Pick<
    Action.AnyWithProps,
    "name" | "tier" | "successSchema" | "errorSchema"
  > & {
    readonly implementationVersion: string | undefined
    readonly idempotencyKey: string | undefined
    readonly nondeterministic: true | undefined
    readonly fileBoundary: Action.Any["fileBoundary"]
    readonly retryPolicy: Action.Any["retryPolicy"]
  }

  // ── Input tab ──────────────────────────────────────────────────────────
  readonly inputs: ReadonlyArray<{
    /** Declaration order; index is what PlanDiff.changed calls `input[n]`. */
    readonly index: number
    readonly field: string
    readonly type: string                       // rendered from the Effect Schema
    readonly ref: KeyMaterial.InputRef          // Literal | Ref | Pending
    /** Absent for Pending (never projected) and before the producer settles. */
    readonly resolved: PlanScheduler.ResolvedInput | undefined
  }>

  // ── Key tab ────────────────────────────────────────────────────────────
  readonly key: {
    readonly planKey: string                    // key1_…
    readonly dispatchKey: string | undefined    // absent before dispatch
    readonly material: StepKey.ContentIdentity
    /** The whole-plan verdict; this node's entry is rekeyed.find(r => r.id === node.id). */
    readonly diff: PlanDiff.PlanDiff | undefined
    readonly rekeyed: PlanDiff.Rekeyed | undefined
    /** flows.engine.cache-provenance, present only when outcome === "clean". */
    readonly provenance: {
      readonly keyDigest: string
      readonly recordedRunId: string
      readonly recordedEventSeq: number
    } | undefined
    readonly downstream: {
      readonly rekeys: ReadonlyArray<string>
      readonly clean: ReadonlyArray<string>
      readonly skipped: ReadonlyArray<string>
      readonly voidedApprovals: number          // D-022
      readonly estimateMs: number
      readonly previousMs: number
    } | undefined
  }

  // ── Code tab ───────────────────────────────────────────────────────────
  readonly code:
    | { readonly stratum: "cell"; readonly source: Cell.Source
        readonly calls: ReadonlyArray<Cell.CallIdentity & { readonly ok: boolean; readonly ms: number }> }
    | { readonly stratum: "flow-file"; readonly path: string; readonly contents: string
        readonly astPath: ReadonlyArray<string>   // ["root","then","andThen"]
        /** PROPOSED — side table flows_plan_node_sources(plan_id, node_id, …). Never in KeyMaterial. */
        readonly source?: { readonly path: string; readonly line: number; readonly label: string } }
    | { readonly stratum: "digest"
        readonly algorithm: "sha256-source-captures/v4" | "sha256-source-ephemeral/v4"
        readonly digest: string }

  // ── Output tab ─────────────────────────────────────────────────────────
  readonly output: {
    readonly outcome: PlanScheduler.Outcome | undefined
    /** TODAY node-output serves a rendered string, not JSON. See risks. */
    readonly value: unknown
    readonly error: ModelError.ModelError | { readonly _tag: string; readonly message: string } | undefined
    readonly files: {
      readonly bundleIdentity: string
      readonly declared: ReadonlyArray<string>
      readonly changedPaths: ReadonlyArray<string>
      readonly deviations: ReadonlyArray<string>
      readonly rebases: number
    } | undefined
  }

  // ── Attempts tab ───────────────────────────────────────────────────────
  readonly attempts: ReadonlyArray<{
    readonly stepKeyDigest: string              // PK is (run_id, step_key_digest, attempt)
    readonly attempt: number
    readonly state: string                      // durable identifier: "running" | "succeeded" | "failed"
    readonly startedAtMs: number
    readonly finishedAtMs: number | undefined
    readonly error: unknown
  }>

  // ── Events tab ─────────────────────────────────────────────────────────
  /** Every journal record whose sourceId starts `node/<id>/`. */
  readonly events: ReadonlyArray<{
    readonly seq: number
    readonly eventType: string                  // "flows.engine.node-settled" | …
    readonly sourceId: string
    readonly payload: unknown
  }>

  // ── Frames tab (kind === "agent") ──────────────────────────────────────
  readonly frames: ReadonlyArray<{
    readonly ordinal: number
    readonly cell: Cell.Source | undefined
    readonly rejections: ReadonlyArray<{ readonly attempt: number; readonly code: Cell.RejectionCode; readonly message: string }>
    readonly calls: ReadonlyArray<CallLedger.Entry>
    readonly events: ReadonlyArray<AgentEvent.AgentEvent>
    readonly transition: "continue" | "complete" | "park" | undefined
  }> | undefined
  readonly discipline: AgentEvent.DisciplineArmed | undefined
  readonly seat: { readonly declared: string; readonly resolved: Seat.Seat | undefined } | undefined

  // ── Questions tab (jev | human) ────────────────────────────────────────
  readonly jev: {
    readonly classifierId: string               // "triage/relevance"
    readonly digest: string                     // sha256 of canonical { id, questions }
    readonly questions: ReadonlyArray<Evaluator.Question>
    readonly answers: ReadonlyArray<Classifier.Answer>
    /** "reported" = provider distribution; "one-hot" = Classifier.confidence fallback reading 1.00. */
    readonly confidence: ReadonlyArray<{ readonly id: string; readonly value: number; readonly provenance: "reported" | "one-hot" }>
    readonly floor: number
    readonly latencyMs: number
    readonly error: Evaluator.EvaluatorError | undefined
  } | undefined
  readonly humanTask: HumanTask.Question | undefined  // { task, name, kind, prompt, attempt, maxAttempts, options?, schema? }
}
```

### Interactions

- Click a canvas node → drawer opens at the state-chosen default tab. Second click on the same node → drawer closes (toggle). `Enter` on a keyboard-selected node does the same (n8n muscle memory).
- Default tab rule, three lines and no more: nothing has settled → `Declaration`; it has settled → `Output`; it is dirty → `Key`. A per-node tab chosen this session overrides the rule; a `tab=` URL param overrides both.
- `i d o f q c k a e` jump to Input / Declaration / Output / Frames / Questions / Code / Key / Attempts / Events. Single key, no modifier, suppressed while focus is in a field or editor.
- `[` / `]` walk to the previous / next node in topological order, respecting the canvas's current filter. The tab and scroll position are preserved, so you can walk eight nodes comparing their Key tabs.
- `m` maximizes and restores. `Escape` in full returns to drawer; `Escape` in drawer closes; `Escape` inside an open dialog closes only the dialog.
- `y` copies a permalink to `?node=<id>&tab=<tab>&view=<presentation>`. `Shift+Y` copies the node id alone.
- `r` opens `Re-run from here…` — the re-key HUD, with the counts on its submit button. It never runs on the keystroke. `p` opens `Pin output…`. `C` opens `Cancel run…`.
- `j` runs `Jump to the run that built this` when the node is `clean`; the button is absent otherwise.
- Click an Input row → selects the producing node on the canvas and moves the camera to it, keeping this drawer open on the same tab. `Shift+Click` instead re-points the drawer at that node's Output tab. One gesture moves code position and data together (DevTools' call-stack rule).
- Click a `ctx.call` gutter chip in the Code tab → the Frames tab opens scrolled to that call. Click a call row in Frames → the Code tab opens with that call's line marked. The round trip is symmetric.
- Hover a token in the Code tab → runs `code.hover <path>:<line>:<col> <repo>`. ⌘/Ctrl-click → `code.definition`. Both are existing command bindings; the drawer adds no bespoke handler.
- `Open file` escalates the Code tab to the full `file` card — VS Code's peek → editor rung. The drawer stays open behind it.
- Drag the drawer's left edge to resize 360–720px; double-click the edge resets to 420. Width persists per workspace.
- Drag an upstream node's schema field onto an Input row → PROPOSED, and it must route through the re-key HUD before it commits, because authoring a `Planned` reference re-keys the target and everything downstream and voids approvals (D-022). A drag is a consequential edit, not a gesture. Until D-003 closes, the mock shows the HUD and the drag does not land.
- Filter field (`/` focuses): filters Input rows, Output fields, Events rows and Frames calls by substring. Shows `3 of 47` when filtering; `No matching fields` when none.
- Liveness: poll 3000ms while the run is active, 1000ms while this drawer is open on a running node, stop entirely on settle. Statuses of things already on screen patch in place; nothing re-points the drawer or changes the selected tab without the user.
- Copy affordances everywhere an identifier appears: node id, AST path segment, `planKey`, `dispatchKey`, `bundleIdentity`, `recordedRunId`, cell digest. Click-to-copy with a 1.2s `Copied` acknowledgement, no toast.
- Every blocked act names its own reason rather than greying out silently: `Nothing upstream has settled`, `A previous node has not run`, `The run is already running`, `You don't have permission to cancel runs`.

### Sample content

═══ EXAMPLE A — AGENT NODE ═══════════════════════════════════════════════
Flow `morning-triage` · repo `tevm/tevm-monorepo` · run `r_e41d77`

HEADER
  ⬢  Write the failing test                                    ⤢   ×
  root › then › andThen · coding/edit-atom
  compensable · agent · coding/implement · claude-opus-5 · ● built
  41m 12s · 612,400 tokens · $8.06 · attempt 1 · 18 frames

TABS  Input  Declaration  Output  Frames  Code  Key  Events

── Input (Table) ─── 2 inputs · 2 keyed · 0 ordering ─────────────────────
  atom      AtomicPlan   Ref      ← repro.plan     { files: ["packages/state/test/StateManager.cache.test.ts"], intent: "assert cache eviction on reorg" }
  parent    Revision     Ref      ← change         "zzqxvmpn 4f19c0a3"

── Declaration ─── 13 fields · 8 keyed · 5 free ──────────────────────────
  keyed  tier                 compensable
  keyed  body                 sha256-source-captures/v4 · 0f31c8…7a42
  keyed  inputs               2 refs
  keyed  layers               NodeFileSystem, @smthrs/harness, @smthrs/jj
  keyed  capabilities         fs ["packages/state/**"], model:call
  keyed  effects              reads ** · writes packages/state/** · expected · serialize
  keyed  placement            sandbox
  keyed  nondeterministic     —
  free   name                 coding/edit-atom
  free   title                Write the failing test
  free   priority             1000
  free   lane                 1
  free   annotations          2
  seat coding/implement → claude-opus-5 · 1,000,000 ctx · route anthropic · protocol anthropic-messages
  maxFrames 100 · corrections 1 · modelCallMs 300000

── Frames ─── 18 frames · 1 rejection · 1 compaction ─────────────────────
  frame 1   model → cell → realm → 2 calls → continue          1m 04s
  frame 2   attempt 1 · compile_failed · Unexpected token '}' (line 7)
            model → cell → realm → 3 calls → continue          2m 18s
  …
  frame 12  compaction-settled · prefix replaced · 9 messages retained
  frame 18  model → cell → realm → 3 calls → complete          3m 41s

  frame 18 · cell · javascript · f4c1a9…
    const edit = await ctx.call("files/edit", {
      path: "packages/state/test/StateManager.cache.test.ts",
      contents: draft
    })
    const after = await ctx.call("proc/spawn", { command: "bun test --filter @tevm/state" })
    const before = await ctx.call("proc/spawn", { command: "bun test --filter @tevm/state", cwd: ctx.base })
    if (before.exitCode !== 0 && after.exitCode === 0) {
      ctx.done({ files: [edit.path], proof: after.stdout })
    }

  ledger        #   flow          subject                              ok  bytes   mutates
                1   files/edit    …/StateManager.cache.test.ts         ✓   2,914   yes
                2   proc/spawn    bun test --filter @tevm/state        ✓   4,096   no
                3   proc/spawn    bun test --filter @tevm/state (base) ✓   3,771   no

  budgets       frames 18 / 100      read-only streak 0 / 12
                calls 41 / 64        model call 3m41s / 5m00s

  completion    complete 0.94 · overclaims 0.06 · accepted
                task · claim · treeMoved true · lastCheck exit 0

── Output ─── built ──────────────────────────────────────────────────────
  EditReport { files: ["packages/state/test/StateManager.cache.test.ts"],
               added: 41, removed: 0, proof: "1 pass, 0 fail" }
  Effects   declared packages/state/**   changed 1   deviation 0
            packages/state/test/StateManager.cache.test.ts     Open diff
            bundleIdentity bundle_7f0c21 · rebases 0

── Code ─── cell ─────────────────────────────────────────────────────────
  cell · javascript · f4c1a9…   (frame 18 of 18 · ← → walks frames)
  [the cell above, Shiki-highlighted, each ctx.call gutter-chipped:
    #1 files/edit · ok · 0.4s   #2 proc/spawn · ok · 2m 05s   #3 proc/spawn · ok · 1m 12s]

── Key ───────────────────────────────────────────────────────────────────
  planKey      key1_5c8b1f22      plan-time
  dispatchKey  key1_5c8b1f22      execution
  StepKey.content({
    body: { version: "flows/key-material/v2", declaration: { action: "coding/edit-atom" } },
    inputs: { "0": { kind: "digest", digest: "key1_2d6e8f05", reference: "ref" },
              "1": { kind: "digest", digest: "key1_9e40b5a7", reference: "ref" } },
    layers: ["NodeFileSystem", "@smthrs/harness", "@smthrs/jj"],
    capabilities: { declared: { fs: ["packages/state/**"], model: ["call"] } },
    hermetic: { readSet: [], writeSet: [{ _tag: "Glob", include: ["packages/state/**"] }],
                boundaryMode: "expected" }
  })
  Unchanged. Nothing this node consumes moved.

══ EXAMPLE B — PLAIN ACTION NODE ═════════════════════════════════════════

HEADER
  ▣  bun test                                                  ⤢   ×
  root › then › andThen › map · proc/spawn
  compensable · step · ● built
  2m 05s · attempt 2 of 3

TABS  Input  Declaration  Output  Code  Key  Attempts  Events

── Input (Table) ─── 2 inputs · 1 keyed · 1 ordering ─────────────────────
  command   NonEmptyString   Literal   —                "bun test --filter @tevm/state"
  cwd       Path             Ref       ← repro.workspace "/w/tevm-4f19c0a3"
  repro                      Pending   ← repro           —   ordering only · not part of the key

── Declaration ─── 11 fields · 7 keyed · 4 free ──────────────────────────
  keyed  tier            compensable
  keyed  effects         proc:spawn:* · expected · onConflict serialize
  keyed  capabilities    process ["bun"]
  keyed  placement       sandbox
  free   retryPolicy     3 attempts · 200ms × 1.5 · max 30s
  free   name            proc/spawn
  successSchema  CommandResult { exitCode: Int, stdout: String, stderr: String, durationMs: Int }
  errorSchema    SpawnError

── Output ─── built ──────────────────────────────────────────────────────
  CommandResult { exitCode: 0, durationMs: 124_918,
                  stdout: "212 pass  0 fail  1 skip", stderr: "" }

── Attempts ──────────────────────────────────────────────────────────────
  2   succeeded   08:19:44   08:21:49   2m 05s
  1   failed      08:19:12   08:19:44   32s
      SpawnError { exitCode: 1, message: "error: Cannot find module '@tevm/state/dist'" }

── Code ─── flow file ────────────────────────────────────────────────────
  flows/morning-triage/flow.ts                                  Open file
  No line: the engine hashes this node's source and keeps only the digest.
                                                      Find "proc/spawn"
  root › then › andThen › map
  [the whole file, Shiki, diagnostics under their lines, hover + ⌘-click live,
   no marked line anywhere]

── Key ───────────────────────────────────────────────────────────────────
  planKey      key1_ff21a80c      dispatchKey  key1_ff21a80c
  Unchanged. Nothing this node consumes moved.

══ EXAMPLE C — THE SAME DRAWER ON THE RE-KEYED JEV NODE (act 3) ══════════

HEADER
  ◈  AI checks                                                 ⤢   ×
  root › then › andThen › andThen · repository/jev-semantic-check
  sealed · jev · typesafe-ai/jev · ◐ will re-run
  previous run 1.2s

TABS  Input  Declaration  Output  Questions  Code  Key  Events   → default Key

── Key ───────────────────────────────────────────────────────────────────
  key1_8f77ac30  →  key1_d12e64b9
  changed: ["input[0]"]
  input[0] is `rules` ← wiki.conventions

  Downstream          3 re-key    checks, pr, notify
                      8 clean     issues, triage, branch, repro, test, approve, change, writetest
                      2 skipped   defer, bundle
                      4.9s instead of 1h 1m
                      1 approval voided — the plan digest changed

  Re-run from here · 3 re-run · 8 clean                         [primary]

── Questions ─── previous run ────────────────────────────────────────────
  triage/relevance · digest 2c81f0…  · floor 0.60 · 312ms / 1500ms
  relevant     boolean   true    0.92 reported
  role         choice    fixture 0.88 reported
  risk         score     low     1.00 one-hot          ← no distribution sent
  in 1,204 tok · out 38 tok · zeroDataRetention true

### Risks

- `NodeOutputRow.output` is `Schema.String`, not JSON. The Output tab's `[Schema][Table][JSON]` toggle is therefore fake for every non-agent node until `node-output` carries a JSON field. Either the mock draws the honest version (one string, no toggle) for step nodes, or the projection changes. Do not ship a toggle over a rendered string.
- No projection serves plan nodes. `workspace-runs, run-summary, run-events, transcript, run-tree, approvals, node-output` carry no plan node ids or edges, and `RunTreeRow.nodeId` is "the ordinal the call opened on". Every tab except Code is blocked on D-020. The drawer must have an honest empty state for this and the mock must not imply the data is one fetch away.
- Two node namespaces. The drawer addresses plan node ids (`root.then.andThen`); `transcript` and `run-tree` address call ordinals (`bash#2`, `result`). Joining them silently would be wrong in exactly the way `NodeOutput.ts`'s own comment warns about. Until the join exists, the Events tab queries `sourceId LIKE 'node/<id>/%'` only, and the Frames tab reads harness events, and the drawer never claims they are the same object.
- `sha256-source-ephemeral/v4` folds a per-process nonce, so a node's identity differs between processes unless `Graph.build` ran with `callbackIdentity: "stable"`. If the app's plan projection does not pass it, every digest the Key tab prints is process-local and the whole re-key story dies on a restart. Verify before the Key tab ships a digest.
- Edge reason is not persisted: `flows_plan_edges` is three columns (`plan_id, from_node, to_node`). The Input tab is safe because `Ref`/`Pending` comes from `KeyMaterial.inputs` inside `node_json`, but the canvas's `THEN`/`ELSE`/`CATCH` labels are not recoverable from the store. Either a fourth column, or the client re-runs `Graph.build`.
- A `clean` node has no attempts and no files of its own. Showing the ORIGINATING run's evidence (via `cache-provenance.recordedRunId`) is the only way a cache hit is auditable, but it means one drawer reads two runs. Unruled. If it is refused, the Key tab's one-line link is the fallback and the Attempts/Effects tabs simply stay absent.
- Nine tabs is at the edge of MINIMAL TEXT even with three of them evidence-gated. If in practice a step node shows six tabs of which three are one line each, collapse to five: Input · Declaration · Output · Code · Key, with Attempts and Events as sections inside Output and Key.
- `RunTrace.ts` folds `control.agent.model-settled` keeping only `inputTokens`/`outputTokens`, discarding `reasoningTokens`, `cachedInputTokens`, `cacheWriteTokens`, `totalTokens`, the seat, the params and the context digest. Cache-read and cache-write tokens are precisely the two numbers that make the content-addressed pitch legible in an agent node, and today's shipped card throws them away. Widening it is a change to a shipped card, not a mock.
- Maximizing suspends D-024: the canvas is hidden, so the camera no longer follows the run and a user in full screen can lose the live node. Mitigated by keeping the live state word and the plan rail in the header, but it is a real conflict between two rulings and should be watched in the demo.
- The drag-to-author gesture (n8n's best idea) is a consequential edit in our engine: it re-keys the target and its whole suffix and voids approvals. D-003 and D-028 are both open, so the mock can only show the consequence. If the builder ships before D-003 closes, this drawer grows an edit affordance with no defined commit semantics.
- `PlanScheduler` carries a `conflicted` outcome on a neighbouring record type while `Outcome` itself is the five words. Confirm which surface a `conflicted` node reaches before drawing a sixth state word.
- This spec keeps the mock as a standalone vite bundle while `apps/app/src/mainview/experimental/` is growing 31 panes (Models, CellLoop, Decisions, Plan) with their own `Primitives.tsx`. The two will diverge unless the drawer borrows their vocabulary now — same section/facts/table/code shapes, same real field names — so that promotion into `experimental/panes/` is a port rather than a redesign. Vocabulary collision already exists: the harness's `Seat.Seat` and the app's `AgentRole` are both called "seat".

## The flow library / example switcher — a popover anchored to the canvas's flow-name pill, plus four new demo flows drawn from `@smthrs/patterns`

Clicking the flow name in the canvas's top-left pill (or pressing `L`) drops a 420px popover *inside the canvas pane* listing every demo flow as a row of shape-thumbnail · id · pattern label · node count · tier bar · kind glyphs, filtered by `All / Primitives / Composites / Use cases`; picking one swaps the canvas, the dagre layout and the transport script in a 180 ms cross-fade without ever leaving the embedded pane.

### Layout

```
PLACEMENT — THE EMBED LAW holds. The library is a `<Panel position="top-left">` child of the
existing ReactFlow instance. It never leaves the canvas pane, never dims chat, never
goes full-screen. The scrim is `inset: 0` on `.pane-canvas` only (rgba surface @ 38%),
so chat, the rail, the topbar and the transport stay fully lit and clickable.

At 1440×900 the canvas pane is ~900 × 780 (`.split` = `minmax(340px,35fr) 65fr`, rail 52px,
topbar 52px, transport 56px). At 1280×800 it is ~780 × 640. **640px is the viewport floor
every layout rule below is sized against.**

CLOSED (today's pill, one word added and a chevron):

  ┌─ .pane-canvas ────────────────────────────────────────────────────┐
  │ ╭──────────────────────────────────────╮                          │
  │ │ morning-triage ⌄ │ key1_9f3c2ab7e015 │ running │   ← .fl-panel  │
  │ ╰──────────────────────────────────────╯                          │
  │                                                                   │
  │        [trigger]──▶[issues]──▶[triage]──▶◆──▶[repro]──▶ …         │
  └───────────────────────────────────────────────────────────────────┘

OPEN (popover hangs from the pill's left edge, 10px below it):

  ┌─ .pane-canvas ────────────────────────────────────────────────────┐
  │ ╭──────────────────────────────────────╮                          │
  │ │ morning-triage ⌃ │ key1_9f3c… │ run  │                          │
  │ ╰──────────────────────────────────────╯                          │
  │ ┌── .fl-library ── 420 × min(520, 62% of pane) ──┐                │
  │ │ ⌕ Search flows…                          36px  │                │
  │ ├────────────────────────────────────────────────┤                │
  │ │ (All 5)(Primitives 2)(Composites 2)(Use cases 1)│  28px         │
  │ ├────────────────────────────────────────────────┤                │
  │ │▌▤▤▤▤  morning-triage             use case │ 76px row           │
  │ │▌▤▤▤▤  Flow.make                            │                    │
  │ │▌      13 ▰▰▰▱ 🔒3   ◈2 ◇2 ☻1               │                    │
  │ ├────────────────────────────────────────────────┤                │
  │ │ ▤▤▤▤  package-migration         composite │                    │
  │ │ ▤▤▤▤  mapReduce(concurrency=4, onEmpty=…)  │                    │
  │ │       11 ▰▰▱▱        ◈8                    │                    │
  │ ├────────────────────────────────────────────────┤                │
  │ │ … 3 more rows, scrolls at 5+                   │                │
  │ └────────────────────────────────────────────────┘                │
  │        (canvas visible, dimmed 38%, behind and right)              │
  └───────────────────────────────────────────────────────────────────┘

ROW INTERNALS (420 − 2×14 padding = 392 usable):

  ┌ 104 ┬──────────────── 240 ────────────────┬──── 48 ────┐
  │     │ morning-triage                      │  use case  │  line 1  15px
  │ SVG │ Flow.make                           │            │  line 2  13px mono
  │ 40h │ 13 ▰▰▰▱ 🔒3   ◈2 ◇2 ☻1              │            │  line 3  14px
  └─────┴─────────────────────────────────────┴────────────┘
  2px left accent bar appears on the selected row only.

DAGRE (replaces the block in `Canvas.tsx`, one graph config + per-node geometry):

  graph.setGraph({
    rankdir: "LR",
    ranksep: 96,      // was 86; +10 buys THEN/ELSE/CATCH labels a clear run
    nodesep: 18,      // was 26; the extra breathing room moves into per-node height
    edgesep: 14,      // new; keeps a 4-wide fan-in from bundling into one line
    marginx: 56,
    marginy: 56,
    ranker: "network-simplex"
    // no acyclicer: a Plan is already a DAG (plan/src/Node.ts), never break cycles
  })

  const GEOM = {
    full:    { width: 228, renderH: 80, pad: 8 },  // setNode height 88 → 26px visual gap
    compact: { width: 228, renderH: 52, pad: 0 },  // setNode height 52 → 18px visual gap
    merge:   { width:  16, renderH: 88, pad: 8 }   // a join BAR, not a card
  }
  graph.setNode(id, { width: g.width, height: g.renderH + g.pad })

  Encoding the gap in the declared height is the whole trick: one `nodesep` gives two
  different separations because a full node declares 8px of padding and a compact
  member declares none.

PASS 2 — merge-bar stretch (no re-layout, runs on the laid-out positions):

  for (const id of mergeIds) {
    if (rankMembers(rankOf(id)).length !== 1) continue   // shares a rank → stay 88 tall
    const preds = incoming(id)
    const top    = Math.min(...preds.map(p => pos[p].y))
    const bottom = Math.max(...preds.map(p => pos[p].y + renderH[p]))
    render[id] = { x: pos[id].x, y: top, width: 16, height: bottom - top }
  }

  The bar's caption (`Node.all`, member count, settlement word) floats in a chip 8px to
  its right, vertically centred, `pointer-events: none`; the bar is the click target.
  Why this is the fan-out answer: four fan-in edges land along 430px of bar instead of
  converging on one 15px handle, so no two overlap — and a merge rank costs 16px of
  width instead of 228, which takes ~424px out of `package-migration`'s total.

COMPACT + FOLD (the only two rules a wide rank needs):

  compact   when rank member count ≥ 5. Drops the mono `Action` tag line ONLY.
            Keeps glyph · title · status dot · state word · duration, so D-026
            (colour is never the only signal) still holds on every member.
  fold      when rank member count > 8. First 6 render compact; the rest collapse
            into one 228×52 stack card reading `+6 more` with a 6-dot status strip.
            Clicking it expands the rank in place and the camera re-frames the rank.
            Honest, because a `Node.all` with 12 members IS one join.

RANK-HEIGHT GUARANTEE (this is why the camera never breaks D-024):

  4 full    = 4×88 + 3×26 = 430 graph px → 404 screen px at 0.94   ✓ fits 640
  8 compact = 8×52 + 7×18 = 542 graph px → 510 screen px at 0.94   ✓ fits 640
  A BOUNDED fan-out cannot exceed `concurrency` anyway: `Bounded.all` splits into
  ceil(n/c) batches, each its own `Node.all`, batches sequenced (Bounded.ts:123-142).
  So `mapReduce(concurrency=4)` over 8 shards draws two 4-wide ranks, never an 8-wide
  one, and the picture IS the concurrency bound — which n8n cannot draw at all.

CAMERA — `cameraFor` gains one mode:

  type Camera =
    | { mode: "fit" }
    | { mode: "follow"; id: string }
    | { mode: "frame";  ids: readonly string[] }     // NEW

  frame   wins whenever ≥2 nodes are simultaneously running | waiting | retrying |
          parked. `flow.fitBounds(union(rects(ids)).inflate(48), {padding: 0.10,
          duration: 620})`. Clamp ladder: if the resulting zoom < 0.62, re-frame on the
          batch alone (the active members' shared `All` join + its members); if still
          < 0.62, clamp to 0.62 and centre on the union's centroid.
  fit     used only when the whole graph fits at ≥ 0.62; otherwise it falls through to
          `frame` over every non-hidden node. `fitViewOptions` gains `minZoom: 0.62`.
  follow  unchanged, including the 120px lead at ≥0.9 so successors stay visible.

  Fixed zoom ladder, never interpolated: 0.94 follow · 0.78 frame a batch ·
  0.62 frame the cached/dirty boundary. Never below 0.62 (D-024).
  `1` = fit, `0` = reset to 0.94 on the cursor node (n8n's muscle memory).
```

### Anatomy

- **Trigger — the flow-name pill (`.fl-panel-name` becomes a `<button>`)** — morning-triage ⌄ _(The chevron is the only added glyph. No word "Library", no "Switch flow" label — NO INVENTION. `aria-haspopup="listbox"`, `aria-expanded`. The chevron does NOT render when the library holds one flow. THREE-DOOR LAW: button (this pill), keyboard (`L`), agent/slash (`/flow.open <id>`).)_
- **Popover container** — (no title, no header text) _(`role="listbox"`, `aria-label="Flows"`. 420 × min(520px, 62% of pane height). `--surface-glass-strong` + `blur(14px)` + `--shadow-2`, `--r-3`. Anchored to the pill's left edge, 10px below. Never a portal to `document.body` — a child of the ReactFlow `<Panel>` so it cannot escape the pane.)_
- **Search field** — Search flows… _(Placeholder only; no label. `aria-label="Search flows"`. Autofocused on open. Matches the flow id, the pattern label, and every node's `Action` tag — so typing `npm/publish` finds `publish-release`. `/` refocuses it; Escape with text clears the text, Escape empty closes the popover.)_
- **Filter chips** — All 5 · Primitives 2 · Composites 2 · Use cases 1 _(Four buttons, `role="group" aria-label="Filter by class"`, `aria-pressed`. `All` is `.active` on open. Internal filter keys are the retired field guide's verbatim: `all | primitive | composite | recipe`; `recipe` displays as `use cases`. A chip whose count is 0 DOES NOT RENDER (MINIMAL TEXT: no row whose value is nothing). The counts replace the guide's `— patterns in view` sentence.)_
- **Row · shape thumbnail** — inline SVG, 104 × 40, viewBox `0 0 104 40` _(Columns evenly spaced x=8→96; row bands ys(1)=[20], ys(2)=[13,27], ys(3)=[9,20,31], ys(4)=[7,15.6,24.3,33]. A step/agent node is a 7×7 rect rx 2; a merge is a 2×12 vertical bar; edges are 0.75px quadratic béziers at `--border-strong` 55%, failure edges `4 3` dashed. Fill is the node's LAST-RUN settlement outcome: built `--success`, clean `--success` @ 40%, skipped `--text-faint` @ 38%, failed `--danger`, never-run `--border-strong`. Ported from the retired guide's 40-line diagram DSL (`docs/orchestration-patterns.html`, `{c:[column…], loop:[from,to,label]?}`) with its invented agent/action/decision/data/human palette REPLACED by the real outcome ramp. Not a minimap (D-025): 104px of identity, never navigation, never live.)_
- **Row · flow id** — morning-triage · package-migration · implement-issue · publish-release · repair-red-test _(12.5px/600. The id, never a prose title — D-001, and it is the string `/flow.open` takes.)_
- **Row · class chip** — use case | primitive | composite _(Right-aligned, 10.5px, `--r-full`, `--surface-2`. `primitive` = one `@smthrs/patterns` constructor drawn bare. `composite` = several patterns or hand-written Actions composed. `use case` = a real repository job. Displayed word for the `recipe` key is `use case`, exactly as the retired guide did it.)_
- **Row · pattern label** — Flow.make | mapReduce(concurrency=4, onEmpty=reduce) | reviewLoop(maxRounds=3) | saga(steps=reserve-version,publish-npm,push-tag,deploy-docs, onFailure=compensate) | escalation(rungs=3, fallback=true) _(10.5px mono, `--text-faint`, one line, ellipsised. These are the literal strings `Compose.label(kind, fields, options)` mints (`internal/Compose.ts:397`), so the row carries the DECLARED BOUND — the whole point of a declared plan — instead of a prose summary. A hand-written flow reads `Flow.make`.)_
- **Row · node count** — 13 · 11 · 13 · 12 · 14 _(A bare number + the node glyph. PLAN nodes only: the trigger is excluded because a trigger is a Dispatcher registration with no step key (D-031), and merge bars ARE counted because they are real `All`/`Succeed` plan nodes.)_
- **Row · tier bar** — ▰▰▰▱ (a 56 × 4px three-segment bar) _(Proportional segments, left to right: sealed `--text-faint`, compensable `--info`, irreversible `--warning`. `title` gives the three counts. A picture, not a sentence — MINIMAL TEXT.)_
- **Row · irreversible mark** — 🔒3 (the `IconLock` glyph + count) _(Renders ONLY when the count is > 0. `--warning`. This is the one thing worth a number beside the bar because it is the safety fact.)_
- **Row · kind glyphs** — ◈2  ◇2  ☻1 _(The existing `KIND_ICON` glyphs from `Icons.tsx` + a count, one per non-default kind present: agent, jev, human, branch. `action` and `merge` are the default and carry NO chip. Glyph+count, never the word.)_
- **Row · selected state** — (no copy) _(2px `--brand` left accent, `--surface-2` background, `aria-selected="true"`. Exactly one row is selected at all times — the flow on the canvas.)_
- **Empty state** — No flows match that search. _(One line, centred, `--text-faint`, 14.5px. Verbatim from the retired guide (`No patterns match that search.`) re-nouned to obey D-001.)_
- **Popover footer** — (absent) _(No "5 flows in view", no "New flow" button, no provenance line. The chips carry the counts and nobody asked for creation. NO INVENTION.)_
- **Adjacent-flow keys (no popover)** — [  ] _(Previous / next flow within the CURRENT filter, stolen from Trigger.dev's `[`/`]` adjacent-run navigation. On change the pill name flashes `--brand` for 240ms. Nothing else is announced.)_
- **Payload chip on a payload-dependent flow** — 8 shards _(Renders on the row and in the canvas pill ONLY for the nine patterns whose graph is a function of the input as well as the source (MapReduce, Supervisor, Recursion, Trellis, DelegationChain…). `MapReduce.make` throws `PatternError{code:"invalid_input", message:"MapReduce input must contain a shards array"}` if the shards are not literal at build time, so the plan preview is against a named payload and the chip says which.)_

### States

- **Closed (default)** — The pill reads `morning-triage ⌄`. Nothing else changes. The chevron is `--text-faint` and goes `--text` on hover.
- **Closed, single flow in the library** — No chevron, the name is not a button, `L` and `[`/`]` are no-ops. A switcher for one thing is chrome.
- **Open** — Popover fades+rises in over 160ms (`--ease-current`, `translateY(-4px) → 0`). Canvas scrims to 38% inside `.pane-canvas` only. Search is focused. The current flow's row is `aria-selected` and scrolled into view. The pill's chevron flips to `⌃`.
- **Open, filtered** — One chip is `.active` (white on `--ink`, the retired guide's exact treatment). Rows outside the filter are removed, not dimmed. Row count in the active chip is unchanged — the chips always show the totals, never the filtered subtotal.
- **Open, searching** — Rows filter on every keystroke, no debounce (5 rows). The matched substring in the id or the pattern label is wrapped in `<mark>` with `background: var(--brand-soft)`. The class chips keep their full counts; they filter the search result, they do not re-count it.
- **Open, no matches** — The row list is replaced by one centred line: `No flows match that search.` The chips stay. The popover does not resize.
- **Row hover** — `--surface-2` background, thumbnail edges brighten to 80%. No tooltip, no preview-on-hover — a hover that swaps the canvas would fight D-024's camera.
- **Row focused by keyboard** — Same as hover plus a 1px `--brand` ring inset. `↑`/`↓` move it, wrapping at both ends. Focus never leaves the list while the popover is open.
- **Switching** — Popover closes immediately (110ms fade). The ReactFlow layer cross-fades opacity 1→0→1 over 180ms total; on the far side the new node set plays the existing `pop` keyframe (320ms, staggered 18ms by dagre rank). The pill name cross-fades in place, the digest swaps, the mode chip resets to the new script's act 1 mode. Transport resets to frame 0 and auto-plays.
- **Switched, whole graph fits at ≥0.62** — `fitView({padding: 0.12, maxZoom: 0.92, minZoom: 0.62, duration: 620})`. True for `implement-issue` and `repair-red-test` at 1440px.
- **Switched, whole graph does not fit at 0.62** — Falls through to `frame` over the flow's declared `home` set at 0.94 — for `package-migration`, the trigger plus batch 0's four shards; for `publish-release`, `preflight → reserve-version → publish-npm`. The graph is NEVER shown at a zoom where its text cannot be read (D-024).
- **Wide fan-out at rest (`package-migration`, rank of 4)** — Four full 228×80 cards stacked 26px apart, 430 graph px tall, at 0.94. The `batch-0` merge bar to their right is 16px wide and stretches the full 430px, with `Node.all · 4` floating beside it. No card is compact; nothing folds.
- **Wide fan-out running** — Camera is in `frame` mode over the four live shards + their join; zoom settles at 0.94 because 430+96+16 fits. All four cards carry the brand ring and the 8px marching-tile texture (stolen from Trigger.dev's `animate-tile-scroll` on a partial span — it survives a screenshot, which a shimmer does not). The join bar shows `0 of 4 built`, incrementing.
- **Rank ≥5 (compact)** — Members drop the mono `Action` tag line and render at 52px: glyph · title · status dot on line 1, state word · duration on line 2. The `Action` tag moves to the drill-in. Nodesep tightens to 18 automatically because a compact node declares `pad: 0`.
- **Rank >8 (folded)** — First 6 compact members, then one 228×52 stack card reading `+6 more` with a 6-dot status strip (one dot per hidden member, coloured by outcome) and a `⌄` chevron. Clicking expands the rank in place and the camera re-frames it.
- **Parked node (new, `package-migration` shard-3)** — Amber breathing ring like `waiting`, but the word is `parked · 14m` and the drill-in names the source. Backed by `flows.agent.quota-parked.v1 {action, session, wakeAt, source}` where `ParkSource ∈ reset | retry-after | text | default` — every competitor draws this as "rate limited, retrying"; we draw a wake time and where it came from.
- **Deep link / bad flow id** — `?flow=nope` falls back to `morning-triage` and opens the popover with `nope` pre-typed in the search, showing `No flows match that search.` No toast, no error card.

### Data shape

```ts
// ─── Engine truth: imported, never redeclared ─────────────────────────────
import type { EdgeReason } from "@smthrs/flow/Graph"
//   VERIFIED at flows/flow/src/Graph.ts:83 — "value" | "continuation" | "failure"
import type { Tier } from "@smthrs/core/Action"
//   "sealed" | "compensable" | "irreversible"
import type { PlanNode } from "@smthrs/plan/Plan"
//   { id, kind: "step"|"agent"|"merge", key, material, effects, dependsOn,
//     conflicts, strategy, runtime, priority, generation }
import type { Settlement } from "@smthrs/engine-store/PlanScheduler"
//   Settlement["outcome"] = "built" | "clean" | "failed" | "skipped" | "deferred"
import type { KeyMaterial } from "@smthrs/plan/KeyMaterial"
//   InputRef = Literal{value} | Ref{from,path} | Pending{from}
import type { Question } from "@smthrs/flow/HumanTask"
//   { kind: "ask"|"confirm"|"select"|"json", prompt, attempt, maxAttempts,
//     options?, schema? }                                           (D-023)
import type { FactoryRule } from "@smthrs/rpc/FactoryProjection"
//   { event, flow, description? } — `event` is the real vocabulary:
//   issue.opened | issue.labeled:<label> | change.landed |
//   github.push:<branch> | schedule:<cron> | box.session.ended |
//   nomination | manual

// ─── Canvas projection of PlanNode.kind ───────────────────────────────────
/**
 * `PlanNode.kind` is only "step" | "agent" | "merge". The canvas needs the
 * rail glyph, so it projects the CALLED FLOW's identity on top of the plan
 * kind. `trigger` is never a plan node (D-031): it is a Dispatcher
 * registration with no step key, joined by a UI-only `fires` edge and
 * excluded from every count.
 */
export type CanvasKind =
  | "trigger" | "action" | "agent" | "jev" | "human" | "branch" | "merge"

/** Settlement outcomes plus the UI-only states around them. `parked` is new. */
export type NodeState =
  | "hidden" | "idle" | "queued" | "running" | "waiting" | "retrying"
  | "parked"                                   // flows.agent.quota-parked.v1
  | "built" | "clean" | "failed" | "skipped" | "dirty"

// ─── The library ──────────────────────────────────────────────────────────
/** The retired field guide's internal keys, kept verbatim. `recipe` displays
 *  as "use case". */
export type FlowClass = "primitive" | "composite" | "recipe"

export interface FlowSummary {
  readonly id: string                 // "morning-triage" — what /flow.open takes
  readonly klass: FlowClass
  /** The literal string `Compose.label(kind, fields, options)` mints, or
   *  "Flow.make" for a hand-written flow. Carries the declared bound. */
  readonly label: string
  /** The factory `on` table key this flow is registered under. */
  readonly event: FactoryRule["event"]
  /** Present only for the nine patterns whose graph is a function of the
   *  input as well as the source (MapReduce, Supervisor, Recursion,
   *  Trellis, DelegationChain). Renders as the "8 shards" chip. */
  readonly payloadChip?: string
  /** Where the camera lands when the whole graph will not fit at 0.62. */
  readonly home: readonly string[]
  readonly nodes: readonly FlowNodeSpec[]   // plan nodes + the trigger
  readonly edges: readonly FlowEdgeSpec[]
  readonly script: readonly Frame[]         // this flow's own transport script
}

/** Derived, never stored — recomputed from `nodes` so it cannot drift. */
export interface FlowCounts {
  readonly planNodes: number            // excludes the trigger (D-031)
  readonly tiers: Readonly<Record<Tier, number>>
  readonly kinds: Readonly<Partial<Record<CanvasKind, number>>>  // agent/jev/human/branch only
}

export interface FlowNodeSpec {
  readonly id: string                   // the real dotted plan path where one exists
  readonly kind: CanvasKind
  readonly title: string
  /** The `Action.make` / `AgentAction.make` tag, or the factory event key on
   *  a trigger, or "Node.all" / "Succeed" / "Map" on a merge. */
  readonly tag: string
  readonly tier: Tier
  readonly summary: string
  readonly seat?: string                // @smthrs/agent Seat: a DECLARED string
  readonly model?: string               // the resolved modelId, when known
  readonly payload: readonly PortField[]
  readonly success: string
  readonly error?: string
  readonly effects?: string
  readonly key: string                  // flows_plan_nodes.key_digest, truncated
  readonly rekey?: string
  readonly ms: number
  readonly rekeyMs?: number
  readonly tokens?: number
  readonly cost?: number
  readonly question?: Question          // human nodes only — renders the control
  readonly notes?: readonly string[]
}

export interface PortField {
  readonly name: string
  readonly type: string
  /** A `Ref` into an upstream node's result — drawn `← upstream.field`. */
  readonly from?: string
  readonly literal?: string
  /** True when this input is a `Pending{from}` ordering ref rather than a
   *  `Ref{from,path}` value ref. IT STILL ENTERS THE KEY — Graph.ts:1134
   *  pushes it into `inputs` and KeyMaterial hashes the tag. */
  readonly pending?: boolean
}

export interface FlowEdgeSpec {
  readonly id: string
  readonly from: string
  readonly to: string
  /** `fires` is UI-only: the Dispatcher joining a trigger to a plan root. */
  readonly reason: EdgeReason | "fires"
  readonly label?: "then" | "else" | "catch" | "escalate" | "undo"
}

// ─── Layout ───────────────────────────────────────────────────────────────
export type NodeGeom = "full" | "compact" | "merge" | "stack"

export interface LaidNode {
  readonly id: string
  readonly geom: NodeGeom
  readonly x: number
  readonly y: number
  readonly width: number
  /** For a merge alone in its rank this is the stretched span of its
   *  predecessors, set in layout pass 2. */
  readonly height: number
  readonly rank: number
}

export type Camera =
  | { readonly mode: "fit" }
  | { readonly mode: "follow"; readonly id: string }
  | { readonly mode: "frame"; readonly ids: readonly string[] }   // NEW

// ─── Selection, the shipped shape ─────────────────────────────────────────
/** In the mock: useState + a `?flow=` hash so a screenshot is linkable.
 *  In apps/app: a field on the card payload, changed through a flow —
 *  `target.flow.select { flow }` — never component state
 *  (apps/app/AGENTS.md: "Anything a card projects … lives in the card
 *  payload and changes through a flow"). */
export interface LibraryPayload {
  readonly flow: string
  readonly open: boolean
  readonly filter: FlowClass | "all"
  readonly query: string
}
```

### Interactions

- Click the pill name (`morning-triage ⌄`) → popover opens, search focused, current row selected and scrolled to. Click it again, click the canvas, or press Escape → closes with no change.
- `L` → opens the popover. `Escape` with text in search clears the text; `Escape` on an empty search closes. `/` refocuses search from anywhere in the popover.
- `↑` / `↓` move the focused row, wrapping at both ends. `Enter` switches to the focused flow. `Tab` cycles the four class chips, `Space`/`Enter` applies one.
- `[` / `]` switch to the previous / next flow in the current filter WITHOUT opening the popover; the pill name flashes `--brand` for 240ms. Stolen verbatim from Trigger.dev's adjacent-run navigation, which turns a list into a triage queue.
- Type in search → rows filter live, matched substrings wrapped in `<mark>`. The match runs over the flow id, the pattern label AND every node's `Action` tag, so `npm/publish` finds `publish-release`.
- Click a class chip → filters to that class; chips never re-count on filter, they always show totals. A chip whose total is 0 does not render.
- Click a row → popover closes (110ms), canvas cross-fades (180ms), dagre layout swaps from the module-scope memo, transport resets to that flow's frame 0 and auto-plays. The act chips in the topbar re-render from the new script.
- The agent can do this too (THREE-DOOR LAW): `/flow.open publish-release` switches the canvas and renders the same embedded result in chat. The agent NEVER opens it full-screen (THE EMBED LAW); maximize is the human's gesture only.
- Click a merge bar → the drawer opens on the `Node.all` join: member list, per-member outcome, and the batch's wall clock. The bar is the click target; its floating caption is `pointer-events: none`.
- Click a folded `+6 more` stack card → the rank expands in place, the card is replaced by its 6 compact members, and the camera re-frames the rank at whatever zoom keeps it ≥0.62.
- `1` fits the graph (clamped to `minZoom: 0.62`, falling through to `frame` when it will not fit). `0` resets to 0.94 centred on the cursor node. Both are n8n's bindings, so anyone arriving from n8n already has them.
- While ≥2 nodes are live the camera is in `frame` mode and does not chase any one of them; a fan-out is watched as a batch, not as a race.
- Hover does NOT preview a flow on the canvas. A hover that swapped the canvas would fight the camera (D-024) and would make the graph flicker while you read the list.
- Deep link: `?flow=<id>` selects on boot. An unknown id falls back to `morning-triage` and opens the popover with the id pre-typed, showing `No flows match that search.`

### Sample content

════ THE FIVE ROWS, EXACT COPY ═══════════════════════════════════════════

▤ morning-triage                                              use case
  Flow.make
  13   ▰▰▰▱  🔒3    ◈2 ◇2 ☻1
  event: schedule:0 8 * * 1-5     [FIX: today's mock says `dispatcher/cron`,
                                   which is invented; the real vocabulary is
                                   the factory `on` table]

▤ package-migration                                          composite
  mapReduce(concurrency=4, onEmpty=reduce)
  11   ▰▰▱▱         ◈8                      8 shards
  event: manual

▤ implement-issue                                            primitive
  reviewLoop(maxRounds=3)
  13   ▰▰▰▱  🔒1    ◈6
  event: issue.labeled:ready

▤ publish-release                                            primitive
  saga(steps=reserve-version,publish-npm,push-tag,deploy-docs, onFailure=compensate)
  12   ▰▰▰▱  🔒2
  event: change.landed

▤ repair-red-test                                            composite
  escalation(rungs=3, fallback=true)
  14   ▰▰▱▱         ◈4 ☻1
  event: github.push:main

Chips:  All 5 · Primitives 2 · Composites 2 · Use cases 1


════ FLOW A — package-migration — WIDE FAN-OUT / FAN-IN ══════════════════
MapReduce.make({ map: migratePackage, reduce: landBatch,
                 concurrency: 4, onEmpty: "reduce" })
payload: { shards: ["@smthrs/core","@smthrs/flow","@smthrs/plan",
  "@smthrs/engine-store","@smthrs/run-store","@smthrs/capability",
  "@smthrs/patterns","@smthrs/model"] }
home: ["trigger","shard-0","shard-1","shard-2","shard-3","batch-0"]

NODES — id · kind · title · tag · tier
  trigger   trigger  Run manually              manual                   —
  shard-0   agent    @smthrs/core              coding/edit-atom         compensable
  shard-1   agent    @smthrs/flow              coding/edit-atom         compensable
  shard-2   agent    @smthrs/plan              coding/edit-atom         compensable
  shard-3   agent    @smthrs/engine-store      coding/edit-atom         compensable
  batch-0   merge    Node.all · 4              Node.all                 sealed
  shard-4   agent    @smthrs/run-store         coding/edit-atom         compensable
  shard-5   agent    @smthrs/capability        coding/edit-atom         compensable
  shard-6   agent    @smthrs/patterns          coding/edit-atom         compensable
  shard-7   agent    @smthrs/model             coding/edit-atom         compensable
  batch-1   merge    Node.all · 4              Node.all                 sealed
  reduce    action   Squash into one change    jj/squash                compensable
  (11 plan nodes; every shard: seat `implementation`, model `claude-opus-5`)

EDGES — from → to (reason)
  trigger→shard-0 (fires)   trigger→shard-1 (fires)
  trigger→shard-2 (fires)   trigger→shard-3 (fires)
  shard-0→batch-0 (value)   shard-1→batch-0 (value)
  shard-2→batch-0 (value)   shard-3→batch-0 (value)
  batch-0→shard-4 (continuation)  batch-0→shard-5 (continuation)
  batch-0→shard-6 (continuation)  batch-0→shard-7 (continuation)
  shard-4→batch-1 (value)   shard-5→batch-1 (value)
  shard-6→batch-1 (value)   shard-7→batch-1 (value)
  batch-0→batch-1 (value)   ← the accumulator: Bounded.all builds
                              `capture(prev => map(all(batch), vals =>
                              ({...prev, ...vals})))`, so batch 1's join
                              really does consume batch 0's record
  batch-1→reduce (value)
  (18 edges)

RANKS  [trigger] [4 shards] [bar] [4 shards] [bar] [reduce]
WIDTH  228+96+228+96+16+96+228+96+16+96+228 + 112 margin = 1536px
       fit would be 0.58 → below the floor → camera opens in `frame` on `home`
RANK H 4×88 + 3×26 = 430 graph px = 404 screen px at 0.94   ✓
BEAT   8 agents live in 2 batches of 4. The picture IS the concurrency bound —
       n8n draws 8 unbounded branches and cannot say what is in flight.
       shard-3 hits a provider quota and PARKS with `wakeAt` (source `reset`),
       which no competitor draws as anything but "retrying".
COST   8 × ~$0.61 = $4.88, 1.04M tokens, wall clock 31m at concurrency 4
       against 1h 58m serial.
TRAP   Do NOT sell a shard-level cache hit here. `Compose.call(map, {shard,
       index, input})` carries the WHOLE input into every shard's key
       material, so adding a ninth package re-keys all eight.


════ FLOW B — implement-issue — BOUNDED LOOP, UNROLLED ═══════════════════
ReviewLoop.make({ produce: implement, review: reviewDiff,
                  revise: implement, maxRounds: 3 })
home: ["read-issue","implement@1","review@1"]

NODES
  trigger      trigger  Issue labelled ready   issue.labeled:ready      —
  read-issue   action   Read #1347             github/read-issue        sealed
  implement@1  agent    Draft the change       coding/implement         compensable
  review@1     agent    Review round 1         coding/review-diff       sealed
  approved@1   merge    Approved               Succeed {_tag:"Approved"} sealed
  revise@1     agent    Revise round 1         coding/implement         compensable
  review@2     agent    Review round 2         coding/review-diff       sealed
  approved@2   merge    Approved               Succeed {_tag:"Approved"} sealed
  revise@2     agent    Revise round 2         coding/implement         compensable
  review@3     agent    Review round 3         coding/review-diff       sealed
  approved@3   merge    Approved               Succeed {_tag:"Approved"} sealed
  exhausted    merge    Exhausted              Succeed {_tag:"Exhausted"} sealed
  run-tests    action   bun test               proc/spawn               compensable
  push-main    action   Push main              jj/git-push              irreversible
  (13 plan nodes. Three SEPARATE Approved nodes — each is built inside its own
   round's Node.capture, so there is no shared exit.)

EDGES
  trigger→read-issue (fires)
  read-issue→implement@1 (value)
  implement@1→review@1 (value)
  review@1→approved@1 (value)      review@1→revise@1 (value)
  implement@1→revise@1 (value)  ← revise consumes BOTH the draft and the
                                  review; ReviewLoop.test asserts the third
                                  FlowCall's key material holds refs to
                                  `root.andThen` AND `root.then.andThen`
  revise@1→review@2 (value)
  review@2→approved@2 (value)      review@2→revise@2 (value)
  revise@1→revise@2 (value)
  revise@2→review@3 (value)
  review@3→approved@3 (value)      review@3→exhausted (value)
  approved@1→run-tests (continuation)  approved@2→run-tests (continuation)
  approved@3→run-tests (continuation)  exhausted→run-tests (continuation)
  run-tests→push-main (continuation)
  (18 edges)

RUN    review@2 approves. approved@2 `built`; approved@1, revise@2, review@3,
       approved@3 and exhausted all `skipped` — five dashed nodes at 38%,
       the most legible skipped region in the set.
BEAT   D-017 made visible: six calls, the bound in the flow label, no loop
       widget. Put n8n's hedge beside it — "Node configuration changed. Output
       data may change when this node is run again" — against ours:
       "re-keys · 12 downstream · 1 cache hit".
BEAT 2 Rename `review@2` → 0 re-keys, free. Ids never enter the hash
       (StepKey.ts:459-461). This is the cheapest possible proof and it
       belongs on this flow, not on morning-triage.


════ FLOW C — publish-release — COMPENSATING SAGA ════════════════════════
Saga.make({ steps: [reserve-version, publish-npm, push-tag, deploy-docs],
            onFailure: "compensate" })
home: ["preflight","reserve-version","publish-npm"]

NODES
  trigger              trigger  Change landed       change.landed            —
  preflight            action   Preflight           release/preflight        sealed
  reserve-version      action   Reserve 1.0.0-rc.116 release/reserve-version compensable
  publish-npm          action   npm publish          npm/publish             IRREVERSIBLE
  push-tag             action   Push the tag         git/push-tag            compensable
  deploy-docs          action   Deploy the docs      cloudflare/deploy-worker compensable
  completed            merge    Completed            Succeed {_tag:"Completed"} sealed
  undo.deploy-docs     action   Roll the worker back cloudflare/rollback-worker compensable
  undo.push-tag        action   Delete the tag       git/delete-tag           compensable
  undo.publish-npm     action   npm deprecate        npm/deprecate           IRREVERSIBLE
  undo.reserve-version action   Release the slot     release/release-slot    compensable
  residue              merge    compensation_failed  Map → PatternError      sealed
  compensated          merge    Compensated          Succeed {_tag:"Compensated"} sealed
  (12 plan nodes)

EDGES
  trigger→preflight (fires)
  preflight→reserve-version (value)
  reserve-version→publish-npm (value)
  publish-npm→push-tag (value)
  push-tag→deploy-docs (value)
  deploy-docs→completed (value)
  deploy-docs→undo.deploy-docs (failure)  label `catch`
  undo.deploy-docs→undo.push-tag (continuation)  label `undo`
  push-tag→undo.push-tag (value)   ← the compensation consumes its own step's
                                     value: Compose.call(step.compensation,
                                     {id, input, value})  (Saga.ts:252)
  undo.push-tag→undo.publish-npm (continuation)  label `undo`
  publish-npm→undo.publish-npm (value)
  undo.publish-npm→undo.reserve-version (continuation)  label `undo`
  reserve-version→undo.reserve-version (value)
  undo.reserve-version→residue (failure)
  residue→compensated (failure)
  (15 edges)

SHAPE  Dagre puts `completed` and `undo.deploy-docs` in the same rank, so the
       forward chain runs along the top and the undo chain continues along
       the bottom, with four long value arcs sweeping from each forward step
       down to its own undo. A mirrored V. Nobody else's canvas draws it.
RUN    deploy-docs fails (Cloudflare 500). The four undos run LIFO — exactly
       the order Saga.test pins: do-one, do-two, do-three, undo-three,
       undo-two, undo-one. `completed` settles `skipped`.
BEAT   Two IRREVERSIBLE locks face each other across the mirror:
       `npm/publish` and its compensation `npm/deprecate`. A deprecate cannot
       take back a publish, and the canvas is the only place that is visible
       BEFORE the run.
TOGGLE Flip `onFailure: "compensate"` → `"fail"` and the entire bottom half
       disappears (0 `Catch` nodes, 12 → 5 plan nodes) in one switch. That is
       the proof that the plan is a projection of the source (D-002).


════ FLOW D — repair-red-test — ESCALATION / APPROVAL LADDER ═════════════
Escalation.make({ rungs: [repairHaiku, repairSonnet, repairOpus],
                  accept: runTest, fallback: askOwner })
home: ["reproduce","minimise","repair@0","accept@0"]

NODES
  trigger           trigger  main pushed       github.push:main           —
  reproduce         action   bun test          proc/spawn                 sealed
  minimise          agent    Minimise the repro coding/minimise-repro     sealed
                                 seat trivial-implementation · claude-haiku-4-5
  repair@0          agent    Repair · rung 0   coding/repair-test         compensable
                                 seat trivial-implementation · claude-haiku-4-5
  accept@0          action   bun test          proc/spawn                 sealed
  reached@0         merge    level 0           Succeed {level:0,exhausted:false} sealed
  repair@1          agent    Repair · rung 1   coding/repair-test         compensable
                                 seat implementation · claude-sonnet-4-6
  accept@1          action   bun test          proc/spawn                 sealed
  reached@1         merge    level 1           Succeed {level:1,exhausted:false} sealed
  repair@2          agent    Repair · rung 2   coding/repair-test         compensable
                                 seat orchestrator · claude-opus-5
  accept@2          action   bun test          proc/spawn                 sealed
  reached@2         merge    level 2           Succeed {level:2,exhausted:false} sealed
  ask-owner         human    Take it manually? system/human-task          sealed
  reached@fallback  merge    level 3           Succeed {level:3,exhausted:false} sealed
  commit            action   Commit the repair jj/commit                  compensable
  (14 plan nodes)

  ask-owner.question, verbatim (D-023, HumanTask shape):
    { kind: "confirm",
      prompt: "Three seats failed to repair packages/smithers/flows/patterns/test/Saga.test.ts. Take it manually?",
      attempt: 1, maxAttempts: 3 }

EDGES
  trigger→reproduce (fires)
  reproduce→minimise (value)
  minimise→repair@0 (value)
  repair@0→accept@0 (value)
  accept@0→reached@0 (value)
  accept@0→repair@1 (continuation)  label `escalate`
  minimise→repair@1 (value)   ← the NEXT rung consumes the ORIGINAL input:
                                Escalation.ts visit() calls
                                `Compose.call(rung.flow, input)`, never the
                                previous rung's result
  repair@1→accept@1 (value)
  accept@1→reached@1 (value)
  accept@1→repair@2 (continuation)  label `escalate`
  minimise→repair@2 (value)
  repair@2→accept@2 (value)
  accept@2→reached@2 (value)
  accept@2→ask-owner (continuation)  label `escalate`
  minimise→ask-owner (value)
  ask-owner→reached@fallback (value)
  reached@0→commit (continuation)  reached@1→commit (continuation)
  reached@2→commit (continuation)  reached@fallback→commit (continuation)
  (20 edges)

SHAPE  `minimise` fans four long value edges the whole length of the graph —
       a spine with three rungs hanging off it. Unmistakable next to A, B, C.
RUN    repair@0 built, accept@0 red → escalate. repair@1 built, accept@1
       green → reached@1 built. reached@0, repair@2, accept@2, reached@2,
       ask-owner and reached@fallback all `skipped` — six skipped.
BEAT   THE MODEL SURFACE. Three `repair@n` nodes, three seats, three prices:
       claude-haiku-4-5 $0.04 · claude-sonnet-4-6 $0.31 · claude-opus-5
       $2.18 (never paid). The drill-in on each is the model panel — routeId
       `anthropic`, protocolId `anthropic-messages`, framing `sse`,
       publicHeaders with `anthropic-version: 2023-06-01`, `bodyText`
       (credential-free by construction, Route.ts:73-90), the six usage
       counters, and the two retry ladders (inner `attempt n of 3`, outer
       `re-issue 0 of 1`).
NOTE   The drawer carries Escalation.ts's own sentence so the mock does not
       overclaim: "Rungs are alternative strategies, not model-seat fallback.
       Provider or seat fallback belongs to model routing before a flow is
       selected."


════ TWO ENGINE CORRECTIONS THIS SPEC DEPENDS ON ═════════════════════════
1. `Graph.EdgeReason` is confirmed `"value" | "continuation" | "failure"`
   (flows/flow/src/Graph.ts:83). The research digest left this OPEN; it is
   closed.
2. A `continuation` edge STILL RE-KEYS ITS TARGET. Graph.ts:1134 pushes
   `{_tag:"Pending", from}` into `inputs`, and KeyMaterial.ts:22-24 states
   the tag is hashed. So the re-key HUD must shade descendants along ALL
   THREE edge kinds. Shading only `value` descendants under-reports the
   dirty set — on `publish-release` it would miss the entire undo chain.

### Risks

- A `continuation` edge is hashed. `Graph.ts:1134` pushes `{_tag:"Pending", from}` into `inputs` and `KeyMaterial.ts:22-24` says the tag is hashed, so re-keying propagates along value, continuation AND failure edges. If the re-key HUD walks only `value` descendants it under-reports the dirty set — on `publish-release` it would miss every undo node.
- `package-migration` cannot honestly demo a shard-level cache hit. `Compose.call(map, {shard, index, input})` carries the WHOLE input object into every shard's key material, so editing the payload re-keys all eight shards. Sell this flow on batching, concurrency and eight live agents; sell the re-key on `implement-issue` and `morning-triage` instead.
- Nine of the 28 patterns build a graph that is a function of the INPUT as well as the source (MapReduce, Supervisor, Recursion, Trellis, DelegationChain). `MapReduce.make` throws `PatternError{code:"invalid_input", message:"MapReduce input must contain a shards array"}` at build time. So `Graph.build(flow, payload)` takes two arguments and the library row needs the payload chip. If the canvas caches one plan across payloads it will draw a graph that does not exist.
- A folded `+6 more` stack card has no step key of its own, so it has no drill-in. Decide what clicking it opens (expand only? the join's member table?) before building it, or the drawer contract breaks on the first wide rank.
- The merge-bar stretch assumes the merge is alone in its rank. `publish-release` puts `completed` and `undo.deploy-docs` in the same rank, so the guard fires there and that bar renders at 88px while others span 430px. Check it reads as deliberate rather than broken before shipping.
- `repair-red-test`'s four `minimise → …` edges span 6, 9 and 12 ranks. Dagre routes long edges through invisible dummy nodes that occupy vertical slots, so a rank's LAID-OUT height can exceed its node count × 88. Choose `compact` from the measured rank height after `dagre.layout`, never from the member count alone.
- Five flows × their own scripts is the real cost. The four pattern flows must ship ONE act (run to settlement, plus a single re-key or toggle beat), not three. morning-triage keeps its three. Otherwise the mock doubles in size and argues nothing new.
- The `All / Primitives / Composites / Use cases` taxonomy is recovered from `docs/orchestration-patterns.html`, deleted at commit `2716e9855855` and two majors stale — its card sources point at `packages/components` and `examples/*.jsx`, neither of which exists. The LIVE doc site groups by shape question instead ("Repeat until something is true…", eight rows). The three tabs are right for five flows and wrong for twenty-eight; when the catalog grows, the eight shape rows become the section headers and the tabs stay as the coarse filter.
- Today's mock gives the trigger the tag `dispatcher/cron`, which is invented. The real vocabulary is the factory `on` table (`FactoryProjection.ts:18-19`): `issue.opened`, `issue.labeled:<label>`, `change.landed`, `github.push:<branch>`, `schedule:<cron>`, `box.session.ended`, `nomination`, `manual`. Fix `morning-triage` to `schedule:0 8 * * 1-5` in the same pass or the five flows disagree with each other.
- Adding the `parked` node state is a real addition to `NodeState`. It is justified — `flows.agent.quota-parked.v1 {action, session, wakeAt, source}` is a durable park, not a retry, and `ParkSource ∈ reset | retry-after | text | default` — but it needs a word, a colour and a drawer row, and it is the only state in this spec that did not already exist.
- The canvas draws plan node ids (`root.andThen.map`) while `run-tree` and `node-output` carry call ordinals (`bash#2`, `result`). Until D-020's plan-graph projection lands these are two namespaces. The mock should either draw the join it wants and label it as a proposal, or draw both honestly and make the gap visible — not silently imply they are the same object.

## Trigger node + trigger panel (the Dispatcher surface on the flow canvas)

The one object on the canvas that is not a plan node: a Dispatcher registration drawn with its own silhouette in its own gutter, joined to the plan by a UI-only `fires` edge, whose panel states the schedule, what that schedule means in English, when it fires next in two clocks, what became of the last two dozen occurrences, and whether a scheduler is even polling to fire it.

### Layout

```
CANVAS — the trigger sits in a dispatcher gutter, left of dagre rank 0, and is excluded from every count (D-031, D-032).

Dagre: `rankdir LR, ranksep 86, nodesep 26, marginx 48, marginy 48`. Plan nodes 228x88. The trigger is laid out as a dagre node of **260 x 88** (the 32px semicircular cap widens it) at rank -1, and the `fires` edge is given `minlen: 2` so the gutter is ~172px wide — wide enough to carry the boundary hairline and the `FIRES` label without either touching a node.

```
 DISPATCHER GUTTER  ┊                       THE PLAN (13 nodes)
                    ┊
  ╭───────╮────────╮┊
 ╱        │ ⏱ Weekdays, 08:00      ● │       ╭──────────────────────╮
│   ⏱    ║ dispatcher/cron              │ ···FIRES···>│▌ List new issues   ✓ │
│  260px │ next in 4h 12m               │┊       │  github/list-issues  │
 ╲       │ [trigger][America/New_York] armed │       │  action    built 1.4s│
  ╰───────╯────────╯┊                       ╰──────────────────────╯
   cap 32  body 228 ┊
                    ┊  ← 1px dotted vertical hairline, --border-strong
                    ┊    caption at its foot, 10.5px, --text-faint:
                    ┊    "Dispatcher · not part of the plan"
```

Left cap: a 32px-wide half-capsule (`border-radius: 44px 0 0 44px`, background `--surface-2`) holding a 16px glyph. Node border-radius is therefore `44px var(--r-2) var(--r-2) 44px`. The 3px kind rail that every plan node wears on its left edge moves to the cap's **right** edge for a trigger, so the silhouette reads as "entry point" from the shape alone and never needs colour (n8n's one-sided-radius trick; D-026).

PANEL — a right-side `aside`, not a modal (D-024: the camera follows the action and a modal would fight it). 420px, not the 336px node inspector, because it carries a two-column table; on open the canvas re-centres by +84px so the selected trigger does not slide under it.

```
┌ 420px ────────────────────────────────────────────────────┐
│ ⏱  Weekdays, 08:00                                   [×] │ 56
│    dispatcher/cron · runs morning-triage    [live · box]  │
├───────────────────────────────────────────────────────────┤
│ ● armed · next in 4h 12m · last fired Yesterday 8:00 AM   │ 34  status line
├───────────────────────────────────────────────────────────┤
│  Schedule (s)    Runs (r)  ²⁴    Input (i)                │ 36  tabs, sliding
├═══════════════════════════════════════════════════════════┤     underline
│                                                           │
│  CRON pattern                                        (ⓘ)  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 0 8 * * 1-5                                         │  │
│  └─────────────────────────────────────────────────────┘  │
│  Valid pattern: Every weekday at 08:00 America/New_York   │
│                                                           │
│  Timezone                                                 │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ America/New_York                                  ▾ │  │
│  └─────────────────────────────────────────────────────┘  │
│  This will automatically adjust for daylight savings time.│
│                                                           │
│  Next 5 runs                                              │
│  ┌──────────────────────┬──────────────────────────────┐  │
│  │ America/New_York     │ Europe/London (your clock)   │  │
│  ├──────────────────────┼──────────────────────────────┤  │
│  │ Fri 19 Sep  08:00    │ Fri 19 Sep  13:00            │  │
│  │ Mon 22 Sep  08:00    │ Mon 22 Sep  13:00            │  │
│  │ Tue 23 Sep  08:00    │ Tue 23 Sep  13:00            │  │
│  │ Wed 24 Sep  08:00    │ Wed 24 Sep  13:00            │  │
│  │ Thu 25 Sep  08:00    │ Thu 25 Sep  13:00            │  │
│  └──────────────────────┴──────────────────────────────┘  │
│                                                           │
│  Overlap     skip                                         │
│  Catch-up    none                                         │
│  Scheduler   local polled 2s ago                          │
│  Revision    7                                            │
│                                                       ⋮   │ scroll
├───────────────────────────────────────────────────────────┤
│ [ Fire once ]  [ Disable ]                  Open source ↗ │ 52  foot
└───────────────────────────────────────────────────────────┘
```

Runs tab body (same 420px column):

```
│  Last 24 occurrences        22 launched · 1 skipped · 1 failed │
│  ▮▮▮▮▮▮▮▮▮▯▮▮▮▮▮▮▮▮▮▮▮▮▮▮                                     │
│  ↑ oldest                                        newest ↑     │
│                                                               │
│  Today 8:00 AM      launched   r_8c21f4      View run →       │
│  Yesterday 8:00 AM  completed  r_7ffe10      View run →       │
│  Sep 16 8:00 AM     failed     r_7c0091      View run →       │
│     └ Control could not launch the scheduled run              │
│  Sep 15 8:00 AM     skipped                                   │
│     └ a run was still in flight and overlap is skip           │
│  …                                          [ Older ]         │
```

Input tab body:

```
│  Input                                    [ JSON ] [ Schema ] │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ {                                                        │ │
│  │   "repo": "tevm/tevm-monorepo",                          │ │
│  │   "label": "triage"                                      │ │
│  │ }                                                        │ │
│  └──────────────────────────────────────────────────────────┘ │
│  Saving re-registers the trigger · revision 7 → 8              │
│  [ Save input ]                                                │
```

The strip and both tables are the same 420px column; nothing horizontally scrolls. At <520px viewport the panel becomes a bottom sheet at 62vh with the same three tabs and the Next-5 table collapsing to one column (the declared zone) with the viewer's clock as a second line per row.
```

### Anatomy

- **Node — silhouette** — 260 x 88, `border-radius: 44px var(--r-2) var(--r-2) 44px`, left cap 32px wide, `background: var(--surface-2)`. _(Shape encodes role so colour never has to (D-026). Copied from n8n's `--trigger-node--radius: 36px` one-sided radius; ours is a full half-capsule because our node is 88px tall. Dagre must be given the per-node size: `graph.setNode(id, { width: kind === "trigger" ? 260 : 228, height: 88 })`.)_
- **Node — kind rail** — 3px vertical bar, `background: var(--text-faint)`, on the RIGHT edge of the cap (x = 32px), not the node's left edge. _(Every plan node wears the rail on its left edge; the cap's radius would eat it. Moving it is the second silhouette cue.)_
- **Node — glyph** — 16px, centred in the cap. `⏱` clock for cron, `⚡` bolt for event, `🔗` link for webhook, `▶` play for manual. _(Icon vocabulary per kind, hue constant (`--text-faint`) — Trigger.dev's `task-cached` lesson: same hue, different glyph.)_
- **Node — title** — The human reading of the schedule, from the SHIPPED `describeSchedule(cron, timezone)` in `apps/app/src/mainview/cards/TriggerEvents.ts`. Examples it actually produces: `Every weekday at 08:00 America/New_York`, `Every minute`, `Every 15 minutes`, `Every hour at 30 minutes past`, `Every day at 03:00`, `Every Monday, Wednesday at 09:00`, `Monthly on day 1 at 00:00`. For an event trigger, `describeEvent(rule.event)`: `On a new issue`, `On an issue labeled triage`, `GitHub push on main`, `On a Change landed`, `On a box session ended`, `On a nomination`, `Started by hand`. _(Both functions already ship and already fall back to the raw expression rather than guessing — reuse them verbatim, do not write a second cron-to-English. The node truncates with ellipsis at 228px; the panel head shows the full sentence.)_
- **Node — tag line** — `dispatcher/cron` · `dispatcher/event` · `dispatcher/webhook` · `dispatcher/manual`, then ` · runs <flowId>` when the flow differs from the canvas's own flow. _(Mono, 11px, `--text-faint`. Matches the existing mock's `fl-node-tag` slot. `dispatcher/*` is a UI tag, not an `Action.make` tag — a trigger has no Action, which is exactly the point.)_
- **Node — countdown caption** — `next in 4h 12m` while armed. `firing now` while a launch reservation is held. `run r_8c21f4` while a run is in flight. Absent when disabled, unsatisfiable, or unscheduled. _(Occupies the same `fl-node-caption` slot the running plan nodes use. Ticks once a minute above 90s, once a second below.)_
- **Node — chips** — `trigger` (kind chip, `--text-faint`), then the declared timezone verbatim (`America/New_York`) or, when no zone was declared, `host zone` in `--warning`. _(`TriggerEvents.ts` already refuses to print a zone the declaration did not name: "the scheduler's default zone is the store's fact, not this card's". `host zone` states the gap instead of inventing `UTC`.)_
- **Node — state word** — One word, chosen by the precedence ladder in `states`: `no scheduler` · `unsatisfiable` · `disabled` · `waiting on you` · `parked on quota` · `failing` · `fired` · `firing` · `buffered` · `armed`. _(n8n's `CanvasNodeStatusIcons` lesson: an explicit v-if/v-else-if ladder, one slot. Unlike n8n we also print the word (D-026). Never `built`, never `clean`, never `skipped` — a trigger has no step key and no settlement (D-031).)_
- **Node — never-fired sub-caption** — `never fired`, 10.5px, `--text-faint`, right of the state word. _(A modifier, not a status. A brand-new armed trigger is healthy. n8n's rule: `executionStatus === 'unknown'` renders nothing — ours renders the fact quietly because "registered three weeks ago and never once fired" is a real defect a person must be able to see.)_
- **Node — declared badge** — `declared in code`, a 10px pill on the node's top-right corner, `--surface-2` fill, shown only when `source === "declared"`. _(Trigger.dev's Declarative/Imperative split, which is a shippable partial answer to D-003 for exactly this object: a rule in `.smithers/FACTORY.ts` is read-only on the canvas and says so; a trigger-store row is editable in place.)_
- **Edge — `fires`** — 1px dashed, `--text-faint`, zoom-compensated label `FIRES` (`transform: scale(var(--canvas-zoom-compensation-factor, 1))`). No arrowhead marching dashes; instead one 3px dot travelling source→target on a 1.4s loop, and only while the state is `firing` or `fired`. _(It must not be mistaken for a `value` edge. `Graph.EdgeReason` has exactly three members and `fires` is not one of them — this edge exists only in the UI (D-031) and is excluded from every edge count.)_
- **Canvas — dispatcher boundary** — 1px dotted vertical hairline, `--border-strong`, full canvas height, at the right edge of the gutter. Foot caption, 10.5px `--text-faint`: `Dispatcher · not part of the plan`. _(The structural fix for the D-032 mistake. The count chip on the canvas panel reads `13 plan nodes · 11 executed` and the trigger is visibly outside the line that the count describes.)_
- **Panel — head** — Glyph tile 28px, then the full schedule sentence as `<h2>`, then the mono sub-line `dispatcher/cron · runs morning-triage`, then a source pill: `live · box` or `declared in code`. Close button, `aria-label="Close"`. _(Same `inspector-head` markup as the node inspector; only the body differs. Per-kind inspector shape is Trigger.dev's span-kind pattern.)_
- **Panel — status line** — Status dot + word + ` · ` separated facts, in this order and only when known: `next in 4h 12m`, `last fired Yesterday 8:00 AM`, `run r_8c21f4`, `1 buffered`. Nothing renders a dash or `not measured yet`. _(`timeLabel()` from `apps/app/src/mainview/Timestamps.ts` for absolute stamps — it already answers `8:00 AM` / `Yesterday 8:00 AM` / `Sep 16 8:00 AM`.)_
- **Panel — tabs** — Cron: `Schedule` (s) · `Runs` (r) · `Input` (i). Event: `Event` (e) · `Runs` (r) · `Input` (i). Webhook: `Channel` (c) · `Runs` (r). Manual: `Runs` (r) · `Input` (i). The Runs tab carries a superscript count pill of the occurrences on the page. _(Single-key shortcuts and a `layoutId` sliding underline, straight from Trigger.dev's `TabContainer`. Tab selection goes in the URL (`?tab=runs`) so a tab is linkable. Three tabs is the ceiling; a fourth is a smell.)_
- **Schedule tab — CRON field** — Label `CRON pattern`. Input, mono, placeholder `* * * * *`. An `ⓘ` tooltip whose body is OUR grammar, not Trigger.dev's:
```
We support this CRON format:

  ┌─ second (0 - 59, optional)
  │ ┌─ minute (0 - 59)
  │ │ ┌─ hour (0 - 23)
  │ │ │ ┌─ day of month (1 - 31)
  │ │ │ │ ┌─ month (1 - 12, or jan - dec)
  │ │ │ │ │ ┌─ day of week (0 - 7, or sun - sat; 0 and 7 are Sun)
  │ │ │ │ │ │
  * * * * * *

Five fields sets seconds to 0. Ranges (1-5), lists (1,3,5) and
steps (*/15) work in every field.
When day of month and day of week are both restricted, a date
matches if either matches.
``` _(This is `effect/Cron.parse` read from source, not cron folklore. Our parser takes 5 or 6 segments and unshifts `"0"` for five. It has NO `L`, NO `#`, NO `?`, NO `W`, and NO `@daily`/`@hourly` macros. Copying Trigger.dev's `"L" means the last.` would ship a lie. The either-matches rule is a real behavioural difference worth stating.)_
- **Schedule tab — validation line** — Valid: `Valid pattern: ` + `describeSchedule(cron, timezone)`. Malformed: `Invalid pattern: ` + the `TriggerError.message` for code `invalid_cron`, which is `CronParseError.message` verbatim — `Invalid number of segments in cron expression`, `Expected a value between 0 and 59`, `Expected step value to be greater than 0`, `Invalid value range`, `Invalid time zone in cron expression`. Parses but never matches: `Invalid pattern: ` + the `unsatisfiable_cron` message verbatim — `cron expression '0 0 30 2 *' has no next occurrence`. _(TWO distinct failures and they must read differently; `unsatisfiable_cron` is the one our engine catches at declaration time and nobody else does. Validate on a 250ms debounce by calling `Cron.parse` in the browser (`effect/Cron` is already a dependency), then confirm server-side on save — `Trigger.make` runs the same probe.)_
- **Schedule tab — timezone** — Label `Timezone`, a combobox over `Intl.supportedValuesOf("timeZone")`, placeholder `Select a timezone`. Below it exactly one sentence: `UTC will not change with daylight savings time.` when the zone is UTC, `This will automatically adjust for daylight savings time.` otherwise, and when no zone is declared: `No timezone declared — the scheduler fires in whatever zone its host runs in.` _(The third sentence is ours and is the honest one. `Schedule.timezone` is `Schema.optional`; `Cron.parse(expr, undefined)` resolves against the host. A mock that prints `UTC` for an absent zone invents a fact.)_
- **Schedule tab — Next 5 runs** — Heading `Next 5 runs`. Two columns: the declared zone (or `host zone`) and `<viewer zone> (your clock)`. Rows `Fri 19 Sep  08:00`. The columns collapse to one when the two zones resolve to the same offset for all five rows. A DST transition inside the five gets a `⚠` on the row and the footnote `Clocks change between these two runs.` _(Exactly 5 because the engine already computes exactly 5: `DispatchReader.nextOccurrenceCount = 5`, `nextOccurrences(trigger, now)` returns ascending epoch ms strictly after `now`, and `TriggerSummary.nextOccurrencesMs` carries them. Do not compute a sixth in the client. Trigger.dev shows schedule-zone + UTC; ours shows schedule-zone + viewer-zone because a Smithers operator reads their own clock, and the ⚠ catches the DST bug both of those miss.)_
- **Schedule tab — policy rows** — `Overlap` with the value and its consequence in six words: `skip` → `an occurrence while a run is in flight is dropped`; `buffer-one` → `the newest waiting occurrence runs after this one`; `supersede` → `the run in flight is cancelled and replaced`. `Catch-up` with: `none` → `nothing is owed after downtime`; `one` → `only the most recent missed occurrence`; `all` → `every missed occurrence, up to <maxCatchUp>`. _(`Schedule.Overlap = ["skip","buffer-one","supersede"]`, `Schedule.CatchUp = ["none","one","all"]`, `maxCatchUp` is an int in `[0, 1000]` (`Cron.maxOccurrences`). `maxCatchUp` renders only when `catchUp !== "none"`. n8n's node-hint discipline: one line restating a non-default setting, where the object lives.)_
- **Schedule tab — scheduler row** — `Scheduler` + `<host> polled 2s ago` when fresh, or the whole row turns `--danger` and reads `no scheduler has polled this store` / `<host> last polled 41m ago`. _(From `TriggerSummary.schedulerLastTickMs` and `TriggerStore.lastHeartbeat(): Option<{host, tickedAt}>`. `Scheduler.defaultHost = "local"`; the CLI default poll interval is 1000ms. THE THRESHOLD: stale at `> 5 x pollInterval`, i.e. 5s by default. This row is the single most valuable thing on the surface and no competitor has it — a schedule that will never fire because nothing is running `smthrs triggers serve` looks identical to a healthy one everywhere else.)_
- **Schedule tab — revision row** — `Revision` + the integer. _(`Registered.revision` is the optimistic-concurrency fence. It renders because a save bumps it and a `revision_mismatch` refusal names it.)_
- **Event tab (event triggers)** — `Event` + the raw key in mono (`issue.labeled:triage`), `Means` + `describeEvent(key)`, `Starts` + the flow ids from `ruleFlows(rule)` as links, `Declared in` + `.smithers/FACTORY.ts` as a link to the source, and when the rule carries one, `Visible as` + `rule.description`. _(`FactoryRule = { event, flow: string | string[], description? }`. The whole tab is read-only with the InfoPanel `Editing declared rules` / `This rule is declared in .smithers/FACTORY.ts. Edit it there and the canvas re-derives.` — Trigger.dev's declarative-schedule treatment, and it buys an honest shippable panel without closing D-003.)_
- **Channel tab (webhook triggers)** — `Channel` + `channel.name`, `Starts` + `flowId` when known, `Credential` + the `CredentialRef` NAME only, `Verified by` + the header name (e.g. `x-hub-signature-256`). No URL, no secret, no copy button. _(`Channel.Verify` takes `Redacted<CredentialRef>` and resolves per request; `Webhook.makeSignatureVerifier` compares in constant time and every refusal is the same string, `webhook signature in <header> did not verify`, whatever the reason. Deliberately REJECT Trigger.dev's waitpoint `Callback URL` ClipboardField — our channel has no token to hand out, and a copyable URL would imply one.)_
- **Runs tab — history strip** — Up to 24 cells, oldest left → newest right, 10px wide x 22px tall, 3px gap, `border-radius: 2px`. Above it: `Last 24 occurrences` and, right-aligned, the tally `22 launched · 1 skipped · 1 failed` (only non-zero outcomes, in the order they appear in `FireOutcome`). Below it, 10.5px `--text-faint`: `↑ oldest` … `newest ↑`. Hovering a cell shows `Today 8:00 AM · launched · r_8c21f4`. _(One cell per `FireSummary`, coloured by `outcome`: launched `--info`, completed `--success`, skipped `--text-faint`, buffered `--text-faint` with a 45° hatch, superseded `--warning`, failed `--danger`, `null` (claimed, not yet reported) a 2px dashed outline with no fill. Every cell also carries a distinct fill pattern so the strip survives greyscale. Fixed height, NOT a duration bar: `FireSummary` carries no duration and inventing one from `run-summary` would make the strip lie on a page where some runs were pruned.)_
- **Runs tab — table** — Columns `Occurrence` (from `timeLabel(occurrenceAtMs)`), `Outcome` (the literal word), `Run` (the `RunId`, mono, truncated to 8 chars), and a trailing `View run →`. A `failed` row expands one 11px `--danger` line with `error` verbatim. A `skipped`/`superseded`/`buffered` row expands one `--text-faint` line naming the policy that caused it. A row whose `waiting === "approval"` shows the word `waiting on approval` in place of the outcome. _(`FireSummary = { triggerId, occurrenceAtMs, outcome: FireOutcome | null, runId?, error?, waiting?: "approval" }`. Paging is the store's real cursor: `HistoryQuery { triggerId, runId, outcome, cursor: Fire, limit }` → `HistoryPage { items, nextCursor }`, newest first by `compareNewestFirst`. Footer button `Older` appears only when `nextCursor` exists.)_
- **Runs tab — pruning note** — Rendered only when the oldest row on the last page is younger than the trigger's `lastFiredAt` minus the retention window: `Settled occurrences older than 30 days are pruned.` _(`pruneFires({ olderThan })` deletes only `completed | failed | skipped | superseded` rows and never the buffered or active one. A host that never calls it keeps every row forever, so this note is conditional, not decorative.)_
- **Input tab** — Heading `Input`, a segment control `JSON` / `Schema`, a mono editor pre-filled with `JSON.stringify(trigger.input, null, 2)`. Below: `Saving re-registers the trigger · revision 7 → 8`. Button `Save input`. Invalid JSON: `Invalid input, must be valid JSON`. The `Schema` arm shows the target flow's declared `inputSchema` from `FactoryFlow.inputSchema`, or, when the flow declares none, the sentence `<flowId> declares no input schema.` _(`Trigger.input` is `Schema.Json` persisted by `JSON.stringify` into a NOT NULL column; the schema refuses `undefined`, `NaN`, `Date` and functions at the declaration boundary. The `Schema` arm is Trigger.dev's Test-page schema tab, which we CAN do honestly because our flows are typed — but only when the projection carries a schema.)_
- **Panel — foot, cron/manual** — `Fire once` (primary), `Disable` / `Enable` (secondary), and a right-aligned `Open source ↗` when the trigger is declared. _(n8n's ellipsis convention is adopted verbatim: a label ending in `…` opens a dialog, a bare label acts now. `Fire once` acts now because `setPending` is one durable write. `Delete schedule…` is deliberately NOT in this round — there is no delete on `TriggerStore.Service`.)_
- **Fire once — the honest constraint** — `Fire once` queues one occurrence at `Date.now()` with the trigger's STORED input. It does not take an ad-hoc payload. Tooltip on the button: `Queues one occurrence now with the saved input. Approvals still apply.` Disabled when `!enabled`, with the tooltip carrying the real refusal: `Enable this trigger before queueing a manual occurrence`. _(THIS IS THE ONE PLACE THE BRIEF ASKS FOR SOMETHING THE ENGINE DOES NOT DO. `TriggerStore.setPending(fire: Fire)` where `Fire = { triggerId, occurrence }` — there is no payload parameter, and `Scheduler.idempotencyKey(triggerId, occurrence) = `${triggerId}:${new Date(occurrence).toISOString()}`` is derived from the occurrence alone. So a Trigger.dev-style replay-with-a-different-payload is not available. Two honest moves, both in this spec: (1) the Input tab edits the stored input as a real `register` with a revision bump, then `Fire once` uses it; (2) the engine ask is written down as `setPending(fire: Fire & { readonly inputOverride?: Json })` persisted on the fire row, which is a small additive change to `flows_trigger_fires` and to `Scheduler`'s `StartInput`. Do not draw an editable-payload Fire dialog until that lands.)_
- **Fire once — the receipt** — On press the button becomes `Queued` for 1.2s, a row is inserted at the right end of the history strip with the `null`-outcome dashed cell, and the toast reads `Occurrence queued · <idempotencyKey>`. The strip cell settles from the next poll, not from the button. _(AGENTS.md instant-chat rule: 'Requested' is not 'started'. The launch is at-least-once and is deduplicated by `idempotencyKey`; a repeated press inside the same millisecond is the same occurrence and must not insert a second cell.)_
- **Disable / Enable** — `Disable` acts now. Its confirm is a one-line inline undo bar, not a dialog: `Disabled · future occurrences will not fire.` `[Undo]`, 6s. `Enable` reads `Enabled · next in 4h 12m` once the recomputed occurrences arrive. _(Real semantics from the CLI: 'Enable/Disable future occurrences without cancelling an active run.' The undo bar must say that a run in flight is untouched when `activeRunId` is set: `A run is still in flight and keeps going.`)_
- **Permission gate** — A door the session cannot open renders disabled with a tooltip, never hidden. `You don't have permission to fire triggers`. For an unregistered workspace, `Fire once` is absent and the foot carries the SHIPPED refusal sentence: `A schedule cannot be registered on tevm/tevm-monorepo from here yet: this workspace has no repository/trigger flow.` _(Trigger.dev's disabled+tooltip over hidden, which matches the agent-parity rule. The refusal string is `registerUnavailableSentence(repo)` from `TriggersSeam.ts` and already ships.)_
- **Ask-the-agent chip** — On a `failing` or `unscheduled` trigger only, a chip in the panel status line: `What happened here?`. It drops a prefilled prompt into the left chat pane — `Trigger morning-triage-0800 has failed its last 3 occurrences with "Control could not launch the scheduled run". Find out why and tell me what to change.` _(Trigger.dev's short-label/long-prompt pair. Costs nothing here because the left pane is already the agent. The chip renders only when there is a failure to ask about — an always-present chip would be MINIMAL TEXT slop.)_
- **Canvas empty state — nothing fires this flow** — A dashed 260x88 placeholder in the gutter, `2px dashed var(--border-strong)`, holding one line `Nothing fires this flow` and a `Register a schedule` button. When the workspace has no registrar the button is replaced by the refusal sentence. _(n8n's `Add a Trigger Node before executing the workflow` transposed. Do NOT reuse `Add first step…` — our plan has steps, it just has no dispatcher. `Register a schedule` is the existing `triggers.register` door (the shipped card's button reads `Register a rule`; on the canvas the noun is the object you are adding).)_
- **Panel empty state — no occurrences** — Runs tab with an empty ledger: the strip is absent entirely (not 24 empty cells) and the tab body is one line: `No occurrences yet.` plus, when armed, `First run <timeLabel(nextOccurrencesMs[0])>.` _(MINIMAL TEXT: no row whose value is a dash. An absent strip is more honest than an empty one, because an empty strip reads as 24 skipped occurrences.)_
- **Signed-out / no box** — Declared rules render in full (they come from the public mirror). No live column, no placeholder for one, no `Fire once`, no `Disable`. The panel foot is a single `Sign in to see live state` link. _(`TriggerListCard.payload.live` is the flag. The shipped seam's rule is explicit: 'Signed out there is no live column and no placeholder for one.' Honour it exactly.)_

### States

- **PRECEDENCE LADDER (node status word, highest first)** — 1 `no scheduler` → 2 `unsatisfiable` → 3 `disabled` → 4 `waiting on you` → 5 `parked on quota` → 6 `failing` → 7 `fired` → 8 `firing` → 9 `buffered` → 10 `armed`. Exactly one word renders. `never fired` is a modifier printed beside the word, never instead of it. A trigger NEVER renders `built`, `clean`, `skipped`, `dirty` or a `0ms` chip — it has no step key and no settlement (D-031).
- **unregistered (declared only)** — Node: solid border, `--text-faint` rail, `declared in code` badge top-right, no status dot, state word absent, no countdown. Panel: Event tab only plus the InfoPanel `Editing declared rules`. Predicate: the row came from `.smithers/factory.json` `on` and no `TriggerSummary` matches it.
- **armed** — Node: `--border-strong` border, status dot a hollow 1.5px `--text-faint` ring, word `armed` in `--text-muted`, caption `next in 4h 12m`. Panel status dot the same. Predicate: `enabled && activeRunId === undefined && nextOccurrencesMs.length > 0 && schedulerFresh`.
- **armed · never fired** — Exactly `armed`, plus `never fired` at 10.5px `--text-faint` to its right and, in the panel status line, `first run Fri 19 Sep 8:00 AM` in place of `last fired`. Predicate: `lastFiredAtMs === undefined`. Not a warning — a three-week-old never-fired trigger is caught by `no scheduler` or by the Runs tab, not by colouring this.
- **firing (launch reserved)** — Node: `--brand` 1.5px border, dot dashed `--brand` spinning 1.5s, word `firing`, caption `firing now`, the `fires` edge pulse starts. An 8px marching-tile texture (`background-size: 8px 8px`, `animate-tile-scroll`, 30% opacity) over the cap so the state survives a screenshot without relying on hue. Predicate: `isReservation(activeRunId)` — `activeRunId.startsWith("trigger-reservation:")`. Bounded: `reservationLeaseMs = 300000`; past the lease the tile texture goes `--warning` and the caption reads `launch reservation expired · retrying`.
- **fired (run in flight)** — Node: `--brand` border, solid `--brand` dot, word `fired`, caption `run r_8c21f4`. The `fires` edge shows a travelling dot and the first plan node carries its own running treatment. Panel status line gains `View run →`. Predicate: `activeRunId !== undefined && !isReservation(activeRunId)`.
- **buffered** — Node: `fired` chrome plus a second small chip `1 buffered` in `--text-faint`. Panel status line gains `1 buffered · runs after this one`. Predicate: `pendingAtMs !== undefined`. Only reachable under `overlap: "buffer-one"`. `Overlap.pendingAfter` keeps the NEWEST, so the chip is always `1 buffered`, never a count.
- **waiting on you (approval)** — Node: `--warning` 1.5px border breathing at 2.4s, dot `--warning` filled on `--warning-soft`, word `waiting on you`, caption `approval required`. Panel foot gains `Review approval →`. Predicate: the newest `FireSummary.waiting === "approval"`, or the launched run's `RunStatus` is `waiting-approval`. Bounded: `Scheduler.parkedAttempts = 8` with a doubling delay from 1s, so an unapproved plan is abandoned a little past two minutes and the fire settles `failed` with `Control plan <planId> is still parked awaiting approval after 8 attempts`. The panel says so once the abandonment lands — it does NOT pretend the approval is still open.
- **parked on quota** — Node: `--warning` border, dot `--warning` hollow, word `parked on quota`, caption `resumes 09:40`. Panel status line: `parked on quota · resumes Fri 19 Sep 9:40 AM`. Predicate: the launched run's `flows_runs.waiting_reason === "quota"` with `waiting_wake_at_ms` set. HONEST NOTE FOR THE BUILDER: this is a RUN state, not a trigger state — `@smthrs/triggers` has no quota concept and `TriggerSummary` carries no quota field. Rendering it on the trigger requires joining `activeRunId` to the run's waiting annotation. `waiting_reason` is a free `Schema.String` with the conventional values `timer`, `event`, `approval`, `quota`, `input`; render `parked on <reason>` for any value the UI does not know rather than swallowing it.
- **failing** — Node: `--danger` 1.5px border, dot `--danger` with `✕`, word `failing`, caption `3 of the last 5 failed`. The `Ask the agent` chip appears. Panel Runs tab opens on the first failed row expanded. Predicate: the 3 newest settled `FireSummary` rows all have `outcome === "failed"`, OR the newest has `error !== undefined`. Real messages: `Control could not launch the scheduled run`, `Control rejected the scheduled run: <message>`, `Runner.start for <key> did not answer within 240000 ms` (`runner_timeout`, `startTimeout` default 4 min).
- **disabled** — Node: 38% opacity, 1px dashed border, no status dot, word `disabled` in `--text-faint`, no countdown. The `fires` edge drops to 20% opacity. Panel: the Next-5 table is replaced by one line, `No next occurrence while disabled.` — NOT a greyed table of dates, which would imply it still fires. Foot button flips to `Enable`. Predicate: `enabled === false`. An active run keeps going and the status line still shows `run r_8c21f4` beneath the word.
- **unsatisfiable** — Node: `--danger` 1px dashed border, dot `--danger` with `✕`, word `unsatisfiable`, caption `this schedule never happens`. Panel Schedule tab: `Invalid pattern: cron expression '0 0 30 2 *' has no next occurrence` and no Next-5 table. Predicate: `nextOccurrencesMs.length === 0` while `enabled`, or `TriggerErrorCode === "unsatisfiable_cron"`. Mostly unreachable through our own doors — `Trigger.make`, `Schedule.make` and `SqlTriggerStore.register` all run the probe — so it is reachable only through a row written outside them. Render it anyway; that is precisely the row a person needs to find.
- **no scheduler** — Node: `--danger` border, dot `--danger` hollow, word `no scheduler`, caption `nothing is polling this store`. OUTRANKS EVERY OTHER STATE including `disabled` — a disabled trigger on a dead scheduler is still a dead scheduler and the person needs to know. Panel Schedule tab's Scheduler row turns `--danger` and reads `no scheduler has polled this store` or `local last polled 41m ago`, with the next line `Run `smthrs triggers serve` to fire schedules.` Predicate: `schedulerLastTickMs === undefined`, or `now - schedulerLastTickMs > 5 x pollInterval` (5s at the 1000ms default). This is the state no competitor renders and the one that actually bites.
- **undecodable row** — Node: `--danger` dashed, word `unreadable`, caption the `TriggerError.message`. Panel shows only the head, the error code (`invalid_trigger` / `invalid_schedule` / `invalid_cron`) and `path` when the error names one, and the raw stored JSON. Predicate: `Listed.trigger` is `Result.isFailure`. The store deliberately isolates one corrupt row so it cannot stop the other triggers from being scheduled; the canvas honours that by drawing the bad row instead of hiding it.
- **empty — no dispatcher at all** — No trigger node. The gutter holds the dashed placeholder (`Nothing fires this flow` + `Register a schedule`). The dispatcher hairline still renders, so the plan's left boundary is stated even when nothing sits behind it. Signed out with no declared rules, the panel is not reachable and the Dispatcher list card is exactly one sentence: `No rules declared yet`.
- **empty — registered, no occurrences** — Runs tab: no strip, one line `No occurrences yet.`, plus `First run Fri 19 Sep 8:00 AM.` when armed. Strip absent rather than empty.
- **loading** — Node renders immediately from the declared/cached row with the status word omitted and the countdown replaced by three 4px skeleton bars. It NEVER renders `armed` optimistically — `armed` is a claim about a live scheduler. Panel tabs render with a 3-row skeleton in the Next-5 and Runs tables.
- **stale / offline** — The panel keeps its last values and the status line gains a right-aligned `as of 11:42 AM` in `--text-faint`. Liveness disappears entirely when there is nothing live to show — no spinner on a settled view (Trigger.dev's `LiveReloadingStatus` returns null once the root span completes).

### Data shape

```ts
```ts
// ─── REAL engine types, imported, not restated ──────────────────────────────
import type {
  TriggerSummary,   // @smthrs/control/ControlSchema — the live registration
  FireSummary,      // @smthrs/control/ControlSchema — one occurrence's ledger row
  FireOutcome,      // "launched"|"completed"|"skipped"|"buffered"|"superseded"|"failed"
  RunStatus,        // "accepted"|"running"|"parked"|"waiting-approval"|"cancelled"|"completed"|"failed"
  RunId,
  FlowId
} from "@smthrs/control/ControlSchema"
import type { Overlap, CatchUp } from "@smthrs/triggers/Schedule"
import type { TriggerErrorCode } from "@smthrs/triggers/TriggerError"
import type { Heartbeat } from "@smthrs/triggers/TriggerStore"
import type { FactoryRule } from "@smthrs/rpc/FactoryProjection"

// TriggerSummary, for reference (ControlSchema.ts:905) — do not redeclare:
//   { triggerId, flowId, input: Json, cron, timezone?, overlap, catchUp,
//     maxCatchUp?, enabled, revision, lastFiredAtMs?, pendingAtMs?,
//     activeRunId?, nextOccurrencesMs: readonly number[], schedulerLastTickMs? }
// FireSummary (ControlSchema.ts:941):
//   { triggerId, occurrenceAtMs, outcome: FireOutcome | null, runId?,
//     error?, waiting?: "approval" }

// ─── The surface's own view model ───────────────────────────────────────────

/** Which door fires the flow. Four doors, one canvas object each. */
export type TriggerKind = "cron" | "event" | "webhook" | "manual"

/**
 * Where the row came from. `declared` is the `on` table of
 * `.smithers/factory.json`, read from the public mirror, visible signed out
 * and READ-ONLY on the canvas. `live` is the box's own trigger store, present
 * only when a signed-in session's box answered. Never mixed.
 */
export type TriggerSource = "declared" | "live"

/** The one word the node prints, resolved by the precedence ladder. */
export type TriggerState =
  | "unregistered"
  | "armed"
  | "firing"
  | "fired"
  | "buffered"
  | "waiting-approval"
  | "parked"
  | "failing"
  | "disabled"
  | "unsatisfiable"
  | "no-scheduler"
  | "unreadable"

/** What the panel says about the run a fired trigger is holding. */
export interface TriggerActiveRun {
  readonly runId: RunId
  readonly status: RunStatus
  /** `flows_runs.waiting_reason` — a free string; conventional values are
   *  "timer" | "event" | "approval" | "quota" | "input". */
  readonly waitingReason?: string
  /** `flows_runs.waiting_wake_at_ms`. */
  readonly wakeAtMs?: number
  /** True while `activeRunId` is still a launch reservation
   *  (`TriggerStore.isReservation`, prefix "trigger-reservation:"). */
  readonly reserved: boolean
}

/** The declaration half of a webhook door. No URL, no token, no secret. */
export interface TriggerChannel {
  readonly name: string
  readonly flowId?: FlowId
  /** The `CredentialRef` NAME only — the value is `Redacted<CredentialRef>`. */
  readonly credentialName: string
  /** The header `Webhook.makeSignatureVerifier` reads, e.g. "x-hub-signature-256". */
  readonly signatureHeader?: string
}

/** A parse verdict rendered under the CRON field. */
export type CronVerdict =
  | { readonly ok: true; readonly sentence: string }        // describeSchedule()
  | { readonly ok: false; readonly code: Extract<TriggerErrorCode,
        "invalid_cron" | "unsatisfiable_cron">
      readonly message: string                              // TriggerError.message, verbatim
      readonly path?: string }                              // TriggerError.path

/** Everything the node and the panel render for one dispatcher. */
export interface TriggerNodeModel {
  /** `TriggerSummary.triggerId`, or the `FactoryRule.event` key for a declared row. */
  readonly id: string
  readonly kind: TriggerKind
  readonly source: TriggerSource
  readonly state: TriggerState
  /** The full live row. Absent for `source === "declared"`. */
  readonly summary?: TriggerSummary
  /** The declared rule. Absent for a trigger-store row with no declaration. */
  readonly rule?: FactoryRule
  readonly channel?: TriggerChannel
  /** `describeSchedule(cron, timezone)` or `describeEvent(rule.event)` — the node title. */
  readonly title: string
  /** `Cron.parse` run in the browser against the current field text. */
  readonly verdict?: CronVerdict
  /** Newest first, `historyPage`-cut. Empty array means an empty ledger. */
  readonly fires: readonly FireSummary[]
  readonly nextCursor?: { readonly triggerId: string; readonly occurrence: number }
  readonly activeRun?: TriggerActiveRun
  readonly scheduler?: Heartbeat            // { host, tickedAt }
  /** `now - scheduler.tickedAt > 5 * pollIntervalMs`. */
  readonly schedulerStale: boolean
  /** The `TriggerError` a row that would not decode carries (`Result.isFailure`). */
  readonly decodeError?: { readonly code: TriggerErrorCode; readonly message: string; readonly path?: string }
  /** The viewer's zone, from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  readonly viewerZone: string
  /** Doors this session may open; a closed door renders disabled with a tooltip. */
  readonly can: { readonly fire: boolean; readonly toggle: boolean; readonly edit: boolean }
}

/** The UI-only edge from the dispatcher to plan rank 0. Not a `Graph.EdgeReason`. */
export interface FiresEdge {
  readonly id: string
  readonly from: string        // TriggerNodeModel.id
  readonly to: string          // the first plan node id, e.g. "root.andThen"
  readonly reason: "fires"     // deliberately outside "value" | "continuation" | "failure"
  readonly label: "FIRES"
  readonly counted: false      // excluded from every node and edge count (D-031, D-032)
}

// ─── The one engine change this surface asks for ────────────────────────────
// `TriggerStore.setPending(fire: Fire)` takes no payload, so "Fire once with a
// different input" is NOT available today. The additive change, if Will wants
// the Trigger.dev-style replay:
//
//   readonly setPending: (
//     fire: Fire & { readonly inputOverride?: Json }
//   ) => Effect.Effect<void, TriggerError>
//
// persisted on the fire row and read by `Scheduler` into `StartInput.input`.
// `idempotencyKey(triggerId, occurrence)` is unchanged, so a retry of the same
// occurrence still replays the same launch.
```
```

### Interactions

- Click the trigger node → selects it and opens the panel on its last tab (default `Schedule`); the canvas re-centres by +84px so the node is not under the panel. `Esc` closes.
- `Enter` on a focused trigger node opens the panel; `P` is NOT bound (a trigger has no settlement to pin — n8n's `P` would be meaningless here and binding it would imply a cache story the object does not have).
- Tabs take single keys while the panel has focus: `s` Schedule, `e` Event, `c` Channel, `r` Runs, `i` Input. The active tab is written to the URL as `?tab=runs` so a panel state is linkable. A sliding `layoutId` underline moves between tabs.
- Typing in the CRON field re-validates after 250ms by calling `Cron.parse(text, timezone)` in the browser, rewrites the verdict line, and recomputes the Next-5 table locally so the preview moves as you type. The server confirms on save through `Trigger.make`, which runs the same probe.
- Changing the timezone recomputes both Next-5 columns and swaps the DST sentence. It does not re-validate the pattern — a valid pattern stays valid across zones; only `Invalid time zone in cron expression` can appear.
- `Save` on the Schedule or Input tab calls `register` with the current `revision`. A `revision_mismatch` refusal does not silently retry: the panel shows `This trigger changed while you were editing it.` with `[Reload]` / `[Overwrite]`, and `Overwrite` re-reads then re-registers.
- `Fire once` writes `setPending({ triggerId, occurrence: Date.now() })`, returns before the launch, and inserts a `null`-outcome cell at the right end of the strip. The toast carries `Occurrence queued · <triggerId>:<ISO>`. Repeated presses inside the same millisecond are the same occurrence and insert one cell.
- `Disable` / `Enable` act immediately with a 6s inline undo bar. Neither cancels a run in flight, and the bar says so when `activeRunId` is set.
- Hovering a history-strip cell opens a 3-line popover (`Today 8:00 AM` · outcome · run id). Clicking a cell scrolls the table to that row and expands it. Clicking a table row's `View run →` opens the run's trace card, replacing the panel body rather than opening a second window.
- `Older` pages the ledger with the store's real cursor (`HistoryQuery.cursor = nextCursor`), appending to the table. The strip stays at the newest 24 and never grows.
- Outcome filter: clicking a word in the tally line (`1 failed`) sets `HistoryQuery.outcome` and re-queries. Clicking it again clears. This is the only filter; a 14-chip filter row at our scale is MINIMAL TEXT violation by volume.
- The panel polls its own trigger every 2500ms while open and stops when the tab is hidden. New occurrences are PATCHED into rows already on screen; a new occurrence at the head is not auto-inserted into the table — a pill appears above it reading `1 new occurrence` / `N new occurrences` (capped `99+ new occurrences`), aria-label `New occurrences. Refresh to see them.` The strip, which is a summary rather than a list, does update in place. Polling stops entirely when the trigger is `disabled` and has no active run.
- `Ask the agent` chip drops its prefilled prompt into the left chat pane and focuses the composer without sending, so the person can edit it first.
- `Open source ↗` on a declared rule opens `.smithers/FACTORY.ts` in the code surface, anchored at the `on` key. On a live row with no declaration the link is absent, not disabled — there is no source to open.
- Right-click the trigger node → a 4-item context menu: `Open…`, `Fire once`, `Disable`, `Copy trigger id`. No `Delete` (the store exposes no delete), no `Deactivate` (that word means something else here), no `Replace` (it would be an edit routed through the re-key HUD, and a trigger has no key to re-key).
- Every gesture is also an agent act: `Fire once` is `triggers.run`, `Enable`/`Disable` are `triggers enable|disable`, `Save` is `triggers.register`. Nothing on this surface is user-only.

### Sample content

FOUR TRIGGERS, ONE CANVAS. Repo `tevm/tevm-monorepo`, flow `morning-triage`.

── 1. The demo trigger (cron, live, armed) ──────────────────────────────

TriggerSummary:
  triggerId            "morning-triage-0800"
  flowId               "morning-triage"
  input                { "repo": "tevm/tevm-monorepo", "label": "triage" }
  cron                 "0 8 * * 1-5"
  timezone             "America/New_York"
  overlap              "skip"
  catchUp              "none"
  maxCatchUp           0
  enabled              true
  revision             7
  lastFiredAtMs        1758196800000   (Thu 18 Sep 2026, 08:00 EDT)
  activeRunId          undefined
  pendingAtMs          undefined
  nextOccurrencesMs    [1758283200000, 1758542400000, 1758628800000,
                        1758715200000, 1758801600000]
  schedulerLastTickMs  1758211320000   (2s ago)

Node reads:
  ⏱  Weekdays, 08:00
     dispatcher/cron
     next in 4h 12m
     [trigger] [America/New_York]                         armed

Panel, Schedule tab:
  CRON pattern            0 8 * * 1-5
  Valid pattern: Every weekday at 08:00 America/New_York
  Timezone                America/New_York
  This will automatically adjust for daylight savings time.

  Next 5 runs
  ┌──────────────────────┬──────────────────────────────┐
  │ America/New_York     │ Europe/London (your clock)   │
  ├──────────────────────┼──────────────────────────────┤
  │ Fri 19 Sep  08:00    │ Fri 19 Sep  13:00            │
  │ Mon 22 Sep  08:00    │ Mon 22 Sep  13:00            │
  │ Tue 23 Sep  08:00    │ Tue 23 Sep  13:00            │
  │ Wed 24 Sep  08:00    │ Wed 24 Sep  13:00            │
  │ Thu 25 Sep  08:00    │ Thu 25 Sep  13:00            │
  └──────────────────────┴──────────────────────────────┘

  Overlap      skip · an occurrence while a run is in flight is dropped
  Catch-up     none · nothing is owed after downtime
  Scheduler    local polled 2s ago
  Revision     7

Panel, Runs tab:
  Last 24 occurrences              20 completed · 2 launched · 1 skipped · 1 failed
  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯▮▮▮▮▮▮▮▮▮
  ↑ oldest                                              newest ↑

  Yesterday 8:00 AM   completed   r_8c21f4     View run →
  Sep 17 8:00 AM      completed   r_8b04a9     View run →
  Sep 16 8:00 AM      failed      r_89f120     View run →
     └ Control could not launch the scheduled run
  Sep 15 8:00 AM      skipped
     └ a run was still in flight and overlap is skip
  Sep 12 8:00 AM      completed   r_871cc3     View run →
                                                          [ Older ]

Panel foot:
  [ Fire once ]   [ Disable ]                          Open source ↗

── 2. Event trigger (declared, read-only) ───────────────────────────────

FactoryRule:
  { "event": "issue.labeled:triage",
    "flow": "morning-triage",
    "description": "Triages the issue the moment it is labelled" }

Node reads:
  ⚡  On an issue labeled triage                   [declared in code]
     dispatcher/event · runs morning-triage
     [trigger]

Panel, Event tab:
  Event         issue.labeled:triage
  Means         On an issue labeled triage
  Starts        morning-triage
  Visible as    Triages the issue the moment it is labelled
  Declared in   .smithers/FACTORY.ts                      Open source ↗

  ⓘ Editing declared rules
    This rule is declared in .smithers/FACTORY.ts. Edit it there and the
    canvas re-derives.

── 3. Webhook trigger (live channel) ────────────────────────────────────

Node reads:
  🔗  Webhook github-issues
      dispatcher/webhook · runs morning-triage
      [trigger]                                            armed

Panel, Channel tab:
  Channel       github-issues
  Starts        morning-triage
  Credential    github-webhook-secret
  Verified by   x-hub-signature-256

  A refused request is recorded as:
    webhook signature in x-hub-signature-256 did not verify

── 4. The state that sells the surface (no scheduler) ───────────────────

Same trigger as (1), but `schedulerLastTickMs` is 41 minutes old.

Node reads:
  ⏱  Weekdays, 08:00
     dispatcher/cron
     nothing is polling this store
     [trigger] [America/New_York]                   no scheduler

Panel status line:
  ● no scheduler · last fired Yesterday 8:00 AM        What happened here?

Panel, Schedule tab, Scheduler row (in --danger):
  Scheduler    local last polled 41m ago
               Run `smthrs triggers serve` to fire schedules.

The Next 5 runs table still renders its five dates, unchanged and
unstyled, with one line above it in --danger:
  These are the times it would fire. Nothing is running to fire them.

── 5. The unsatisfiable cron (typed while editing) ──────────────────────

Field: 0 0 30 2 *
  Invalid pattern: cron expression '0 0 30 2 *' has no next occurrence
  (no Next 5 runs table renders)

── 6. The empty canvas ──────────────────────────────────────────────────

  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
  ╷  Nothing fires       ╷ ┊
  ╷  this flow           ╷ ┊ ···>  ▌ List new issues
  ╷  [ Register a        ╷ ┊
  ╷    schedule ]        ╷ ┊
  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘

With no registrar on the workspace the button is replaced by:
  A schedule cannot be registered on tevm/tevm-monorepo from here yet:
  this workspace has no repository/trigger flow.

### Risks

- `Fire once` with an editable payload is NOT in the engine. `TriggerStore.setPending(fire: Fire)` takes `{ triggerId, occurrence }` and nothing else; `Scheduler.idempotencyKey` is derived from the occurrence alone. The brief asks for 'a Test run affordance with a payload editor' and the honest version is two separate acts — edit the stored `input` (a `register`, revision 7 → 8), then `Fire once`. If someone builds the Trigger.dev dialog with an ad-hoc payload field, it will silently fire the SAVED input and the demo will lie on stage. The additive engine change is written in `dataShape`; it needs Will's ruling before any UI implies it.
- `parked on quota` is a run state wearing a trigger's clothes. `@smthrs/triggers` has no quota concept and `TriggerSummary` carries no quota field. Drawing it on the trigger node requires joining `activeRunId` to `flows_runs.waiting_reason` / `waiting_wake_at_ms`, which no projection serves today (the same gap as D-020). Either the panel joins two reads, or the state is cut from this round and the node says `fired` with the run card carrying the park. I chose to spec it because the brief named it — but it is the one state whose data path does not exist.
- There are no environments, and pretending otherwise would be inventing a product noun. I searched `packages/smithers/control/src` and `packages/smithers/gateway/src` for an `Environment` type and there is none. Our two real axes are (a) `declared` vs `live` — the `.smithers/factory.json` `on` table read from the public mirror versus the box's own trigger store, which the shipped seam says must never be mixed — and (b) `GatewayWorkspaceId`, one box per branch. If someone reads Trigger.dev's Prod/Staging/Dev and ships a segmented control, they have shipped a concept the engine cannot back.
- Copying Trigger.dev's cron tooltip verbatim would ship a false grammar. `effect/Cron.parse` supports 5 or 6 segments, `*`, lists, ranges, steps and jan-dec / sun-sat aliases. It has NO `L`, NO `#`, NO `?`, NO `W` and NO `@daily` macros, and its day-of-month / day-of-week rule is OR-when-both-restricted. The `ⓘ` body in this spec is read off `node_modules/effect/src/Cron.ts`, not off a cron cheat sheet. Any copy that says `"L" means the last.` is a bug.
- A zone the declaration did not name must not render as `UTC`. `Schedule.timezone` is optional and `Cron.parse(expr, undefined)` resolves against whatever zone the scheduler host runs in. The shipped `TriggerEvents.ts` already refuses to print an undeclared zone for exactly this reason. Rendering `UTC` would make a trigger that fires at 08:00 in Frankfurt look like one that fires at 08:00 in London.
- The history strip has no durations and must not grow any. `FireSummary` carries `occurrenceAtMs`, `outcome`, `runId?`, `error?`, `waiting?` — no start, no finish. A Vercel-style variable-height bar chart would have to source durations from `run-summary` per row, which breaks the moment `pruneFires` has removed settled rows or the run store was rotated. Fixed-height cells coloured and patterned by outcome are the honest strip. If Will wants duration bars, that is a join and a projection, not a CSS change.
- `Graph.EdgeReason` has exactly three members and `fires` is not one of them. The `fires` edge is UI-only (D-031). If it ever enters an edge count, a `Graph.build` round-trip, or the plan digest, the trigger becomes a plan node and D-031 is broken. The canvas count chip must read `13 plan nodes · 11 executed` with the trigger outside the dispatcher hairline — the exact figure D-032 says the first mock got wrong.
- A trigger must never render `built`, `clean`, `skipped`, `dirty` or a `0ms` chip. It has no step key, so it is never a cache hit and a re-run never re-fires it. The shared node component makes this easy to get wrong: if `FlowNode.tsx` keeps one `STATE_WORD` map for every kind, someone will eventually pass `clean` to a trigger. Give the trigger its own state union (`TriggerState` in `dataShape`) so the compiler refuses.
- The 2500ms poll plus a 1000ms scheduler tick means the `firing` window (claim written, run id not yet reported) is often shorter than one poll and will frequently be invisible. That is acceptable — the state exists for the pathological case, where a launch reservation sits for up to `reservationLeaseMs = 300000`. But do not tune the poll down to try to catch it; catch it with the lease-expired treatment instead.
- `waiting on approval` is bounded and the panel must not imply otherwise. `Scheduler.parkedAttempts = 8` with a delay doubling from 1s abandons an unapproved plan a little past two minutes, and the fire settles `failed` with `Control plan <planId> is still parked awaiting approval after 8 attempts`. A panel that shows `waiting on you` indefinitely, with a `Review approval →` door that leads to an approval the scheduler has already given up on, is worse than showing nothing.


---

# Round 2 — critiques of the surface specs

## Fidelity critic

Three of the five specs are drawn against a left-to-right canvas the repo abandoned five decisions ago — Canvas.tsx:32 is `rankdir: "TB"` and D-034 RULED it. Every geometry number in the Canvas/Run-Rail spec (the 202px band, the 452/360 split), the Trigger spec (the left dispatcher gutter, rank -1, minlen 2) and the Library spec (the 16x430 vertical merge bar, the per-rank compact/fold thresholds) is derived from LR and transposes wrong. Separately, two specs build a node-detail pane on Inspector.tsx (336px), which App.tsx does not mount: the live drill-in is Drawer.tsx at 440px with ten tabs, maximize, a code tab with line ranges, a frames tab with model events and usage, a questions tab with probability bars, attempts, events and cache provenance. Roughly 70% of the Node Inspector spec and 60% of the model peek already ship; both propose a third and fourth container for the same pane at 420px and 720px. The taste problem is one thing repeated everywhere: engine lore leaking into the UI — `Refreshable  no - a static credential stays terminal on a 401`, `This will automatically adjust for daylight savings time.`, `Deferred - runnable, postponed by a scheduling guess. Never a pass.`, a 14-line CRON grammar table inside a tooltip. That is the engineering doc wearing a pane, and it is exactly what AGENTS.md MINIMAL TEXT bans. Fix the layout premise, collapse to one drill-in pane, delete the lore, and this beats n8n and Trigger.dev side by side on three pictures they cannot draw: the re-key HUD, an 8-agent bounded fan-out, and a `no scheduler` trigger.

### Blocking

- **Canvas & Run Rail** — The whole spec is sized against a left-to-right graph. `Canvas.tsx:32` sets `rankdir: "TB"`, ranksep 54, nodesep 30, and D-034 RULED top-to-bottom. Under TB, morning-triage's 13 nodes over ~9 ranks is 9x88 + 8x54 = 1,224px tall and ~486px wide. The graph already overflows vertically; it is not starving in 812px of dots. The stated justification for stealing 360px for a run rail is inverted. **Fix:** Re-derive the split against TB before writing a line: the graph region needs MORE height, so the rail's default snap is `closed` (32px header) and `open` is a 240px overlay, not a 360px co-tenant. If Will wants LR back, overturn D-034 explicitly first and re-run the arithmetic in D-034's own terms (a rank costs 142px vertically, 314px horizontally).
- **Trigger node + panel** — Specifies `rankdir LR, ranksep 86, nodesep 26`, a 260x88 node at rank -1, a left DISPATCHER GUTTER, a vertical dotted hairline and a horizontal FIRES edge. Under the shipped TB layout the dispatcher sits ABOVE rank 0, the hairline is horizontal, the `fires` edge runs down, and the left half-capsule (`border-radius: 44px 0 0 44px`) points the wrong way. **Fix:** Transpose: gutter band above rank 0, horizontal hairline with its caption at the right end, top half-capsule (`44px 44px 0 0`), kind rail on the cap's bottom edge, vertical `fires` edge with a counter-scaled label. The silhouette idea survives the transpose; the coordinates do not.
- **Flow library / example switcher** — The dagre block (`rankdir: "LR", ranksep: 96, edgesep: 14`) and layout pass 2 are LR-only. The merge-bar stretch computes `top = min(pred.y)`, `height = bottom - top`, rendering a 16px-wide, 430px-tall bar across a vertical rank. Under TB a rank is horizontal, so that bar becomes 430 wide and 16 tall and the `Node.all` caption floating 8px to its right lands on the next rank. The compact (>=5) and fold (>8) thresholds are keyed to vertical rank height too. **Fix:** Transpose the pass-2 stretch to span x, move the caption below the bar, and derive the compact threshold from measured rank WIDTH after `dagre.layout` — the spec already says to measure rather than count, so honour that in the transposed axis.
- **Node Inspector + model drill-in** — Both target `.inspector` / `Inspector.tsx`. `App.tsx` imports `Drawer`, not `Inspector` — Inspector.tsx and its CSS block (app.css:441) are dead code. The live pane is `.drawer` at 440px (app.css:618) which already does full-screen via `.drawer[data-max="true"] { inset: 0 }`. The Inspector spec re-specs it at 420px with a bespoke clip-path transition; the model spec re-specs it at 720px with `data-width="wide"`. Three widths, two maximize mechanisms, one pane. **Fix:** One contract: `.drawer`, 440px, resizable, existing `data-max`. The model peek is not a container — it is the Drawer's tab set when the selected node called a model. Delete Inspector.tsx and its CSS in the same pass.
- **Node Inspector — Code tab** — Stratum B ships `No line: the engine hashes this node's source and keeps only the digest.` and asserts `A mock that draws flow.ts:42 is lying.` D-037 RULED the opposite: a non-hashed `declaredAt {path, line}` ships on an additive `graph` field outside the digest, with Dagster's LocalFileCodeReference as prior art. Drawer.tsx already renders `L{range[0]}-{range[1]}` and highlights the range in CodeView. Building stratum B deletes a shipped feature to honour a constraint Will overruled. **Fix:** Keep the line range and the highlight. Stratum C (`digest only` plus the ephemeral-nonce warning) still earns its place for a cell with no declaration site. Cut stratum B's gap line and its `Find "proc/spawn"` fallback button entirely.
- **Node Inspector — tab strip** — Proposes nine tabs led by `Input`, plus a new `Declaration` tab. D-035 RULED the order: kind-specific first (Schedule/Frames/Questions/Question), then Output · Input · Code · Key · Attempts · Events, and `Drawer.tsx:tabsFor` implements exactly that. Reordering breaks a ruling and a shipped component for no stated gain. **Fix:** Keep D-035's order. The Declaration rows ARE key material — `tier, body, inputs, layers, capabilities, effects, placement, nondeterministic` is the StepKey.content field list — so fold them into the Key tab beside the block it already renders, with the keyed/free column there. That kills a tab and strengthens the one tab that sells the product.
- **Flow library — class chips** — The spec's own rule is `primitive = one @smthrs/patterns constructor drawn bare`. MapReduce.ts, Saga.ts, Escalation.ts and ReviewLoop.ts all exist as single constructors in packages/smithers/flows/patterns/src/. By that rule 4 of 5 rows are primitives, `Composites` counts 0, and the spec says a 0-count chip does not render. The four-chip filter collapses to two chips over five rows, and the sample copy labelling package-migration `composite` and implement-issue `primitive` contradicts the rule three lines above it. **Fix:** Delete the chips. Five rows need no filter. The class word on the row carries no information at n=5 either — cut that too.
- **All five — fixture drift** — The same fact has four values. Cache provenance is `served from run r_8f2c41 - event #412` in the shipped Drawer.tsx, `r_8c21f0 - event #1447` in the Inspector spec, `r_8c21 - event #1447` in the Canvas and model specs. The re-key consequence is `Re-run 3 nodes - 8 cache hits - 4.9s` (Canvas), `Re-run from here - 3 re-run - 8 clean` (Inspector) and `3 re-key - 8 clean - 2 skipped` (Key tab). A demo that screenshots two surfaces shows two numbers for one run. **Fix:** One fixture module. Pin one run id, one event seq, and one re-key string (`3 re-run · 8 clean · 2 skipped · 4.9s against 1h 1m`, per D-032's honest figures) and import it everywhere. Same for the trigger's r_8c21f4.
- **All five — MINIMAL TEXT** — About forty rows carry an explanatory clause instead of a value. Worst: `Refreshable  no - a static credential stays terminal on a 401`; `Retries  none - the caller decides whether a failure is worth a second request`; `Tools declared  none - the cell-first controller opens every turn with tools: [] and toolChoice: "none"`; `publicHeaders refuses any route header matching the credential matcher, so this view is credential-free by construction.`; `Deferred - runnable, postponed by a scheduling guess. Never a pass.`; `This will automatically adjust for daylight savings time.`; `Overlap  skip - an occurrence while a run is in flight is dropped`; a 14-line ASCII CRON field table inside a tooltip. **Fix:** One pass over every string with one test: does deleting the clause change what the user does next? `Refreshable  no`. `Retries  none`. `Overlap  skip`. Move the grammar table to docs and leave the validity sentence. Keep exactly three lore lines in the whole product — the ones stating a fact the value cannot: `one-hot` confidence provenance, `ordering only · not part of the key`, and the pinned-and-re-keyed row.
- **Canvas & Run Rail — cost estimate** — The spec says the rail 'is NOT new code. RunTraceCard.tsx is 797 lines already shipping.' True of apps/app, false of the mock. docs/flow-builder/mockups/source/src has seven components and no RunTrace anything — the mock is a standalone vite bundle. The rail is ~400 lines of new code here. **Fix:** Price it as new. That moves it below the hover toolbar, the edge peek and the trigger silhouette in the build order, all of which are hours.

### Missing

- Real-life workflow examples. The user asked to use patterns.smithers.sh examples 'as inspiration for built ins or if they are not primitives to show as examples'. The library ships five rows of which exactly ONE (morning-triage) is a repository job; the other four are pattern constructors wearing job names. 28 patterns exist in packages/smithers/flows/patterns/src/ — Kanban, MergeQueue, Quarantine, DriftDetector, Runbook, ScanFixVerify, Debate, Optimizer. Add three more named jobs (a merge queue, a drift sweep, a flaky-test quarantine) so the 'use case' half of the library is not one row.
- The agent drafting act. D-029 RULED the vision is 'an agent walking you through building', the user asked to look at 'how agent ui works', and FlowNode.tsx already renders a presence cursor (.fl-node-cursor). None of the five specs touches act 1. The one differentiator no competitor has — a peer drafting the graph while you watch — gets zero design in a round of five specs.
- Predictions. D-030 is RULED and already shipping: FlowNode.tsx renders `~{p50}` on a pending node and `of ~{p50}` on a running one; Drawer.tsx renders `p50 of {samples}`. Four of the five specs drop it entirely and the Inspector spec mentions it once in an idle state. Building these as written regresses a ruled feature. Every new node geometry, every drill-in header and every library row needs a prediction slot.
- The code-to-graph round trip. The user's exact ask is 'a really high quality way of drilling into things and seeing the actual code.' Today code is per-node and one-directional. Missing: click a line in the Code tab and the node that owns it selects on the canvas, plus a whole-flow code view with every node's range marked in the gutter. Neither n8n nor Trigger.dev can draw that, and the fixtures (FLOW_SOURCE.ranges, AST_PATH in source.ts) already exist.
- Light-theme values for every new treatment. figures/07-light.png exists and the shell toggles theme. Marching tiles at 30% opacity, a 38%-opacity stream legend, hollow distribution bars and 55%-opacity below-floor answers are dark-tuned, and no spec states a light value. Half the screenshots will be wrong.
- The comparison shot. What is being sold is 'better than n8n and Trigger.dev side by side', and two specs name the beat in prose (n8n's `Node configuration changed. Output data may change when this node is run again` against our `3 re-run · 8 clean`) but nobody ships it as a figure. One side-by-side is worth more demo minutes than the sticky-note, lanes and conflict-edge budget combined.
- One populated screen. Every spec draws its own surface alone. There is no shot where canvas, drill-in and rail are live at once at the real shell size — `.split` is `minmax(340px, 35fr) 65fr`, which the Canvas spec calls 476/1124 and the Library spec calls ~900 wide. Two specs, two shells.

### Cut

- Sticky notes (⇧S). The spec ranks itself 'the least defensible item' and D-015 already says the card payload struggles past 30 union members. Cut, do not defer.
- Placement lanes (L). Every flow in library.ts is single-placement, so the toggle renders disabled with `One placement - nothing to lane` on every demo. A control that is always disabled is chrome.
- Conflict edges. The spec concedes 'most demo flows have zero conflicts, so this may never appear in a screenshot.' Building a relation for a screenshot that does not exist is solutionism. Keep the idea in decisions.md until a flow has a real serialize pair.
- The 13-tag stream legend rendered always, absent tags at 38%. Thirteen mono words above an 8-row list to encode absence. Show the tags present; the absence is visible in the list.
- The boolean two-sided floor diagram (`false |---|----@--| true` with hairlines at 0.15 and 0.85). One question type, on one node, on one flow, costing a bespoke chart. Show the number and the floor.
- The CRON grammar tooltip — the six-line field table plus three sentences of range/step/OR semantics. Ship the verdict line; the grammar belongs in docs.
- The library search field, its `<mark>` highlighting and the `/` refocus binding, at n=5. Keep L, ↑/↓, Enter and [ / ].
- `Sync selection with canvas`, shipped disabled with `Not joined yet - the plan graph and the trace name nodes differently`. D-036 supersedes the D-020 reason it cites, and a dead switch with an excuse reads as broken, not principled.
- The three-counter retry ladder in the model Failure tab (inner attempts + transport-failure rebuild count + outer re-issues + four lines of prose). Two counters: `attempt 2 of 3` and `re-issue 0 of 1`.
- Overlap / Catch-up consequence sentences in the trigger panel. `Overlap  skip`. `Catch-up  none`. The six-word gloss is prose beside a value.
- The `Fire once` engine-gap essay — tooltip, two honest moves, and a proposed setPending signature rendered in the pane. Either the button queues the stored input with no commentary, or it is absent. The engine ask belongs in decisions.md.
- The `+6 more` fold stack card. No flow in library.ts or in the four proposed flows has a rank above 8 — `mapReduce(concurrency=4)` draws two 4-wide ranks by construction, which the spec itself argues is the point. Build the compact rule; skip the fold.

### Build order

1. 0. Resolve the layout premise. Confirm D-034 (TB) stands, then transpose every geometry in the Canvas, Trigger and Library specs. Nothing else starts: three specs' numbers are wrong until this lands.
2. 1. Collapse the three drill-in specs into one Drawer contract. Delete Inspector.tsx and app.css:441-541. Keep 440px plus the existing data-max, D-035's tab order, and the shipped line ranges (D-037). Fold Declaration into Key. Largest reduction in work, largest gain in consistency.
3. 2. Node hover toolbar and context menu. FlowNode.tsx already renders three dead icons in `.fl-node-tools`. Making them real plus the menu is the most recognisable n8n interaction and it is hours, not days.
4. 3. Edge peek card — 220x64, 250ms dwell, reason plus declared type plus bytes/outcome. n8n's best canvas detail, and ours carries a typed value theirs cannot. Cheap.
5. 4. Trigger silhouette, dispatcher gutter, `fires` edge and the `no scheduler` state. TRIGGER in detail.ts already holds the fixture and the Schedule tab already renders; what is missing is the picture that says 'not a plan node' and the one state no competitor draws. Half a day.
6. 5. `package-migration` — MapReduce, 8 shards, two 4-wide batches, one parked shard. The concurrency-bound fan-out is the only genuinely new picture in the five specs and the shot n8n structurally cannot take. library.ts's node()/edges() helpers make it a data file.
7. 6. Model chip on the node (kind glyph plus protocol glyph, colour-free) and the model peek as Drawer tabs over the existing FramesTab data. Answers 'multiple types of model' with a shape, not a pane.
8. 7. Code-to-graph round trip: click a line, select the node; mark every node's range in the gutter. The user's literal ask, and source.ts already holds the fixtures.
9. 8. Run rail, re-sized against TB, defaulting to `closed`. Price it at ~400 new lines in this bundle. Highest ceiling, highest cost.
10. 9. Library popover — rows, thumbnails, tier bar, kind glyphs. No chips, no search. The existing .flowpick menu is the starting point.
11. 10. Copy pass. Every string against the one test in blocking item 9, plus the shared fixture module. Before screenshots, not after.

## Taste critic

These five specs are unusually well-grounded — the model package (13 ModelEvent tags, PreparedRequest, ModelError fields, RequestExecutor's MAX_RETRIES=2 / BASE_DELAY_MS=500 / rebuildAfter=3, Classifier.confidence's one-hot fallback, Evaluator.defaultTimeoutMs=1500, and Evaluator.Response.confidence "for a choice and a score and never for a boolean"), the trigger constants (nextOccurrenceCount=5, parkedAttempts=8, reservationLeaseMs=300000, defaultHost="local"), the pattern labels (Compose.label at internal/Compose.ts:397 really does mint "escalation(rungs=3, fallback=true)" and "saga(steps=a,b,c, onFailure=compensate)" character for character), Bounded.all's accumulator, GraphBuildError's 12 codes, flows_plan_edges' three columns and flows_attempts' PK all check out verbatim. But six things are invented or contradict a RULED decision and must not be built as written. The worst is structural: three of the five specs lay the graph out left-to-right, which D-034 ruled against and the shipped mock (Canvas.tsx:30, rankdir "TB") already obeys — every width and height number in spec 1's rank-height guarantee, spec 4's dispatcher gutter and spec 5's band arithmetic is computed against a layout the product does not use. The second worst is quieter: no plan node has a human title anywhere in the engine, and all five specs print one on every card.

### Blocking

- **All — specs 1, 4, 5 (dagre config)** — rankdir "LR" contradicts D-034 RULED ("The graph lays out top to bottom"), and the shipped mock is already TB: docs/flow-builder/mockups/source/src/components/Canvas.tsx:30 reads `graph.setGraph({ rankdir: "TB", ranksep: 54, nodesep: 30, marginx: 48, marginy: 48 })`. D-034's reasoning is explicit — 228x88 nodes make a rank cost 142px vertically and 314px horizontally, so an unrolled reviewLoop is readable TB and a 0.3-zoom ribbon LR. Every derived number is therefore wrong: spec 1's GEOM block, ranksep 96 / nodesep 18 / edgesep 14, the merge-bar vertical stretch, the '4x88 + 3x26 = 430 graph px' rank-height guarantee; spec 4's 172px dispatcher gutter left of rank 0 and its 260x88 half-capsule; spec 5's 452px graph region sized against a 202px tall horizontal band. **Fix:** Re-derive all three layouts against rankdir "TB". The merge bar becomes a horizontal join bar stretching across its predecessors' x-span, not a 16px vertical bar. The dispatcher gutter becomes a top band with a horizontal hairline. Spec 5's whole 'wasted vertical band' premise disappears — D-034 says TB already ended it — so the rail split needs a new justification or it is unmotivated. If LR is genuinely better for these five flows, get D-034 overturned in decisions.md first and say why; do not ship three specs that silently revert a ruling.
- **All five — every node card and every sample** — Node titles are invented. `Plan.PlanNode` (plan/src/Plan.ts:143-153) is exactly {id, kind, key, material, effects, dependsOn, conflicts, strategy, runtime, priority, generation} — no title, no label, no description. `Action` (flow/src/Action/Action.ts:116-137) carries `name` and `annotations` and nothing human. `RunTreeRow.label` is `call.flowName` (GatewayProjection.ts:422), and `cardLabel` survives only as a comment about the old wire. So "Write the failing test", "Reproduce the bug", "Triage each issue", "Squash into one change", "Take it manually?" and the per-shard "@smthrs/core" titles have no source. Spec 2 compounds it by listing `title`, `description` and `lane` as Declaration-tab rows in the `free` column — none is an Action member. **Fix:** Pick one and state it in every spec. Either (a) a node's two lines are `Action.name` in mono plus the structural id (`root.then.andThen`), which is what the engine actually has; or (b) `title` is a PROPOSED non-hashed field riding D-037's additive optional `graph` field on the PlanCard — the same carrier D-037 already blessed for `declaredAt` — badged as a proposal in every mock. Delete `title`/`description`/`lane` from spec 2's Declaration field list and move `priority` to the PlanNode section where it belongs.
- **Spec 2 — Node Inspector, Code tab** — It contradicts D-037, which is RULED. Spec 2 builds its whole Code-tab honesty mechanism on "No line: the engine hashes this node's source and keeps only the digest" and "A mock that draws flow.ts:42 is lying", then demotes source location to a PROPOSED side table `flows_plan_node_sources(plan_id, node_id, ...)`. D-037 ruled the opposite, explicitly because Will asked for "a really high quality way of drilling into things and seeing the actual code": a non-hashed `declaredAt {path, line}` ships, "carried beside the plan (never inside KeyMaterial, or every edit would re-key everything), plus typed edge reasons from Graph.build. Both ride an additive optional `graph` field on the PlanCard, outside the digest an approval binds to." The side table is also the wrong carrier. **Fix:** Rewrite stratum B: badge `flow file`, header `flows/morning-triage/flow.ts`, a real marked line from `declaredAt.line`, breadcrumb `root > then > andThen`. Keep the gap line verbatim ONLY as the fallback when `declaredAt` is absent (legacy plans, plans built before the lane lands). Delete the `flows_plan_node_sources` proposal and cite D-037's PlanCard `graph` field. Spec 5's Open-code button (stratum b, "the node id as a segmented AST path and no fake line marker") needs the identical correction.
- **Spec 4 — Trigger node + panel** — It unifies four engine objects that are not one object. `Trigger` (triggers/src/Trigger.ts:58-64) is `{id, flowId, input, ...Schedule.Schedule.fields, enabled}` and `Schedule.cron` is `Schema.NonEmptyString` — REQUIRED (Schedule.ts:67). There is no event trigger, webhook trigger or manual trigger row anywhere in the store. `event` is a `FactoryRule` read off `.smithers/factory.json` (`{event: z.string().min(1), flow, description?}`) with no store row, no `revision`, no `enabled` and no fire ledger. `webhook` is a `Channel {name, verify}` in a different module. So for three of the four `TriggerKind`s, `TriggerNodeModel.summary?: TriggerSummary` cannot exist, the Runs tab has no `FireSummary` rows to page, and `Fire once` / `Disable` / `Enable` / `Revision` have nothing to write to. **Fix:** Split the model. `TriggerNodeModel` keeps `kind: "cron"` and the whole live half (summary, fires, cursor, scheduler, revision, foot actions). Add a separate read-only `DeclaredRule` shape for factory `on` rows: Event tab only, no Runs tab, no Input tab, no revision row, no `Fire once`, no `Disable`, foot = `Open source` only. Add a separate `ChannelNode` shape: Channel tab only. Spec 4 already writes the right copy for the declared case (the `Editing declared rules` InfoPanel); it just has to stop giving those rows a cron trigger's chrome.
- **Spec 4 — the `firing` state and its lease-expired treatment** — The predicate is unreachable from the data the spec names. `DispatchReader.ts:88` builds the summary as `...(held.activeRunId === undefined || isReservation(held.activeRunId) ? {} : { activeRunId: held.activeRunId })` — reservations are stripped. `ControlSchema.ts` says so in words: "`activeRunId` names the run the trigger is currently holding, and is absent while the trigger holds a reservation rather than a launched run." So `isReservation(summary.activeRunId)` is never true, and the `firing` word, the marching-tile cap texture, the travelling-dot pulse on the `fires` edge and the `launch reservation expired - retrying` caption can never render. **Fix:** Cut `firing` from the precedence ladder (ten words become nine) and delete the lease-expired treatment; OR add `reserved: boolean` to `TriggerSummary` in `DispatchReader.summarize` first and name that as an engine change the spec depends on. Do not spec a state the projection deliberately deletes. Spec 4's own risk note already says the firing window is usually shorter than one poll — that is the stronger argument for cutting it.
- **Spec 5 — edge classification rule** — The rule mislabels conflict-ordering edges as continuations, and spec 5 then draws the same relation twice under two names. `flows_plan_edges` is written straight from `node.dependsOn` (PlanStore.ts:172-175), and `Plan.PlanNode`'s own doc says `dependsOn` is "material references, any ordering edge a `serialize` verdict added, and the reader-after-writer edges that put a node behind whoever produces the paths it reads." Spec 5's rule — "`continuation` iff X in dependsOn and the only reference to X is `Pending{from: X}`, or there is none" — catches every serialize and reader-after-writer edge in that second clause and paints it `continuation`, while the same spec promises to draw those pairs as dotted conflict edges labelled `serialize` / `lane` / `fail`. **Fix:** Add a fourth derived reason, `ordering`: a `dependsOn` entry that appears in no `material.inputs` ref AND matches an entry in this node's `conflicts[].with`. Draw it as the dotted conflict edge (its existing treatment) and exclude it from the `continuation` bucket. State in the spec that `EdgeReason` stays the engine's three words (Graph.ts:83) and that `ordering` is a UI-only fourth, exactly as `fires` is.

### Missing

- D-020 is superseded and three specs still cite it as the blocker. D-036 RULED (Round 6) that the production host serves no plan graph AND no node events: `NativeControl.durableFlow` has no `plan` hook so `PlanCard.nodes` is always `[]`, `PlanScheduler` — the only emitter of `node-*` records — has no production caller, the `Interpreter` that does run emits no journal records, and live status folds app-side from `run-events` "which supersedes D-020's separate plan-graph selector." Replace every "blocked on D-020" line in specs 2 and 5 (and the `Sync selection with canvas` tooltip) with D-036's two named engine changes: the plan hook, and Interpreter node events through a `FlowRuntime.recordNode` seam.
- `node-output` cannot say the five settlement words. `NodeOutputRow` is `{runId, nodeId, outcome: Schema.Literals(["success","failure"]), output: Schema.String, settledAt}` (GatewayProjection.ts:156-162). Spec 2's Output header promises `built` / `clean` / `failed` / `skipped` / `deferred` verbatim as the first word. Say that word comes from `flows.engine.node-settled`, never from the served projection, and drop the `[Schema][Table][JSON]` toggle for step nodes — spec 2's own risk already concedes `output` is a rendered string.
- `clean` is not always a cross-run cache hit. PlanScheduler.ts:104-107: "`clean` — a recorded result served it and no executor ran. This includes same-run durable attempt replay for every tier, and shared-cache hits for eligible sealed work. It does not assert cross-run cache eligibility." Specs 1, 2, 3 and 5 all render `clean` as the word `cache hit` plus `served from run r_8c21 - event #1447`; a same-run replay has no other run to link to. Gate both on a `flows.engine.cache-provenance` record whose reason is `hit` (ActionPersistence.ts:1441 emits `cacheSource("hit", recorded)`; the other reasons are `expired`, `ttl`, `replay_failed`, `unpublished:<reason>`). Otherwise the word is `clean` with `0ms` and no origin link.
- Spec 2's Key-tab material block has the wrong capabilities shape and reads fields the plan row does not store. `ContentIdentity.capabilities` is `Readonly<Record<string, ReadonlyArray<string>>>` (StepKey.ts:239), so the sample's `capabilities: { declared: { fs: [...], model: ["call"] } }` is wrong — copied verbatim from apps/app/src/mainview/experimental/panes/Plan.tsx:51, which carries the same defect and should be fixed upstream. Worse, `KeyMaterial` (what flows_plan_nodes.node_json decodes to) is `{version, kind, nondeterministic?, body, inputs, layers, capabilities, effects?, placement?}` — it has no `environment` and no `hermetic` field at all, so a Key tab reading the plan row cannot reconstruct that block. Print `capabilities: { fs: [...], model: ["call"] }` and mark environment/hermetic as dispatch-identity facts, not stored material.
- Two seat vocabularies inside one round. Spec 1 uses `implementation`, `trivial-implementation`, `orchestrator` — the real `AgentRole` ids (packages/rpc/src/AgentRoles.ts:54-59; the full set is orchestrator / explainer / implementation / trivial-implementation / ui / fast-ui). Specs 2 and 3 put `coding/implement` in the seat slot, which is not an AgentRole id and not anything else in the repo — it reads as an Action name. Spec 3's own risk names the `Seat.Seat` vs `AgentRole` collision and then commits it in every sample. Pick the AgentRole id for `Seat.Seat["id"]` everywhere and never render an Action tag in the seat slot.
- `describeSchedule` never returns spec 4's sample string, and is five-field only. TriggerEvents.ts:48 returns the fallback (`On the schedule <cron>`) for anything that is not exactly 5 fields, while spec 4's cron tooltip — correctly read off effect/Cron — advertises 6 segments. And the sample node reads `Weekdays, 08:00`, which the function never produces: it returns `Every weekday at 08:00 America/New_York`. Use the real string in the sample, and either widen `describeSchedule` to 6 fields upstream or state in the tooltip that a 6-field expression loses its English sentence.
- The `callbackIdentity` risk is overstated in specs 2 and 5. Interpreter.ts:837 already defaults it: `makeLayer(flow, { ...options, callbackIdentity: options.callbackIdentity ?? "stable" }, true)`. The real ephemeral path is an un-captured mapper or continuation — plan/src/internal/node.ts:623-625 picks `sha256-source-ephemeral/v4` when ANY identity in the set is ephemeral — which is an authoring fact, not an app build-option fact. Rewrite the Code tab's ephemeral warning and spec 5's risk accordingly; "declare its captures with Node.capture" is the actionable sentence, not "verify the app passes stable".
- `FactoryRule.event` is `z.string().min(1)`, not a literal union (packages/rpc/src/FactoryProjection.ts:43-47). The eight-key vocabulary lives in a doc comment and in `describeEvent`'s fallback (`return key`). Spec 1 types `readonly event: FactoryRule["event"]` as if it carried the vocabulary; fine to render, but the mock must not imply the keys are typed. Also `describeEvent`'s EVENT_WORDS table holds three keys none of the specs list: `issue.closed`, `change.opened`, `change.updated`.
- Spec 1's `package-migration` node count is probably wrong. `Bounded.all` builds `andThen(joined, capture(prev => map(all(batch), capture(vals => ({...prev, ...vals})))))` (Bounded.ts:124-141), so each batch is an `All` node AND a `Map` node, not the single `Node.all` merge bar the spec draws. Check the claimed 11 plan nodes and 18 edges by actually building the plan before the library row prints a count.
- @smthrs/flows/patterns ships a module literally named `Loop.ts`. D-017 bans a loop NODE, not a Loop pattern, but a library filtered to `Primitives` will eventually show a row reading `loop(...)` beside a canvas that refuses to draw a loop widget. Decide now how that row reads — it should draw as its bounded unrolling with the bound in the label — rather than discovering it when the catalog grows past five.

### Cut

- Spec 5's sticky note. Nothing in flows_plan_nodes holds free text; it lives in the card payload, which D-015 says TanStack DB already struggles to type past 30 union members. Spec 5 already ranks it last and MINIMAL TEXT argues against 280 unrequested characters on a canvas.
- `Pin output` as a shipped verb (spec 5's toolbar button 2, spec 2's footer, spec 3's footer). The engine's pin is a pinned READ snapshot in PlanScheduler, not n8n's pin-data. Spec 5's proposed mechanism — publish a step-cache entry under `key_digest` with `WithCache.Scope = "shared"` and no `ttlMs` — is real machinery (WithCache.ts:33 really is `"run" | "flow" | "shared"`) but nobody wrote the command, and a UI-only pin breaks on reload exactly the way n8n's does. Cut the verb; KEEP `Pinned at key1_8f77ac30 - this node now keys key1_d12e64b9` as a read-only state for when it lands. That row is the best single line in spec 5.
- Spec 4's `parked on quota` trigger state. Its own risk says the data path does not exist: @smthrs/triggers has no quota concept, TriggerSummary carries no quota field, and drawing it needs a join from activeRunId to flows_runs.waiting_reason / waiting_wake_at_ms that no projection serves. The run card carries the park; the node says `fired`.
- Spec 2's drag-an-upstream-field-onto-an-Input-row gesture. D-003 is OPEN and D-028 says the mock shows the consequence of an edit, never the edit. A drag that opens a HUD and then does not land is a worse demo than no drag.
- Spec 1's shard-level cache-hit beat on `package-migration` — spec 1 already cut it in its own TRAP (`Compose.call(map, {shard, index, input})` carries the whole input into every shard's key material). Keep it cut, and keep the re-key story on `implement-issue`, where renaming `review@2` really is free (StepKey.ts:459-461, ids never enter the hash).
- Spec 5's `Re-run from here` as a working button this round. `runs.rerun` re-runs the whole run; `runs.rerun-from <runId> <nodeId>` exists nowhere in the repo. Spec 5 names this honestly as its top risk. Ship the button opening the re-key HUD with real PlanDiff counts and a submit disabled with the reason `No command re-runs from one node yet` — better than a toolbar whose first verb is a mock.

### Build order

1. Spec 5 — Canvas & Run Rail, re-derived against rankdir TB, with the `ordering` edge reason added and the sticky note, pin and working re-run cut. It carries the layout every other spec sits inside, and its `role="listbox"` fix (WorkflowCanvas.tsx:138-142 states the contract explicitly; the mock's nodes are orphaned options today) is a real accessibility defect every keyboard interaction in the other four specs assumes is already fixed.
2. Spec 2 — Node Inspector, with the Code tab rewritten to D-037 (declaredAt {path, line} on the PlanCard's additive `graph` field; gap line demoted to the fallback state). This is what Will actually asked for — "a really high quality way of drilling into things and seeing the actual code" — and every other drill-in is a variant of it. Collapse to five tabs if a step node would otherwise show three one-line tabs; spec 2's own risk offers that fallback.
3. Spec 3 — the model drill-in. The highest-fidelity spec of the five: the 13 ModelEvent tags, PreparedRequest's seven fields, the six Usage counters with "a missing count is not a zero count", both retry ladders, and the reported/one-hot confidence provenance all check out verbatim against packages/smithers/agent/model. Fix the seat vocabulary, gate the Cost row on a bound price table, and it is buildable as written.
4. Spec 1 — the flow library and the four new demo flows, once the canvas takes a flow as a prop. The pattern labels are exact — Compose.label at internal/Compose.ts:397 mints them character for character — which makes each row carry a declared bound instead of prose. Verify each flow's node count by building the plan first; package-migration's 11 looks low.
5. Spec 4 — Trigger node and panel, LAST, because it needs the most engine correction: split into cron / declared-rule / channel shapes, cut `firing` and `parked on quota`, re-derive the gutter for TB. Its `no scheduler` state is the single most valuable row in the whole set — schedulerLastTickMs undefined or stale past 5 x pollInterval, with `Run smthrs triggers serve to fire schedules` — and is worth shipping on its own even if the other three kinds slip.
