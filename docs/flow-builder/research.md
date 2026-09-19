# Flow Builder & Monitor — External Research

**Purpose.** Prior art for the visual flow builder and run monitor we are adding to
Smithers. This file is written for LLM consumption: verbose, quote-heavy, no
context elided. Append to it over time; never compress it.

**Convention.** Each entry gets: what it is, the mechanism (how it actually
works, not the marketing), evidence, what we steal, what we reject. Every claim
that came from the web carries its URL. Claims marked `[unverified]` came from a
search-result summary rather than a primary page and should be upgraded before
anyone builds on them.

**Log**
- 2026-09-18 — round 1. n8n, Temporal, Inngest/Trigger.dev, Windmill, Kestra,
  Dagster/Airflow, Argo/Prefect, Node-RED, LangGraph Studio/LangSmith,
  Gumloop/Lindy/Relay, BuildBuddy, canvas libraries, agent-observability
  standards.
- 2026-09-18 — round 2 (six parallel lanes). Trigger.dev dashboard, n8n canvas + NDV
  at source-string fidelity, @smthrs/patterns graph shapes, the @smthrs/model layer,
  node drill-in evidence, and how an agent step works. Appended verbatim below as R2.*.

---

## 1. n8n — the thing we are being compared to

### What it is
Node-based automation canvas. Nodes are integrations (HTTP, Slack, Postgres,
LLM). Edges carry item arrays. A workflow is a JSON document; the canvas is the
primary authoring surface; execution history is a first-class tab.

### Mechanism

**Canvas.** The 2.0 canvas (early 2026) was rewritten: "Canvas rendering is now
hardware-accelerated, allowing massive workflows (100+ nodes) to load and
execute without lag." `[unverified — from search summary]`
Source: https://nodesify.com/blog/n8n-workflow-automation-guide-2026

**AI as nodes, not as a layer.** n8n's answer to agents was to make the agent a
node with sub-nodes attached to it: "An AI Agent is connected to a Chat Model
node (which LLM to use), Tool nodes (what the agent can do), Memory nodes (what
the agent remembers), and Vector Store nodes (what knowledge the agent can
search)." Multi-agent works by connecting *AI Agent Tool* nodes to a primary
agent, "letting it supervise and delegate across specialized agents in a single
execution on one canvas."
Sources: https://hatchworks.com/blog/ai-agents/n8n-guide/ ,
https://strapi.io/blog/build-ai-agents-n8n

**MCP.** "The AI Agent node can now use tools exposed by remote MCP servers
directly, and there's also a standalone MCP Client node allowing any step in the
workflow to call an MCP server." `[unverified]`
Source: https://nodesify.com/blog/n8n-workflow-automation-guide-2026

**Debugging — the genuinely good part.** Three mechanisms compose:
1. *Data pinning.* "When performing manual executions, you can use data pinning
   to 'pin' or 'freeze' the output data of a node, and you can optionally edit
   the pinned data as well. On future runs, instead of executing the pinned node,
   n8n will substitute the pinned data and continue following the flow logic."
   Source: https://docs.n8n.io/data/data-pinning/
2. *Partial execution.* "Partial execution allows running only a portion of a
   workflow from a specific node to a destination, reusing existing run data
   where possible."
   Source: https://deepwiki.com/n8n-io/n8n/2.4-partial-execution-and-error-handling
3. *Debug in editor.* From a past execution, "n8n copies the execution data into
   your current workflow, and pins the data in the first node in the workflow."
   Failed executions show "Debug in editor"; successful ones show "Copy to
   editor."
   Source: https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions

   Caveats from the same page: the feature is gated ("all Cloud plans support
   it, while self-hosted deployments need at least the Registered Community
   tier") and retention is configurable ("executions available on the Executions
   list depends on your Workflow settings").

   Known sharp edge: pinned data leaks into the execution view —
   https://github.com/n8n-io/n8n/issues/30771

**Text-to-workflow.** The AI Workflow Builder (beta) "turns natural-language
requirements into a draft flow, selecting nodes, placing them on canvas, and
wiring logic," with a three-step loop: describe → watch the builder step through
phases with real-time feedback → review credentials and parameters, then refine
with more prompts. Positioned explicitly as *no lock-in*: "You can review
credentials, tweak parameters, and extend the flow directly in the standard n8n
editor."
Sources: https://docs.n8n.io/advanced-ai/ai-workflow-builder/ ,
https://max-productive.ai/blog/n8n-ai-workflow-builder-launch-natural-language-automation/

**Evaluations.** n8n ships eval methods: "Matches, Semantic similarity/relevancy,
Factual Correctness, and more generic LLM-as-judge and Custom evaluations."
`[unverified]` Source: https://docs.n8n.io/changelog/release-notes-2.x

### Where it breaks — this is the opening

The criticism is consistent and it is all about **the canvas being the source of
truth**:

- *Diffs are noise.* "The exported files include metadata like internal IDs and
  timestamps that change between exports, making clean diffs difficult... two
  exports of the same unchanged workflow can look different to Git."
  Source: https://hostadvice.com/blog/web-hosting/vps/designing-fault-tolerant-n8n-architectures/
- *Merges don't work.* "Try merging two branches of a big workflow and you'll see
  why text diffs, typed models, and PRs still win."
  Source (Reddit, via search): https://pixeljets.com/blog/n8n-vs-code/
- *No native version control.* Open feature request:
  https://github.com/n8n-io/n8n/issues/26707 — "Currently, n8n lacks a built-in
  version control system for workflows." Git integration is an Enterprise
  feature: https://docs.n8n.io/source-control-environments/understand/git/
- *Complexity ceiling.* "When your logic gets complex—like AI agent behaviors,
  decision trees, recursion, or multi-layered branching—it becomes hard to debug,
  hard to trace failures, hard to maintain over time, and near impossible to
  version, test, or document properly."
  Source: https://dev.to/thevenice/n8n-a-great-starting-point-but-not-where-real-engineering-lives-cji
- *Outgrowth.* "If your team depends on code review, CI, and tests, you've
  outgrown the visual editor."
  Source: https://pixeljets.com/blog/n8n-vs-code/

### Steal
Pinning, partial re-execution from a node, "debug in editor" (load a past run's
data into the editing surface), the executions tab as a peer of the canvas, the
canvas as documentation surface (stickies/groups).

### Reject
Canvas-as-source-of-truth. Node-as-integration as the primitive. Agent-as-a-node
(it inverts our model: for us the agent *owns* the flow, the flow doesn't own the
agent).

---

## 2. Temporal — the best monitor UI in the category

### What it is
Durable execution engine. No authoring canvas at all: workflows are code. The UI
is purely a *monitor and debugger* over an append-only event history.

### Mechanism

The design problem, in their words: workflows may contain "a handful of Events,
or tens of thousands" and may last "milliseconds or take years to complete." The
goal: a user should "look at any Workflow and understand what's happening, right
now" without needing to read the full Event History.
Source: https://temporal.io/blog/the-dark-magic-of-workflow-exploration

**Event Groups** are the key abstraction. Rather than rendering raw events, they
group related ones (`ActivityTaskScheduled` + `ActivityTaskStarted` +
`ActivityTaskCompleted`) into one row and show "high value user data" as the
summary. This is the single most transferable idea in this document.

**Three views over the same data:**
- *Compact* — linear left-to-right Event Group progression; repeated identical
  groups collapse under one line with a count and expand on demand. "Very
  helpful for consolidating complex Workflows."
- *Timeline* — same groups, but positioned by clock time, so you see "the
  latency between each Event in its Event Group" and spot bottlenecks.
- *Full history* — every event including Workflow Tasks, "styled as a git tree
  with branching relationships."

**Visual language (verbatim):** "Red means failure, dashed red means retrying,
dashed purple is pending, green means completion." Dashed animated lines mean
awaiting. "Liveness means the Workflow updates in real-time."

**Child workflows render inline** in the parent timeline, so debugging doesn't
require navigation.

**Replay debugging.** "The workflow replayer reconstructs workflow execution from
Temporal's event history, allowing you to debug exactly what happened during the
original execution." You can "read the full event history of every step,"
"replay it locally to reproduce a bug," "send signals to running workflows," and
"inspect activity inputs and outputs."
Sources: https://docs.temporal.io/encyclopedia/event-history ,
https://temporal.io/code-exchange/temporal-workflow-replay-debugger ,
https://docs.temporal.io/web-ui

There are ~40 distinct event types in a history. Icons encode category
(Activity, Child Workflow, Command, Local Activity, Marker, Signal, Timer,
Update, Workflow); color encodes status.

### Note
Third parties are building visual authoring *on top of* Temporal precisely
because Temporal refuses to: "Temporal UI: why durable execution still needs a
visual authoring layer."
Source: https://www.workflowbuilder.io/blog/temporal-workflow-editor-durable-execution-visual-authoring
That is the exact market gap we are walking into, from the other side (we
already have the engine and the agent).

### Steal
Event groups. Three views over one event log. The color/liveness language.
Progressive disclosure: summary → group → raw event. Inline child runs.

### Reject
Nothing. But note: Temporal has no builder, and the absence is felt.

---

## 3. Inngest / Trigger.dev — durable execution with a run dashboard

### Mechanism
Both are TypeScript-first step functions with durable checkpointing. "Each step
is checkpointed so a retry after a failure resumes at the failed step rather than
re-running the whole function."
Source: https://www.pkgpulse.com/guides/inngest-vs-trigger-dev-v3-vs-restate-2026

Inngest's pitch on observability is *zero instrumentation*: "Inngest captures
execution data for every function run, providing metrics, traces, event logs,
and per-step timing without instrumenting your code."
Source: https://www.inngest.com/docs/platform/monitor/observability-metrics

Trigger.dev is described as "the closest like-for-like alternative... with open
source, TypeScript-first design, step/retry model, waitpoints, scheduling, and a
function-run dashboard."
Source: https://hookdeck.com/webhooks/platforms/inngest-alternatives

### Steal
"Observability by default, no instrumentation" as a stated product promise. The
step-level checkpoint as the unit the UI renders. Waitpoints as a first-class UI
object (a run that is *waiting on a human* should look different from a run that
is *working*).

### Reject
Their run views are list-shaped, not graph-shaped. Fine for linear step
functions; not enough for a Bazel-shaped DAG.

---

## 4. Windmill — the closest structural analogue

### What it is
Open-source dev platform: scripts in TS/Python become webhooks, flows, and
auto-generated UIs. Positioned as "Open-source alternative to Retool and
Temporal."
Source: https://github.com/windmill-labs/windmill

### Mechanism
"Windmill's flows let you chain scripts into complex orchestrations with
branching, iteration, error handling, and suspend/resume support, all expressed
through a visual DAG editor. Each step in a flow is a real script in TypeScript,
Python, or any supported language, with the same editor, LSP autocompletion, and
resource access."
Source: https://www.windmill.dev/docs/flows/flow_editor

Crucially they also ship the code-first path: "If you prefer code over
drag-and-drop, workflows as code lets you define the same logic in a single
Python or TypeScript file."
Source: https://www.windmill.dev/platform/flow-editor

**Git two-way sync.** Two-way synchronization between Windmill workspaces and
GitHub repos; a VS Code extension with "full LSP support, inline script testing,
and one-click deployment from your editor"; a workspace setting to "Create one
branch per deployed script/flow/app," with changes committed automatically on
deploy.
Sources: https://github.com/windmill-labs/windmill-sync-example ,
https://github.com/windmill-labs/windmill-vscode

### Steal
Steps are *real code files with an LSP*, not form fields. Editing a step opens a
real editor. One branch per deployed change. The "same logic, two surfaces"
promise.

### Reject
Two-way sync as the mechanism — it is the expensive way to get the property. See
Kestra for the cheap way.

---

## 5. Kestra — the correct architecture for round-tripping

### The thesis
"Kestra's source of truth is always the declarative config, and any change made
via the UI or API automatically adjusts the YAML, ensuring the orchestration
logic is **always** managed as code."
Source: https://kestra.io/blogs/declarative-from-day-one

This is *not* two-way sync. There is one source of truth (the declarative doc);
the canvas is an editor *of that document*. The canvas never owns state the
document doesn't have. That is the whole trick, and it is why their diffs work:
"Every change is a diff in YAML, enabling peer reviews and audit trails."

### Mechanism
"A visual editor sits alongside the YAML editor, with each flow section
(Triggers, Tasks, Errors, Finally, After Execution) rendering as blocks that can
be configured through guided forms or raw YAML. Three ways to build the same flow
— the YAML editor, the No-Code editor, and the AI Copilot — all edit the same
flow and stay in sync."
Source: https://kestra.io/blogs/declarative-from-day-one

"The UI provides a live topology view of your workflow as a DAG that updates as
you edit, plus integrated documentation and even a built-in code editor."

They reject the code/no-code dichotomy explicitly: "no-code, low-code, and
full-code in one platform," so that teams "never hit a wall where the platform is
either too simplistic or too rigid."

Consolidation argument against the status quo: "one file for pipeline code,
another for scheduling, plus manual UI setup for triggers" fragments the system;
instead "one YAML file can encapsulate tasks, dependencies, schedules, and event
triggers."

### Steal
**Everything.** One source of truth; canvas is a projection and an editor of it;
live topology updates as you type; AI copilot edits the same document as the
human, not a parallel representation.

### Open question this raises for us
Kestra gets round-tripping for free because YAML is structurally editable. Our
flows are **TypeScript + Effect**, which is not. Deciding how a canvas edit
becomes a TypeScript edit is the central engineering risk of this project. See
`decisions.md` D-003.

---

## 6. Dagster vs Airflow — what the monitor should be *about*

### The mental-model split
"Airflow thinks in tasks — units of work arranged into a DAG that runs on a
schedule, while Dagster thinks in assets — data artefacts (tables, files, ML
models) that have producers and consumers, which shapes testing, observability,
partitioning, and the entire developer experience."
Source: https://www.datasops.com/blog/dagster-vs-airflow

Consequence for the UI: "Airflow's UI excels at task-centric observability: the
grid view shows run history per task, the graph view shows the DAG topology...
However, it takes more work to connect a failed task to the business impact of
the failure." Dagster instead has an Asset Catalog with "materialisation history,
metadata, owners, tags, and current freshness status" and a global lineage graph.
Source: https://www.ryankirsch.dev/blog/airflow-vs-dagster-comparison

And the observability payoff: "Dagster gets observability for free through Rich
MetadataValue with every materialization attaching row counts, aggregates, and
markdown previews, whereas Airflow requires XComs + a Grafana panel to
approximate this."

### Dagster+ UI redesign rationale
The problem framing is vivid: "Pipelines break overnight, and you're greeted in
the morning with a wall of red failures and Slack pings."
The answer was a **homepage command center**: "pin the assets and jobs you care
about most, and scope the homepage down to the exact slice of your platform that
matters to you," plus freshness/health policies that "surface problems
preemptively," plus faceted lineage (toggle metadata density on the graph).
Stated principle: "Observability isn't just a nice-to-have anymore, it's the
foundation for running data platforms with confidence."
Source: https://dagster.io/blog/introducing-the-new-dagster-plus-ui

### Steal
The asset framing, translated: our monitor should be *about the artifacts the
run produced* (the diff, the test result, the review, the deployed thing), not
only about which step is spinning. Rich per-step metadata rendered inline
(markdown previews, counts) rather than raw logs. Faceted density on the graph.

### Reject
Freshness/SLA machinery — wrong domain for us right now.

---

## 7. Argo Workflows / Prefect — live DAG rendering

Argo: "a live, interactive representation of your workflow execution graph...
as the container starts, the node color changes from gray (pending) to blue
(running), once it completes it turns green, and if it fails it turns red."
Source: https://adhdecode.com/articles/argo-workflows/argo-workflows-ui-access/

Prefect deliberately does *not* pre-render a static DAG: it "is designed to
visualize workflows that can adapt at runtime (think if/else conditionals, while
loops, etc.), which was intentional to address the limitations that fixed,
pre-defined DAGs present when writing dynamic/event-driven workflows."
Source: https://linen.prefect.io/t/27055166/

Counterpoint on the cost of not having it: "Metaflow's UI lacks static DAG
visualization with no live updates as steps execute, which is a limitation
compared to competing tools like Dagster and Prefect."
Source: https://docs.metaflow.org/internals/gsoc-2026

### Steal
Gray→blue→green/red as the universal status ramp. Live node state, not polled
tables.

### The Prefect tension — important for us
Our flows are *dynamic*: an agent decides at runtime what the next step is. A
statically-drawn DAG will frequently be wrong or incomplete. The monitor must
render **the graph that actually happened**, growing live, with the *planned*
graph shown as a ghost. This is the single biggest divergence from n8n, where the
drawn graph is the executed graph by construction.

---

## 8. Node-RED — twenty years of visual-flow lessons

Design guidance that survived contact with users:
"keeping flows in good form through habits that prevent spaghetti code: calling
shared things, using one path per beginning, decoupling UI from logic, and
catching errors where visible." Reuse ladder: "link in/out, link call, subflow,
or packaged node." Layout advice: "nodes should be well laid out to minimize wire
crossing."
Sources: https://flowfuse.com/docs/node-red-guide/ ,
https://nodered.org/docs/developing-flows/documenting-flows

Scaling reality: "Going from one instance of Node-RED to 100 isn't
straightforward." "As flows grow over time, they can lead to applications that
are harder to maintain."
Source: https://flowfuse.com/blog/2022/11/scaling-node-red-with-diy-tooling/

### Steal
The reuse ladder — a flow builder without subflow/extract-to-flow becomes
spaghetti. Auto-layout is not a nicety; wire crossing is the failure mode.

### Reject
Manual node placement as the only layout mechanism. If the agent writes the flow,
the *layout must be derived*, not stored — or stored as an override on top of a
derived default.

---

## 9. LangGraph Studio / LangSmith — agent-graph debugging

### Mechanism
"A local desktop IDE that renders your graph as a live diagram, lets you step
through node execution, inspect state at every checkpoint, and replay any run
from any point."
Source: https://markaicode.com/langgraph-studio-visual-debugger-agent-graphs/

**Time travel is checkpoint-based:** "Studio reads those checkpoints to render
the animated graph and lets you fork a new run from any checkpoint — that's the
time-travel feature." "Time Travel... is a practical architectural pattern built
on persistent checkpoints that allows developers to rewind a graph to a previous
state, inspect the internal data (the State object), and replay the graph from
that point onward."
Sources: https://mem0.ai/blog/visual-ai-agent-debugging-langgraph-studio ,
https://programmingcentral.hashnode.dev/master-time-travel-debugging-in-langgraphjs-rewind-edit-and-replay-agent-states

**Production→local replay:** "Studio can pull traces from production runs (via
LangSmith) and replay them locally, showing the exact sequence of decisions the
agent made with the exact production data, then you can modify an input at any
step and re-run from that point to test a fix."
Source: https://docs.langchain.com/langsmith/studio

Each node links to its LangSmith trace with "token usage, latency, model
parameters, and any errors."

Justification for graph UI at all: complex agent workflows "would be nearly
impossible to follow through traditional logging."

### Steal
Fork-from-checkpoint. Edit-state-and-replay. Per-node cost/token/latency badges.
The framing that a graph view exists because logs failed, not because graphs are
pretty.

### Note
This is structurally the same feature as n8n's pin + partial execution, arrived
at independently from the agent side. That convergence is strong evidence the
feature is load-bearing. **Pin/fork/replay is table stakes, not a differentiator.**

---

## 10. AI-native builders — Gumloop, Lindy, Relay.app

Positioning as of 2026: "Lindy and Relevance AI (agent builders), Gumloop
(visual agent workflows), Relay.app (human-in-the-loop AI workflows), Bardeen
(browser AI agents), and CrewAI (multi-agent code framework)."
Source: https://www.frankx.ai/blog/best-no-code-ai-agent-builders-2026

Gumloop: "a visual workflow builder focused on business process automation and
data processing... best for data-heavy, node-based workflows — scraping,
enrichment, research, and content operations."
Source: https://www.gumloop.com/blog/best-ai-agent-builder

**Relay.app is dead:** "free access ends August 15, 2026, paid access ends
September 14, 2026, and new signups are already closed."
Source: https://aitoolsdirectory.com/blog/gumloop-relayapp-lindy-comparison

### Read
The prosumer AI-workflow canvas market is consolidating and the human-in-the-loop
specialist just died. The surviving positions are (a) mass-market no-code
(Gumloop/Lindy/Zapier) and (b) engineer-grade code-first (Temporal, Inngest,
Windmill, Kestra). There is no credible occupant of "engineer-grade, agent-
authored, visually monitored." That is our slot.

---

## 11. BuildBuddy — the Bazel analogy, since our engine is Bazel-shaped

"BuildBuddy is an open source Bazel build event viewer, result store, remote
cache, and remote build execution platform." The Invocation View is "the primary
interface for examining build results... organized into several sections through
a tabbed interface," React SPA over RPC. A **Timing tab** "pulls the Bazel
profile logs from your build cache and displays them in a human-readable
format," and raw logs expose "all of the events that get sent up via Bazel's
build event protocol."
Sources: https://github.com/buildbuddy-io/buildbuddy ,
https://deepwiki.com/buildbuddy-io/buildbuddy/3.1-web-ui ,
https://docs.bazel.build/versions/main/build-event-protocol.html

### Steal
The invocation as the unit of the UI (one run = one durable, linkable page with
tabs: summary / graph / timing / artifacts / raw events). A **build event
protocol**: a typed, append-only, streamable event schema that the UI is merely a
renderer of. Cache-hit visualization — showing what was *skipped* is as
informative as showing what ran.

---

## 12. Canvas rendering — engineering constraint

React Flow (xyflow) is DOM-based: "extremely large graphs with thousands of
visible nodes may face performance ceilings compared to pure WebGL/Canvas
solutions... you will hit performance walls earlier than with Canvas/WebGL
libraries." Its own docs have a performance page.
Sources: https://reactflow.dev/learn/advanced-use/performance ,
https://velt.dev/blog/best-canvas-library-web-mobile-apps

Alternatives: Cytoscape.js (canvas/WebGL, "handles much larger graphs faster than
React Flow, though its nodes are not interactive React components"), PixiJS
(WebGL), Konva.js, JointJS, JsPlumb.

### Read
Node count in our domain is tens, not thousands — a run has ~5–50 steps. React
Flow's ceiling is irrelevant; interactive React nodes (which we need, because a
node renders a live agent card) are decisive. **Default to React Flow unless a
run's node count exceeds ~500.** Revisit only with evidence.

---

## 13. Agent observability standards

OpenTelemetry GenAI semantic conventions (CNCF SIG) "define what a trace event
captures across six layers — LLM client calls, agent orchestration, MCP tool
calls, workflow composition, content capture, and quality evaluation." As of
v1.41 the spec "defines agent, workflow, tool, and model spans plus required
latency and token-usage metrics, though nearly all `gen_ai.*` attributes carry
Development stability badges, meaning attribute names can change without a major
version bump." Langfuse, Arize, Bedrock AgentCore and Datadog all consume OTLP.
Sources: https://www.braintrust.dev/articles/agent-observability-complete-guide-2026 ,
https://twistag.com/thinking/ai-agent-observability

Platform niches: "Langfuse is the open-source baseline, LangSmith leans into
LangChain workflows, and Braintrust targets rigorous eval science."
Source: https://www.marktechpost.com/2026/08/09/top-llm-observability-and-evaluation-platforms-in-2026-langfuse-langsmith-braintrust-arize-and-more-compared/

### Read
Emit `gen_ai.*`-shaped spans from our step events so runs are exportable to
whatever the customer already uses. Do not build an eval platform; be the thing
that *produces* traces others consume. The attributes are unstable — wrap them.

---

## Cross-cutting findings

**F1. Every serious system has converged on pin → fork → replay-from-step.**
n8n (pin + partial execution + debug-in-editor), LangGraph (checkpoint fork),
Temporal (replay debugger). Three independent lineages, same feature. If our
monitor ships without it, it is a toy.

**F2. Source-of-truth is the only architectural question that matters.**
Canvas-as-truth (n8n) → unmergeable diffs, no code review, complexity ceiling.
Document-as-truth (Kestra) → free diffs, free review, canvas is a lossless
editor. We already have document-as-truth (TypeScript flows in git). We must not
give it up for a canvas.

**F3. The monitor and the builder are the same artifact viewed at two times.**
Temporal has only the monitor. n8n's builder and executions tab are separate
screens with a copy-the-data bridge between them. Nobody has made them one
surface. The obvious design: **one graph; a time cursor; "now" is the builder,
past is the monitor.**

**F4. Nobody renders a graph that grows at runtime.** Argo/n8n draw the static
graph and color it. Prefect refuses to draw a static graph at all. Our flows are
agent-authored and dynamic, so we need *both*: the planned graph as a ghost, the
actual graph materializing over it.

**F5. Grouping beats events.** Temporal's Event Groups are the difference
between 40 event types and a readable row. Our step events will need the same
collapse rule.

**F6. Layout must be derived.** If an agent writes the flow, no human placed the
nodes. Auto-layout + optional stored overrides. Node-RED's wire-crossing warning
is the failure mode to design against.

---

## Gaps to fill in later rounds

- Retool Workflows, Zapier Canvas/Copilot, Make.com — enterprise monitor patterns.
- Sim Studio, Dify, Flowise — the open-source agent-canvas cohort.
- Figma/Multiplayer canvas mechanics: how does a human edit a graph an agent is
  concurrently editing? (Live cursors, CRDT vs. lock, "agent is editing" state.)
- Unreal Blueprints / Houdini / TouchDesigner — decades of node-graph UX for
  genuinely complex programs.
- Concrete n8n execution-list API + DB schema (retention, pruning) as a
  storage-cost reference.
- Primary-source confirmation for every `[unverified]` claim above.

---

## 14. Human + agent co-editing one canvas — the novel mechanic

This is the part nobody in the workflow category has solved, and it is being
solved right now in adjacent categories.

**Agent as a CRDT peer.** "The agent works through tool calls: the AI model
decides what to do, a runtime on the server translates those tool calls into Yjs
operations, and the CRDT sync propagates the changes to all connected clients.
Two integrations with one primitive makes the AI become a genuine CRDT peer."
Source: https://electric.ax/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs

**Presence as the UX.** "AI agents can display a visible cursor that moves
through the document as the agent works, with presence indicators showing
thinking, composing, or idle status, and edits appearing in real-time through
CRDT sync." `[unverified]`

**Figma** opened its canvas to third-party agents via MCP in March 2026, then
shipped a first-party canvas agent on 2026-05-20 that "lives both on the canvas
and in the left rail." `[unverified — confirm dates]`
Source: https://www.progress.com/blogs/designing-on-the-canvas-with-agents

**Zed** "inverts the model so multiple humans and multiple agents share one
buffer, one cursor stream, one set of channels and threads, treating
collaboration as a first-class primitive." `[unverified]`
Source: https://www.digitalapplied.com/blog/zed-ai-coding-deep-dive-multiplayer-agents-2026

**Cursor 3.1 Canvas** (2026-04-16): "lets AI agents generate persistent,
interactive React interfaces directly inside the Agents Window. Actual charts,
tables, diff views, and custom logic rendered live as the agent works." The
framing: "Instead of an agent describing what it found, it can now show you — a
grouped diff review, a failure cluster visualization, or a live research progress
chart while it runs experiments."
Source: https://www.joinnextdev.com/blog/cursor-31-canvas-ai-agents-now-build-your-dashboard

Academic prior art worth reading in a later round: Cocoa (co-planning and
co-execution with agents, arXiv 2412.10999), collaborative document editing with
multiple users and AI agents (arXiv 2509.11826), ECHO (arXiv 2606.09851).

### Read
The agent editing the graph should be *visible as a peer*, not as a black box
that hands back a finished artifact. Presence state (planning / editing /
running), a live cursor on the graph, and a reviewable diff of what it changed.
Cursor's framing — "instead of describing what it found, it can show you" — is
exactly the argument for putting a graph in our chat.

---

## 15. The open-source agent-canvas cohort — and its death rate

Positioning: "Flowise and Sim Studio are visual agent builders where multi-agent
orchestration is the primary use case, not a feature added on top, while Dify is
oriented toward retrieval-focused applications." Verdicts: "Sim Studio wins for
TypeScript teams building commercial products; Dify wins for chat-first RAG apps
and beginners; Flowise wins when human-in-the-loop is a hard requirement."
Source: https://madappgang.com/blog/open-source-visual-agent-builders-compared-flowise-vs-langflow-vs-n8n-vs-sim-studio-in-2026/

**Flowise is dead:** "stopped development on July 29, 2026, and archived its
GitHub repository on August 13, 2026. Flowise is no longer a recommendation for
new projects." `[unverified — confirm on GitHub]`

**Sim is the closest competitor to our positioning.** "Sim combines an Apache
2.0 open-source visual-to-code canvas with the Mothership conversational control
plane, native PostgreSQL tables, and vector knowledge bases under full data
ownership."
Source: https://www.vellum.ai/blog/best-ai-workspaces-2026

That is: canvas + conversational control plane + owned data. Read their product
before we finalize ours. Difference to establish and defend: their canvas is the
artifact and the chat drives it; ours should be that **the durable flow is the
artifact**, the chat is where it is proposed and watched, and the canvas is a
lens on a real executed graph rather than a diagram of an intended one.

### Death rate note
Relay.app (shutting down Sep 2026), Flowise (archived Aug 2026). Two of the
named leaders in the AI-workflow-canvas cohort died within a month of each
other in 2026. The canvas alone is not a business. The durable engine and the
runs are.

---

## Cross-cutting findings (continued)

**F7. The canvas is not a moat; the run history is.** Two canvas-first products
in this cohort died in 2026 (Relay.app, Flowise). Temporal, Inngest, Dagster and
BuildBuddy — all engine-first, monitor-second — did not. Build the monitor
before the builder.

**F8. The agent should edit the flow as a visible peer.** CRDT-peer agents,
presence, live cursors and reviewable diffs are shipping in Figma, Zed and Cursor
in 2026. Applying that to a flow graph is, as far as this round of research
shows, unoccupied.


---

# Round 2 — six research lanes (2026-09-18)

Verbatim lane output. Verdicts are steal / adapt / reject for a durable, typed,
agent-authored DAG. Sources are URLs or repo .

## R2.1 — How a Smithers agent step actually works (cell loop, seats, steering, budgets) so an agent-node drill-in is honest

An agent node is not a "model call with tools" — it is a nested durable run of JavaScript REPL cells, where the model's only authority is `ctx.call(flow, input)` and every call is its own keyed, journaled boundary. The harness already emits 31 typed `flows.harness.*` events plus 6 `flows.agent.*` records that carry everything a drill-in needs: the three prompt sections with digests, each cell's source and digest, every call's identity and result, the realm's variable roster, the call ledger, compaction, steering drains, permission asks, six named completion brakes, and the structured-output correction ladder. A Jev node is a completely different shape (one state + typed questions + probabilities + confidence, 1500 ms deadline, no transcript), and a plain Action node has no turns at all — so the drill-in must be three different panels, not one with fields blanked out.

### [steal] One agent frame is a fixed five-stage pipeline, and that is the drill-in's spine
`packages/smithers/agent/harness/docs/concepts.md:15` states it verbatim: `model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition`. CellTurn.ts's header repeats it: "One frame is: seal a model step, recover the cell from the settlement, run it in the sandbox, resolve each of its flow calls as its own keyed durable boundary, then apply the transition it returned." Four actors are drawn apart on purpose: "The model authors cells. The realm evaluates them. The controller (`CellTurn`) decides what the transition means and what the next frame shows. The engine (`EngineLike`) owns everything durable."

*Why:* A frame rail with exactly these five stages is the one honest skeleton for an agent-node drill-in. Anything that draws "model call → tool call → model call" is drawing a different engine.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/CellTurn.ts:1-17

### [steal] The loop is cell-first: the harness sends `tools: []` and `toolChoice: "none"` on every request
concepts.md §The cell loop: "The controller seals every model request with `tools: []` and `toolChoice: "none"`, so continuation never comes from provider plumbing: it comes from the transition the cell settled and the budgets the run declared." `AgentEvent.TurnOpened.activeToolNames` exists only so old journals decode: "the tool set the turn opened with, which the cell-first controller always opens empty: it declares no provider tools."

*Why:* A mock that shows a "Tools" list on an agent node is lying about our engine. The tool list is the flow catalog (`ctx.flows`), rendered into the prompt — not a provider tool array.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/docs/concepts.md:27-33

### [steal] The model's whole authority is `ctx`: eight members, nothing else
From the REPL contract shipped to every run (`internal/cellPrompt.ts`): "Your bindings are `ctx`, `console`, and everything your earlier cells defined." The members are `ctx.call(name, input)`, `ctx.flows`, `ctx.done(output)`, `ctx.park(reason, message)`, `ctx.justify(...)`, `ctx.checkpoint()`, `ctx.base`, plus `console.log`. Rule 1 continues: "There is nothing else — no imports, no require, no fetch, no filesystem, no process, no Date, no Math.random. Referencing anything else throws." concepts.md §Agent cell context: "There is no `ctx.fs`, no `ctx.shell`, no `ctx.mcp`, no `ctx.spawn`."

*Why:* The drill-in's "what this agent could do" panel is exactly `ctx.flows` + these seven verbs. It is a small closed set, which makes it drawable and checkable.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/internal/cellPrompt.ts:150-170

### [steal] The system prompt is three digested sections ordered by change frequency, for prefix caching
`cellPrompt.make` returns `Section[]` with `id: "cell-contract" | "cell-environment" | "cell-catalog"`, each carrying `text` and `digest`. The ordering is load-bearing: "The order is by how often each section changes, because every one of them is a prefix segment and a prefix is only cached up to its first edit: the contract is constant for the life of the binary, the environment for the life of a run, and the catalog can differ frame to frame." The catalog line format is exact: `- <name> (<tier>) capabilities=<a,b>: <description>\n  provenance: {"source":…,"root":…,"path":…}\n  input: <json schema>`, wrapped in an untrusted-data block titled `flow catalog (descriptor provenance follows)`.

*Why:* A "System prompt" tab that shows three collapsible sections with their digests — and marks which one broke the cache this frame — is both honest and genuinely new. Nobody else's agent UI shows the cache breakpoint.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/internal/cellPrompt.ts:238-271

### [steal] Every harness event type, with the payload each carries — 31 in one table
`AgentEvent.eventType` is the single table `CellTurn` writes and `Transcript` reads. The drill-in-relevant payloads: `turn-opened {seat, modelParams, activeToolNames, contextDigest}`; `model-delta {delta}`; `model-retried {attempt, code, delayMillis}`; `model-settled {message, usage, durationMillis}`; `cell-produced {cell: {language,text,digest}, blocks}`; `cell-rejected-in-frame {attempt, code, message}`; `cell-call-started {call}`; `cell-call-settled {flowName, identity, result}`; `cell-printed {cell, text}`; `cell-settled {cell, outcome, boundary?}`; `transition-applied {transition}`; `compaction-settled {replacedPrefixDigest, retainedMessageCount?, summary}`; `steering-drained {messages}`; `permission-required {request}`; `turn-closed {stopReason, outcome}`; `resolved {message}`; `aborted {reason}`; `checkpoint-minted {id, ref, cell, ordinal}`; `mutation-observed {basis, mutated, digest, paths, declaredWrites}`.

*Why:* This is the drill-in's data source and it already exists. No new projection is needed for the agent panel itself (unlike the plan graph, decisions.md D-020).
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/AgentEvent.ts:900-946

### [steal] A failed `ctx.call` resolves, it does not throw — 14 codes, each with a one-action hint
`Cell.CallFailureCode` = `unknown_flow, capability_refused, truncated_write, declaration_changed, invalid_input, unimplemented, timeout, run_completed, checkpoint_unavailable, checkpoint_exhausted, checkpoint_readonly, checkpoint_unsupported, flow_failed`, default `flow_failed`. `Cell.callFailureHint` pairs each with the recovery sentence the cell is shown, e.g. `timeout: "Narrow the call — a smaller root, a tighter pattern, a shorter command — and issue it again in this cell."` The cell sees `{ ok: false, error: { code, message, hint } }`.

*Why:* The call row in a drill-in should show code + hint, not a stack trace. `declaration_changed` in particular is a Smithers-only concept (the catalog moved between the frame that showed it and the boundary that ran it) and it is a great detail to surface.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/Cell.ts:329-393

### [steal] Cell rejection is a separate, in-frame failure mode with 8 codes
`Cell.RejectionCode` = `no_cell, output_truncated, imports_forbidden, compile_failed, invalid_transition, unsupported_language, limit_exceeded, stalled`. A parse refusal is answered *inside* the same frame (`cell-rejected-in-frame {attempt, code, message}`) rather than ending it: "If a cell does not PARSE nothing ran at all, so you are asked again inside the SAME frame, with the error and the offending line." The journal comment notes it is real spend: "a re-prompt is a real model call, cached prefix or not."

*Why:* A frame with 3 rejections and 1 accepted cell is 4 model calls. A drill-in that shows one box per frame undercounts cost; showing `attempt 1 · compile_failed` rows inside the frame is the honest render.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/Cell.ts:193-206

### [steal] Every call carries a replay identity: session, frame, cell digest, ordinal, declaration digest, layers
`Cell.CallIdentity {session, frame, cell, ordinal, declaration, layers}`. The doc states why: "Re-executing the cell source reaches the same lexical call in the same order with the same declaration, so the boundary keys identically and replays." `Cell.Source.digest` is computed over `{kind:"flows/harness/Cell/Source", language, text}` and "editing one character of the source re-keys every boundary within it." The journal's public projection is `flows.harness.call-fact.v1` with `callId` matching `/^cell-call-v1:[0-9a-f]{64}$/`.

*Why:* This is the agent-level equivalent of the plan's content-addressed step key (D-021). Same pitch, one level down: edit one line of a cell, only that call and the ones after it re-run. It makes the re-key story fractal instead of a single trick.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/Cell.ts:408-435

### [steal] The call ledger and the variables panel are what the model is shown every frame — and they are perfect UI rows
`CallLedger.Entry {ordinal, flow, subject, ok, digest, bytes, mutates, payloadBytes, signature}`, bounded to `bound = 30`, `width = 120`, `members = 6`. "It carries no payloads: a line says `stdout=4096b`, never the four kilobytes." A repeated write names the earlier write it repeats. `VariablesPanel.Stamp {name, type, size, frame, since}`, `bound = 64`, where `type` can be `unset` (a throw left it unassigned) or `unreadable` (a throwing accessor / refusing proxy).

*Why:* Both are already bounded, already rendered, already journal-derivable. The existing `CellLoop` pane mock guessed these tables; the real column sets are better (`mutates`, `payloadBytes`, `since`) and should replace the guesses.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/CallLedger.ts:80-150

### [steal] The agent runs under eight named ceilings, journaled once at the start as `discipline-armed`
`DisciplineArmed {readOnlyCap, maxFrames, approvalChannel, modelCallMs, repeatCap, narrowingCap, unmovedCap, revalidations, unresolvedCap, claimCap, calls?, memoryBytes?, steps?, timeMs?, totalMs?, callMs?}`. Defaults with their evidence: `defaultMaxFrames = 100`, `defaultReadOnlyFrames = 12`, `defaultModelCallMs = 300_000`, `defaultRepeatFrames = 4`, sandbox `defaultLimits.calls = 64`. The event exists specifically so a viewer can tell "armed but never reached" from "never armed" — "This event is the positive record: it says what was armed, before anything has had a chance to fire."

*Why:* A budget gauge row per armed cap, showing consumed-vs-cap, is the single most legible thing in the whole drill-in and it maps 1:1 onto a real journaled record. n8n and Trigger.dev have nothing like it.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/AgentEvent.ts:29-122

### [steal] Six named brakes bounce a frame, each with its own event and its own demand text
`read-only-demanded {streak, cap, nextFrame, nextAction: "write"|"justification"|"read-only"|"park"}`, `repeat-demanded {frames, cap, nextFrame}`, `unmoved-demanded {openedDigest, currentDigest, nextFrame}`, `unresolved-demanded {flow, failed, instead, currentDigest, nextFrame}`, `narrowed-demanded {flow, broader, narrower, broaderDigest, currentDigest, nextFrame}`, `narrow-only-demanded {flow, check, targets[], currentDigest, nextFrame}`, plus `claim-demanded {complete, overclaims, latencyMs, demanded, currentDigest, nextFrame}`. Two observers that do not bounce: `sufficiency-observed`, `vacuous-verification-observed`. The demand text is real product copy, e.g. read-only opens `"Read-only discipline — N consecutive frames have made no call that declares a write…"`.

*Why:* These are the moments a human actually wants to see on a timeline: "frame 14 — the harness bounced the run and told it why." Every brake carries `nextFrame`, so it anchors precisely on the frame rail.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/internal/demandText.ts:26-140

### [steal] The final answer is judged by Jev before it is allowed to stand, and it never falls back
`CompletionClaim.classifier = Classifier.make("completion/claim", …)` over `Evidence {task, claim, treeMoved, lastCheck?}` where `Check {command, exitCode, output}`. Two boolean questions: `complete` — "Does the evidence show the task as stated is done?" and `overclaims` — "Does the claim assert something the evidence does not show?". Thresholds `disprovenAt = 0.3`, `overclaimedAt = 0.8`, bounds `outputBytes = 4096`, `proseBytes = 8192`. "It never falls back… an unjudged completion ends the run as a typed `completion_unjudged` failure rather than standing."

*Why:* The last card of an agent drill-in should be the verdict on the answer, with the two probabilities and the four facts that were sent. It is the honest end of the run and it is unique to us.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/CompletionClaim.ts:197-230

### [steal] A seat is an opaque declared string; only a host resolver turns it into a model
`Seat.Seat {id, modelId, model, route, contextWindowTokens}` — "Zero disables compaction, so a resolver must never report it." The declared half carries no credentials: "a declaration is portable, and a run that reads one out of a repository must not be handed the keys with it." `provider:modelId` is the Node resolver's convention only; a host may accept `reviewer` or `fast`. Failure is `SeatUnresolved {seat, message}`. Seats actually written in this repo: `anthropic:claude-sonnet-4-5`, `anthropic:claude-opus-4-1`, `openai:gpt-5.6-sol`, `moonshot:kimi-k3`, `cerebras:gpt-oss-120b`, `gemini:gemini-2.5-pro`, `opus`, `reviewer`, `critic`, `sdk:fast`, `cloud`.

*Why:* The node chip should show the seat string, and the drill-in should show the resolution `seat → modelId → route`. Showing only the model id hides the indirection that lets a test swap the whole model.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/src/Seat.ts:30-48

### [steal] Steering has exactly four kinds and two delivery modes, drained at a turn boundary
`SteerPayload` kinds: `Message {body}`, `Seat {seat}`, `Thinking {thinking}`, `Tools {toolNames}`. `Thinking` literals: `none, minimal, low, medium, high, xhigh`. Tools is "Additive only: steering can widen what the agent may reach for, and cannot narrow it." Delivery is `"steer" | "queue"` — queue items are "promoted only when the run would otherwise go idle." Drain is journaled as `flows.harness.steering-drained.v1 {messages}` and recorded as `DrainRecord {inserts, seatChanges, queued}` so a replay is told the same thing. Rationale: "An operator steers a run for four different reasons, and only one of them is something to tell the model. Saying 'your seat changed' would spend a turn on bookkeeping; changing the seat is what was asked for."

*Why:* A steer composer on a running agent node is a four-way control, not a chat box. And the drill-in must show where in the frame rail a steer actually landed — at a turn boundary, not where it was typed.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/Steering.ts:20-135

### [steal] Structured output is enforced locally with a correction ladder and one repair ask
`StructuredOutput.instructions(schema)` renders the declared schema as a JSON Schema document into the system teaching; the answer is `Cell.Complete.output`, a string, and is decoded locally. `StructuredOutputFailure {schema, candidate, corrections, limit, issues[], message}`, `maxIssues = 5`. Failure codes: `invalid_json, schema_mismatch, no_candidate, correction_exhausted`. Issue codes: `invalid_json, no_candidate, invalid_type, invalid_value, missing_key, unexpected_key, forbidden, one_of, constraint`. Each rejection writes `flows.agent.structured-output-rejected.v1 {action, attempt, limit, schema, candidate, issuesDigest}`. Correction budget: `options.corrections ?? host.defaultCorrections ?? 1`; after it is spent, `Options.repair` asks **once**, with its own prompt/seat/system.

*Why:* The drill-in needs a rung list: `attempt 0 → schema_mismatch (2 issues) → attempt 1 → repair → decoded`. Each rung is a whole separate cell run under its own session key, which is why they must be drawn as siblings, not retries of one call.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/src/AgentAction.ts:735-780

### [steal] A quota refusal is a real durable park, not a retry — and it is a recorded step
`QuotaPolicy.quotaParkedEvent = "flows.agent.quota-parked.v1"` with payload `{action, session, wakeAt, source}` where `ParkSource` ∈ `reset, retry-after, text, default`. `defaultWaitMillis = 60_000`, `maxWaitMillis = 3_600_000`, `defaultMaxParks = 8`. The park uses `FlowRuntime.annotateWaiting({reason: "quota", wakeAt})` and `DurableClock.sleep` with `inMemoryThreshold: 1` deliberately — "a two-second window is still a park, and `DurableClock.sleep`'s default threshold would run any wait of a minute or less as an in-memory sleep, hiding it from every operator view."

*Why:* Every agent UI I have seen shows "rate limited, retrying". Ours can show a wake time and where it came from (`reset` from the provider vs `text` parsed from a message). That is a real differentiator and it costs nothing to draw.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/src/AgentAction.ts:551-600

### [adapt] Budget events are the agent's cost ledger, and one field name is a trap worth knowing
Six `flows.agent.*` records: `usage.v1` (`UsageRecord {stepKey, spent}`), `budget-started.v1` (`{startedAt}`), `budget-latched.v1`, `budget-warning.v1`, `quota-parked.v1`, `structured-output-rejected.v1`. `Budget.OnExceeded` ∈ `fail, warn, skip-remaining`; `BudgetExceeded {scope: "tokens"|"latency", …}`; `Budget.Skipped` is non-retryable (`neverRetrySkipped`). The cost field is `spent`, not `tokens`, because the journal redacts credential-shaped key names: "`tokens` canonicalizes to `token` and the production `SqlJournal` writes `\"[REDACTED]\"` in place of the number."

*Why:* Draw cost from `spent`, and label the skip state as a distinct terminal (`Budget.Skipped`) rather than a failure — a retry can never change it. The redaction trap is a real hazard for anyone building a cost panel.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/src/Budget.ts:429-456

### [steal] Context window and compaction are segment-shaped, with a prefix/tail cache boundary
`ContextWindow.SegmentKind` ∈ `system, instructions, registry, tools, transcript, summary, steering`; `SegmentZone` ∈ `prefix, tail` — "`prefix` segments are stable across turns; `tail` segments change every turn." `Compaction.shouldCompact` fires when `total > contextWindow - reserve`, `defaultReserve = 16_000`, `defaultKeepRecent = 20_000`. The settlement is `compaction-settled {replacedPrefixDigest, retainedMessageCount?, summary}`. The summary instruction is fixed text beginning "Summarize the supplied conversation for a continuation model." and ending "Be concise, factual, and do not call tools."

*Why:* A stacked bar of the seven segment kinds, split at the prefix/tail boundary, with a compaction marker on the frame rail, is a context view nobody ships. It is directly derivable from journaled events.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/ContextWindow.ts:46-80

### [steal] An agent node, a Jev node and an Action node have three genuinely different data shapes
Action node: payload fields + types, success/error schema, `EffectTier` ∈ `sealed|compensable|irreversible`, `Placement` ∈ `client|local|sandbox|remote`, `EffectDeclaration {mode: hermetic|expected, onConflict: serialize|lane|fail}`, step key, settlement outcome, duration. No turns, no tokens, no transcript. Jev node: one `state` (JSON ≤ 32 KiB, `MAX_STATES = 64`, `CONCURRENCY = 8`), `questions` keyed by id each `{type: "boolean"|"choice"|"score", instructions, criteria}`, answers `{value, probability}` / `{value, probabilities, confidence}` / `{value, label, probabilities, confidence}`, plus `latencyMs` and optional `usage {inputTokens, outputTokens}`; `defaultTimeoutMs = 1500`; failure `EvaluatorError {code, status?, message}` with codes `unreachable, refused, empty, timeout, invalid_answer, invalid_question`; `Classifier.confident(answer, floor)` returns none below the floor. Agent node: everything an Action node has, plus the whole nested frame history above.

*Why:* Three panels, not one. A Jev drill-in is a probability distribution against a floor and takes ~300 ms; an agent drill-in is a twenty-minute transcript. Rendering them with the same chrome would misrepresent both.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Evaluator.ts:39-56

### [steal] Permission asks are a typed suspension the drill-in must render as a form, not a toast
`PermissionRequired {code: "permission_required", requestId, runId?, capability, tier, meta}` where `capability` is "always the exact adapter request, never a wildcard" and `meta` is journal-safe JSON (depth 16, 1024 members, 64 KiB). Rule decisions are `RuleEffect` ∈ `allow, deny, ask`. The harness emits `flows.harness.permission-required.v1 {request}` and `flows.harness.suspended.v1 {reason}`. A cell's own park is `Cell.Park {reason: "waiting-input"|"waiting-event"|"waiting-quota", message}`, and `DisciplineArmed.approvalChannel: false` means "a `park` transition is refused and answered in the frame that returned it, because a run that waits for an answer nobody will give has stopped working with its budget unspent."

*Why:* This is the second form law surface after HumanTask (decisions.md D-023). Same rule: the engine already specifies the render, so do not invent a second approval shape.
*Source:* /Users/williamcory/smithers/packages/smithers/flows/capability/src/PermissionRequired.ts:27-53

### [adapt] Another Smithers agent is building 31 experimental panes right now, including Models, Cell loop and Decisions — align or collide
Uncommitted on this tree: `apps/app/src/mainview/experimental/` with `Manifest.ts` listing 31 panes behind `VITE_SMITHERS_EXPERIMENTAL`, reached as `/experimental.<id>`. Directly overlapping: `cell-loop` ("The model's cell, its calls, its variables and the exact context window"), `models` ("Which model each role uses, its credential and its route"), `decisions` ("Jev's questions, criteria and floors"), `plan` ("The keyed action graph, its step keys and the diff between revisions"), `step-cache`, `time-travel`, `tools`, `journal`. Its README rules: "Compose `Primitives.tsx`; write no CSS… Use the abstraction's real vocabulary — real table names, real field names, real verdicts. Invent values, never fields." Its `Models.tsx` already splits `Agent roles` (the six `AGENT_ROLE_IDS`: `orchestrator, explainer, implementation, trivial-implementation, ui, fast-ui`) from `Decision seats` (`front-door`, `completion-brake`, `health`, all on `typesafe-ai/jev` with a confidence floor).

*Why:* Two live meanings of "seat" now exist: the harness's `Seat.Seat` (a resolved model + route) and the app's `AgentRole` (a job bound to a local harness CLI). The flow-builder mock must pick one vocabulary and say which; and decisions.md D-014 already says our first canvas lands as one more pane in exactly this directory, so the drill-in should compose their `Primitives.tsx` rather than grow a parallel design system.
*Source:* /Users/williamcory/smithers/apps/app/src/mainview/experimental/Manifest.ts:28-58

### [steal] The REPL contract's own worked example is the best possible mock content — and it encodes a ruling
The shipped two-cell example does search→read→print, then edit→baseline at `ctx.base`→re-check→`ctx.done` behind `if (before.exitCode !== 0 && after.exitCode === 0)`. The ordering is a ruling: "the same ruling is why the worked examples put the edit first and the baseline second… on `sympy__sympy-13878` the r95repl lane applied one byte-identical 4,789-character patch five times, four of those applications preceded by `git checkout -- …`, because a clean fails-before proof required reverting the very work it was meant to prove." The module also records will's 2026-08-20 ruling: "the model authoring surface stays this shape, because agents perform better on the shape they are trained on. Effect.ts is the language of the code we maintain, not the language the model writes."

*Why:* Use this exact cell text in the mock. It is real, it is short, it shows two calls deriving from one another inside a frame, and it demonstrates `ctx.base` — the one affordance that makes our checkpoint model visible.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/internal/cellPrompt.ts:105-175

**Exact strings a mock or product must use:**

 ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  · 

**Open questions:**
- Which meaning of "seat" does the flow-builder ship? `Seat.Seat` from the harness (declared string → modelId + route + contextWindowTokens) and `AgentRole` from `packages/rpc/src/AgentRoles.ts` (job → model → local harness CLI) are both live, both called "seat" in the app's Models pane, and they are not the same object. The node chip and the drill-in must use one and name the other.
- Where does the agent drill-in read its events from? `AgentEvent` is a `Stream` inside the process and a journal on the engine, but none of the seven gateway projections listed in `GatewaySchema.ts:171` (`workspace-runs`, `run-summary`, `run-events`, `transcript`, `run-tree`, `approvals`, `node-output`) carries frame/cell structure. Is the drill-in fed by `run-events` filtered on `flows.harness.*`, or does it need its own fold like the plan-graph projection in D-020?
- Does the drill-in show the rejected cells and the correction rungs as siblings of the accepted frame, or hidden behind a disclosure? Each one is a real model call with real cost, so hiding them undercounts spend; showing them all inline makes a 40-frame run unreadable.
- Can the mock show a cell's source next to its `digest` and claim "edit this line, only these calls re-run"? The mechanism is real (`Cell.Source.digest` folds into every `CallIdentity`), but nothing in the engine today offers cell-level editing — it would be the fractal version of D-021 and it needs Will's ruling before a mock implies it.
- What does a `Flow.to()` trampoline round look like around an agent node, given the agent's realm is scoped to one run? design.md lists multi-round flows as still-to-design, and an agent that parks with `waiting-quota` for an hour is a different visual from one that hands off to a new round.
- Does the completion brake's verdict appear on the node itself (a bounced completion is a run the node has not finished) or only in the drill-in? `claim-demanded` carries `nextFrame`, so it is a frame event, but `CompletionClaim.unproven` is a terminal failure of the whole node.

## R2.2 — The Smithers model layer (@smthrs/model): protocols, routes, seats, the Jev evaluation model, and what a faithful model-call drill-in must render

"Multiple types of model" is four independent axes, not one list: protocol (wire shape, 4 ids), route/deployment (5 constructors, incl. a ChatGPT-subscription backend), auth mode (api-key header / bearer / refreshing OAuth token store), and model id (which also decides context window and native deferred-tool support). Orthogonal to all of that is a genuinely different kind of model — Jev, the evaluation model: no text, no stream, no tools, one POST to the Vercel AI Gateway with a 1500 ms deadline that returns one typed probability per declared question. Another Smithers agent has, in this working tree right now, added `apps/app/src/mainview/experimental/panes/Models.tsx` (386 lines, "Models and seats"), `Decisions.tsx` (Jev drawn) and `Evals.tsx`; the two `api.md` files are modified by only a 2-line wording change, so the live model-UI work is the panes, not the docs.

### [steal] Four protocol ids — the wire shape is the first axis of "type of model"
`Protocol.id` values, verbatim: `"anthropic-messages"` (AnthropicMessages.ts:849, via `const ID`), `"openai-responses"` (OpenAIResponses.ts:763), `"openai-responses-chatgpt"` (OpenAIResponses.ts:806), `"openai-chat-completions"` (OpenAIChatCompletions.ts:529). A Protocol owns exactly three things: `body` (a `Schema.Codec` plus `from(request, { native })`), `stream` (`event` codec, `initial`, `step`, `onHalt?`, `terminal?`), and `classifyError(status, body)`. Responses and Chat Completions are NOT two names for one shape — api.md says so explicitly: "`api.openai.com` serves Responses. Ollama, Gemini's compatibility layer, Cerebras, OpenRouter's chat route … serve Chat Completions."

*Why:* A model UI that shows only "provider" is lying: two seats on the same provider (api.openai.com vs chatgpt.com/backend-api) run different body schemas, different continuation mechanics and different deferred-tool support.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Protocol.ts:26-62

### [steal] Five route constructors, five URLs — route id is a separate axis from protocol id
`Route.anthropic` → id `"anthropic"`, `https://api.anthropic.com/v1/messages`, `Auth.apiKeyHeader("x-api-key", …)`, header `{"anthropic-version": "2023-06-01"}` (Route.ts:341-366). `Route.openai` → id `"openai"`, `https://api.openai.com/v1/responses`, `Auth.bearer` (Route.ts:369-389). `Route.openaiResponsesCompatible({ id, baseUrl, apiKey, headers? })` → `<baseUrl>/v1/responses`, and it force-overrides `supportsDeferred: () => false`. `Route.openaiChatCompatible({ id, baseUrl, path?, apiKey, structuredOutput? })` → `<baseUrl>/v1/chat/completions` by default. `OpenAIChatGPT.make({ auth, baseUrl?, headers? })` → id `"openai-chatgpt"`, `https://chatgpt.com/backend-api/codex/responses` — note NO `/v1` prefix. The compatible constructors take the ORIGIN and append the path themselves "so one origin cannot produce two different URLs".

*Why:* The route id (`anthropic`, `openai`, `openai-chatgpt`, or a caller-supplied id like `cerebras`) is what `PreparedRequest.routeId` carries into the sealed step key, and it is the id a drill-in must show beside the protocol id — they differ.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Route.ts:341-480

### [steal] Three auth modes, and only one of them can recover from a 401
`Auth.apiKeyHeader(name, key)` sets an exact header and declares `credentialHeaders: [name]`; `Auth.bearer(key)` sets `Authorization: Bearer <value>` and declares `credentialHeaders: ["Authorization"]`. Both fail an empty key as `ModelError` code `authentication`, message `"API key must not be empty"`. The third mode is a host-owned rotating token store: `Auth.refresh?: Effect<void, ModelError>`. `Route.stream` runs refresh after an `authentication` failure and re-signs EXACTLY ONCE; a static credential leaves `refresh` undefined so a bad key stays terminal. `OpenAIChatGPT` is the one built-in that needs it: an OAuth access token plus a `chatgpt-account-id` header, with fixed client headers `accept: text/event-stream`, `openai-beta: responses=experimental`, `originator: codex_cli_rs`, `user-agent: codex_cli_rs/0.149.1`.

*Why:* "Which credential signed for this call, and can it repair itself?" is exactly the question the existing Models.tsx mock says the product cannot answer today — and the answer is one boolean (`auth.refresh` present) plus one header name.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Auth.ts:57-132 and Route.ts:238-252

### [adapt] Framing is its own axis, with hard byte budgets that surface as typed failures
`Framing<Frame>` has `id` and `frame`. Two built-ins: `Framing.sse` (id `"sse"`) and `Framing.ndjson` (id `"ndjson"`). Budgets: `defaultMaxRecordBytes = 4 * 1024 * 1024` (4 MiB per pending record) and `defaultMaxResponseBytes = 64 * 1024 * 1024` (64 MiB whole response, delimiters included). Exceeding either fails terminally as `invalid_provider_output` with `"Model response exceeds 67108864 bytes"` / `"Model stream record exceeds 4194304 bytes"`, and the message never contains response text. SSE drops the `[DONE]` sentinel and empty events.

*Why:* Worth one row in a route panel (`framing: sse`), not a whole section — but the budgets are the honest explanation for a class of stream failure a mock currently has no vocabulary for.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Framing.ts:26-45,113-140

### [steal] Jev IS a different kind of model — one POST, no stream, no tools, no text, a hard 1500 ms deadline
Exact constants: `defaultBaseUrl = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"`, `defaultModel = "typesafe-ai/jev"`, `defaultTimeoutMs = 1500`, `protocolVersion = "0.0.1"`, `specificationVersion = "4"`, `environmentKey = "AI_GATEWAY_API_KEY"`. Headers sent: `authorization: Bearer <key>`, `ai-gateway-protocol-version: 0.0.1`, `ai-gateway-auth-method: api-key`, `ai-evaluation-model-specification-version: 4`, `ai-model-id: typesafe-ai/jev`, `content-type: application/json`. Body: `{ state, questions, providerOptions: { gateway: { zeroDataRetention } } }`, zeroDataRetention defaulting to `true`. No retries at all: "the caller decides whether a failure is worth a second request." Response carries `answers`, optional `usage: { inputTokens, outputTokens }`, and provider confidence read from the path `providerMetadata.typesafe.confidence`.

*Why:* This is literally "multiple types of model": a chat model streams 13 event kinds over minutes; Jev answers a fixed question map in ≤1500 ms with probabilities. A model UI that renders them with the same widget is wrong.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Evaluator.ts:382-418,533-600

### [steal] Jev's three question shapes and its own six-code failure vocabulary
Question `type` values: `"boolean"`, `"choice"`, `"score"`. Constraints enforced at construction by the field schema: choice has 2–255 options (`"A choice question offers between 2 and 255 options, not N"`), score has ≥2 distinct rungs (`"A score question orders at least 2 rungs, not N"`, `"A score question's rungs are distinct"`). Raw answers: `{ type: "boolean", probability }`, `{ type: "choice", choice, probabilities? }`, `{ type: "score", score, probabilities? }`. `EvaluatorErrorCode` = `"unreachable" | "refused" | "empty" | "timeout" | "invalid_answer" | "invalid_question"` — 400 and 422 map to `invalid_question`, every other non-200 to `refused` with `status`. `ClassifierError` reuses the same six codes.

*Why:* Six codes, three shapes — small enough to render exhaustively, and the existing Decisions.tsx mock already uses them, so a flow-builder decision node can share the vocabulary rather than invent one.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Evaluator.ts:39-46,104-119 and Classifier.ts:33-37

### [steal] Confidence has two different definitions and they disagree — a UI must pick and label
`Classifier.confidence(answer)`: a boolean's is `Math.abs(probability - 0.5) * 2`; a choice's or score's is its own `confidence`, which is `Math.max(...Object.values(probabilities))`. Critically: "A distribution the transport did not send is one-hot on the chosen option or nearest rung, so `confidence` reads 1" — i.e. a missing distribution renders as total certainty. `Evaluator.Response.confidence` is a DIFFERENT number: the provider's own, present for choice and score, never for boolean. `Classifier.confident(answer, floor)` returns `Option.none()` below the floor. Real floors in the repo: `Health` disregards below its floor, `CompletionClaim.disprovenAt = 0.3` and `overclaimedAt = 0.8`.

*Why:* A confidence bar that reads 1.00 because the gateway sent no distribution is the single most misleading thing a decision UI can draw. The drill-in has to distinguish "one-hot fallback" from "reported".
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Classifier.ts:336-354 and CompletionClaim.ts:120,134

### [steal] Seven real classifier ids exist today, each with its site — these are the "decision seats"
Declared with `Classifier.make(id, { description, state, questions })`: `"triage/relevance"`, `"check/verdict"`, `"probe/attribution"`, `"edit/risk"` (all in `agent/std/src/Classifiers.ts`), `"completion/claim"` (`agent/harness/src/CompletionClaim.ts:197`), `"harness/health"` (`opencode/src/Health.ts:136`), `"cli/did-you-mean"` (`smithers/src/DidYouMean.ts:34`). `harness/health` asks a score `progress` over `["stuck", "exploring", "progressing", "verifying", "done"]` plus booleans `stuck` and `needsHuman`, and renders as `dots = { green: "🟢", yellow: "🟡", red: "🔴", gray: "⚪" }`. `digest` is the SHA-256 of canonical JSON of `{ id, questions }`, so a durable call key never replays an answer to a changed question.

*Why:* These are real, not invented, and `digest` is the same content-addressing idea as the plan's step key — a decision node re-keys when its questions change. That parallel is worth drawing explicitly.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/std/src/Classifiers.ts:26,66,107,143

### [steal] The model event stream is exactly 13 tags, verbatim
`type` literals of the `ModelEvent` union: `"text-start"`, `"text-delta"`, `"text-end"`, `"thinking-start"`, `"thinking-delta"`, `"thinking-end"`, `"tool-call-start"`, `"tool-call-delta"`, `"tool-call-end"`, `"tool-result"`, `"usage"`, `"retry"`, `"settle"`. `ThinkingStart` carries optional `signature` (the provider's attestation, echoed back verbatim on continuation). `ToolCallEnd.arguments` is optional and repeats the complete text when the provider sends it. `Retry` = `{ type, attempt, code, delayMillis }` with `delayMillis` defaulting to 0. `Settle` = `{ type, stopReason, responseId?, itemIds? }` — "A stream without one was interrupted."

*Why:* Thirteen tags is small enough to render as an exhaustive legend, and `retry` + `settle` are the two the run monitor needs most: they explain a call that took 40 s without producing text.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/ModelEvent.ts:329-355

### [steal] `settledMessage` is the fold that turns a stream back into one durable message — and it deliberately keeps malformed output
`settledMessage(events) => { message: AssistantMessage, usage: Usage }`. No `settle` event ⇒ `stopReason: "aborted"`, "which no provider reports" — it is this layer's own value. The doc comment states a deliberate two-policy split: `ToolStream.end` REFUSES argument text that is not a JSON object (`invalid_provider_output`, `"Invalid JSON input for streamed tool call <name>"`) because a live stream must not hand a guess to a tool; `settledMessage` and `ToolStream.flushAborted` PRESERVE partial text verbatim because "the durable transcript must remain truthful".

*Why:* "Live view refuses, history preserves" is a rule a drill-in can state in one line, and it explains why the transcript sometimes shows argument text the tool never ran on.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/ModelEvent.ts:381-412 and ToolStream.ts:113-155

### [steal] `PreparedRequest` is the exact object a "see the actual code" drill-in should render
`{ routeId, protocolId, method: "POST", url, publicHeaders, body: Uint8Array, bodyText }`. It is credential-free by construction: `Route.publicHeaders` REJECTS any route header whose name matches the credential matcher with `invalid_request` / `` `Route header ${name} must be applied through Auth` ``, always injects `content-type: application/json`, and sorts header names. `bodyText` is the canonical-JSON decode of `body`. This exact value "is what the engine digests into the sealed-step key when it services `EngineLike.sealStep`". Endpoint query pairs are sorted; embedded URL credentials, fragments, relative path segments and credential-looking query keys (`key`, `sig`, anything matching the credential pattern) are all refused at construction.

*Why:* Will asked for "a really high quality way of drilling into things and seeing the actual code." For a model node the actual code IS `bodyText` plus `publicHeaders` — and it is already guaranteed safe to display, which is rare.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/Route.ts:31-40,73-90,190-215

### [steal] `ModelRequest` has six fields and their DECLARATION ORDER is load-bearing
`{ modelId, system, messages, tools, params, toolChoice? }` — "the stable step-key serialization order for a sealed model step." `params` is `GenerationParams`: optional `maxTokens`, `temperature`, `topP`, `topK`, `stopSequences`, `thinkingBudget`, `reasoningEffort`. `ReasoningEffort` = `"none" | "minimal" | "low" | "medium" | "high" | "xhigh"`. `ToolChoice` has exactly one value, `"none"`, expressed on the wire by omitting `tools` entirely. Three documented knob behaviours a UI must not flatten: Anthropic sends `max_tokens: 4096` for an omitted `maxTokens`; `topK`/`stopSequences`/`thinkingBudget` are DROPPED from both OpenAI bodies; `maxTokens` on the ChatGPT route FAILS locally as `invalid_request` naming that member.

*Why:* "Set, dropped, defaulted, or refused" is four distinct states per knob, and a params panel that shows only the declared value hides three of them.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/ModelRequest.ts:427-455,378-388

### [steal] Twelve error codes, a computed `retryable`, and diagnostics scrubbed twice
`ModelErrorCode` = `"invalid_request" | "context_overflow" | "no_route" | "authentication" | "rate_limited" | "quota_exceeded" | "content_policy" | "provider_internal" | "transport" | "call_timeout" | "invalid_provider_output" | "unknown"`. Fields: `code, message, path?, retryAfterMillis?, resetAtEpochMillis?, resetSource?, providerCode?, requestId?, httpStatus?`, tag `flows/model/ModelError`. `path` is "a key path only (for example `messages[2].content[0].text`), never a value". `error.body` and `error.bodyTruncated` live OUTSIDE the schema and are non-enumerable so a journal never copies a provider body into run state: read stops at 64 KiB, redaction walk stops at depth 12, kept text capped at 16 KiB, redaction literal is `<redacted>`. `retryable` = `rate_limited | provider_internal | transport | call_timeout`, or status 429/5xx, and `quota_exceeded` is NEVER retryable.

*Why:* Twelve codes with a per-code retryable boolean is a complete, exhaustive failure surface — the typed-failure rule Will already set for the product, already implemented here.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/ModelError.ts:28-41,140-155

### [steal] Two nested retry ladders with different budgets — a mock that shows one number is wrong
INNER (`RequestExecutor`): `MAX_RETRIES = 2` so at most three attempts, `BASE_DELAY_MS = 500`, jittered exponential, `MAX_DELAY_MS = 10_000` per wait, `MAX_RETRY_DURATION_MS = 60_000` total. `Retry-After` / `retry-after-ms` replaces the computed delay without jitter, still capped at 10 s; a wait larger than the 60 s budget is NOT slept — the error surfaces with `retryAfterMillis`, `resetAtEpochMillis`, `resetSource` so the caller parks durably. `rebuildAfter = 3`: three consecutive transport failures replace the whole HTTP client (a destroyed HTTP/2 pool never heals by waiting; cited evidence is "r92 of the SWE-bench full benchmark"). OUTER (`FlowEngineLike.recordModelStep`): retries only `provider_internal`, `transport`, `call_timeout`; `defaultModelOverruns = 1`, so an overrun gets exactly one re-issue carrying `overrunTeaching(budgetMillis)` prepended to `system`.

*Why:* "Attempt 2 of 3 on the inner ladder, re-issue 1 of 1 on the outer" is the only honest way to draw a call that has been running for two minutes, and the existing Models.tsx mock's "Retries 0 of 2" already gets half of it.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/RequestExecutor.ts:37-43,796 and /Users/williamcory/smithers/packages/smithers/agent/src/internal/FlowEngineLike.ts:67-71,110,129

### [steal] A seat is a declared STRING resolved to a live model — and the declaration deliberately carries no credential
Declared half: an ordinary string, no schema ships for it. The Node convention is `provider:modelId` (`anthropic:claude-sonnet-4-5`), "but that convention belongs to the resolver, not to the agent" — a host may accept `fast` or `reviewer`. Resolved half: `Seat = { id, modelId, model: Model.Model, route: RouteResolver, contextWindowTokens }`, where "Zero disables compaction, so a resolver must never report it." Failure is `SeatUnresolved` (tag `@smthrs/agent/Seat/SeatUnresolved`, fields `{ seat, message }`). `Seat.modelIdOf(id)` splits on the first `:` and treats a separator-free seat as its own model id. `TurnOpened` journals `seat: Schema.String`.

*Why:* Answers "what is a seat" definitively: a seat is a declaration, a resolved seat is a capability. The two must render differently — one is portable text in a flow file, the other is a credentialed runtime object.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/src/Seat.ts:39-47,84-87 and SeatResolver.ts:31-33

### [adapt] There is no single model catalog — the real catalog is four tables in four packages
(1) `ModelCatalog.contextWindowTokensFor(modelId)` — a regex table only: `claude.*haiku` → 200_000; `^claude-(?:opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)$` and `^claude-(?:fable|mythos)-5(?:-[0-9]+)*$` → 1_000_000; `claude` → 200_000; `gpt-5` → 400_000; `gpt-4.1` → 1_000_000; `gpt-4o` → 128_000; `^o[134]` → 200_000; unknown → 128_000, "Never zero". (2) `AGENT_ROLES` — six built-in role seats with `{provider, id, label}` + harness. (3) `Providers` — `compatible` (`moonshot` → `https://api.moonshot.ai`, `gemini` → `https://generativelanguage.googleapis.com/v1beta/openai` path `/chat/completions`, `cerebras` → `https://api.cerebras.ai`), `defaultSeat`, `starterSeats`, and the rule "Anthropic never appears" for `smthrs suggest`. (4) `DeferredTools` — two exact-id allowlists.

*Why:* A "Models" pane that implies one registry would be inventing. The honest drawing is: model id → window (regex), role → seat, provider → route, model id → deferred support — four lookups, each fallible in a different way.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/ModelCatalog.ts:16-28 and /Users/williamcory/smithers/packages/smithers/src/Providers.ts:119-176

### [steal] Native deferred tools are an exact-id allowlist, and an unknown id silently takes the portable path
`DeferredTools.ProtocolId = "anthropic-messages" | "openai-responses"`. Anthropic allowlist: `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-opus-4-5`, `claude-opus-4-5-20251101`, `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5`, `claude-haiku-4-5-20251001`. OpenAI allowlist: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-pro`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. "a version comparison would enable unverified wire behavior without a release, which is the one thing this predicate must never do." `resolve(request, native)` returns `{ immediate, deferred, activatedNames }`, computed from declared `deferred`/`loader` flags plus one chronological pass over the transcript — no process-local state, so replay reproduces the identical partition.

*Why:* A tools panel can show `immediate` vs `deferred` vs `activatedNames` as three counts and be exactly right, and the allowlist explains why the same tool set lowers differently on two models of the same provider.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/src/DeferredTools.ts:24,49-91,170-233

### [steal] What the journal actually records about a model call today — and the gap
Four harness events: `flows.harness.turn-opened.v1` (`{ seat, modelParams, activeToolNames, contextDigest }`), `flows.harness.model-delta.v1` (`{ delta: ModelEvent }` — the token-by-token prefix), `flows.harness.model-retried.v1` (`{ attempt, code, delayMillis }`), `flows.harness.model-settled.v1` (`{ message: AssistantMessage, usage: Usage, durationMillis }`). Usage counters: `inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens`, `cacheWriteTokens`, `totalTokens` — "a missing count is not a zero count". The gap: the app's existing `RunTrace.ts` folds `control.agent.model-settled` into a span of kind `"model"` that keeps ONLY `usage: { inputTokens, outputTokens }` and drops the other four counters, the seat, the params and the context digest.

*Why:* This is a concrete, provable shortfall in the shipped monitor: cache-read and cache-write tokens are the two numbers that make a content-addressed-rerun pitch legible, and today's trace throws them away.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/AgentEvent.ts:134-211 and /Users/williamcory/smithers/apps/app/src/mainview/cards/RunTrace.ts:843-858

### [adapt] Context window segments — what a "what did we actually send" tab renders
`ContextWindow = { modelId, segments: Segment[], activeTools: string[], replaced? }`. `SegmentKind` = `"system" | "instructions" | "registry" | "tools" | "transcript" | "summary" | "steering"`. `SegmentZone` = `"prefix" | "tail"` — "`prefix` segments are stable across turns; `tail` segments change every turn", i.e. the cache breakpoint. Each segment carries a digest; the window's own digest is built from `(modelId, segment digests, activeTools, replaced?)`. Its one failure code is `invalid_compaction_prefix`. Segment content is a union of `SystemPart | Message | ToolDefinition`.

*Why:* Seven kinds and a prefix/tail split is a ready-made stacked bar for a context panel, and prefix/tail is the honest visual for why `cachedInputTokens` is large — but it belongs to the harness, not @smthrs/model, so don't file it under "the model layer".
*Source:* /Users/williamcory/smithers/packages/smithers/agent/harness/src/ContextWindow.ts:48-76,152-165

### [adapt] Another Smithers agent is building the model UI RIGHT NOW — three new panes; the api.md diff is trivial
`jj st` shows ADDED: `apps/app/src/mainview/experimental/panes/Models.tsx` (386 lines, manifest id `models`, title `"Models and seats"`, summary `"Which model each role uses, its credential and its route"`, packages `["@smthrs/model", "@smthrs/harness-detect"]`), `Decisions.tsx` (id `decisions`, `"Jev's questions, criteria and floors"`), `Evals.tsx`. MODIFIED: both `api.md` files, by exactly one 2-line wording change — `choice`/`score` over- or under-supply now reads "is refused by the class's own schema check at construction" instead of "throws a `TypeError` at construction". Models.tsx already fixes vocabulary a flow-builder mock should reuse: seat `kind` is `"role" | "decision"`; role seats show Harness/Fallback/Delegates, decision seats show Floor/Deadline/Zero data retention; the request strip is `prepare → sign → attempt 1 → refresh → settle` for a failure and `prepare → sign → attempt 1 → stream → settle` for a success; `"Retries 0 of 2"`, `"Rebuild transport: after 3 transport failures"`, `"Sealed view: publicHeaders"`.

*Why:* Reuse their words verbatim or the two surfaces diverge into two designs. Their seat panel is the right shape; what it lacks — and what the flow canvas needs — is the per-call drill-in: prepared bodyText, the 13-tag event stream, the six usage counters and the two-ladder retry state.
*Source:* /Users/williamcory/smithers/apps/app/src/mainview/experimental/panes/Models.tsx:1-12,300-386

### [steal] The complete field list a faithful model-call drill-in must render, grouped
IDENTITY: seat id (declared string) · resolved modelId · role or decision-seat label · harness id · run/frame/turn. ROUTE: routeId · protocolId · framing id · method+url (`Endpoint.render`) · sorted query pairs · `publicHeaders` (content-type always present, `anthropic-version` on Anthropic, the four codex_cli_rs headers on ChatGPT) · credential header NAME only (`x-api-key` / `Authorization` / `chatgpt-account-id`) · whether `auth.refresh` exists · `supportsDeferred(modelId)`. PREPARED: `bodyText` (canonical JSON, credential-free, safe to show) · byte length · the sealed step key it feeds. PARAMS: each of the seven `GenerationParams` knobs tagged set / defaulted (Anthropic `max_tokens: 4096`) / dropped (topK, stopSequences, thinkingBudget on OpenAI) / refused (maxTokens on `openai-chatgpt`) · `reasoningEffort` · `toolChoice: "none"`. CONTEXT: `contextWindowTokens` from `ModelCatalog` vs tokens actually used · segments by kind and prefix/tail zone · `activeTools` · `contextDigest`. TOOLS: immediate / deferred / activatedNames counts · per tool name + JSON-Schema `parameters` · `deferred`/`loader` flags. STREAM: the 13 event tags on a time axis · text vs thinking parts (with `signature` presence) · tool-call arg text assembling · terminal frame. USAGE: all six counters, absent rendered as absent not zero · `durationMillis`. OUTCOME: `stopReason` (7 literals, `"aborted"` meaning interrupted) · `responseId` · `itemIds` · settled message parts. FAILURE: `code` (12) · `retryable` · `httpStatus` · `providerCode` · `requestId` · `path` (key path, never a value) · `retryAfterMillis` / `resetAtEpochMillis` / `resetSource` · `body` (≤16 KiB) + `bodyTruncated`. RETRY: inner attempt n of 3 with `delayMillis` per `retry` event · transport-failure counter toward `rebuildAfter = 3` · outer re-issue count against `defaultModelOverruns = 1` and whether `overrunTeaching` was prepended. CAPABILITY: the `model:call` grant this request ran under. FOR A JEV CALL INSTEAD: classifier id · `digest` · description · encoded state JSON · each question's type/instructions/criteria · raw answer · decoded answer · confidence WITH its provenance (reported vs one-hot fallback) · floor and whether `confident` returned none · `latencyMs` against the 1500 ms deadline · `usage.inputTokens`/`outputTokens` · `zeroDataRetention` · the six-code failure.

*Why:* This is the answer to question 5, and every field named here is read off a real schema in this repo — nothing on the list has to be invented, which is the bar the mock's own README sets for a proposal.
*Source:* /Users/williamcory/smithers/packages/smithers/agent/model/docs/api.md:60-360

**Exact strings a mock or product must use:**

 ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  · 

**Open questions:**
- Does a model node on the flow canvas drill into the PREPARED request (`bodyText`, credential-free, already safe to display) or into the sealed step key that request produced? They are different artifacts and only the second explains a cache hit.
- `Evaluator.Response.confidence` (provider-reported, absent for booleans) and `Classifier.confidence` (derived, reads 1.00 when no distribution was sent) are two different numbers with the same name. Which one does a decision node show, and what label distinguishes a one-hot fallback from a real distribution?
- `RunTrace.ts` keeps only `inputTokens`/`outputTokens` from `model-settled`. Widening it to all six counters is a change to a shipped card, not a mock — is that in scope for this round, or does the mock render the six counters against fixture data and leave the card alone?
- A seat string is resolver-defined (`provider:modelId` is only the Node convention). Does the canvas render the declared string verbatim, or does it resolve and show `modelId` + provider? A flow file read from a repository has only the string.
- There is no plan-graph projection today (decisions.md D-020) and no projection carries model-call detail either. Does the model drill-in read from `run-events`/`transcript`, or does it need a projection of its own? That decision has the same shape as D-020 and should probably be made at the same time.
- Three new experimental panes (Models, Decisions, Evals) landed in this working tree from another agent. Do the flow-builder mock and the experimental panes share one component vocabulary (`Primitives.tsx`: Section/Split/Facts/Table/Rail/Steps/Bars/Code/Badge), or does the flow-builder mock stay a standalone vite bundle and duplicate them?

## R2.3 — n8n canvas + NDV mechanics, at source-string fidelity, for the Smithers flow-builder mock

n8n's canvas is a fixed graph of item-array pipes, and almost every UI affordance we envy — the three-pane NDV, the Schema drag-source, pinning, "Debug in editor", the dirty-node triangle — exists because their engine cannot tell you what is stale, so a human must pin, mock and re-run to find out. The mechanics worth stealing are the presentation ones: status-icon precedence in one slot, the zoom-compensated edge label, the hover toolbar's three-verb order, the Logs bottom drawer with an Overview/Details switch, and the schema-before-execution preview ("Usually outputs the following fields. Execute the node to see the actual ones."). The mechanics to reject are the ones our engine already replaces: item counts on edges, Table view, pinning-as-transport, and the whole heuristic dirty-node vocabulary of "may change", which we can state exactly instead.

### [adapt] NDV is INPUT | node tabs | OUTPUT, and the side panes are the same component as the run data viewer
Pane titles are literally `ndv.input` = "Input" and `ndv.output` = "Output" (the docs and the pin flow shout them as **INPUT** / **OUTPUT**). The centre column is a tab strip: `nodeSettings.parameters` = "Parameters" (compact: `nodeSettings.parametersShort` = "Params"), `nodeSettings.settings` = "Settings", `nodeSettings.docs` = "Docs". Both side panes render the SAME `RunData.vue`; the input pane just points at the upstream node's output. Opening is double-click on canvas, or Enter on a selected node. A real PR exists titled "Keep NDV input and output panel content visible at narrow widths" — the three-pane layout is their hardest layout problem.

*Why:* Our inspector is already schema-derived and one-sided. Two live panes flanking the payload is the upgrade: left = the typed values this node consumes (with their producing node named), right = the typed success/error value it settled. Do NOT copy the tab strip — "Docs" and "Settings" are n8n's plugin-config problem, not ours.
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json:1977 (ndv.input); packages/frontend/editor-ui/src/features/ndv/panel/components/InputPanel.vue:444; https://docs.n8n.io/build/work-with-data/overview.md

### [adapt] The view toggle is a three-option segment control in a fixed order: Schema, Table, JSON
`RunDataDisplayModeSelect.vue` builds `defaults` as exactly `[{label: runData.schema='Schema', value:'schema'}, {label: runData.table='Table', value:'table'}, {label: runData.json='JSON', value:'json'}]`, then conditionally pushes `runData.binary='Binary'`, and unshifts `'HTML'` (output pane, html-generating node) and `runData.rendered='Rendered'` (AI content). In compact mode each option collapses to an icon: `schema`, `table`, `json`, `binary`, `file-code`, `text`. Schema is FIRST and is the default.

*Why:* Steal "Schema first", steal the segment control. Reject "Table": a table exists because an n8n edge carries an item ARRAY. Our edges carry one typed value. Our three are Schema | Value | Code — and "Code" is the drill-in the user asked for, which n8n has no equivalent of.
*Source:* packages/frontend/editor-ui/src/features/ndv/runData/components/RunDataDisplayModeSelect.vue

### [steal] Schema view is the drag SOURCE; the parameter input is the drop TARGET, and both sides advertise it in copy
Mapping is "dragging and dropping data from the **INPUT** pane into node parameters. This generates the expression for you." The source side hints `dataMapping.dragColumnToFieldHint` = "Drag onto a field to map column to that field"; the empty target side hints with a three-part sentence: `parameterInput.dragTipBeforePill` = "Drag an" + `parameterInput.inputField` = "input field" (rendered as a pill) + `parameterInput.dragTipAfterPill` = "from the left to use it here." A second route is advertised too: `parameterInput.hoverTableItemTip` = "You can also do this by hovering over input/output items in the table view". On first success they fire a celebration toast: `dataMapping.success.title` = "You just mapped some data!". Node authors opt fields in with `requiresDataPath: 'single' | 'multiple'`.

*Why:* This is the single best idea on the n8n canvas and it maps onto our engine BETTER than onto theirs: dragging a field from an upstream node's schema onto a payload field is precisely how you author a `Planned` reference (`← upstream.field`), and unlike n8n it is type-checked at drop time. The empty-state pill sentence is the whole discoverability mechanism — copy its shape.
*Source:* https://docs.n8n.io/build/work-with-data/reference-data/use-the-ui-mapper.md; packages/frontend/@n8n/i18n/src/locales/en.json (dataMapping.*, parameterInput.dragTip*)

### [steal] n8n shows a schema BEFORE the node has ever run, and labels its uncertainty precisely
Three distinct strings for three epistemic states: `dataMapping.schemaView.preview` = "Usually outputs the following fields. {execute} to see the actual ones. {link}" with `{execute}` = "Execute the node"; `dataMapping.schemaView.previewExtraFields` = "There may be more fields. Execute the node to be sure."; and for a stale-but-real schema `dataMapping.schemaView.previewLastExecution` = "The fields below come from the last successful execution. {execute} to refresh them." The preview badge is `dataMapping.schemaView.previewNode` = "Preview". Merged branches get `dataMapping.schemaView.mergeNotice` = "This schema shows fields from multiple items. Some fields may be absent in individual items."

*Why:* This is n8n guessing at a schema from a hand-maintained sample. We have the real thing: `Graph.build` evaluates every continuation against a strict `Planned` placeholder, so our pre-run schema is EXACT, not "usually". Steal the three-state vocabulary and then delete the hedging: our states are "declared" (from the Action's schema), "settled" (from this run) and "cached" (from a prior run at the same step key), and none of them needs the word "usually".
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json (dataMapping.schemaView.*)

### [adapt] Every parameter has a Fixed/Expression toggle, and the expression's evaluated result is shown inline as "e.g. …"
`parameterInput.fixed` = "Fixed" / `parameterInput.expression` = "Expression" is the toggle. Typing `=` into an EMPTY parameter input switches to expression mode (documented shortcut). Expression source is `={{ ... }}`; CodeMirror 6 powers highlighting and completion. The live result appears under the field as `parameterInput.expressionResult` = "e.g. {result}", with `parameterInput.result` = "Result" heading in the modal and `expressionEdit.resultOfItem1` = "Result of item 1". The affordance hints are `expressionTip.javascript` = "Anything inside <code>{{ }}</code> is JavaScript." and `expressionTip.typeDotObject` = "Type <code>.</code> for data transformation options, or to access fields." When there is nothing to evaluate against: `expressionModalInput.evaluatedDuringExecution` = "[evaluated during execution]".

*Why:* Steal the inline evaluated preview under the field and steal "[evaluated during execution]" verbatim as a state — it is exactly what a `Planned` reference is before its producer settles. Reject the Fixed/Expression duality itself: a typed field is either a literal or a reference, and we can show that with the reference arrow rather than a mode switch that makes every field two fields.
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json (parameterInput.*, expressionTip.*, expressionModalInput.*); https://deepwiki.com/n8n-io/n8n/6.3-parameter-input-and-expression-editor

### [steal] Expression failures are diagnostic sentences that NAME the offending node, not "invalid expression"
`expressionModalInput.noNodeExecutionData` = "Execute node ‘{node}’ for preview"; `pairedItemConnectionError` = "No path back to node"; `pairedItemError` = "Can’t determine which item to use"; `pairedItemInvalidPinnedError` = "Unpin node ‘{node}’ and execute"; `expressionEditor.uncalledFunction` = "[this is a function, please add ()]". The full error view escalates to `nodeErrorView.description.noNodeExecutionData` = "An expression references the node <strong>'{nodeCause}'</strong>, but it hasn't been executed yet. Either change the expression, or re-wire your workflow to make sure that node executes first."

*Why:* This is the same discipline as our typed-failures-blame-infra rule: every message names the node, the cause and the next action. Our equivalents write themselves — "Node ‘review’ consumes `plan.summary`, which `plan` has not settled" — and unlike n8n ours are statically knowable before the run starts.
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json (expressionModalInput.*, nodeErrorView.description.*)

### [reject] Item counts, page size and run selector are the whole grammar of the OUTPUT header — and they exist because edges carry arrays
`ndv.output.items` = "{count} item | {count} items"; `ndv.output.itemsTotal` = "{count} item total | {count} items total"; `ndv.output.of` = "{current} of {total}"; `ndv.output.pageSize` = "Page Size"; `ndv.output.run` = "Run"; `ndv.output.branch` = "Branch"; `ndv.output.andSubExecutions` = ", {count} sub-execution | , {count} sub-executions". Input and output run selectors can be chained: `runData.linking.hint` = "Link displayed input and output runs" / `runData.unlinking.hint` = "Unlink displayed input and output runs". Search reports `ndv.search.items` = "{matched} of {count} item | {matched} of {count} items", and schema view cannot search values: `ndv.search.noMatchSchema.description` = "To search field values, switch to table or JSON view."

*Why:* An n8n edge is a bag of items and a node runs once per item, so "3 of 47" is load-bearing there and meaningless here. Our edge carries one typed value; our multiplicity is bounded unrolling (N real nodes, D-017) and trampoline rounds. The one piece worth keeping is the `Run` selector, re-pointed at `lineage_id` + `round_ordinal`: "Round 2 of 3".
*Source:* packages/frontend/editor-ui/src/features/ndv/runData/components/RunDataItemCount.vue; packages/frontend/@n8n/i18n/src/locales/en.json (ndv.output.*, runData.linking.*)

### [steal] The node hover toolbar has exactly three verbs, in a fixed order, and the status icon lives beside it
From source, in render order: `execute-node-button` icon `node-play`, tooltip `node.testStep` = "Execute step" (or `ndv.execute.deactivated` = "This node is deactivated and can't be run" when off) → `disable-node-button` icon `node-power`, tooltip flips between `node.disable` = "Deactivate" and `node.enable` = "Activate" → `delete-node-button` icon `node-trash`, tooltip `node.delete` = "Delete" → optional `crosshair` (`node.focusNode` = "Focus node") → optional sticky colour selector → optional `sparkles` (`node.addToAi` = "Add to n8n AI" / `node.addToChat` = "Add to chat") → always-last `overflow-node-button` icon `node-ellipsis`, tooltip `node.moreActions` = "More actions", which opens the context menu. The toolbar sits ABOVE the node (`padding-bottom`, `justify-content: center`) and `<CanvasNodeStatusIcons>` is rendered as its right-hand sibling.

*Why:* Three verbs and an ellipsis is the right budget, and "above the node, not on it" is why n8n nodes stay readable. Our three verbs are different: Re-run from here · Pin this settlement · Inspect code. "Deactivate" has no meaning in a content-addressed plan — deactivating a node would re-key everything downstream, which is an edit, not a toggle.
*Source:* packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/nodes/CanvasNodeToolbar.vue

### [adapt] The context menu is the full verb list, and it is shared by the ellipsis, right-click and multi-select
Exact labels, all pluralised via `{subject}`: `contextMenu.open` = "Open...", `contextMenu.test` = "Execute step", `contextMenu.rename` = "Rename", `contextMenu.deactivate` = "Deactivate | Deactivate {subject}", `contextMenu.pin` = "Pin | Pin {subject}" / `contextMenu.unpin` = "Unpin | Unpin {subject}", `contextMenu.copy`, `contextMenu.duplicate`, `contextMenu.tidyUpWorkflow` = "Tidy up workflow" / `contextMenu.tidyUpSelection` = "Tidy up selection", `contextMenu.extract` = "Convert node to sub-workflow | Convert {subject} to sub-workflow", `contextMenu.selectAll` = "Select all", `contextMenu.deselectAll` = "Clear selection", `contextMenu.delete`, `contextMenu.addSticky` = "Add sticky note", `contextMenu.replace` = "Replace", `contextMenu.openSubworkflow` = "Go to Sub-workflow". The subject noun is itself a string: `contextMenu.node` = "node | {count} nodes".

*Why:* The `{subject}` pluralisation pattern ("Delete" vs "Delete 4 nodes") is free correctness and we should copy it. "Convert node to sub-workflow" is the one entry with a direct analogue: our `Flow.to()` handoff. "Replace" is a trap for us — replacing a node re-keys the suffix and voids approvals (D-022), so it must route through the re-key HUD, never a menu item that just does it.
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json:2566 (contextMenu.*); https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes.md

### [adapt] ONE status slot per node, with a documented precedence chain and an explicit no-op case
`CanvasNodeStatusIcons.vue` is a v-if/v-else-if ladder in this exact order: Restricted (`lock`, "Restricted on this instance"/"Restricted in this project") → not-installed community node (`hard-drive-download`, "Install the package to use this node") → Disabled (`power`) → execution errors (`CanvasNodeStatusMark status="error"`, icon `node-execution-error`, tooltip is a `TitledList` headed "Issues:" listing each error, deduped as `"{error} (x{count})"`) → validation errors (`node-validation-error`, or `key-round` with `node.setupRequired` = "Add a credential in the setup panel") → `executionStatus === 'unknown'` renders NOTHING, with the comment "Do nothing, unknown means the node never executed" → pinned (`node-pin`) → dirty (`status="warning"`, icon `node-dirty`) → success (`status="success"`, icon `node-success`). `CanvasNodeStatusMark` appends an iteration count `{{ iterations }}` when `status !== 'error' && iterations > 1`.

*Why:* Steal the explicit precedence and especially the "never executed renders nothing" rule — silence is a state, and our dashed-idle node is saying the same thing. Reject the single slot: n8n collapses pinned+dirty+error into one icon and loses information. We already ruled colour is never the only signal (D-026), so our node can afford a status word plus an independent pin/lock mark. Steal the `(x{count})` de-dup for repeated failures across unrolled loop bodies.
*Source:* packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/nodes/render-types/parts/CanvasNodeStatusIcons.vue; .../parts/CanvasNodeStatusMark.vue

### [steal] "Dirty nodes" is n8n's hand-rolled, heuristic, apologetic version of our step-key invalidation
Canonical definition: "A **dirty node** is a node that executed successfully in the past, but whose output n8n now considers stale or unreliable… if the node executes again, the output may be different." Recognised by "their different-colored border and a yellow triangle in place of the previous green tick symbol". Two tooltips, both hedged: `node.dirty` = "Node configuration changed. Output data may change when this node is run again" and `node.subjectToChange` = "Because of changes in the workflow, output data may change when this node is run again" (enum `CanvasNodeDirtiness.PARAMETERS_UPDATED` picks between them). The propagation rules are a hand-maintained list: inserting/deleting a node marks the FIRST FOLLOWING node dirty; modifying parameters marks the modified node; adding a connector marks the destination; unpinning marks the unpinned node; inside a loop it also marks the loop's first node. Cleared only by executing it again.

*Why:* Steal the VISUAL — yellow border plus a triangle replacing the green tick is the clearest "this was good and now isn't" in the survey, and it is already our amber-dashed dirty state. Reject every word of the copy. Their invalidation is a per-gesture heuristic list that says "may change"; ours is `StepKey` — we know exactly which nodes re-key and that nothing else does (D-021). Where they write "may change when this node is run again", we write "re-keys · 4 downstream · 9 cache hits · 0ms each". That contrast IS the pitch, and the mock should put their sentence and ours side by side.
*Source:* https://docs.n8n.io/build/understand-workflows/understand-executions/understand-dirty-nodes.md; packages/frontend/@n8n/i18n/src/locales/en.json:2107-2108

### [adapt] Partial execution is one button in the NDV, and its semantics are "run me plus whatever upstream I need"
`ndv.execute.testNode` = "Execute step" with description `ndv.execute.testNode.description` = "Runs the current node. Will also run previous nodes if they have not been run yet". Its blocked states are separate strings: `ndv.execute.requiredFieldsMissing` = "Complete required fields first", `ndv.execute.upstreamNodeHasIssues` = "A previous node has missing required fields", `ndv.execute.fixPrevious` = "Fix previous node first", `ndv.execute.nodeIsDisabled` = "Enable node to execute", `ndv.execute.workflowAlreadyRunning` = "Workflow is already running". Whole-flow run is `nodeView.runButtonText.executeWorkflow` = "Execute workflow" → "Executing workflow", and a partial run relabels it with `nodeView.runButtonText.from` = "from {nodeName}". Known failure: "The destination node is not connected to any trigger. Partial executions need a trigger." and "Please execute the whole workflow, rather than just the node. (Existing execution data is too large.)"

*Why:* "Execute workflow from {nodeName}" on the main run button is the exact affordance D-016 says we are missing — the ability to ACT on a node. Steal it. Steal the family of distinct blocked reasons instead of one greyed button. Reject the "will also run previous nodes" semantics: ours doesn't re-run upstream, it reuses the cache, and the button should say so — "Re-run from here · 9 cache hits".
*Source:* https://docs.n8n.io/build/understand-workflows/understand-executions/types-of-executions.md; packages/frontend/@n8n/i18n/src/locales/en.json (ndv.execute.*, nodeView.runButtonText.*)

### [steal] Pinning is a first-class node state with its own border, ribbon, keyboard shortcut and unpin confirmation
Pin from the OUTPUT pane: `ndv.pinData.pin.title` = "Pin data", tooltip `ndv.pinData.pin.description` = "Node will always output current data instead of executing. Doesn't apply to production executions." Keyboard: **P** on a selected canvas node. The pinned node draws a 2px accent border (`&.pinned { --canvas-node--border-width: 2px; }`) and a `node-pin` status icon; the OUTPUT pane shows the ribbon `runData.pindata.thisDataIsPinned` = "This data is pinned for test executions." with a `runData.pindata.unpin` = "Unpin" link. Running a pinned node is guarded by a modal: title `ndv.pinData.unpinAndExecute.title` = "Unpin output data?", body "Testing a node overwrites pinned data.", confirm "Unpin and test". Pinned data can be edited (`runData.editOutput` = "Edit Output", Save → pins). Limits: no binary data ("Pin Data is disabled as this node's output contains binary data."), and a size cap ("Unable to pin data due to size limit"). AI-fabricated data gets its own warning: "Pin simulated data?" / "…Any IDs, emails or records in it don't exist." / confirm "Pin anyway".

*Why:* D-007 already rules pin is table stakes. Take the whole kit: the 2px border, the ribbon with an inline Unpin, the destructive-action modal, and especially "Pin simulated data?" — an agent-authored flow will absolutely want to pin a model's invented output, and that confirmation is the honest version of it. For us a pin is a forced cache hit at a step key, so the ribbon reads "pinned · 0ms" and the modal warns it will be re-keyed, not overwritten.
*Source:* https://docs.n8n.io/build/work-with-data/pin-and-mock-data.md; packages/frontend/@n8n/i18n/src/locales/en.json:2050 (ndv.pinData.*), packages/frontend/editor-ui/.../CanvasNodeDefault.vue

### [adapt] "Debug in editor" / "Copy to editor": a past execution is loaded back onto the live canvas by PINNING its data
From the Executions list, a failed run offers `executionsList.debug.button.debugInEditor` = "Debug in editor" and a successful one `executionsList.debug.button.copyToEditor` = "Copy to editor". n8n "copies the execution data into your current workflow, and pins the data in the first node". Destructive, so it confirms: headline `nodeView.confirmMessage.debug.headline` = "Unpin workflow data", message "Loading this execution will unpin the data currently pinned in these nodes", confirm button "Unpin". On success the toast is `nodeView.showMessage.debug.title` = "Execution data imported" with body "You can make edits and re-execute. Once you're done, unpin the the first node." (their typo). Partial imports warn: "Some execution data wasn't imported" / "Some nodes have been deleted or renamed or added to the workflow since the execution ran." Read-only past executions banner: `executionDetails.readOnly.readOnly` = "Read only" plus "You're viewing the log of a previous execution. You cannot make changes since this execution already occurred."

*Why:* Steal the JOB ("a past run becomes an editable present run") and the honesty of "Some nodes have been deleted or renamed… since the execution ran" — that is exactly our re-key story told in their vocabulary. Reject the MECHANISM: they transport a past run by pinning JSON into node 1 and telling you to remember to unpin it afterwards. Ours is a fork at a step key; nothing is pinned, nothing must be undone, and the cached prefix is free. This is the single sharpest comparison slide in the deck.
*Source:* https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions.md; packages/frontend/@n8n/i18n/src/locales/en.json:1642 (executionsList.debug.*), nodeView.confirmMessage.debug.*

### [steal] The Logs panel (shipped in n8n@1.94.0) is a collapsible bottom drawer with an Overview/Details switch and a run TREE
Header title `logs.overview.header.title` = "Logs"; a segment switch `logs.overview.header.switch.overview` = "Overview" / `logs.overview.header.switch.details` = "Details"; empty state `logs.overview.body.empty.message` = "Nothing to display yet. Execute the workflow to see execution logs." with action "Execute the workflow". Each row (`LogsOverviewRow.vue`) is: indent connectors (curved/straight) · node icon · name · `logs.overview.body.summaryText.in` = "{status} in {time}" (running rows use `…summaryText.for` = "{status} for {time}" with an `AnimatedSpinner` in place of the status word, waiting rows a `status-waiting` icon, errors a `triangle-alert`) · `logs.overview.body.started` = "Started {time}" · a consumed-token column · hover buttons `square-pen` ("Open node", aria "Open...") and `play` ("Execute step", emits `triggerPartialExecution`) · a chevron `logs.overview.body.toggleRow` = "Toggle row". Panel actions: `runData.panel.actions.collapse` = "Collapse panel", `…open` = "Open panel", `…popOut` = "Pop out panel", `…sync` = "Sync selection with canvas", `logs.overview.header.actions.clearExecution` = "Clear execution". Detail header tabs are `logs.details.header.actions.input` = "Input" / `…output` = "Output".

*Why:* We already ship 80% of this in `RunTraceCard.tsx` (span tree, waterfall, detail pane) — what we lack is the two things this row has: a per-row RE-RUN button and "Sync selection with canvas". Those two turn a log into a control surface and close D-016's real gap. "Pop out panel" is a genuinely good, cheap idea for a two-monitor debug session. Our token column becomes cost + `0ms` for cache hits.
*Source:* packages/frontend/editor-ui/src/features/execution/logs/components/LogsOverviewRow.vue; packages/frontend/@n8n/i18n/src/locales/en.json:1864 (logs.*); https://docs.n8n.io/changelog/release-notes-1.x.md#extended-logs-view

### [steal] Edges: a status-coloured label, a zoom-compensated scale, and a hover toolbar of exactly [+][trash]
`CanvasEdge.vue` renders the label through `EdgeLabelRenderer` with `data-edge-status` set to the edge status; `hasColoredStatus` is true only for `'success'` and `'pinned'`, so a normal edge label is neutral and a pinned/succeeded one is tinted. The label counter-scales against zoom: `transform: scale(var(--canvas-zoom-compensation-factor, 1))`. Hovering an edge opens `CanvasEdgeToolbar.vue`: first a `plus` button, `data-test-id="add-connection-button"`, tooltip `node.add` = "Add" (or `node.add-human-review-step` = "Add human review step" for an AI-tool edge into an Agent), aria `node.addNode` = "Add node"; then a `trash-2` button, tooltip `node.delete` = "Delete", aria `node.deleteConnection` = "Delete connection". Creating a connection is documented as dragging "the grey dot or **Add node**" on the right of a node to "the grey rectangle on the left side of the following node" — the two handle shapes are deliberately different.

*Why:* The zoom-compensated label is the trick that makes their `THEN`/`ELSE`/`CATCH`-equivalent labels legible at every zoom, and D-024 says our camera changes zoom constantly, so we need it. Steal [+][trash] on edge hover. The asymmetric handles (output = dot, input = rectangle) are a free directionality cue we can reuse for value vs continuation vs failure edges.
*Source:* packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/edges/CanvasEdge.vue; .../edges/CanvasEdgeToolbar.vue; https://docs.n8n.io/build/understand-workflows/workflow-components/connect-nodes-together.md

### [steal] The node's SHAPE encodes its role: trigger is rounded on its left side only, a sub-node is a pill
From `CanvasNodeDefault.vue`: base node is `border-radius: var(--radius--lg)`. A trigger sets `--trigger-node--radius: 36px` and `border-radius: var(--trigger-node--radius) var(--radius--lg) var(--radius--lg) var(--trigger-node--radius)` — big radius on the LEFT corners only, so the entry point of the graph is a distinct silhouette. A `configuration` node (a sub-node such as a model or tool) is a full pill: `border-radius: calc(var(--canvas-node--height) / 2)`. A `configurable` node (one that accepts sub-nodes underneath) left-aligns its icon and label instead of centring them. States are stacked classes with a source comment: "The reverse order defines the priority in case multiple states are active" — `.selected`, `.success`, `.warning`, `.error`, `.pinned` (2px border), `.disabled`, `.running`, `.waiting` (both drawing an animated `::after` ring that re-inherits the trigger's radius), `.placeholder` (`2px dashed`). Label/subtitle sit OUTSIDE the node (`top: 100%`, `min-width: calc(var(--canvas-node--width) * 2)`), clamped to 2 lines.

*Why:* Silhouette-encodes-role is the cheapest legibility win available and costs no colour. Our three `Plan` node kinds are "step" | "agent" | "merge": give `agent` the pill, `merge` a distinct notch, `step` the plain radius, and reserve the one-sided radius for a trampoline round boundary (the `Flow.to()` entry). Also steal "label lives outside the node, 2x node width" — it is why n8n nodes stay readable while ours get wide.
*Source:* packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/nodes/render-types/CanvasNodeDefault.vue

### [adapt] Node category colour comes from the node type itself, two ways, and is deliberately a small token set
Older nodes hard-code a hex in `description.defaults`, e.g. the If node is `color: '#408000'`. Newer nodes declare a NAMED token instead: the Set node is `iconColor: 'blue'`, the Code node `iconColor: 'amber'`, alongside a `group: ['input'] | ['transform'] | …`. The design system resolves either: `resolveIconColor()` maps the named `IconColor` tokens (`primary`, `secondary`, `text-dark`, `text-base`, `text-light`, `text-xlight`, `danger`, `success`, `warning`, `foreground-dark`, `foreground-xdark`) to CSS variables, and passes through any raw `--node--icon--color--blue`-style custom property.

*Why:* The migration from free hex to a named token is the lesson: 400+ integrations each picking a hex produced a canvas with no colour grammar, and they are walking it back. We should never let an Action declare a colour. Colour is reserved for STATUS (running/built/clean/failed/skipped/dirty) and the kind rail carries identity. That is already what the mock does — this finding is the evidence for keeping it.
*Source:* packages/nodes-base/nodes/If/V2/IfV2.node.ts:26; packages/nodes-base/nodes/Code/Code.node.ts:36; packages/frontend/@n8n/design-system/src/components/N8nIcon/iconColor.ts

### [adapt] Canvas groups enforce structural invariants at connection time and refuse the edit with a reason
A group has one entry and one exit and must stay connected end to end; violations are blocked with specific copy, not a generic error: `canvas.nodeGroup.connectionChangeBlocked.inputEdgeToNonRoot` = "Connections into '{group}' must go to its first node. You can make this change after ungrouping it.", `…multipleInputNodes` = "'{group}' can have only one entry point…", `…multipleOutputNodes` = "'{group}' can have only one exit point…", `…noContinuousPathFromRootToLeaf` = "'{group}' must stay connected from first node to last node…", `…nonMainBoundary` = "The sub-node connection between '{source}' and '{target}' crosses the boundary of '{group}'…". Titles are `canvas.nodeGroup.connectionAddBlocked.title` = "Connection not added" / `…connectionRemoveBlocked.title` = "Connection not removed". Auto-repair exists too: `canvas.nodeGroup.autoExtended.title` = "'{group}' extended" / message "Added '{node}' to keep '{group}' valid with the new connection." Shortcuts: Cmd+G group, Cmd+Shift+G ungroup, Alt+G expand, Shift+Alt+G collapse.

*Why:* Two transferable moves. First, the refusal names the invariant and offers the escape hatch in the same sentence — that is the template for every edit our canvas must refuse ("this would re-key 6 nodes and void 2 approvals"). Second, auto-extension: the system repairs the structure and TELLS you what it did. An agent editing the graph as a visible peer (D-008) needs exactly that notification shape.
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json (canvas.nodeGroup.*); https://docs.n8n.io/build/understand-workflows/workflow-components/canvas-groups.md

### [steal] The Focus panel: a persistent side surface holding one parameter so you can iterate without reopening the node
`nodeView.openFocusPanel` = "Open focus panel"; empty states `nodeView.focusPanel.v2.noParameters.title` = "Select a node to edit it here" and the older `nodeView.focusPanel.noParameters.title` = "Show a node parameter here, to iterate easily" with subtitle "For example, keep your prompt always visible so you can run the workflow while tweaking it". Staleness is called out where it bites: `nodeView.focusPanel.noExecutionData` = "Execute previous node for autocomplete" and `nodeView.focusPanel.missingParameter` = "This parameter is no longer visible on the node. A related parameter was likely changed, removing this one." Adjacent: `nodeView.enterZoomMode` = "Enter zoom mode" / "Leave zoom mode" and the node toolbar's `crosshair` "Focus node".

*Why:* This is the closest thing n8n has to the user's "really high quality way of drilling into things and seeing the actual code", and its motivating example — keep the prompt visible while you re-run — is our exact use case for an agent node. A persistent pane pinned to one field, surviving canvas navigation, beats a modal NDV for iteration. Steal it and make its content the Action's source, with the `Planned` references resolved inline.
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json (nodeView.focusPanel.*, nodeView.openFocusPanel)

### [steal] Canvas keyboard shortcuts are dense, single-key on selection, and include graph-aware arrow navigation
Single keys with a node selected: **Enter** open, **F2** rename, **D** deactivate, **P** pin, **Delete** delete, **Space** rename the selected group. Graph-aware selection: **ArrowLeft/Right** select the node left/right of the current one, **ArrowUp/Down** select the SIBLING above/below, **Shift+ArrowLeft/Right** select all nodes left/right of the current one. Canvas: **1** zoom to fit, **0** reset zoom, **+/-** zoom, **Space+drag** or **Ctrl/Cmd+drag** pan, **N** open the node panel, **Shift+S** add sticky note, **Ctrl/Cmd+A** select all, **Alt+G / Shift+Alt+G** expand/collapse groups, **Ctrl/Cmd+G / Ctrl/Cmd+Shift+G** group/ungroup. Global: **Ctrl/Cmd+Enter** execute workflow, **Ctrl/Cmd+K** command bar, **Ctrl/Cmd+S** save. In a parameter: **=** in an empty input switches to expression mode.

*Why:* "Shift+ArrowRight selects everything downstream" is the graph-native selection gesture we need for the re-key story — it is literally "select the suffix that will re-run". **1** for zoom-to-fit and **0** for reset should be free even with the camera following the run (D-024). **P** for pin and **Enter** to open are muscle memory anyone coming from n8n already has.
*Source:* https://docs.n8n.io/build/keyboard-shortcuts.md

### [adapt] Node settings expose failure policy as an enumerated On Error with three named outcomes, plus retry and once-only
`nodeSettings.onError.displayName` = "On Error", description "Action to take when the node execution fails", options: `stopWorkflow` = "Stop Workflow" ("Halt execution and fail workflow"), `continueRegularOutput` = "Continue" ("Pass error message as item in regular output"), `continueErrorOutput` = "Continue (using error output)" ("Pass item to an extra `error` output"). Also `Retry On Fail` with `Max. Tries` and `Wait Between Tries (ms)`, `Execute Once`, `Always Output Data`, and `Custom span attributes` for OpenTelemetry. These settings surface back on the canvas as hint sentences: `ndv.nodeHints.continueOnError` = "Execution will continue even if the node fails", `…retryOnFail` = "This node will automatically retry if it fails", `…executeOnce` = "This node will execute only once, no matter how many input items there are", `…alwaysOutputData` = "This node will output an empty item if nothing would normally be returned", `…disabled` = "This node is disabled, and will simply pass the input through".

*Why:* "Continue (using error output)" IS an n8n failure edge, and it is the direct analogue of our `failure` edge reason and the `CATCH` label. Steal the rule that a setting which changes graph shape must render as an extra output on the canvas, not just a checkbox in a panel. Steal the hint sentences — a one-line restatement of each non-default setting, shown where the node lives, is the minimal-text-compliant way to make policy visible. Reject `Always Output Data` and `Execute Once`: both exist only to paper over item-array semantics.
*Source:* packages/frontend/@n8n/i18n/src/locales/en.json (nodeSettings.onError.*, ndv.nodeHints.*); https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes.md

**Exact strings a mock or product must use:**

 ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  · 

**Open questions:**
- What replaces "Execute step" for us? n8n's means "run me, plus any upstream that hasn't run". Ours means "re-run from this step key, reusing the cached prefix" — and the label has to make the cache visible ("Re-run from here · 9 cache hits · +42s") or we lose the only thing that makes us different from them.
- The NDV is a modal that covers the canvas. D-024 says our camera follows the run, so a modal would fight it. Is our drill-in a side pane (n8n's Focus panel shape) that keeps the graph visible, or do we accept a modal for the deep code view? The user asked for BOTH "drill into the actual code" and per-primitive custom UIs — those may need different containers.
- n8n's Schema view is a drag SOURCE for expressions. Our equivalent drag would author a `Planned` reference, which re-keys the target node and everything downstream, which voids approvals (D-022). So a drag is a consequential edit. Does a drag open the re-key HUD before it commits, or do we accumulate drags into a draft the HUD settles once? D-003 and D-028 are both still open and this is where they bite.
- n8n has 400+ node types and one generic parameter renderer. The user says each primitive will have its own UI (the model UI other agents are building). What is the contract between a node's custom pane and the canvas — does the Action declare a renderer id, or does the pane derive from the schema with per-kind overrides? n8n's answer (a `type` field per parameter driving a component tree) is the cheap version; a registry of per-Action panes is the expensive one.
- patterns.smithers.sh was named in the user request and I did not cover it — this brief was n8n-only. Someone must decide which of its real-life examples are built-in primitives versus examples we merely visualize, and that decision changes what the node kind rail has to carry.
- Does our edge label need a value PREVIEW, and at what size? n8n's edge label is status-only because an item array cannot be summarised in 40px. Our edges carry one typed value, so a truncated value is actually possible — but it may read as noise at 0.62 zoom.

## R2.4 — @smthrs/patterns — exact APIs, declared graph shapes, and four demo flows for the flow-builder mock

Every one of the 28 modules in `packages/smithers/flows/patterns/src/` exposes the same two-surface contract — `make(options)` returns a `Flow` whose body is the fully-unrolled conservative topology, and `run(input, options)` is the Effect that performs the branch a declaration cannot — so the canvas can draw the worst case before anything runs, and the unit tests pin exact node counts per pattern that the mock can copy verbatim. The site the user means, `patterns.smithers.sh`, is a RETIRED single-file field guide (`docs/orchestration-patterns.html`, deleted at commit 2716e9855855) whose filter tabs are `All / Primitives / Composites / Use cases` and whose footer reads "Each diagram is inline SVG: sharp, portable, and editable"; the live `smithers-patterns.smithers.sh` Starlight site has no such classification. Two of the retired guide's cards ("Loop", "Ralph loop") now contradict engine ruling D-017 and must not be reused as-is.

### [steal] Every pattern is two surfaces: `make` draws the worst case, `run` narrows it
All 26 pattern modules export `make(options): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown>` and `run(input, options): Effect.Effect<...>`. The docs state the contract verbatim: "`make` returns a flow whose body declares the conservative topology: every round the bound allows, every rung of a ladder, every compensation, whether or not a given run reaches it" and "`run` returns an Effect that performs the branch a declaration cannot." The README proves it with a runnable number: `ReviewLoop.make({produce, review, revise, maxRounds: 3})` then `Graph.nodes(graph).filter(n => n.kind === "FlowCall").length` prints `6` — "Six calls: one draft, three reviews, and the two revisions between them. That is the worst case rather than the likely one, which is the honest answer to 'how much could this cost'." Bounded exceptions: `Bounded` and `Quarantine` export `all(members, options)` (a Node, not a Flow) instead of `make`; `Recursion` exports `recurse(options)`; `Trellis` also exports `compile(plan, options)` and `execute`; `Pattern`/`WithRetry`/`WithCache`/`WithApproval` export decorator factories.

*Why:* This is the single sentence that makes the mock's canvas honest and also sells D-021: a declared plan you can count and cost before it runs is exactly the cache/re-key story, and the patterns package already ships the receipts.
*Source:* /Users/williamcory/smithers/packages/smithers/flows/patterns/docs/README.md:26-33 and /Users/williamcory/smithers/packages/smithers/flows/patterns/README.md:47-55

### [steal] Pattern flows auto-name themselves as `kind(field=value, …)` — the mock's node labels are already specified
`Compose.label(kind, fields, options)` mints `options.name ?? `${kind}(${entries.map(([k,v]) => `${k}=${v}`).join(", ")})``, with array values joined by comma and `undefined` fields dropped. The comment names the exact example: "Names a pattern flow the way the decorators name theirs: the pattern kind and its declared bounds, `reviewLoop(maxRounds=3)`, unless the caller supplied a `name`." Real labels produced by the call sites: `reviewLoop(maxRounds=3)`, `debate(rounds=2)`, `mapReduce(concurrency=4, onEmpty=reduce)`, `escalation(rungs=2, fallback=true)`, `saga(steps=reserve,upload,activate, onFailure=compensate)`, `checkSuite(checks=lint,typecheck,test, strategy=all-pass, concurrency=3)`, `panel(panelists=one,two)`, `loop(maxIterations=3, onMaxReached=return-last)`, `supervisor(workers=coder,tester, maxRounds=3, concurrency=2)`, `kanban(columns=triage,build, items=3, concurrency=3)`, `mergeQueue(members=hotfix,docs,feature, concurrency=1, failurePolicy=halt)`, `scanFixVerify(maxRetries=2, maxIssues=3, concurrency=2)`, `optimizer(maxIterations=3, targetScore=0.8, onMaxReached=return-last)`, `trellis(fuel=3, depth=2, fanout=2)`, `delegationChain(tierOrder=weak,strong, maxDepth=2)`, `driftDetector(alerts=true)`, `intervene(dryRun=false)`, `sidecar(scores=true)`, `runbook(steps=drain,deploy,verify)`, `recurse(fuel=4, depth=3, fanout=2)`, `tryCatchFinally(catch=true, finally=true)`. Decorators name differently: `withApproval(${Compose.displayName(inner)})`, and an unnamed inner flow reads `anonymous` ("`Flow.make` defaults an unnamed flow's name to the empty string … Both forms of 'no name' answer 'anonymous'"). `DelegationChain` mints an inner ladder flow named `delegationTiers(weak -> strong)`.

*Why:* The mock currently invents node captions. These are the real ones, they encode the bound in the label (which is the whole point of a declared plan), and they give the canvas a free second line of information without a single extra word — which satisfies MINIMAL TEXT.
*Source:* /Users/williamcory/smithers/packages/smithers/flows/patterns/src/internal/Compose.ts:397 and src/DelegationChain.ts:373

### [steal] The graph has exactly eight node kinds and a dotted-path id scheme — the mock must not invent a ninth
`Graph.ts` freezes `supportedNodeTags` to `["Succeed", "Fail", "All", "Dynamic", "AndThen", "Map", "FlowCall", "Catch"]`, and `GraphNode.kind` is `NodeAst["_tag"] | "LaneMerge"`. `GraphNode` carries `{ id, kind, dependencies, declaredEffects, effectiveEffects, placement, lane, priority, capabilities, annotations, keyMaterial }`; `Edge` carries `{ from, to, reason }`; `Conflict` carries `{ nodes, paths, strategy: "serialize" | "lane" | "fail", mergeNodeId? }`. Node ids are dotted paths the tests assert on literally: `root`, `root.andThen`, `root.then`, `root.then.andThen`, `root.all.<member>`, `root.all.a.recover` (the per-member Catch arm), and `${call.id}.flow` for the called flow's own body. Trellis plan paths use bracket ordinals: `root.parallel[0]`, `root.parallel[1].sequence[0]`, and its declared slots are `slot-0`, `slot-1`, `slot-2`. Body identity algorithm is the string `sha256-source-captures/v4`. `Graph.maximumGraphDepth = 512`.

*Why:* A mock that shows `root.all.a.recover` as the node id when you click a quarantine arm is instantly credible to anyone who has read a built graph; one that shows `node-7` is not. These ids are also the only thing that makes 'drill into the code' honest — the id IS the address.
*Source:* /Users/williamcory/smithers/packages/smithers/flows/core/src/Graph.ts:97-136, 202, 403-413 and test/Kanban.test.ts:178, test/Trellis.test.ts:546

### [adapt] The site the user means is retired: `patterns.smithers.sh` was a single 504-line HTML field guide, deleted
`CHANGELOG.md:3166` — "feat(patterns-site): ship patterns.smithers.sh orchestration-patterns field guide" (commit `fcc90796a5cf`). It shipped `apps/patterns-site/site/index.html` and `docs/orchestration-patterns.html`, both 504 lines. Commit `2716e9855855` ("phase1: remove the superseded JSX/reconciler execution architecture") deleted both. Neither path exists on main today. Its content is the pre-1.0 JSX era (`packages/components`, `<Task>`, `<Workflow>`, `<Loop>`, `.jsx` examples), so every source link on its cards is dead. Recover it with `jj file show -r 81dd99511728 docs/orchestration-patterns.html` (saved at /private/tmp/claude-501/-Users-williamcory-smithers/35f0fd65-a586-4c1a-aa9a-2960b92b1c42/scratchpad/orchestration-patterns.html). The LIVE site `smithers-patterns.smithers.sh` is an Astro/Starlight docs site at `apps/docs/smithers-patterns/` with five pages: `index.md`, `modules.md`, `loops.md`, `teams.md`, `delegation.md`, `reference/api.md`.

*Why:* Do not cite patterns.smithers.sh as a live reference and do not copy its card taxonomy wholesale — its vocabulary is two majors stale. Its LAYOUT and diagram engine are still the best thing in the repo for a pattern catalog; port those, re-source the cards from `src/`.
*Source:* /Users/williamcory/smithers/CHANGELOG.md:3166; jj diff --stat -r fcc90796a5 and -r 2716e9855855

### [steal] The field guide's filter tabs, footer line, and card chrome — verbatim
`<nav class="toolbar" aria-label="Pattern filters">` holds `<label class="search">` with `placeholder="Search patterns…"` and `aria-label="Search patterns"`, then `<div class="filters" role="group" aria-label="Filter by category">` with four buttons: `All` (`data-filter="all"`, `aria-pressed="true"`, `.active`), `Primitives` (`data-filter="primitive"`), `Composites` (`data-filter="composite"`), `Use cases` (`data-filter="recipe"`). Header: eyebrow `Smithers field guide · 2026`, `<h1>Orchestration patterns</h1>`, a live counter `<strong id="visible-count">–</strong><span>patterns in view</span>`. Empty state: `No patterns match that search.` Footer, two spans: `Built from Smithers components (packages/components), examples/, and docs/recipes.mdx.` and `Each diagram is inline SVG: sharp, portable, and editable.` Sections are numbered `01 / 03` Control-flow primitives, `02 / 03` Composite patterns, `03 / 03` Specific use cases; each card's `.kind` chip prints `section.key === "recipe" ? "use case" : section.key`, with a zero-padded serial. Active-tab style: `.filter.active { color: #fff; background: var(--ink); }`.

*Why:* The user asked specifically what the filter tabs are. Three tabs plus All, with the third internally named `recipe` and displayed as `use case`, is the exact taxonomy to reuse for a pattern palette in the builder — and 'Primitive / Composite / Use case' maps cleanly onto built-in node / composed node / example flow.
*Source:* /private/tmp/claude-501/-Users-williamcory-smithers/35f0fd65-a586-4c1a-aa9a-2960b92b1c42/scratchpad/orchestration-patterns.html:113-139, 465-470, 489-495

### [adapt] The field guide's diagram DSL is a 40-line auto-layout worth porting whole
Spec shorthand, quoted from the source comment: `{ c: [column, column, …], loop: [fromCol, toCol, label]? }`; `column = array of nodes; node = [label, type?, shape?, edgeLabelIn?]`; "Adjacent columns connect automatically (fan-out/fan-in or lane-wise)." Five node types with a two-colour palette each: `agent: ["#fff0e7", "#ff6d2e"]`, `action: ["#e4f4ec", "#176b4b"]`, `decision: ["#f0eafd", "#7753b4"]`, `data: ["#e8eefc", "#3767c8"]`, `human: ["#fff7d6", "#a47708"]`. Three shapes: `rect` (rx 11), `diamond`, `circle`. Layout: viewBox `0 0 390 156`, columns evenly spaced between x=42 and x=348, row bands `ys(1)=[78]`, `ys(2)=[46,110]`, `ys(3)=[32,78,124]`, node width `max(48, min(80, gap-22))`, height 50 (42 when a column holds 3+). Edges are cubic béziers with a mid-point control, stroke `#768078`, 8.5px labels at `#77827b`; loop-backs are `stroke-dasharray="4 4"` routed through y=142. Wiring rule: 1→n fan-out, n→1 fan-in, n→n lane-wise pairing, otherwise full cross product. Each SVG rewrites its arrow marker id (`arrow-N`) so several diagrams coexist on one page.

*Why:* It already solves the problem the mock has — hundreds of small readable graph thumbnails with no layout library — and D-024 says the big canvas can't show everything at once. Use it for a palette/catalog strip, but re-map its five colour types onto the engine's real vocabulary (tier, settlement outcome), not onto 'agent/action/decision/data/human', which is invented.
*Source:* /private/tmp/claude-501/.../orchestration-patterns.html:143-146, 315-318, 360-412

### [reject] Two field-guide cards are now lies: there is no Loop node and no `<Ralph>`
The guide ships a `Loop` primitive card — "Repeat a body until a typed exit condition is met" with a literal loop-back edge labelled `no · next iteration` — sourced to `packages/components · <Loop>`, and a `Ralph loop` card — "Re-run one task forever (check, fix, repeat)" with the edge label `forever · until={false}` — sourced to `examples/ralph-loop.jsx · <Ralph>`. Both contradict D-017 and `plan/src/Node.ts`. What actually exists: `Loop.make` "Declares a bounded loop as its fully unrolled conservative topology. Every iteration up to `maxIterations` is declared" and `Loop.ralph = (options) => make(options)` — "There is no separate predicate flow, so the declared topology is `maxIterations` body calls and nothing else." Test proof: `maxIterations: 3` gives 3 `loop/body` calls and 3 `loop/until` calls, and ralph gives 3 body calls with 0 `until` calls. `Loop.make` refuses a bound that would nest past the plan depth limit: 511 iterations body-only, 255 with an `until` flow, refused at the declaration with `invalid_decorator` rather than as a message-less `plan_too_deep` `GraphBuildError` from `Graph.build`.

*Why:* If the mock reuses that art, the very first engineer who opens it says 'we don't have a loop node' and the demo dies. Draw N real body nodes with the bound in the flow label (`loop(maxIterations=3, onMaxReached=return-last)`) — the unrolling IS the differentiator, so show it.
*Source:* /private/tmp/claude-501/.../orchestration-patterns.html:152,166 vs /Users/williamcory/smithers/packages/smithers/flows/patterns/src/Loop.ts:159-232 and test/Loop.test.ts:38-44,190-195

### [steal] Fan-out family: exact declared shapes, test-pinned
`Bounded.all(members, { concurrency, priority? })` — 5 members at concurrency 2 builds 3 `All` joins and 5 `FlowCall`s (batches 2/2/1, sequenced; "the plan shows exactly how many calls can be in flight"). Order is descending priority then declaration order. `Quarantine.all(members, { policy: "quarantine" | "halt" })` — 3 members under `quarantine` build 3 `Catch`, 3 `Map`, 1 `All`; under `halt`, 0 `Catch`, 1 `All` (a plain `Node.all`). `Panel.make({ panelists, moderator, roles?, concurrency? })` — 2 panelists, no concurrency: 3 `FlowCall` + 1 `All`; 3 panelists at concurrency 2: 4 `FlowCall` + 2 `All`. `MapReduce.make({ map, reduce, concurrency, onEmpty })` — 5 shards at concurrency 4: 6 `FlowCall` + 2 `All`; shard keys are ordinals `shard-0`, `shard-1`, …; `onEmpty: "reduce"` with zero shards = 1 FlowCall, `"succeed"` = 0 FlowCalls and a `Succeed` with value `[]`, `"fail"` throws `{ code: "exhausted", message: "MapReduce received no shards" }` while the graph is being built. `CheckSuite.make({ checks, strategy, concurrency, continueOnFail })` — 3 checks at concurrency 3, `continueOnFail: false`: 3 `FlowCall`, 1 `All`, 1 `Map`; `continueOnFail: true` adds 3 `Catch`; at concurrency 2: 3 `FlowCall`, 2 `All`, 2 `Map` ("one merge between the two batches, plus the verdict"). Each check is called with the literal `{ check: id, input }`.

*Why:* These are the exact numbers a mock has to render to be checkable against `Graph.build`. Batching is the visual that no competitor has: n8n draws a fan-out, nobody draws 'at most 3 of these 6 are ever in flight, and here are the two batches'.
*Source:* test/Bounded.test.ts:30-35, test/Quarantine.test.ts:25-38, test/Panel.test.ts:25-28,123-133, test/MapReduce.test.ts:18-50, test/CheckSuite.test.ts:225-275

### [steal] Loop family: bounded unrolling is visible as N real nodes
`ReviewLoop.make({ produce, review, revise, maxRounds })` — `maxRounds: 2` builds 4 `FlowCall`s; `maxRounds: 3` builds 6 (README prints `6`). Formula: 1 produce + N review + (N-1) revise = 2N. The third call's key material contains refs to BOTH `root.andThen` and `root.then.andThen` — i.e. revise consumes the draft and the review. Outcomes are tagged `{_tag:"Approved", output}` / `{_tag:"Exhausted", output, review}`. `Optimizer.make({ generate, evaluate, targetScore?, maxIterations, onMaxReached? })` — 3 iterations = 3 `optimizer/generate` + 3 `optimizer/evaluate`, and deliberately NOT built on `Loop.make`: "the next `generate` call reads the previous attempt, `{ candidate, score, feedback, iteration }`, so the declared dataflow carries the same edge the search actually depends on." The target score never enters topology, only identity. `ScanFixVerify.make({ scan, fix, verify, maxRetries, maxIssues, concurrency })` — `maxRetries: 2, maxIssues: 3, concurrency: 2` builds 2 scans, 6 fixes, 2 verifies, 4 `All` (two batches per retry: 2+1). Fix member keys are `fix-0`…`fix-{maxIssues-1}`. `DriftDetector.make({ capture, compare, alert?, baseline })` — 1 capture, 1 compare, and the alert call is declared unconditionally when supplied (1) or absent (0): "a declaration cannot branch on the comparison; declaring the alert is the conservative answer, and capability analysis sees the paging authority a run may use." `Sidecar.make({ primary, shadow, score? })` — one `All` over `{primary, shadow}` with the shadow behind a `Catch` settling `{ quarantined: true, error }`, then the score arm declared unconditionally.

*Why:* 'Declared but not taken' is the exact state the mock already needs for D-018's skipped arm, and DriftDetector/Sidecar give two one-node cases where it is trivially legible — the alert node that a green run settles `skipped`.
*Source:* test/ReviewLoop.test.ts:16-28, test/Optimizer.test.ts:63-76, test/ScanFixVerify.test.ts:39-55, test/DriftDetector.test.ts:33-48, src/Sidecar.ts:194-240

### [steal] Escalation: the decider is a NODE, not a diamond on an edge
`Escalation.make({ rungs: ReadonlyArray<Flow.Any | Rung>, accept?, fallback? })` where `Rung = { flow, escalateIf? }`. Two rungs plus a shared `accept` build 4 `FlowCall`s — rung, accept, rung, accept — because `accept` is a flow that is CALLED per rung, not a predicate. Adding a `fallback` adds one more call. The exhausted arm without a fallback is `Node.succeed({ level, result, accepted: false, exhausted: true })`; with one it is `{ level: rungs.length, result, exhausted: false }`. `Reached<A> = { level, result, exhausted: false }`, `Exhausted<A> = { level, result, accepted: false, exhausted: true }`. Doc note that matters for the model-picker UI: "Rungs are alternative strategies, not model-seat fallback. Provider or seat fallback belongs to model routing before a flow is selected." `accepted` reads four shapes only: `true`, `"approved"`, `{ approved: true }`, `{ accepted: true }`. `defaultEscalate` (run-only) escalates on missing result, a set `error`, `failed: true`, or `ok: false`.

*Why:* The retired field guide draws every decision as a `decision`-coloured diamond with the choice on the edge label. That is wrong for this engine: the decider costs a model call and settles its own outcome. Drawing it as a node is both truer and a visible cost the user can point at.
*Source:* /Users/williamcory/smithers/packages/smithers/flows/patterns/src/Escalation.ts:178-240 and test/Escalation.test.ts:34-41

### [steal] Saga: the compensations are declared, in reverse, before anything runs
`Saga.make({ steps: ReadonlyArray<{id, action, compensation}>, onFailure? })`, default `"compensate"`. Three steps under `compensate-and-fail` produce called flows in exactly this order: `do-one, do-two, do-three, undo-three, undo-two, undo-one` — 11 `Catch` and 8 `Fail` nodes ("Three boundaries per step (action, continuation, undo), plus reporting and clean settlement"). Under `onFailure: "fail"` the graph holds only `do-one, do-two, do-three` and 0 `Catch`. The clean-unwind arm is selected by a SCHEMA at execution time, not by a plan-time branch: `const CleanUnwind = Schema.Struct({ failure: Schema.Unknown, residue: Schema.Tuple([]) })`, with the comment "branching on a symbolic error while building the graph would hide the dirty arm." A failed compensation does not stop the ones behind it; every failing id is collected and the run fails `PatternError { code: "compensation_failed", message: `Saga compensation failed for: ${ids.join(", ")}` }` "because state left dirty outranks the failure that started the unwind." Outcomes: `{_tag:"Completed", values}` / `{_tag:"Compensated", failure}`.

*Why:* This is the most visually distinct graph in the package and the one no competitor's canvas can draw: a mirrored second half that exists in the plan and settles `skipped` on a happy run. It also carries the tier story for free — the compensation of an `irreversible` step is the scariest node on any canvas.
*Source:* /Users/williamcory/smithers/packages/smithers/flows/patterns/src/Saga.ts:206-330 and test/Saga.test.ts:66-95

### [steal] Team patterns: Supervisor, Kanban, MergeQueue, Runbook shapes
`Supervisor.make({ plan, workers, review, finalize, maxRounds, concurrency })` — 3 tasks, 2 workers, `maxRounds: 3`, `concurrency: 2` builds 14 `FlowCall`s: 1 `plan`, 9 `work`, 3 `review`, 1 `finalize`. Every call carries a literal `phase` of `"plan" | "work" | "review" | "finalize"`. Concurrency only changes the joins, never the call count: 3 tasks at concurrency 3 = 1 `All`, at concurrency 1 = 3 `All`, same total calls. Round 2+ worker calls additionally carry `{ review, retriable }` so the graph shows which review a re-delegation depends on. `Kanban.make({ columns, items, concurrency, onComplete? })` — 3 items × 2 columns at concurrency 3: 6 `FlowCall`, 2 `All`, 6 `Catch` (one recovery arm per card); at concurrency 2 with `onComplete`: 7 `FlowCall`, 4 `All`, 10 `Map`. `MergeQueue.make({ members, concurrency?, priority?, failurePolicy })` — `concurrency` defaults to 1 and `halt` above 1 is refused; `DefaultPriority = 1000`; 3 members serial = 0 `All` and a chain ordered `hotfix, docs, feature`; priority is carried as a graph ANNOTATION (`node.priority` = `[5000, 1000, 1000]`) and deliberately not as call input "because a priority carried as call input would instead be key material, and re-prioritizing a queue that lands in the same order would re-land every member." `Runbook.make({ steps, approval, onDeny, reason? })` wraps every non-`safe` step in `WithApproval.withApproval`, and REFUSES `onDeny: "skip"` at `make` with a four-sentence `invalid_decorator` message.

*Why:* MergeQueue's priority-as-annotation is a direct, quotable demonstration of D-021: reordering the queue without changing what lands must not re-key any step. That is a re-key-preview beat the mock can show with three nodes.
*Source:* test/Supervisor.test.ts:46-62,170-182; test/Kanban.test.ts:150-180; test/MergeQueue.test.ts:49-129; src/Runbook.ts:179-215

### [adapt] Delegation: Trellis and DelegationChain declare a shape for a plan that does not exist yet
`Trellis.make({ author, leaf, envelope: { fuel, depth, fanout } })` declares "one author call followed by one leaf call per fuel unit", sequenced: total `FlowCall` = `fuel + 1`, with leaf payloads `{ goal, path }` where path is `slot-0`, `slot-1`, `slot-2`. The authored plan itself stands in for the goal, because "a declaration cannot know the goals a plan will name." `Trellis.compile(plan, { leaf })` lowers a REAL plan: `{ sequence: [...] }` becomes chained `Node.andThen`, `{ parallel: [...] }` becomes `Node.all` with members `member-0`…, `{ agent: { goal, seat? } }` becomes one leaf call. `Trellis.leaves(plan)` returns `[{ goal: "a", path: "root.parallel[0]" }, { goal: "b", path: "root.parallel[1].sequence[0]" }, …]`. `Trellis.validate(plan, envelope)` returns typed refusals with messages like `"parallel declares 2 members, above the envelope fan-out 1"` and `"Plan depth 2 exceeds the envelope depth 1"`. `DelegationChain.make` is assembled from other patterns (`ReviewLoop` for derisk, `Trellis` for admission, `Escalation` for the tier ladder, `WithRetry` for attempts) and exports its own size oracle: `bound = (options) => 4 + 2 * options.maxDeriskRounds + options.maxDepth * (3 + 2 * options.tierOrder.length)`, pinned at 22 for `{tierOrder: ["weak","strong"], maxDepth: 2, maxDeriskRounds: 2}`. `Recursion.recurse({ child, fuel, depth, fanout, parent? })` expands a literal `{input, children}` tree, members keyed `child-0`…, and refuses `"Nested recursion may attenuate but cannot widen its parent envelope"`.

*Why:* `DelegationChain.bound()` is a ready-made 'what will this cost before you press go' number for the mock's cost chip. The Trellis slot placeholders are the honest version of D-005's ghost layer — declared leaves whose goals arrive at run time.
*Source:* src/Trellis.ts:375-486, src/DelegationChain.ts:314-315,403-475, test/Trellis.test.ts:530-570, test/DelegationChain.test.ts:379-387

### [steal] Decorators wrap, so they add a real node to the graph
`Pattern.decorate(inner, decorator)` re-declares the result under the wrapped flow's schema and authority ceiling, and "the extra flow call makes the decorator chain part of declaration identity." `WithApproval.withApproval(inner, { reason, approval })` produces a flow named `withApproval(<inner>)` whose body is `approval({input, reason, scope: "run"})` then `inner(input)`; the approval output must decode as `Schema.Literal("approved")` — "A denial cannot decode as this schema and therefore fails on the typed schema-error channel before the inner flow starts." An empty/blank reason throws `"Approval reason must not be empty"`. `WithRetry.{ Backoff, Options, make, withRetry, retryEffect }` — `Backoff = { initialMs, factor, maxMs }`, delay before attempt n+1 is `min(initialMs * factor^(n-1), maxMs)`, and "There is no jitter: a plan built twice must describe the same waits." `nonRetryable` lists error `_tag`s that end the sequence at first occurrence. `WithCache.{ Scope, Options, Policy, CachePolicyAnnotation, policyOf, make, withCache }` — `Scope = "run" | "flow" | "shared"` ("the old `run | workflow | global` policy named after the current concepts"), `Options = { ttlMs?, scope?, version? }`; `withCache` requires explicitly hermetic effects with a sealed or omitted tier and throws `invalid_decorator` synchronously otherwise; the annotation identifier is the literal `"@smthrs/flow/Action/CachePolicy"`. `Pattern` also exports `slot`, `bind`, `Decorator`, `Clipped`, `clipped`, `decorateAll`.

*Why:* `WithCache`'s three scopes and `version` field are literally the re-key lever D-021 sells — and `CachePolicyAnnotation`'s identifier is the string the engine reads at dispatch. A cache chip on a node that prints `shared · ttl 3600000ms · v2` is grounded, not decorative.
*Source:* src/WithApproval.ts:47-113, src/WithRetry.ts:24-50,151-200, src/WithCache.ts:31-115,232-279

### [steal] Error vocabulary the mock must use for a failed node's drawer
`PatternErrorCode = Schema.Literals(["missing_slot", "recursion_bound", "envelope_conflict", "invalid_decorator", "invalid_input", "exhausted", "finalizer_failed", "quarantined", "compensation_failed"])`, tagged `"flows/patterns/PatternError"`, shape `{ code, message, cause? }`. The doc comment draws the operational line: "`invalid_decorator` names a fault in the declaration … `invalid_input` names a fault in the data a pattern read while running … A caller retries or escalates on the second and never on the first." `TrellisErrorCode = ["invalid_envelope", "invalid_plan", "depth_exceeded", "fanout_exceeded", "fuel_exhausted", "leaf_failed"]`, tagged `"flows/patterns/TrellisError"`, shape `{ code, path, message, cause? }`. `DelegationErrorCode = ["invalid_bounds", "missing_tier", "derisk_failed", "leaf_failed"]`, tagged `"flows/patterns/DelegationError"`, same shape, with `path` "or `root` for a failure of the chain itself". Real messages worth quoting on a card: `"No tier settled the leaf at root within 2 attempts each"`, `"Saga compensation failed for: upload, reserve"`, `"Quarantined members: flake"`, `"Loop reached its bound of 4 iterations unsatisfied"`, `"Optimizer reached its bound of 3 iterations below 0.8"`.

*Why:* The declaration-vs-data split is exactly the typed-failure/fault-class rule Will already ruled on (feedback_typed_failures_blame_infra). A failed node whose drawer says `invalid_decorator — this is a bug in the flow, not a retry` is the product working.
*Source:* src/PatternError.ts:20-53, src/Trellis.ts:34-70, src/DelegationChain.ts:36-68

### [steal] DEMO FLOW 1 — wide fan-out: "PR gate · smithersai/smithers#1347"
Pattern: `CheckSuite.make({ checks: { lint, typecheck, test, build, audit, licenses }, strategy: "all-pass", concurrency: 3, continueOnFail: true })`. Flow label: `checkSuite(checks=lint,typecheck,test,build,audit,licenses, strategy=all-pass, concurrency=3)`. NODES (15) — `id · kind · Action · tier`: (1) `resolve-head · step · repo/ResolveHead · sealed`; (2) `add-workspace · step · jj/WorkspaceAdd · compensable`; (3) `check.lint · step · ci/RunLint · sealed`; (4) `check.typecheck · step · ci/RunTypecheck · sealed`; (5) `check.test · step · ci/RunVitest · sealed`; (6) `batch-0 · merge · Node.all`; (7) `check.build · step · ci/RunBuild · sealed`; (8) `check.audit · step · ci/RunAudit · sealed`; (9) `check.licenses · step · ci/RunLicenseScan · sealed`; (10) `batch-1 · merge · Node.all`; (11) `rows · merge · Map (merge batch-0 ∪ batch-1)`; (12) `verdict · merge · Map → Verdict`; (13) `explain · agent · agent/ExplainFailures · sealed`; (14) `post-check-run · step · github/PostCheckRun · irreversible`; (15) `forget-workspace · step · jj/WorkspaceForget · compensable`. EDGES — `1→2 value`; `2→3 value`, `2→4 value`, `2→5 value`; `3→6 value`, `4→6 value`, `5→6 value`; `3→3.recover failure`, `4→4.recover failure`, `5→5.recover failure` (the six `Catch` arms `continueOnFail: true` declares); `6→7 continuation`, `6→8 continuation`, `6→9 continuation` (batch 1 is sequenced after batch 0, it does not consume it); `7→10 value`, `8→10 value`, `9→10 value`, plus three more `failure` arms; `6→11 value`, `10→11 value`; `11→12 value`; `12→13 value`; `12→14 value`; `13→14 value`; `14→15 continuation`. RUN STORY: `check.audit` fails, its `Catch` settles it `Quarantined`, the join does not interrupt its siblings, `verdict` is `{ passed: [lint,typecheck,test,build,licenses], failed: [audit], strategy: "all-pass", verdict: false }`, `explain` settles `built`, and on a green re-run `explain` settles `skipped`.

*Why:* It is the one shape every engineer already has an opinion about, it exercises batching, quarantine arms, a merge node, a skipped arm and an `irreversible` write in fifteen nodes, and the cached-suffix story is obvious: re-run after a docs-only commit and five of six checks are `clean`.
*Source:* src/CheckSuite.ts:202-263 + test/CheckSuite.test.ts:225-275 (shape); node names and Actions are this brief's proposal

### [steal] DEMO FLOW 2 — bounded loop: "Implement #1347 until review approves"
Pattern: `ReviewLoop.make({ produce: implement, review: reviewDiff, revise: implement, maxRounds: 3 })`. Flow label: `reviewLoop(maxRounds=3)`. The loop half is EXACTLY six calls plus four distinct exits — there are three separate `Approved` `Succeed` nodes (one per round) and one `Exhausted` node, because each is built inside its own round's `Node.capture`. NODES (15): (1) `read-issue · step · github/ReadIssue · sealed`; (2) `plan · agent · agent/PlanChange · sealed`; (3) `implement@1 · agent · agent/ImplementChange · compensable`; (4) `review@1 · agent · agent/ReviewDiff · sealed`; (5) `approved@1 · merge · Succeed {_tag:"Approved"}`; (6) `revise@1 · agent · agent/ImplementChange · compensable`; (7) `review@2 · agent · agent/ReviewDiff · sealed`; (8) `approved@2 · merge`; (9) `revise@2 · agent · agent/ImplementChange · compensable`; (10) `review@3 · agent · agent/ReviewDiff · sealed`; (11) `approved@3 · merge`; (12) `exhausted · merge · Succeed {_tag:"Exhausted", output, review}`; (13) `run-tests · step · ci/RunVitest · sealed`; (14) `commit · step · jj/Commit · compensable`; (15) `push-main · step · jj/GitPush · irreversible`. EDGES: `1→2 value`; `2→3 value`; `3→4 value`; `4→5 value`; `4→6 value`; `3→6 value` (revise consumes BOTH the draft and the review — the test asserts the third FlowCall's key material contains refs to `root.andThen` AND `root.then.andThen`); `6→7 value`; `7→8 value`; `7→9 value`; `6→9 value`; `9→10 value`; `10→11 value`; `10→12 value`; `5→13 continuation`, `8→13 continuation`, `11→13 continuation`; `13→14 value`; `14→15 continuation`. RUN STORY: review 2 approves; `approved@2` settles `built`, `approved@1`, `revise@2`, `review@3`, `approved@3` and `exhausted` all settle `skipped`. RE-KEY BEAT: rename `review@2` → free (ids never enter the hash). Change what `implement` consumes → `implement@1` and all 12 nodes downstream re-key; `read-issue` and `plan` stay `clean`.

*Why:* It is the D-017 proof in one picture — a loop drawn as six real nodes with the bound in the flow name — and it is the cleanest carrier for the act-3 re-key preview because the dirty suffix is unambiguous and long.
*Source:* src/ReviewLoop.ts:108-150 + test/ReviewLoop.test.ts:16-28 + docs/README.md:97-133 (the printed `6`); node names and Actions are this brief's proposal

### [steal] DEMO FLOW 3 — compensating saga: "Release @smthrs/patterns 1.0.0-rc.116"
Pattern: `Saga.make({ steps: [reserve-version, publish-npm, push-tag, deploy-docs], onFailure: "compensate" })`. Flow label: `saga(steps=reserve-version,publish-npm,push-tag,deploy-docs, onFailure=compensate)`. NODES (14): (1) `preflight · step · release/Preflight · sealed`; (2) `reserve-version · step · release/ReserveVersion · compensable`; (3) `publish-npm · step · npm/Publish · irreversible`; (4) `push-tag · step · git/PushTag · compensable`; (5) `deploy-docs · step · cloudflare/DeployWorker · compensable`; (6) `completed · merge · Succeed {_tag:"Completed", values}`; (7) `undo.deploy-docs · step · cloudflare/RollbackWorker · compensable`; (8) `undo.push-tag · step · git/DeleteTag · compensable`; (9) `undo.publish-npm · step · npm/Deprecate · irreversible`; (10) `undo.reserve-version · step · release/ReleaseSlot · compensable`; (11) `residue · merge · Map → PatternError{code:"compensation_failed"}`; (12) `compensated · merge · Succeed {_tag:"Compensated", failure}`; (13) `write-note · agent · agent/WriteReleaseNote · sealed`; (14) `announce · step · slack/PostMessage · irreversible`. EDGES: `1→2 value`; `2→3 value`; `3→4 value`; `4→5 value`; `5→6 value`; `5→7 failure`; `4→8 failure`; `3→9 failure`; `2→10 failure`; `7→8 continuation`; `8→9 continuation`; `9→10 continuation` (LIFO, exactly the order the test pins: forward `do-*` then `undo-*` reversed); `10→11 failure`; `11→12 failure` (the `CleanUnwind` schema arm, `residue: []`); `6→13 value`; `13→14 value`. THE BEAT: `publish-npm` is `irreversible` and its compensation `npm/Deprecate` is ALSO `irreversible` — the canvas should make that pair loud, because it is the one thing in the plan that a rollback cannot take back. With `onFailure: "fail"` the entire bottom half disappears (0 `Catch` nodes) — a one-toggle before/after that proves the plan is a projection of the source.

*Why:* No competitor's canvas draws the undo path before the run. It is the most distinct picture in the package, it maps one-to-one onto the `sealed/compensable/irreversible` tier enum the mock already has to honour, and `examples/src/30-failure-control.ts` already ships a runnable four-pattern version of the same release.
*Source:* src/Saga.ts:206-330 + test/Saga.test.ts:66-95 + examples/src/30-failure-control.ts:31-44 (the `reserve/upload/activate` release shape this generalises); Actions and tiers are this brief's proposal

### [steal] DEMO FLOW 4 — escalation ladder: "Repair the red test, cheapest seat first"
Pattern: `Escalation.make({ rungs: [{ flow: repairHaiku }, { flow: repairSonnet }, { flow: repairOpus }], accept: runTest, fallback: askOwner })`. Flow label: `escalation(rungs=3, fallback=true)`. Declares 7 `FlowCall`s — rung, accept, rung, accept, rung, accept, fallback — because `accept` is a flow that is CALLED per rung. NODES (15): (1) `reproduce · step · ci/RunVitest · sealed`; (2) `minimise · agent · agent/MinimiseRepro · sealed`; (3) `repair@0 · agent · agent/RepairTest · compensable`; (4) `accept@0 · step · ci/RunVitest · sealed`; (5) `reached@0 · merge · {level:0, result, exhausted:false}`; (6) `repair@1 · agent · agent/RepairTest · compensable`; (7) `accept@1 · step · ci/RunVitest · sealed`; (8) `reached@1 · merge · {level:1,…}`; (9) `repair@2 · agent · agent/RepairTest · compensable`; (10) `accept@2 · step · ci/RunVitest · sealed`; (11) `reached@2 · merge · {level:2,…}`; (12) `ask-owner · step · flow/HumanTask · sealed`, question `{ kind: "confirm", prompt: "Three seats failed to repair packages/smithers/flows/patterns/test/Saga.test.ts. Take it manually?", attempt: 1, maxAttempts: 3 }`; (13) `reached@fallback · merge · {level:3, result, exhausted:false}`; (14) `commit · step · jj/Commit · compensable`; (15) `push-main · step · jj/GitPush · irreversible`. EDGES: `1→2 value`; `2→3 value`; `3→4 value`; `4→5 value`; `4→6 value` (escalate); `2→6 value`; `6→7 value`; `7→8 value`; `7→9 value`; `2→9 value`; `9→10 value`; `10→11 value`; `10→12 value`; `12→13 value`; `5→14 continuation`, `8→14 continuation`, `11→14 continuation`, `13→14 continuation`; `14→15 continuation`. RUN STORY: `repair@0` and `accept@0` settle `built`, `accept@0` says the test is still red, rung 1 settles `built` and green, so `repair@2`, `accept@2`, `reached@2` and `ask-owner` settle `skipped`. THE BEAT: the three `repair@n` nodes carry three different model seats and a per-node cost, so the ladder is the canvas's model-picker surface — and the comment "Rungs are alternative strategies, not model-seat fallback" is the note the drawer must carry so the mock does not overclaim.

*Why:* It is the only one of the four that naturally demands the model UI the user asked about (three seats, three prices, one ladder), it ends in a real `HumanTask` with the exact `kind: "confirm"` shape the engine already specifies, and its skipped-suffix is the cheapest possible illustration of 'what did this run not have to pay for'.
*Source:* src/Escalation.ts:178-240 + test/Escalation.test.ts:34-41 + HumanTask shape from docs/flow-builder/decisions.md D-023; Actions and seats are this brief's proposal

### [adapt] What the live doc site actually does instead of Primitive/Composite/Use case
`smithers-patterns.smithers.sh` never uses those words. `index.md` carries a "Choose a pattern" table keyed by SHAPE, eight rows: "Repeat until something is true, or until a score is high enough" (`Loop, Optimizer, ScanFixVerify, DriftDetector, Sidecar`); "Get a second opinion, then settle what it says" (`Debate, Panel, ReviewLoop`); "Try one strategy, then a stronger one, then ask a person" (`Escalation`); "Fan out, bound the concurrency, and decide what a failure interrupts" (`Bounded, Quarantine, MapReduce, Recursion`); "Recover, clean up, and undo" (`TryCatchFinally, Saga`); "Coordinate several agents as a team, with approvals and a landing order" (`Supervisor, Intervene, CheckSuite, Kanban, Runbook, MergeQueue`); "Run a plan a model wrote, inside bounds it cannot widen" (`Trellis, DelegationChain`); "Wrap one flow with retries, a cache policy, or an approval" (`WithRetry, WithCache, WithApproval, Pattern`). `modules.md` groups the same 28 modules under six headings: "Loops and search", "Deliberation", "Fan-out and fault isolation", "Teams and queues", "Delegation", "Decorators and building blocks". There are no diagrams on the live site at all — it is prose plus code blocks plus tables.

*Why:* The user asked how the doc site classifies them; the answer is that the live one doesn't, and the shape-keyed table is a better palette taxonomy than Primitive/Composite anyway because each row is a question a user is actually asking. Use the eight shape rows as the node-palette sections and keep the retired guide's three tabs only as a coarse filter.
*Source:* /Users/williamcory/smithers/packages/smithers/flows/patterns/docs/README.md:135-150 and docs/modules.md:22-82

### [adapt] Nine patterns build a graph that depends on the flow INPUT, not only on options
`MapReduce.make` requires a literal `{ shards }` "available while planning" and throws `PatternError { code: "invalid_input", message: "MapReduce input must contain a shards array" }` from inside the body when it is not; `Supervisor.make` reads `input.tasks` and throws `"Supervisor input must contain a tasks array"`, `"Supervisor task ids must be unique"`, or `` `Supervisor has no worker named "${workerType}"` `` while the graph is being built; `Recursion.recurse` refuses a function input with `"Recursion input must be a literal tree available while planning"`. That means `Graph.build(flow, payload)` is a function of BOTH, and the mock's 'plan preview' has to take a sample payload. `Kanban` and `MergeQueue` instead take their items/members as declaration options, so their graphs are payload-independent. `MapReduce`'s empty-shard behaviour is three different graphs from one declaration: `onEmpty: "reduce"` = 1 call, `"succeed"` = 0 calls with a literal `Succeed []`, `"fail"` = a thrown `exhausted` at build time.

*Why:* The mock currently implies a plan is a pure function of the flow source. For a third of the package it is a function of source AND payload — which is a real product surface ('preview this plan against…') and a real trap if the canvas caches a plan across payloads.
*Source:* src/MapReduce.ts:97-110, src/Supervisor.ts:196-220,244-252, src/Recursion.ts:101-104, test/MapReduce.test.ts:42-56

**Exact strings a mock or product must use:**

 ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  · 

**Open questions:**
- `Graph.Edge.reason` is typed `EdgeReason` in core, but I confirmed the three values `value | continuation | failure` only from the brief, not from core's source — someone should read `packages/smithers/flows/core/src/Graph.ts` for the `EdgeReason` union before the mock hard-codes edge labels.
- The four demo flows assume the mock draws a pattern's INNER nodes (the six ReviewLoop calls) rather than one collapsed pattern node. Which is it? A collapsed node with an expand affordance is truer to how a user authors (`ReviewLoop.make({...})` is one call site) but throws away the whole 'count the worst case' pitch. This is a design ruling, not research.
- Nine patterns build a payload-dependent graph (MapReduce, Supervisor, Recursion, Trellis at run, DelegationChain). The mock has no notion of a sample payload. Does the plan preview ship with a payload picker, or do we restrict the demo flows to the payload-independent patterns (Saga, Escalation, ReviewLoop, Kanban, MergeQueue, CheckSuite — which is what I chose)?
- The retired field guide's card sources all point at `packages/components` and `examples/*.jsx`, neither of which exists. If we resurrect the catalog we must re-source all ~130 cards against `packages/smithers/flows/patterns/src/` and `examples/src/*.ts`. That is a real job, not a copy. Who owns it?
- `examples/src/30-failure-control.ts` runs five patterns over one release and `examples/src/32-intervene.ts` runs `Intervene` over a real temp directory with `@smthrs/std` `Read.flow`/`Edit.flow`. These are the only two runnable, multi-pattern, non-toy flows in the repo. Should the mock's example gallery be exactly these two plus the four synthetic flows above, or should the synthetic ones be dropped in favour of making these two real?
- No pattern in the package emits `Flow.to()`. Every repetition in `@smthrs/patterns` is bounded unrolling inside one execution; the trampoline recipe lives in prose (`docs/loops.md:377`) and in `examples/src/17-review-loop.ts`. So the mock cannot demo a round boundary from a pattern — it has to demo it from a hand-written flow. Is a trampoline round in scope for this round of mocks?

## R2.5 — Node drill-in: what evidence Smithers actually persists, how the best tools render code drill-in, and the exact tab set for a node drawer

Smithers persists a rich, exactly-named evidence trail per node — four `flows.engine.node-*` records, cache provenance, diff bundles, attempt rows, and the full `StepKey` material — but it persists **zero** file:line provenance: `functionIdentity` hashes `Function.prototype.toString.call(operation)` and keeps only the digest, so a plan node cannot be mapped back to `flows/<name>/flow.ts:42` today. The one real source text the journal holds is the agent's cell script (`control.agent.cell-produced` → `{text, language}`), already rendered as a `Script` block in `RunTraceCard`, and the app already ships a production Shiki code viewer with line anchoring, diagnostics, hover and go-to-definition (`CodeSurface.tsx`, `files.read <path>:<line>:<col>`). The drawer should therefore be an evidence inspector with a Code tab that is honest about which of three strata exists, and Dagster's `LocalFileCodeReference(file_path, line_number, label)` is the exact missing engine feature to propose.

### [steal] The engine journal's node vocabulary is exactly four records, and only these carry plan node ids
`EventTypes` names seven constants; the node-level four are string literals not in that table: `"flows.engine.node-scheduled"`, `"flows.engine.node-settled"`, `"flows.engine.node-invalidated"`, `"flows.engine.node-reconciled"`. Payloads at the call sites, verbatim keys: node-scheduled `{planId, nodeId, kind, planKey, dispatchKey, attempt, priority, waited}`; node-settled `{planId, nodeId, planKey, dispatchKey, outcome, attempts, rebases}`; node-invalidated `{planId, nodeId, planKey, from, to, reason: "measured-inputs-changed"}`; node-reconciled `{planId, nodeId, trigger, verdict}` where `verdict._tag ∈ Fail | Reorder | FactorOut`. `sourceId` is `node/<id>/<attempt>`, `node/<id>/settled`, `node/<id>/<attempts>/invalidated`, `node/<id>/reconciled/<n>` — so every record for one node is addressable by a `node/<id>/` sourceId prefix. That prefix IS the query for an Events tab.

*Why:* A node drawer needs one cheap, exact query to get every engine fact about that node. `sourceId LIKE 'node/<id>/%'` is it, and it needs no new index.
*Source:* packages/smithers/flows/engine-store/src/PlanScheduler.ts:966,987,1036,1048

### [steal] The full `flows.*` journal event catalog is 90 strings across five namespaces
Grepped from `packages/smithers/**/*.ts`. Engine: `run-decision`, `attempt-started`, `attempt-finished`, `snapshot-identified`, `plan-recorded`, `subgraph-appended`, `deferred-completed`, `clock-scheduled`, `interrupted`, `hard-violation`, `expected-set-deviation`, `diff-bundle-captured`, `copy-back-settled`, `node-scheduled`, `node-settled`, `node-invalidated`, `node-reconciled`, `selection-deferred`, `selection-proposed`, `selection-overridden`, `selection-inconsistent`, `cache-provenance`, `cache-conflict`, `cache-corruption`, `step.settled`. Harness (all `.v1`): `turn-opened`, `turn-closed`, `cell-call-started`, `cell-call-settled`, `cell-printed`, `cell-produced`, `cell-settled`, `cell-rejected-in-frame`, `model-delta`, `model-retried`, `model-settled`, `checkpoint-minted`, `permission-required`, `compaction-settled`, `mutation-observed`, `sufficiency-observed`, `vacuous-verification-observed`, plus ten `*-demanded` discipline records. Agent budget: `flows.agent.budget-started.v1`, `budget-warning.v1`, `budget-latched.v1`, `quota-parked.v1`, `usage.v1`, `structured-output-rejected.v1`. Kernel grants: `flows.kernel.grant.{denied,envelope,once,remembered,run,unknown}.v1`. Host: `flows.host.process-{spawned,adopted,exited,reaped,reap-skipped}.v1`. Time travel: `flows.time-travel.effect-boundary`, `flows.time-travel.fork-created`.

*Why:* A mock that invents an event name is instantly falsifiable. This is the whole legal vocabulary; anything outside it is invention.
*Source:* grep -rhoE '"flows\.[a-zA-Z0-9._-]+"' packages/smithers --include='*.ts'

### [steal] `cache-provenance` is the only evidence a cache hit ever happened — and it names the originating run and event
Payload on a verified hit: `{keyDigest, recordedRunId, recordedEventSeq}`, with `sourceId` `cache:<keyDigest>:hit:<recordedRunId>:<recordedEventSeq>`. The module doc says it plainly: "A cache hit is otherwise invisible in the journal, and provenance is what makes one auditable after the fact." Other `action` values seen in `cacheSource(...)`: `unpublished:<reason>`, `expired`, `ttl`, `replay_failed`, `unverified_read_set`, `hit`. Sibling records `cache-conflict` (two runs, one key, different results) and `cache-corruption` (digest check failed, entry evicted).

*Why:* D-021 says the pitch is the content-addressed re-run. A `clean` node with no explanation is a claim; `served from run r_8c21, event #1447` with a link that opens that run's node is proof. This is the single highest-value drill-in in the product.
*Source:* packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts:1441-1446, 908-918

### [steal] File-level evidence exists and is exact: `diff-bundle-captured` and `copy-back-settled`
`diffBundleCaptured` payload: `{runId, stepKeyDigest, attempt, bundleIdentity, changedPaths, deviations}` where `changedPaths = settlement.files.map(c => c.path)`. `copyBackSettled` payload: `{runId, stepKeyDigest, attempt, bundleIdentity, rebases, queued, dispatched}` — `queued` and `dispatched` are deduplicated idempotency keys, and `dispatched` is "present and empty when no `EffectDispatcher` is composed, so the absence of delivery is a journal fact rather than an inference." Paired with `expected-set-deviation` (result stands, the declaration was a wrong prediction) and `hard-violation` (result refused).

*Why:* "Which files did this node touch, and did it touch what it declared?" is answerable today with no new engine work. Declared write set vs `changedPaths` vs `deviations` is a three-column table that nobody else in the survey can draw.
*Source:* packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts:2314-2320, 2335-2342, 1766-1770

### [steal] Attempt rows are the retry history, keyed exactly `(run_id, step_key_digest, attempt)`
`CREATE TABLE flows_attempts (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json, PRIMARY KEY (run_id, step_key_digest, attempt))`. Decoded through `AttemptStore` into `{checkpoint, error, outcome, meta}`. `attempt-started` / `attempt-finished` journal records carry `{...attemptId, state: "succeeded" | "failed"}` where `attemptId = {runId, stepKeyDigest, attempt}`.

*Why:* The attempts table is keyed by step_key_digest, not node id — so a re-keyed node's old attempts are still reachable under the old key. That is the drill-in that shows "this node ran 3 times under the key you just invalidated."
*Source:* packages/smithers/flows/run-store/src/migrations/0001_initial.ts:74-87; packages/smithers/flows/run-store/src/AttemptStore.ts:366-369; internal/ActionPersistence.ts:786

### [adapt] The persisted `PlanNode` and the plan tables — and what the edges DO NOT store
`PlanNode = {id, kind, key, material, effects, dependsOn, conflicts, strategy, runtime, priority, generation}` with `kind ∈ step|agent|merge`, `strategy ∈ serialize|lane|fail`, `runtime ∈ delay-rebase|stop-merge`. Tables: `flows_plan_nodes(plan_id, node_id, generation, ordinal, kind, key_digest, node_json)` and `flows_plan_edges(plan_id, from_node, to_node)` — **three columns, no reason column**. Both have `BEFORE UPDATE`/`BEFORE DELETE` triggers enforcing append-only; `flows_plans` is forward-only.

*Why:* `Graph.EdgeReason = "value" | "continuation" | "failure" ` exists at build time (Graph.ts:83) but is NOT persisted. A drill-in that labels an edge `CATCH` is reading something the store does not have — it must come from a re-build or a new column. Say so in the doc rather than implying the DB knows.
*Source:* packages/smithers/flows/plan/src/Plan.ts:143-153; packages/smithers/flows/plan/src/internal/migrations/0001_initial.ts:44-73

### [steal] The step key's material is fully inspectable and already has a drawn mock
`KeyMaterial = {version: "flows/key-material/v2", kind: "sealed"|"compensable"|"irreversible", nondeterministic?: true, body, inputs: InputRef[], layers: string[], capabilities: string[], effects?, placement?}`. `InputRef` is a three-arm union: `Literal{value}`, `Ref{from, path}`, `Pending{from}`. `StepKey.ContentIdentity = {body, inputs, layers, capabilities, environment?, hermetic?: {readSet: {path,digest}[], writeSet: FileSet.Entry[], removes?, boundaryMode: "hard"|"expected"}}`. `apps/app/src/mainview/experimental/panes/Plan.tsx` already renders this as a literal `StepKey.content({...})` code block next to the `key1_31b0f4…c9de` digest.

*Why:* The Key tab is already designed and already drawn once. Reuse the rendering exactly — a second visual vocabulary for the same fact is a defect.
*Source:* packages/smithers/flows/plan/src/KeyMaterial.ts:30-34,54,66-77; StepKey.ts:235-250; apps/app/src/mainview/experimental/panes/Plan.tsx

### [steal] `PlanDiff.Rekeyed.changed` gives per-field blame with exact labels
`Rekeyed = {id, from, to, changed}` where `changed` holds "Field labels such as `\"kind\"`, `\"body\"`, `\"layers\"`, `\"capabilities\"`, `\"effects\"`, and `\"input[0]\"` whose declaration differs. `\"kind\"` is the effect tier (`sealed`, `compensable`, or `irreversible`). A `Pending`-referenced upstream re-key is attributed to that input position too." `PlanDiff = {added, removed, rekeyed, unchanged}`. The module states the split explicitly: the verdict is the key, the attribution is "a report for a human... deliberately not part of any digest."

*Why:* This is the answer to "why did this node re-key?" and it is a real engine output, not a UI inference. The re-key HUD in the mock should print `input[1]` verbatim, not prose.
*Source:* packages/smithers/flows/plan/src/PlanDiff.ts:21-52

### [reject] HONEST NEGATIVE: nothing maps a plan node to a file:line. `functionIdentity` hashes the source and throws it away
`functionIdentity` does `const source = metadata?.source ?? Function.prototype.toString.call(operation)` then returns `{_tag: "FunctionIdentity", algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4", digest: digestSync(...)}`. The source text is read and discarded; only the 2-field record is persisted. `Node.FunctionIdentity` is documented as "a digest of its normalized source, hashed in place of a closure that could not be shipped, stored, or compared." There is no `filename`, `lineno`, `abs_path` or captured source anywhere in `plan/` or `flow/`. `sha256-source-ephemeral/v4` additionally folds a per-process nonce, so two processes hashing the same function disagree unless `callbackIdentity: "stable"` is passed to `Graph.build`.

*Why:* A mock that shows `flow.ts:42` next to a node is lying about the engine. Either the drawer says the source is not persisted, or we propose the Dagster-style change (finding 20) and label it as a proposal.
*Source:* packages/smithers/flows/core/src/internal/node.ts:457-470; packages/smithers/flows/plan/src/Node.ts:64-73; packages/smithers/flows/flow/src/Graph.ts:174

### [steal] Node ids ARE structural AST paths — the only source-shaped provenance that survives
Ids are built by string concatenation during the walk, rooted at `"root"`: `${id}.all.${member}`, `${id}.map`, `${id}.andThen`, `${id}.then`, `${id}.else`, `${id}.branch`, `${id}.protected`, `${id}.failure`. `Graph.ts` states "Structural node ids are derived only from traversal positions and do not enter a plan draft's hashed value, so editing a mapper re-keys exactly what reads it." So `root.andThen.branch.then.map` is a readable path into the body's expression tree, stable across runs, and free to rename because it never enters the hash.

*Why:* This is a real breadcrumb and it costs nothing: render the node id as a segmented path (root › andThen › branch › then › map) and it reads as "where in the code you are" without claiming a line number we do not have.
*Source:* packages/smithers/flows/flow/src/Graph.ts:1257,1282,1306,1315,1350,1359-1362,1383-1384,1425; Graph.ts:43-49

### [steal] The ONE real code text the journal holds is the agent's cell script — and it is already rendered
`control.agent.cell-produced` payload carries `{text, language, ...}`. `RunTrace.ts` folds it into a span of kind `"cell"` labelled `` `cell · ${language}` `` with `detail.source = asString(payload.text)`. `RunTraceCard.tsx` renders it as `<Block title="Script" text={detail.source} />`, alongside `Block title="Printed"`, `Block title="Input"`, `Block title="Output"`, `Block title="Failure"`. `SpanKind = "run" | "frame" | "model" | "cell" | "call" | "approval" | "resolved" | "event" | "fork" | "execution" | "attempt"`.

*Why:* "Show me the actual code" already has a true answer for agent nodes: the script the agent wrote and ran. That is the highest-value half of the Code tab and it needs zero engine work — only a better renderer than a `<pre>`.
*Source:* apps/app/src/mainview/cards/RunTrace.ts:34,46-47,865-880; apps/app/src/mainview/cards/RunTraceCard.tsx:854-858

### [steal] The app already ships a production code viewer with line anchoring, diagnostics, hover and go-to-definition
`CodeSurface.tsx` renders `CodeFileView` from `@smthrs/ui/adapters/code-view` (Shiki, `@pierre/diffs` `File`), lazily loaded as its own chunk. The `file` card payload carries `{repo, localRepoId, path, content, truncated, binary?, address?, readAt?, line?, column?, diagnostics?}` — "The anchored line and column (`files.read <path>:<line>[:<col>]`), 1-based: scrolled to and marked." Gestures are command bindings, not bespoke handlers: pointer at rest runs `code.hover <path>:<line>:<col> <repo>`, ⌘/Ctrl-click runs `code.definition`. Diagnostic glyphs: `{error: "✖", warning: "▲", information: "·", hint: "·"}`. Related flows: `files.read`, `files.list`, `files.edit`, `files.add`, `files.open-diff`, `files.implementation-diff`, `code.hover`, `code.definition`, `code.diagnostics`.

*Why:* The "really high quality way of drilling into the actual code" is already built and shipping in this repo. The drawer's Code tab must be this component, not a new one — and the mock must show the Shiki-highlighted file with a marked line, diagnostics under lines, and the two gestures, because that is what the real thing does.
*Source:* apps/app/src/mainview/cards/CodeSurface.tsx:1-40; packages/rpc/src/Cards.ts:1753-1795

### [adapt] Flow source discovery is three filenames, and it is a `Doctor` check
`Doctor.ts` probes `${child}/flow.ts`, `${child}/flow.mdx`, `${child}/SKILL.md` and reports `"${directory} holds no flow.ts, flow.mdx, or SKILL.md; discovery finds nothing"`. `Init` scaffolds `flows/<name>/flow.mdx` because "Markdown, not TypeScript: `flow.mdx` needs no build step, no import". `Markdown.ts` lowers frontmatter `{name, description, model, flows, capabilities, effects: {reads, writes, mode: "hermetic"|"expected", onConflict: "serialize"|"lane"|"fail", tier: "sealed"|"compensable"|"irreversible"}, placement: "sandbox"|"remote"|"client"|"local"}` into an ordinary flow.

*Why:* A Code tab can always find the flow FILE (`flows/<plan.flow>/flow.ts|flow.mdx`) even though it cannot find the LINE. For a markdown flow the whole body IS the prompt, so the Code tab is complete for that case — a good demo node.
*Source:* packages/smithers/src/Doctor.ts:155-194; packages/smithers/src/Init.ts:183,257; packages/smithers/flows/core/src/Markdown.ts:41-57

### [adapt] The gateway projects seven things and none of them is the plan graph; `RunTreeRow.nodeId` is a lie for our purposes
Selectors: `workspace-runs`, `run-summary`, `run-events`, `transcript`, `run-tree`, `approvals`, `node-output`. `RunTreeRow = {runId, nodeId, label, status: "running"|"completed"|"failed", seat?, startedAt, endedAt?, parentRunId?}` where the doc says "`nodeId` is the ordinal the call opened on, because the emitter names no node." `NodeOutputRow = {runId, nodeId, outcome: "success"|"failure", output: string, settledAt}` — `output` is a **string**, not JSON. `TranscriptRow = {runId, sequence, turn, at, kind, callId?, text}`. `ApprovalRow` carries `questionProvenance ∈ "events"|"legacy-observation"|"unverified-observation"`.

*Why:* Confirms D-020. A drill-in built on `run-tree` is drilling into call ordinals, not plan nodes. The drawer's Input/Output tabs cannot be schema-typed until `node-output` carries JSON instead of a rendered string.
*Source:* packages/smithers/gateway/src/GatewaySchema.ts:38,54,70,86,102,123,141; GatewayProjection.ts:91-195

### [adapt] `NodeOutput` node identity is `<flowName>#<ordinal>` with a reserved id `result`
"A node's identity is `<flowName>#<ordinal>`, the ordinal counting that flow's distinct calls within the run from 1... The reserved id `result` names the run's final assistant output." `export const resultNodeId = "result"`. `Node = {nodeId, flowName, callId?, outcome: "success"|"failure"|"pending", input?, value?, message?, startedAt?, settledAt?, startedSequence?, settledSequence?}`. Consumed by `smthrs output` and the MCP tool `get_node_detail`. A call that started and never settled is reported `pending` "rather than dropped: a run that died mid-call is exactly when an operator asks what the last step was doing."

*Why:* There are two node namespaces in the product — plan node ids (`root.andThen.map`) and call ordinals (`bash#2`). The drawer must say which one it is showing or it will be wrong in exactly the way the module's own comment warns about.
*Source:* packages/smithers/src/NodeOutput.ts:1-30,40-63

### [adapt] `Forensics.Digest` is the ready-made run-level header for a drawer
`Digest = {status, cause, seat, turns, calls, callsFailed, duplicateCalls, editsAttempted, editsSucceeded, flows: [name, count][], refusals: {message, count}[], inputTokens, outputTokens, finalOutput, parkedQuestion, parkedApproval, startedAt, endedAt}`. `duplicateCalls` is "Calls whose flow and input were byte-identical to an earlier call." Projected by `smthrs logs` and `smthrs status`; the module notes the first SWE-bench benchmark "was diagnosed with ad-hoc SQLite scripts because a settled run's journal had no readable projection."

*Why:* `duplicateCalls` and `refusals` are real, counted, and invisible in every competitor's UI. Worth one chip each in the drawer header when nonzero — not a row that reads "0".
*Source:* packages/smithers/src/Forensics.ts:1-20,57-90

### [steal] Sentry: source context is three fields and five lines each side
A stack frame carries `filename` ("path relative to the project root directory"), `abs_path`, `function`, `lineno` ("starting at 1"), `colno`, `in_app` (distinguishes framework infrastructure from your own code), `vars` ("A mapping of variables which were available within this frame (usually context-locals)"), and the three context fields: `pre_context` ("A list of source code lines before `context_line` (in order)"), `context_line` ("Source code in filename at `lineno`"), `post_context`. Conventionally five lines before and five after.

*Why:* This is the minimum viable shape for shipping code with an event, and it is tiny: one path, one line number, eleven lines of text. It is exactly what a Smithers node record would need to carry to make a Code tab true, and it proves the payload cost is trivial.
*Source:* https://develop.sentry.dev/sdk/data-model/event-payloads/stacktrace/

### [steal] Chrome DevTools: clicking a call-stack frame changes TWO things at once
Sidebar panes are `Call Stack`, `Scope`, `Watch`, `Breakpoints`. Clicking a Call Stack entry "jumps to that function's source line" (marked with "the blue arrow icon") AND repoints the `Scope` pane to that frame's `local`, `closure` and `global` variables. The `Ignore List` (from the source map `ignoreList` field, or Settings > Ignore List > Enable Ignore Listing > Custom exclusion rules > Add pattern) hides framework frames so the stack is your code only.

*Why:* The coupled move is the whole feel of a good drill-in: one click, and both the code position and the data at that position change together. A Smithers node click should move the canvas selection, the Code tab's marked line, and the Input tab's resolved values in one gesture.
*Source:* https://developer.chrome.com/docs/devtools/javascript/reference

### [steal] GitHub: permalink and blame are one keystroke each, and blame walks backwards
`y` rewrites the URL to a commit-pinned permalink; `b` opens blame. Line gutter click selects one line, shift-click a range, and the range enters the URL. In blame, each row shows "the author, commit description, and commit date", and the versions icon is "View blame prior to this change" — it re-blames the file as of the parent commit. The toggle above the file is two buttons: `Blame` and `Code` (plus `Preview` for Markdown).

*Why:* "View blame prior to this change" is the exact interaction our cache story needs, transposed: from a `clean` node, walk back to the run that first built it, and from there walk back again. Same gesture, different backing store (`cache-provenance.recordedRunId`).
*Source:* https://docs.github.com/en/repositories/working-with-files/using-files/viewing-and-understanding-files

### [steal] Dagster ships the thing we are missing: file path and line number as asset metadata
`with_source_code_references()` "automatically attaches the proper metadata" during development. Manual form: `LocalFileCodeReference(file_path="/path/to/source.yaml", line_number=1, label="Model YAML")`. Stored under the metadata key `dagster/code_references` as a `CodeReferencesMetadataValue`. For production, `link_code_references_to_git()` (OSS) and `link_code_references_to_git_if_cloud()` (Dagster+) rewrite local paths into GitHub/GitLab permalinks. The docs state the purpose directly: code references "allow you to easily view assets' source code from the Dagster UI, both in local development and in production."

*Why:* This is the engine change to propose, with a precedent and a shape. A `Plan.PlanNode` gains an optional non-hashed `source?: {path, line, label}` — non-hashed so it cannot re-key anything, exactly as `PlanDiff.changed` is deliberately outside the digest. Without it the Code tab is guesswork forever.
*Source:* https://docs.dagster.io/guides/build/assets/metadata-and-tags

### [steal] Inngest: two panels, a time brush, and rerun-from-step with editable input
"Left panel: Run info header and an interactive timeline of execution bars · Right panel: Contextual details for the selected step or the run itself." Steps expand to reveal "all the attempted retries along with their respective error." Buttons: `Rerun`, `Rerun from step`, `Replace step input`. The timeline header carries a time brush — "Drag the handles to narrow the view, move the selection to pan across the timeline, click outside to expand it, or use the reset button." Panels: `Trigger details`, `Event payload`, `Run details`.

*Why:* `Rerun from step` + `Replace step input` is the closest competitor to our re-key story and it is a manual, untyped version of it. Our answer is strictly better and must use their verbs so the comparison is legible: theirs replaces an input and reruns everything after; ours re-keys and everything unaffected comes back `clean`.
*Source:* https://www.inngest.com/docs/platform/monitor/inspecting-function-runs

### [adapt] Trigger.dev: three tabs, and replay takes a different payload
The run inspector has exactly three tabs: `Overview` (status, a timeline of events, payload, output and errors), `Detail` ("a full list of data relevant to the run (including tags and usage data)"), `Context` ("the run context that you can access inside the `run` function"). Replay supports "replaying a run from the dashboard with a different payload and environment", in JSON or SuperJSON (so `Date`, `Map`, `Set`, `BigInt` survive). Span inspector shows "attributes, timing, events, and AI enrichment (model, tokens, cost)".

*Why:* Three tabs is the right ceiling for a run-level pane, and "AI enrichment (model, tokens, cost)" is the agent-node header we need. But their `Context` has no analogue for us — our equivalent is the step key material, which is a stronger fact.
*Source:* https://trigger.dev/changelog/run-page-inspector

### [adapt] Temporal: breakpoints on history events AND on code, in the same session
Command palette entry is `Temporal: Open Panel`. You set ordinary breakpoints in workflow TypeScript and breakpoints on specific history events; "The Workflow Execution will start replaying and hit a breakpoint set on the first event." Because it runs a replay Worker, "Activity code is not run." Controls are play, step, and "green restart icon at the top of the screen". The Web UI shows Event History three ways: `Timeline` (clock-time durations, updates in real time for running Workflows, related events collapse into one Activity row), `Compact` ("a logical grouping of Activities, Signals and Timers... does not take clock time into consideration"), and `JSON`.

*Why:* The two-breakpoint model is the deepest code drill-in in the survey and it is unreachable for us: it needs deterministic replay of the same code in a debugger, which our agent nodes are not. Take the `Compact` vs `Timeline` split instead — our Events tab is Compact, our existing waterfall is Timeline.
*Source:* https://github.com/temporalio/vscode-debugger-extension/blob/main/README.md ; https://docs.temporal.io/web-ui

### [steal] VS Code Peek: an inline editor with a result list, editable in place
`Peek Definition` is Alt+F12 (Ctrl+Shift+F10 on Linux); `Go to References` is Shift+F12; `Go to Definition` is F12 and Ctrl+Click, `Ctrl+Alt+Click` opens it to the side. The peeked editor is a real embedded file view: "You can navigate between different references in the peeked editor and make quick edits right there." "Clicking on the peeked editor filename or double-clicking in the result list will open the reference in the outer editor." Escape closes it unless `editor.stablePeek`.

*Why:* The escalation ladder is the lesson: hover preview → inline peek → full editor, each a strictly larger commitment, each reachable without losing your place. A node drawer should be the peek rung, with an explicit door to the full file card.
*Source:* https://code.visualstudio.com/docs/editing/editingevolved

### [adapt] n8n: one INPUT panel, one OUTPUT panel, three view modes each
Double-clicking a node opens the node details view (NDV) with an input panel and an output panel. Each offers `Schema`, `Table` and `JSON` — "Schema view shows a simplified structure from the first item only, while Table and JSON display the full dataset." Node hints can be attached to the input panel, the output panel, or the NDV as a whole.

*Why:* Schema/Table/JSON is the correct three-way toggle and we should copy the words exactly. But n8n's Schema view is inferred from the first item; ours is declared — `Flow.make`'s `input`/`output` Effect Schema — so ours is true for zero items and for items that disagree with each other.
*Source:* https://docs.n8n.io/build/work-with-data/overview

### [reject] Prisma Studio / Drizzle Studio are the wrong prior art here
Both are row browsers: "browse, filter, and edit rows, run SQL, and inspect relationships without writing throwaway queries"; Prisma Studio lets you "edit fields inline while seeing relationships visually". Neither presents a typed value against a declared schema, and neither has a notion of provenance for a value.

*Why:* A node's output is one typed value with a known schema and a known producer, not a table of rows. Copying a data-grid here would make the Output tab worse than the `<pre>` it replaces. The typed-inspector idea is right; these two are not the instance of it.
*Source:* https://www.bytebase.com/blog/drizzle-vs-prisma/

**Exact strings a mock or product must use:**

 ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  · 

**Open questions:**
- THE TAB SET — the answer the task asked for, in order. Tabs 6 and 7 render only when their evidence exists; a tab with nothing behind it must not appear (MINIMAL TEXT). (1) **Output** — default. The settled value with a `Schema` / `Table` / `JSON` toggle (n8n's three words exactly), the Schema arm driven by the flow's declared Effect Schema, not inferred from the first item. Header word is the settlement outcome verbatim: `built` / `clean` / `failed` / `skipped` / `deferred`. On `failed`, the typed error from `flows_attempts.error_json` with its cause chain. On `clean`, no value re-render — one line, `served from run <recordedRunId> · event #<recordedEventSeq>`, clickable. Source: `NodeOutputRow.output`, `outcome_json`. (2) **Input** — the node's resolved `ResolvedInput[]` as `{from, path, value}`, each row badged `Literal` / `Ref` / `Pending` from `KeyMaterial.InputRef._tag` and drawn `← upstream.field` exactly as the existing mock Inspector does; clicking a row selects that upstream node on the canvas. Ordering (`Pending`) edges are listed separately and marked as not part of the key. (3) **Code** — three strata, in this order, and the drawer states which one it is showing: (a) the agent's cell source from `control.agent.cell-produced` `{text, language}`, rendered through `CodeFileView` with Shiki; (b) the flow file — `flows/<plan.flow>/flow.ts` or `flow.mdx` — opened via `files.read <path>` with the node id shown as a segmented AST path (`root › andThen › branch › then › map`) and NO fake line marker; (c) neither: the `FunctionIdentity` `{algorithm, digest}` and one sentence that source is not persisted. Gestures already exist and must be used: hover → `code.hover <path>:<line>:<col> <repo>`, ⌘-click → `code.definition`. A `Open file` door escalates to the full `file` card (VS Code's peek → editor rung). (4) **Key** — `StepKey.content({...})` verbatim as the experimental Plan pane already draws it, `planKey` above `dispatchKey`, and after an edit the `PlanDiff` verdict: `from → to` with `changed: ["input[1]"]` printed as engine labels, plus the approvals the digest change voids (D-022). (5) **Attempts** — one row per `flows_attempts` row keyed `(run_id, step_key_digest, attempt)`: attempt ordinal, `state`, started/finished, `error_json` expandable under the row (Inngest's expand-retries), with `node-invalidated` `{from, to, reason: "measured-inputs-changed"}` interleaved in sequence order. (6) **Files** — only when a `diff-bundle-captured` exists: declared write set vs `changedPaths` vs `deviations`, `bundleIdentity`, `rebases`, `queued`/`dispatched` effect keys, and a per-path diff through `files.open-diff`. A `hard-violation` renders here as a refusal banner, an `expected-set-deviation` as a warning row. (7) **Cache** — only when `cache-provenance` exists: the provenance chain walked backwards GitHub-blame style (`View blame prior to this change` transposed), plus `cache-conflict` / `cache-corruption` when present. (8) **Events** — the raw escape hatch: every journal record whose `sourceId` starts `node/<id>/`, as `seq · eventType · payload`, with a `Compact` / `JSON` toggle (Temporal's words). Footer actions, never tabs: `Re-run from here`, `Pin output`, `Open file`.
- Does a `clean` node have anything to show in Attempts and Files? It never dispatched, so both are empty — does the drawer then hide them, or show the ORIGINATING run's attempts and files fetched through `cache-provenance.recordedRunId`? Showing the origin's evidence is the better product and is the only way a cache hit is auditable, but it means the drawer reads two runs. Needs a ruling.
- `NodeOutputRow.output` is `Schema.String`, not `Schema.Json`. Either the Output tab's Schema/Table/JSON toggle is fake, or `node-output` gains a JSON field. Which — and does that block the mock, or does the mock show the honest version (one string, no toggle) for non-agent nodes?
- Proposing a non-hashed `source?: {path, line, label}` on `Plan.PlanNode` (the Dagster shape) is an engine change that touches `flows_plan_nodes.node_json`. It cannot enter `KeyMaterial` or it would re-key every node on every edit. Is a field the digest ignores acceptable inside an append-only node record, or does it belong in a side table keyed `(plan_id, node_id)`?
- `sha256-source-ephemeral/v4` folds a per-process nonce, so two processes disagree on a node's identity unless `Graph.build` is called with `callbackIdentity: "stable"`. Does the app's plan projection build with `stable`? If not, every drill-in that prints a digest is printing a process-local number and the re-key story does not survive a restart.
- The drawer shows plan node ids (`root.andThen.map`) but `run-tree` and `node-output` both use call ordinals (`bash#2`, `result`). Until D-020's plan-graph projection lands, a node on the canvas and a node in the transcript are different objects. Does the mock draw the join it wants, or does it draw the two namespaces honestly and make the join the visible gap?
- Edge reason (`value` / `continuation` / `failure`) is not persisted — `flows_plan_edges` is three columns. The mock labels edges `THEN` / `ELSE` / `CATCH`. Is that a fourth column we are asking for, or is the canvas expected to re-run `Graph.build` client-side to recover it?

## R2.6 — Trigger.dev's UI (dashboard v4.6.x, read from the triggerdotdev/trigger.dev webapp source), studied to build a better TRIGGER surface for a cron+event trigger sitting in front of a durable agent DAG

Trigger.dev's dashboard is worth stealing from at the level of mechanism, not layout: a two-vocabulary status system (17 DB enum values collapsed to 16 friendly words, rendered mono + icon + word so colour is never load-bearing), a cron field that validates and narrates itself live and previews "Next 5 runs" in both the schedule's timezone and UTC, and a run inspector whose tabs are Overview/Detail/Context/Metadata with single-key shortcuts. Two findings bear directly on our open decisions: they ship a 3 s poll with in-place row patching plus an explicit "N new runs" button rather than auto-inserting rows (D-013), and a cached run's inspector says "(cached)" in the title with a "Jump to original run" button (our D-021 cache-hit story, already prototyped by a competitor). Reject their loop/wait modelling wholesale — waitpoints are a token with a URL, which is the opposite of our HumanTask question shape — and reject "Test" as a separate page, because our trigger node is on the canvas and should fire in place.

### [steal] Two status vocabularies: a 17-value DB enum collapsed to 16 friendly words
`allTaskRunStatuses` is the DB enum: DELAYED, WAITING_FOR_DEPLOY, PENDING_VERSION, PENDING, DEQUEUED, EXECUTING, RETRYING_AFTER_FAILURE, WAITING_TO_RESUME, COMPLETED_SUCCESSFULLY, COMPLETED_WITH_ERRORS, CANCELED, TIMED_OUT, CRASHED, PAUSED, INTERRUPTED, SYSTEM_FAILURE, EXPIRED. `runStatusTitleFromStatus` maps each to a UI word: PENDING→"Queued", WAITING_TO_RESUME→"Waiting", RETRYING_AFTER_FAILURE→"Reattempting", COMPLETED_SUCCESSFULLY→"Completed", COMPLETED_WITH_ERRORS→"Failed", SYSTEM_FAILURE→"System failure", PENDING_VERSION→"Pending version". `filterableTaskRunStatuses` is a *shorter* list (13) — PAUSED, INTERRUPTED, RETRYING_AFTER_FAILURE and WAITING_FOR_DEPLOY are renderable but not filterable. Each status also has a one-sentence tooltip in `taskRunStatusDescriptions`, e.g. WAITING_TO_RESUME: `You have used a "wait" function. When the wait is complete, the task will resume execution.`

*Why:* Our engine has the same shape: `Settlement.outcome ∈ built|clean|failed|skipped|deferred` is the enum, and the mock already shows words like "cache hit" and "will re-run". Formalise it as one map from outcome→word, one map outcome→one-sentence tooltip, and a separate shorter filterable list. It also proves the mock's D-026 (colour is never the only signal) is what a mature product converges on — they render `<icon><word>` with the word in a `.system-mono-label` class that a high-contrast theme deliberately *uncolours*.
*Source:* https://github.com/triggerdotdev/trigger.dev/blob/main/apps/webapp/app/components/runs/v3/TaskRunStatus.tsx

### [steal] Status is icon + word + colour, and the colour is a themed CSS variable per status, not a tailwind class
`runStatusClassNameColor` returns semantic classes (`text-pending`, `text-success`, `text-error`, `text-text-faint`, `text-amber-500`), but charts read `RUN_STATUS_CHART_COLORS` which are `var(--color-run-*)` tokens declared `@theme static`. Exact dark values: `--color-run-executing: var(--color-pending)` (=blue-500), `--color-run-dequeued: #4d8ef5`, `--color-run-retrying-after-failure: #2f6fec`, `--color-run-completed-successfully: var(--color-success)` (=mint-500), `--color-run-completed-with-errors: #de405c`, `--color-run-system-failure: #e7536c`, `--color-run-crashed: #cc193d`, `--color-run-timed-out: #f0667b`, `--color-run-interrupted: #d52c4d`, `--color-run-pending: charcoal-500`, `--color-run-delayed: #6b7580`, `--color-run-waiting-to-resume: #555d67`, `--color-run-canceled: #78828c`, `--color-run-expired: #848d96`, `--color-run-paused: #fbbf24`. The comment is explicit: "In-between shades are intentional - statuses within a family (blues, roses, charcoals) are evenly spaced so chart series stay distinguishable."

*Why:* A family-spaced ramp is exactly what our status ramp needs and does not have: idle/clean/skipped are three greys in our mock with no stated spacing rule, and they will collide in a screenshot. Adopt the rule "statuses within a family are evenly spaced" and declare our ramp as tokens so a settlement colour is the same in a node, a chip and a chart.
*Source:* apps/webapp/app/tailwind.css:394-420 (github.com/triggerdotdev/trigger.dev)

### [adapt] A per-user contrast preference that adds a ring to tinted chips and monochromes status labels
`[data-icon-contrast="true"] .system-mono-label { color: inherit; }` — the high-contrast theme strips the status word's hue and lets the icon carry type. Separately `[data-icon-contrast="true"] .contrast-chip { box-shadow: inset 0 0 0 1px color-mix(in srgb, currentcolor calc(var(--theme-contrast, 0) * 70%), transparent); }` fades a ring into tinted chips as a `--theme-contrast` slider rises. Another comment explains why the span title colour is conditional: "the tasks and agents blues fall under 4.5:1 on the light themes, so the title takes the text colour there and the icon carries type."

*Why:* The mechanism — a continuous contrast variable that chips and labels respond to — is more than our mock needs today, but the *rule* behind it is not: "a colour that fails 4.5:1 as 16px text may still be used as an icon." Our node kind rail and status dot are exactly that case. Bank the rule; skip the slider.
*Source:* apps/webapp/app/tailwind.css:305-320; apps/webapp/app/routes/…runs.$runParam.spans.$spanParam/route.tsx:464-470

### [steal] The run inspector is four tabs with single-key shortcuts: Overview (o) · Detail (d) · Context (x) · Metadata (m)
`TabContainer`/`TabButton` with `layoutId="span-run"` (a shared-layout underline that slides between tabs), each with `shortcut={{ key: "o" }}` etc. The tab lives in a URL search param via `replace({ tab: "overview" })`, so a tab is linkable. The header above it is `<RunIcon>` + `<Header2>` showing the task identifier, and when the run is a cache hit the title literally renders `{run.taskIdentifier}{run.isCached ? " (cached)" : null}`.

*Why:* Our inspector is currently one scrolling schema-derived column. Four named tabs with one-key access and a URL-addressable selection is strictly better, and the names almost map onto us already: Overview (what settled), Detail (payload/output/effects), Context (step key, digest, upstream refs), Metadata. The `layoutId` sliding underline is a free bit of polish since the mock already runs React.
*Source:* apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route.tsx:488-532

### [steal] An AI/model span has its own tabs — Overview (o) · Messages (m) · Tools (t)+count badge · Prompt (p) — and ~20 named metric rows
`AIModelSummary` renders `MetricRow` labels: "Response ID", "Model", "Provider", "Resolved provider", "Prompt", "Finish reason", "Service tier", "Tool choice", "Tools provided", "Messages", then a `Stats` block: "Input"/"Output"/"Cache read"/"Cache write"/"Reasoning" each with unit `tokens`, "Total" (bold), "Cost", "TTFC", "Speed" as `${n} tok/s`. The underlying `AISpanData` type carries `inputTokens, outputTokens, totalTokens, cachedTokens, cacheCreationTokens, reasoningTokens, tokensPerSecond, msToFirstChunk, durationMs, inputCost, outputCost, totalCost, cachedCost, cacheCreationCost` and a display model `DisplayItem = SystemItem | UserItem | ToolUseItem | AssistantItem` where `ToolUse` holds `{toolCallId, toolName, description, parametersJson, inputJson, resultSummary, resultOutput, subAgent?}`. The Tools tab count is a pill badge on the tab label.

*Why:* This is the answer to "there are multiple types of model and the model ui." Their model span is a *different inspector shape* from a task span — different tabs, different metric set — selected by span kind. Our agent node should do the same: an agent node's inspector is Messages/Tools/Model, a step node's is Payload/Output/Effects. The `ToolUse.subAgent` field (a tool result that is itself a UIMessage stream) is the recursion our agent-in-a-node needs.
*Source:* apps/webapp/app/components/runs/v3/ai/AIModelSummary.tsx:27-112; apps/webapp/app/components/runs/v3/ai/types.ts

### [steal] A Prompt is a first-class versioned object the span links to: slug + version + labels + model
`PromptSpanDetails` tabs are Overview (o) · Input (i) · Template (t). Overview shows `MetricRow label="Prompt"` as a `TextLink` to `v3PromptPath(org, project, env, promptData.slug, promptData.version)`, plus `label="Version" value={`v${promptData.version}`}`, `label="Labels"`, `label="Model"`, then a "Resolved content" block rendering the interpolated prompt as markdown. The Template tab shows the uninterpolated template. Changelog 2026-08-12: "AI prompts: code-defined, versioned, overridable — Dashboard controls for prompt text and model selection without redeployment."

*Why:* This is the high-quality drill-into-the-code affordance the brief asks for, and it is better than a code viewer: the span does not show you *a* prompt, it shows you the resolved text AND links to the versioned definition AND shows the template it came from. Our equivalent: a node links to its `Action.make` call site by step key, shows the resolved payload, and shows the declarative manifest it was compiled from. The Overview/Input/Template triple is the right decomposition — resolved, inputs, source.
*Source:* apps/webapp/app/components/runs/v3/PromptSpanDetails.tsx

### [steal] A cached run says "(cached)" in the title and offers "Jump to original run"
Inspector footer: `<LinkButton shortcut={{ key: "f" }} LeadingIcon={QueueListIcon}>{run.isCached ? "Jump to original run" : "Focus on run"}</LinkButton>`, rendered only when `run.friendlyId !== runParam`. The icon vocabulary has a dedicated `"task-cached"` name → `<TaskCachedIcon className="text-tasks">`, i.e. the same hue as a normal task but a distinct glyph.

*Why:* D-021 claims the content-addressed re-run is our pitch and that n8n cannot copy it. Trigger.dev has already shipped the *inspection half* of it: a cache hit is visually distinct by glyph (not colour), says so in the title, and links to the settlement that produced the value. Our `clean`/`0ms` node must carry the same button — "Jump to the run that built this" — or the cache story is a number with nothing behind it. Note the design choice: same hue, different glyph, so cached and fresh read as the same kind.
*Source:* apps/webapp/app/routes/…runs.$runParam.spans.$spanParam/route.tsx:1232-1248; apps/webapp/app/components/runs/v3/RunIcon.tsx:79-82

### [steal] Liveness is a 3 s poll that patches visible rows in place, plus an explicit "N new runs" button — never auto-insert
`RUNS_POLL_INTERVAL_MS = 3000`, `NEW_RUNS_EVERY_N_POLL_TICKS = 2` (~6 s). `patchVisibleRunsWithLiveUpdates` merges only `status, updatedAt, startedAt, finishedAt, hasFinished, isCancellable, isPending, usageDurationMs, costInCents, baseCostInCents, metadata` into rows already on screen. New runs are counted, not inserted: a button appears with `LeadingIcon={<PulsingDot/>}`, label `${newRunsCount} new ${newRunsCount === 1 ? "run" : "runs"}` capped at `"99+ new runs"`, tooltip "Refresh to see new runs", aria-label "New runs created. Refresh to see new runs." Polling stops entirely when `!hasActiveRuns && !shouldPollForNewRuns`.

*Why:* This directly answers D-013, which is still OPEN and blocking the design doc. A 3 s poll is what a well-funded competitor ships for a live list, which falsifies the worry that our 2.5 s poll "will read as lag." The real insight is the split: statuses of *visible* things patch silently, *new* things need consent, and polling stops when nothing is running. Take option (a) — poll, tighten while a graph card is open, stop when the run settles — and stop treating the streaming mounts as a prerequisite.
*Source:* apps/webapp/app/routes/…runs._index/useRunsLiveReload.ts:10-12,71-90,282-295; …runs._index/route.tsx:342-356

### [steal] The trace pane degrades liveness honestly: "Live reloading" with a pulsing dot, "Live reloading disabled" past a log budget
`LiveReloadingStatus` returns `null` once the root span completes; otherwise a `PulsingDot` (a `size-2` blue dot with an `animate-ping` ring, `duration-1000`) plus text "Live reloading" in blue-500, or `BoltSlashIcon` + "Live reloading disabled" with tooltip `Live reloading is disabled because you've exceeded ${settingValue} logs.` Separately the trace can render the callout "Trace too large to display completely." In-progress spans get an animated tiled texture: `node.data.isPartial && <div className="animate-tile-scroll opacity-30" style={{backgroundImage: url(tileBg), backgroundSize: "8px 8px"}}/>`.

*Why:* Two things our mock lacks. First, liveness is a *stated* affordance with an off state that explains itself, not an invisible property — and it disappears entirely once the run is done, so a finished run has no stale live chrome. Second, the 8px marching-tile texture on a partial span is a better "still running" signal than our shimmer because it survives a screenshot and does not rely on hue. Our running node ring should carry it.
*Source:* apps/webapp/app/routes/…runs.$runParam/route.tsx:1703-1745,1775-1782

### [adapt] The runs table has user-definable "smart columns": a JSON path into payload/metadata/output, rendered as text|number|duration|badge
`RUN_COLUMN_IDS` = id, task, status, ver, started, dur, compute, machine, queue, region, test, created, delayed, ttl, tags — labels "ID", "Task", "Status", "Version", "Started", "Duration", "Compute", "Machine", "Queue", "Region", "Test", "Created at", "Delayed until", "TTL", "Tags". id/task/status are `locked: true` (reorderable, never hideable). `SmartColumnDef = {source: "payload"|"metadata"|"output", path: string, label: string, displayAs: "text"|"number"|"duration"|"badge"}`. The whole layout lives in three URL params `cols`, `sc`, `hide`, and the column set drives the Postgres select: `deriveRunSelect` hydrates the payload/output blobs *only* when a smart column references them. Popover opens on `l`, footer offers "Add smart column…", "Save to favorites"/"Remove from favorites", "Reset to default".

*Why:* The idea — let a user promote a field out of a payload into a column — is strong and maps onto our node-output projection. But the honest version for us is narrower and sharper: our plan nodes are typed, so we can offer the *schema's* fields as columns rather than making the user type a JSON path. Steal the four display kinds (`text|number|duration|badge`), the locked-column concept, and the discipline that the column set drives the query (do not hydrate outputs nobody displays). Reject the free-text path input.
*Source:* apps/webapp/app/components/runs/v3/runColumns.ts:10-125; apps/webapp/app/components/runs/v3/RunsDisplayOptions.tsx:45,200-267

### [adapt] Filters are a fixed catalogue with an AI escape hatch, all encoded in the URL
`RunFilters` declares filters titled/labelled: "Status", "Task", "Task type", "Versions", "Tags", "Run ID", "Batch ID", "Schedule ID", "Error ID", "Bulk action", "Machines", "Queues", "Region", "Root only" (with "Toggle root only"), param names `source, versions, tags, run, batch, schedule, error, bulk, machines, queues, regions`. "Task type" values are "Standard", "Scheduled", "Webhook", "Agent". Time filters: "Today", "Yesterday", "This week", "Last week", "This month", "Custom" with "From"/"To", under "Filter by time period". Alongside sits `AIFilterInput` with placeholder "Describe your filters…", committed on Enter, cleared on Escape. Changelog: filters are "stored in the URL so you can use the magic of copy+paste to quickly share the filtered view with your team."

*Why:* "Task type: Standard | Scheduled | Webhook | Agent" is the closest thing they have to our trigger taxonomy, and it is a filter facet rather than a first-class object — which is why their trigger story is weak and ours can be better. Steal URL-encoded filters (D-002 wants the canvas to be a projection; a shareable URL is the same instinct) and the natural-language input as an *additive* affordance beside the chips, never replacing them. Reject the 14-filter catalogue: at our scale that is MINIMAL TEXT violation by volume.
*Source:* apps/webapp/app/components/runs/v3/RunFilters.tsx; SharedFilters.tsx; AIFilterInput.tsx:placeholder

### [steal] The cron field validates, narrates and previews itself in one column — and an AI field writes it
Label "CRON pattern (UTC)" with a tooltip containing "We support this CRON format:" plus a box-drawing ASCII diagram (`└ day of week (0 - 7, 1L - 7L) (0 or 7 is Sun)` … `└─ minute (0 - 59)`) and `"L" means the last.`. Input placeholder `? ? ? ? ?`. Below it a `ValidationMessage` with `validLabel="Valid pattern:"` / `invalidLabel="Invalid pattern:"` (or "Unavailable on Free plan:") whose message is `cronstrue.toString(pattern)` — the human sentence. Empty state hint: "Enter a CRON pattern or use natural language above." Above it, `AIGeneratedCronField` with placeholder "e.g. the last Friday of the month at 6am" and a button "Generate"/"Generating". Then a "Next 5 runs" table computed with `cron-parser`, with TWO columns when the timezone isn't UTC: the selected zone and UTC side by side. Timezone hint switches between "UTC will not change with daylight savings time." and "This will automatically adjust for daylight savings time."

*Why:* This is the single best thing in their product for our purpose and it is the whole trigger-node inspector, ready-made. Every element earns its place: the pattern, the sentence it means, the next five firings, and both clocks so a DST bug is visible before it happens. Put it in the trigger node's inspector, not on a separate page. The two-column timezone table is the detail most products get wrong.
*Source:* apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route.tsx:62-70,355-500

### [adapt] "Window": a schedule can deliberately smear its firings, and the UI states the guarantee
Field "Window", placeholder "30m or 25%", valid message "Runs will be assigned a stable time within this window." (or, on the free plan, `Runs use this window; the Free plan minimum of ${n} minutes will be applied.`). Docs: "A window spreads scheduled runs deterministically within a timeframe after their cron time." With a window set, the Next-5-runs table gains the hint "Actual run times will get a fixed offset based on the window, displayed after creation."

*Why:* We do not have thundering-herd pressure yet, so shipping a window field now is solutionism. What transfers immediately is the copy discipline: the word "stable" is doing real work — it promises the offset is deterministic per schedule, not random per firing. When our trigger node eventually needs jitter, that one word is the spec.
*Source:* apps/webapp/app/routes/…schedules.new/route.tsx:425-470; https://trigger.dev/docs/tasks/scheduled

### [steal] Declarative vs imperative schedules are a visible, iconed type — and declarative ones are read-only in the UI
`scheduleTypeName`: IMPERATIVE→"Imperative" (`ArrowsRightLeftIcon`), DECLARATIVE→"Declarative" (`ArchiveBoxIcon`). The schedule inspector's property table is Status / Task ID / CRON / Timezone / Window / Environment / External ID / Deduplication key / Type, with "Last 5 runs" and "Next 5 runs", a Disable/Enable toggle, "Edit schedule…" and "Delete schedule". A declarative schedule cannot be edited from the dashboard — the UI shows an InfoPanel titled "Editing declarative schedules" instead. Docs: declarative schedules are the `cron` property in code and "sync during dev/deploy commands"; imperative ones are created via dashboard or `schedules.create()` with a required `deduplicationKey`.

*Why:* This is D-003 solved for one object, in production, by someone else. They did not build a round-trip: code-declared schedules are *read-only on the canvas and say so*, dashboard-created ones are editable. Our trigger node should do exactly that — a trigger declared in `Flow.make` renders with a "declared in code" badge and an "open source" link, a trigger created from the canvas is editable in place. It buys us an honest, shippable builder for the first node without closing D-003.
*Source:* apps/webapp/app/components/runs/v3/ScheduleType.tsx; apps/webapp/app/components/schedules/ScheduleInspector.tsx:181-346

### [adapt] Replay is a full re-trigger form with an editable payload, not a re-run button
Dialog header "Replay this run", body "Replaying will create a new run in the selected environment. You can modify the payload, …", a `JSONEditor` with tabs "Payload" / "Metadata" (payload tab disabled with the note "Payload is not editable for runs with large payloads."), an environment select labelled "Replay this run in" (placeholder "Select an environment"), plus "Delay", "TTL", "Priority", "Max duration", "Idempotency key TTL", machine/queue/version/region selects, each with a one-line hint ("Delays run by a specific duration.", "Expires the run if it hasn't started within the TTL.", "Runs task on a specific version.", "Overrides the machine preset."). Submit is "Replay run"/"Replaying...". The trigger is a `secondary/small` button with `shortcut={{ key: "R" }}`, disabled with tooltip "You don't have permission to replay runs".

*Why:* D-007 calls replay table stakes, and this is the table-stakes shape. But their replay re-runs *everything* because they have no content addressing — that is precisely the gap D-021 says we win on. Our version of this dialog is the re-key HUD the mock already has: same form, but the submit button says how many nodes re-run and how many are cache hits. Steal the form's field set and the per-field one-line hints; reject the idea that replay means start over.
*Source:* apps/webapp/app/components/runs/v3/ReplayRunDialog.tsx:106,250,257-311,577

### [adapt] Cancel is a separate destructive act with its own key, and permission gates render as disabled+tooltip, never hidden
`<Button variant="danger/small" LeadingIcon={StopCircleIcon} shortcut={{ key: "C" }} disabled={!canCancel} tooltip={canCancel ? undefined : "You don't have permission to cancel runs"}>Cancel run…</Button>`, rendered only when `!run.isFinished`. Row-level equivalents are "Replay run…" and "Cancel run". Bulk actions live behind a "Bulk action" inspector with operations "Replay" and "Cancel" and lifecycle states "In progress", "Completed", "Aborted", and a bulk action is itself a filter facet so you can "get back to runs you bulk cancelled or replayed."

*Why:* The ellipsis convention ("Cancel run…", "Replay run…", "Add smart column…", "Edit schedule…" = opens a dialog; "Run test", "Replay run" = acts now) is a cheap, real signal we should adopt verbatim. Disabled-with-tooltip over hidden matches our agent-parity rule. Bulk-action-as-filter-facet is over-built for us; the retrievability idea (you can always find the runs you just acted on) is worth one line in the design doc.
*Source:* apps/webapp/app/routes/…runs.$runParam/route.tsx:760-780; apps/webapp/app/components/runs/v3/BulkAction.tsx

### [adapt] The trace tree row is deliberately spare: icon · title · optional Root badge · status icon — with the timeline in a separate resizable pane
Each 32px row is `<RunIcon name={style.icon}>` + `<NodeText>` + `{isRoot && <Badge variant="extra-small">Root</Badge>}` + `<NodeStatusIcon>`. Indent guides are `<TaskLine>` per level; the disclosure button's aria-label is "Collapse task"/"Expand task"/"Select task" and alt-click expands/collapses every sibling below that depth. The tree and the waterfall are two `ResizablePanel`s with synchronised scrollTop. Toolbar above: a search field plus three switches — "Debug" (shift+D, admin only), "Queue time" (Q), "Errors only". Footer: "Expand all" (e), "Collapse all" (w), number keys toggle expand level, `[`/`]` move to adjacent runs, arrow keys navigate, and a zoom `Slider` min 0 max 1 step 0.05 with magnifier icons. Empty state for the root: "This is the root task".

*Why:* Our `RunTraceCard` already ships a span tree and waterfall (D-016), so most of this is parity, not news. Two things are news and cheap: the zoom slider is 0..1 in 0.05 steps driving the *timeline scale*, which is the readable-density control D-024 argues for, and "Errors only" as a switch beside search is a better first filter than our chip row. The `[`/`]` adjacent-run navigation is the kind of keyboard affordance that makes a monitor feel operated rather than browsed.
*Source:* apps/webapp/app/routes/…runs.$runParam/route.tsx:1060-1210,975-1005,1878-1895

### [reject] Waitpoints are tokens with a URL, and the dashboard can complete, skip or force-timeout one by hand
`WaitpointTokenStatus` is exactly three values — WAITING / COMPLETED / TIMED_OUT → "Waiting" (blue-500, `Spinner`), "Completed" (success, `CheckCircleIcon`), "Timed out" (error, `TimedOutIcon`). The detail table is Status / ID / "Callback URL" (a `ClipboardField`) / "Idempotency key" / "Timeout" / "Tags", with prose that states the situation: "The waitpoint timed out" · "The waitpoint completed before this timeout was reached" · "The waitpoint is still waiting". Manual actions: "Complete waitpoint"/"Completing…", "Skip waitpoint", "Force timeout"/"Forcing timeout…", under dialogs "Manually complete this waitpoint" and "Manually skip this waitpoint"; errors "Invalid payload, must be valid JSON" and "Payload is too large". API: `wait.createToken({timeout: "10m", idempotencyKey, idempotencyKeyTTL: "1h", tags})`, `wait.forToken<T>(id)` → `{ok, output, error}` with `.unwrap()`, `wait.completeToken(id, output)`.

*Why:* Their human-in-the-loop primitive is an opaque token completed by an arbitrary JSON POST — the UI cannot know what it is asking, so it can only offer a JSON box. D-023 already rules that our question shape is `{kind: "ask"|"confirm"|"select"|"json", prompt, attempt, maxAttempts, options?, schema?}`, which renders a real control. Do not import the token model. Steal exactly two things: the three-state vocabulary (Waiting/Completed/Timed out) and the escape hatches — an operator must be able to force a timeout and to *skip* a wait, and both must be labelled as manual ("Manually complete this waitpoint").
*Source:* apps/webapp/app/components/runs/v3/WaitpointStatus.tsx; WaitpointDetails.tsx; apps/webapp/app/routes/resources…waitpoints.$waitpointFriendlyId.complete/route.tsx; https://trigger.dev/docs/wait-for-token

### [adapt] The Test page: payload editor + Options/AI/Schema sidebar + "Recent runs" and "Templates" prefill
Main pane is a `JSONEditor` under tabs "Payload" / "Metadata"; the sidebar is `TestSidebarTabs` with "Options", "AI" (an `AISparkleIcon` that generates a payload from the task's schema), "Schema" (the declared `payloadSchema` or the `inferredPayloadSchema`). Two prefill popovers: "Recent runs" (copies a past run's payload) and "Templates" (saved configs; "Create run template", field "Template label", placeholder "Enter a name for this template", "Delete template", helper "Save your current run configuration as a template to reuse it later."). Submit: "Run test". For a scheduled task the payload fields are replaced by "Timestamp UTC", "Last timestamp UTC", an external-ID field (placeholder "Optionally specify your own ID, e.g. user id") and a timezone select.

*Why:* Reject the separate page — our trigger node is the first node on the canvas, so "fire this once with a payload" belongs in that node, and a second Test destination would be a second noun (D-011). Steal three mechanisms outright: the schema tab showing declared-or-inferred shape beside the editor, "Recent runs" as prefill (we have the journal, so this is free), and the scheduled-task variant where the payload editor is *replaced* by timestamp/lastTimestamp/timezone fields — that is the correct shape for our cron trigger node's test control.
*Source:* apps/webapp/app/routes/…test.tasks.$taskParam/route.tsx:519-591,929,1434-1510; TestSidebarTabs.tsx

### [steal] An "Ask <agent>" button is planted at the point of failure, carrying a pre-written prompt
`AskAgentButton({prompt})` with `ASK_AGENT_LABEL = \`Ask ${AGENT_NAME}\`` and `AgentIcon = AISparkleIcon`; on the run page an `InvestigateButton` appears beside `<RunError>` when the run failed, and beside the status when it is in progress, each carrying a generated prompt (`failedRunPrompt(friendlyId)`, `runningRunPrompt(friendlyId)`). Per-page suggested-prompt chips pair a short label with a long prompt: "What happened in this run?", "Why does this keep happening?" → "Investigate this error — why does it keep coming back, and which runs are affected?", "Find similar failures" → "Find other failures that look like this one.", "Tell me if it comes back" → "Watch this error and tell me if it happens again."

*Why:* Our product is an agent that drafts and runs the flow, and our mock's left pane is already chat — so a failed node that offers "What happened here?" as one click, prefilled, costs nothing and closes the loop the competitor only bolted on. The short-label/long-prompt pair is the part to copy: the chip stays within MINIMAL TEXT while the prompt that fires is specific enough to be useful.
*Source:* apps/webapp/app/components/dashboard-agent/AskAgentButton.tsx; apps/webapp/app/components/dashboard-agent/suggested-prompts/page-prompts.ts:58-108; apps/webapp/app/routes/…spans.$spanParam/route.tsx:1202-1218

### [adapt] The run page header is a copyable mono ID with prev/next run arrows, not a name
`PageTitle backButton={{to: runsPath, text: "Runs"}}` and the title itself is `<CopyableText value={run.friendlyId} variant="text-below" className="font-mono text-xs">` flanked by `PreviousRunButton`/`NextRunButton` (aria "Previous Run"/"Next Run"), which only render when the list's `tableState` is known — i.e. the arrows walk the filtered list you arrived from. Accessories: a `docs/small` LinkButton "Run docs", then "Replay run" (R), then "Cancel run…" (C). An admin-only tooltip exposes ID / Trace ID / Env ID / Org ID as copyable rows.

*Why:* Prev/next that respect the filter you came from is the detail worth taking — it turns a list plus a detail page into a triage queue, and our run history has the same shape. The copyable mono ID as the page title is right for an opaque run; our runs have a flow name and a round ordinal, so ours should be `<flow name> · round N` with the id copyable beside it, not instead of it.
*Source:* apps/webapp/app/routes/…runs.$runParam/route.tsx:476-560

### [steal] Span inspector exports are explicit and agent-shaped: "Copy for AI" plus three download formats
Footer popover: `title="Copy for AI"`, then `"Download · Markdown"`, `"Download · Log"`, `"Download · JSON Lines"` — each opening in a new tab, gated on `run.logsDeletedAt === null`. Elsewhere, dashboard widgets offer "Copy JSON" / "Copy CSV" from a three-dot menu.

*Why:* "Copy for AI" as a distinct action from "Copy" is a small, correct 2026 affordance: it formats the span for a prompt rather than for a file. Our run trace is already fed to agents, so the button is nearly free, and it makes the drill-in surface end somewhere useful instead of at a wall of JSON.
*Source:* apps/webapp/app/routes/…runs.$runParam.spans.$spanParam/route.tsx:1529-1553; https://trigger.dev/docs/observability/dashboards

**Exact strings a mock or product must use:**

 ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  · 

**Open questions:**
- D-013 is still OPEN but Trigger.dev ships a 3000 ms poll with in-place row patching and an explicit "N new runs" button, and stops polling when nothing is active. Does that settle it in favour of option (a) — poll, tighten while a graph card is open, stop on settle — or does Will want the streaming mounts opened anyway for the node-lights-up moment?
- Their declarative-vs-imperative split (code-declared schedules are read-only in the dashboard and say so in an InfoPanel) is a shippable partial answer to D-003 for the trigger node specifically. Do we adopt it — a trigger declared in Flow.make renders read-only with an "open source" link, a canvas-created trigger is editable in place — or does that commit us to a persisted trigger record we do not want?
- They render a cache hit as the same hue with a different glyph plus the literal text "(cached)" and a "Jump to original run" button. Our mock renders a cache hit as green-dimmed with "0ms". Which is right for us: dim the colour, or keep the colour and change the glyph?
- Their span inspector shape is chosen by span kind (task span vs AI span vs prompt span have different tabs and different metric sets). Do we do the same per node kind (step | agent | merge), and if so what are the agent node's tabs — Messages/Tools/Model, or Overview/Transcript/Cost?
- Smart columns let a user type a JSON path into payload/metadata/output. Our plan nodes are typed, so we could offer schema fields instead. Is the typed-field picker enough, or do power users need the raw path escape hatch?
- We have no equivalent of their "Window" (deterministic jitter within a timeframe after the cron time). Is thundering-herd a real problem for our trigger node yet, or is adding the field solutionism?
- Their "Test" is a separate page reachable from a task. Our trigger node is the first node on the canvas. Confirm that fire-once-with-a-payload lives in the trigger node's inspector and we mint no second destination (bears on D-011).
