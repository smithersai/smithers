# Flow Builder & Monitor — Product

Stage: **vision ruled by Will (2026-09-18); sentence wording still open.**

Will's ruling, verbatim: "I imagine working with smithers to build a workflow to
mostly just be an agent walking you through building and potentially running the
workflow in real time with n8n animation and what you are talking about [the
content-addressed re-run]. So I think we have a vision." Added later the same day:
"one thing we need in workflows is predictions on how long things will take."

So the product is three things on one canvas: **the agent walks you through
building it, it runs live in front of you, and every number is predicted before
you pay for it** — how long a run will take, and what an edit will re-run.

---

## Proposed one sentence — v3 (after the engine survey)

> Smithers makes an agent run incremental: the whole run is a content-addressed
> graph, so you can change one step of a two-hour run and pay for one step,
> watching the rest come back as cache hits.

Earlier drafts, kept for the record:

- **v2** — "Smithers gives every agent run a graph you can act on: watch it draw
  itself as the agent works, grab any node to steer, pin or re-run it, and edit
  the flow without ever leaving typed code in git."
- **v1** — "Smithers turns every agent run into a live graph you can read while
  it runs, steer at any node, and fork from any step — a flow builder where the
  agent holds the pen and the canvas is just a view of typed code in git."

Why v3: the engine survey found a property no competitor has and none can
retrofit. A node's step key is a function of what it consumes, so editing one
node re-keys that node and everything downstream of it **and nothing else** —
"that is the entire invalidation mechanism" (`flows/plan/src/Plan.ts:4-12`).
Node ids never enter the hash, so renaming and moving nodes is free. Cache state
is legible before a run (`PlanNodeStatus = ["cached","run"]`) and after
(`Settlement.outcome ∈ {built, clean, failed, skipped, deferred}`).

n8n's answer to the same problem is manual data pinning plus partial execution,
which the user has to set up by hand and which lies when the pin goes stale.
Ours is a build system. Watching a graph light up is table stakes — three
products already ship it. Paying for one step of a two-hour agent run is not.

See decisions.md D-021.

---

## The three bets underneath it

After Will's ruling: bets 3 (agent as visible peer) and 1 (one surface) are the
experience, bet 4 (incremental re-runs) is the differentiator, bet 2 (code stays
the source of truth) is the constraint, and bet 5 (predictions) is new.

**Bet 1 — Monitor first: the builder and the monitor are one surface at two
times.** Nobody in the survey has merged them. Temporal has only the monitor and
third parties are bolting authoring onto it. n8n has both as separate screens
with a copy-the-data bridge. One graph plus a time cursor — "now" is the builder,
the past is the monitor — is a real product shape nobody occupies.
*Falsifiable claim:* a user watching a Smithers run today cannot answer "what is
it doing and what will it do next" without reading logs.

**Bet 2 — The flow file stays the source of truth.** Every n8n complaint is
downstream of canvas-as-truth: unmergeable diffs, no code review, a complexity
ceiling. We already have typed TypeScript flows in git. A canvas that gives that
up to gain drag-and-drop trades our only structural advantage for the thing that
killed two competitors this year.
*Falsifiable claim:* engineers will not adopt a flow tool whose output they
cannot review in a PR.

**Bet 4 — Incremental re-runs (the new one, and the strongest).** The run is a
content-addressed DAG. Edit a node, and exactly that node and its downstream
re-key; everything upstream and everything unrelated is a cache hit. This is
Bazel's incrementality pointed at agent work, it is already true in the engine,
and it is not a UI feature a competitor can ship on top of a JSON canvas.
*Falsifiable claim:* people abandon long agent runs rather than re-run them, and
will pay to edit one step instead.

**Bet 5 — Every run is predicted before it starts (Will, 2026-09-18).** Each
node shows an expected duration before it runs, the run shows an ETA on its
critical path, and a running node shows progress against its prediction. The
re-key preview is the same feature pointed at an edit. The data exists: attempts
are recorded per step key with start and finish times, and an action tag is
stable across re-keys, so history by tag gives p50/p90. No predictor exists yet.
*Falsifiable claim:* agent steps vary too much for a p50 to be useful; if p90/p50
is routinely above 3, show a range or nothing.

**Bet 3 — The agent edits the graph as a visible peer.** Figma, Zed and Cursor
all shipped agent-as-collaborator on a shared surface in 2026. Nobody has done it
on a flow graph. The mechanic: the agent's proposed nodes appear live with
presence state, you take the pen mid-edit, and the change lands as a reviewable
diff.
*Falsifiable claim:* users want to watch and interrupt, not receive a finished
flow.

## Alternate one-sentence framings (pick or discard)

- *Monitor-led:* "The missing screen for agent work: watch a run as a graph,
  stop it at a node, fork from any step."
- *Builder-led:* "n8n's canvas over real TypeScript — the agent drafts the flow,
  you edit it visually, git sees a clean diff."
- *Co-authoring-led:* "You and the agent build the flow on the same canvas, and
  the canvas is where it runs."

## What is deliberately not claimed
- Not an integrations marketplace. Nodes are our typed actions, not 500 SaaS
  connectors.
- Not an eval platform. We emit traces; others score them.
- Not no-code. Engineer-grade is the segment; the visual layer is for reading and
  steering, not for avoiding code.

## Open, needs Will
1. Which bet is the pitch and which are supporting.
2. Whether the buyer is the engineer running agents or the team watching them.
3. Whether "builder" is even the right word if the agent writes the flows —
   see decisions.md D-011.

---

## User stories — NOT YET WRITTEN
Blocked on the one-sentence ruling. Each story will be a person saying, in their
own words, why they want this, with the workaround they use today and what it
costs them.
