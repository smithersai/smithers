# Flow builder & monitor — mock

Open `flow-builder.html`. One self-contained file, no network, no server.

```
open docs/flow-builder/mockups/flow-builder.html
```

Space plays and pauses. `1` `2` `3` jump to an act. `←` `→` step a frame. The
scrubber scrubs. Click any node for its inspector. The sun/moon at the bottom of
the rail switches theme.

## What it argues

Three acts, one canvas.

1. **Draft** — you type the ask, the agent drafts the flow while you watch, node
   by node, with its cursor on the node it is writing. It explains only the
   choices you would otherwise have to discover: which decisions go to Jev, why
   both branch arms are in the plan, why three steps sit behind your approval.
2. **Run** — the same canvas executes. Nodes light, edges flow, `bun test` fails
   its first attempt and the retry policy recovers it, the human gate parks the
   run and the approval renders from `flows_runs.waiting_request`.
3. **Re-key** — you ask for one more rule in the AI checks. Before anything runs,
   the canvas shows what that costs: 3 nodes re-key, 8 are cache hits, 4.9
   seconds instead of 1h 1m, and one approval is voided because the plan digest
   changed. Then it runs, and the 41-minute agent step never re-runs.

Act 3 is the product. Acts 1 and 2 are the setup.

## Round 2

- **Flow library.** The flow name is a picker. Four flows from `@smthrs/patterns`
  open on their last settled run: `CheckSuite` (a two-batch fan-out with a
  quarantined failure), `reviewLoop(maxRounds=3)` (a bounded loop drawn as the
  real nodes it unrolls to — there is no loop node), a `Saga` whose
  compensations are declared before anything runs, and a three-rung
  `Escalation` ladder where `accept` is a node because it is a called flow.
- **Drill-in drawer.** Click a node. Tabs appear only when evidence exists:
  `Frames` for an agent (its cells, each `ctx.call`, the real `ModelEvent`
  stream, usage, armed ceilings), `Questions` for Jev (typed questions,
  per-option probability, the 0.8 / 0.2 thresholds), `Schedule` for the trigger
  (cron narrated, next 5 runs in zone and UTC, last 14 outcomes), then
  `Output · Input · Code · Key · Attempts · Events`. Maximize fills the pane.
- **Code tab.** The real `flows/morning-triage/flow.ts`, the node's declaration
  highlighted and scrolled to, with its plan node id as an AST path. Line
  anchoring needs the `declaredAt` engine lane (decisions.md D-037).
- **Predictions.** Pending nodes show `~13m`; running nodes show `of ~13m`; the
  drawer shows p50 and the sample size. No history, no number.
- **Model identity on the node.** `claude-opus-5 · anthropic-messages` for a
  seat-resolved agent, `typesafe-ai/jev · evaluation-model` for Jev.
- **n8n-grade affordances.** A three-verb hover toolbar, a trigger rounded on
  its left side, merge nodes, and a top-to-bottom layout that fits a whole
  15-node flow in the pane (decisions.md D-034).

Self-review corrections from round 1 are in decisions.md D-031 to D-033.

## What is real

Every label is engine vocabulary, not invention:

- `tier` is `Action.Tier` — `sealed | compensable | irreversible`.
- Edge kinds are `Graph.EdgeReason` — `value | continuation | failure`.
- Node outcomes are `PlanScheduler.Settlement.outcome` — `built | clean |
  failed | skipped | deferred`. `clean` is the cache hit.
- The branch draws both arms because `Graph.build` expands both; the arm not
  taken settles `skipped`.
- There is no loop node, because `plan/src/Node.ts` has none and never will.
- The step keys, the re-key set, and "renaming is free" all follow
  `plan/src/Plan.ts:4-12` and `StepKey.ts:459-461`.
- The approval card is rendered from the `HumanTask` question shape:
  `{ kind, prompt, attempt, maxAttempts, options?, schema? }`.
- Colours come from `apps/app/src/mainview/styles/tokens.css` (night-owl, both
  themes). Node anatomy follows `@smthrs/ui`'s `sui-canvas-*` vocabulary.

## What is fake

- The timings, token counts and costs are plausible, not measured.
- The transport bar at the bottom is a demo control. It is not a product
  surface.
- Nothing is wired to the gateway; every frame is precomputed.

## Building it again

```
cd source && npm install && npx vite build
```

`vite-plugin-singlefile` inlines the JS, CSS and font subsets into one HTML
file. The canvas is `@xyflow/react` laid out with `dagre`, the same two
dependencies `apps/app` already has installed and unimported.

## Figures

| | |
|---|---|
| `figures/01-drafting.png` | the agent writing the graph |
| `figures/02-running.png` | a live run, branch taken, else arm skipped |
| `figures/03-waiting-on-you.png` | the human gate, retry recorded on `bun test` |
| `figures/04-rekey-preview.png` | the inspector showing the key change |
| `figures/05-cache-hits.png` | the cached/dirty boundary — the money shot |
| `figures/06-completed.png` | 4.9s, 8 clean, 1h 1m saved |
| `figures/07-light.png` | light theme |
| `figures/08-agent-frames.png` | agent drill-in: cells, calls, model events |
| `figures/09-code-tab.png` | the code tab on the node's declaration |
| `figures/10-jev-questions.png` | Jev: questions, probabilities, thresholds |
| `figures/11-trigger-schedule.png` | trigger: cron, next 5, last 14 |
| `figures/12-predictions.png` | predicted durations on pending nodes |
| `figures/13-checksuite.png` … `16-escalation.png` | the four pattern flows |
