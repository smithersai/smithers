# VibeLang factory wiki

The working memory of vibelang.smithers.sh (ruling VL-23): what Will ruled, what we decided and why, and what comes
next. Every decision lands here in the same change as the code it shapes.

| Page | What it holds |
| --- | --- |
| [Rulings](rulings.md) | Will's words, VL-1 to VL-26. The source of truth. |
| [Roadmap](roadmap.md) | The bricks: done, in progress, next. |
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

## Layout

```
apps/vibelang/
  src/core/       the state machine (conversation.vibe), the Effect API (Factory.vibe, MockFactory.vibe, LiveFactory.vibe)
                  and the HTTP protocol (wire.vibe)
  src/surfaces/   the shared command registry, CLI, MCP server and discovery manifest
  skills/         agent instructions for the Factory CLI
  src/web/        the Foldkit program (main.vibe), its view (view.vibe) and styles
  worker/         the site Worker (index.vibe) and the API Worker (Api.vibe): sequencer, reply flow, budget
  infra/          the Alchemy stack (Stack.vibe; alchemy.run.ts re-exports it)
  test/ e2e/      unit, property and scene tests; browser tests
  wiki/           this wiki
```
