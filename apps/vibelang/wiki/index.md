# VibeLang factory wiki

The working memory of vibelang.smithers.sh (ruling VL-23): what Will ruled, what we decided and why, and what comes
next. Every decision lands here in the same change as the code it shapes.

| Page | What it holds |
| --- | --- |
| [Rulings](rulings.md) | Will's words, VL-1 to VL-29. The source of truth. |
| [Designs](designs/index.md) | Designer handoffs and implementation notes. |
| [Roadmap](roadmap.md) | The bricks: done, in progress, next. |
| [Rulings status](rulings-status.md) | Each ruling's state, evidence and owner (lane vl-audit). |
| [Review of 2026-11-08](review-2026-11-08.md) | Findings in the night's changes: fixed, and open with owners (lane vl-review2). |
| [Decisions](decisions/) | One record per consequential choice, numbered. |

## Decisions

| # | Decision |
| --- | --- |
| [0001](decisions/0001-app-and-stack.md) | `apps/vibelang`: Foldkit and VibeLang on Effect 4.1.1, Cloudflare by Alchemy, no other runtime dependencies |
| [0002](decisions/0002-core-is-an-effect-api.md) | The core is one Effect service, `Factory`; the web app, CLI, MCP server and skill are its clients |
| [0003](decisions/0003-one-state-machine.md) | One state machine: a sequencer per conversation numbers events; every client applies them |
| [0004](decisions/0004-mock-mode.md) | Mock mode: the real sequencer in memory and a scripted agent |
| [0005](decisions/0005-formal-verification.md) | LemmaScript `//@` contracts proven by Dafny, plus `Arbitrary` properties |
| [0006](decisions/0006-hosting.md) | A Cloudflare Worker with static assets; the domain comes from the deployment |
| [0007](decisions/0007-multiplayer.md) | Multiplayer is the sequencer's event stream; no CRDTs |
| [0008](decisions/0008-testing.md) | Suites: property, scene, integration, browser e2e, then benchmarks and fuzzing |
| [0009](decisions/0009-surfaces.md) | One Schema command registry derives the Factory CLI, MCP tools and agent manifest |
| [0010](decisions/0010-live-agent.md) | The live agent: a Durable Object per conversation runs the sequencer and its reply's durable flow; LiveFactory over HTTP and SSE |
| [0011](decisions/0011-post-flow.md) | A person's post is a durable `vibelang/Post` flow: record, then dispatch the reply; the mock runs the same flows in memory |
| [0012](decisions/0012-smithers-agent.md) | The reply is smithers.sh's agent: `@smthrs/agent`'s `AgentAction` on a workerd QuickJS sandbox, VibeLang's skill as context |
| [0013](decisions/0013-dark-only.md) | Dark only, for now: the marketing media are dark and have no light versions (VL-27) |
| [0014](decisions/0014-agent-tour.md) | Learn more is a tour the agent drives: its pane actions are numbered events of the one state machine (VL-28) |
| [0014 production fixes](decisions/0014-agent-tour.md#other-choices) | Tour docs and current narration stay in view; durable reading holds, paragraphs, keyboard control, inert background and control announcements |
| [0015](decisions/0015-fuzzing.md) | Effect fork as `@smthrs/fuzz`, corpus, budgets, whole-app fuzz targets and independent coverage |
| [0016](decisions/0016-coverage.md) | Boundary tests, prepared source coverage gates and recorded measurement limitations |
| [0017](decisions/0017-benchmarks.md) | Local/live benchmark methods, deterministic regression gate, artifacts and independent coverage |
| [0018](decisions/0018-proofs.md) | Inventory and Dafny proofs of production decisions, executable mutations and explicit tool boundaries |
| [0019](decisions/0019-sign-in-and-roles.md) | GitHub identity; five project roles, first participation, explicit grants and demotions |
| [0020](decisions/0020-mythical-history.md) | The mythical history: one linear stack of epics and mythical commits in a History object, bootstrapped from VibeLang's real history; plan, start, note, approve and fold are flows people and the agent share (VL-22) |
| [0021](decisions/0021-wiki.md) | The working-memory wiki: build-time Markdown in the shared maximizable pane, one numbered opening flow for people and the agent |
| [0022](decisions/0022-issues-and-vips.md) | GitHub issues and sub-issues, committed tasks, and agent-drafted VIP review changes |
| [0023](decisions/0023-actions.md) | Registered actions, slash commands, real run traces, agent/CLI/MCP surfaces and role gates |
| [0024](decisions/0024-sandboxes.md) | Sandboxes, shared flows, a single durable minute writer and opt-in offline Cloudflare Containers |
| [0025](decisions/0025-desktop.md) | Electrobun hosts the shared Foldkit app; local models, confined folders and flows run on Bun |
| [0026](decisions/0026-marketing-media.md) | The Tour flow selects each stop’s media; compiler card in empty chat, silent videos, posters and failure removal (VL-19) |

## Layout

```
apps/vibelang/
  src/core/       the state machine (conversation.vibe), the Effect API (Factory.vibe, MockFactory.vibe, LiveFactory.vibe)
                  and the HTTP protocol (wire.vibe)
  src/surfaces/   the shared command registry, CLI, MCP server and discovery manifest
  skills/         agent instructions for the Factory CLI
  src/history/    the mythical history: its state machine (mythical.vibe), sequencer, flows, API (MythicalHistory.vibe), mock
                  and the bootstrapped snapshot (seed/)
  src/web/        the Foldkit program (main.vibe), its view (view.vibe) and styles
  worker/         the site Worker (index.vibe) and the API Worker (Api.vibe): sequencer, reply flow, budget
  infra/          the Alchemy stack (Stack.vibe; alchemy.run.ts re-exports it)
  test/ e2e/      unit, property and scene tests; browser tests
  wiki/           this wiki
```


[Benchmark methods and measurements](benchmarks.md).
