# VibeLang factory wiki

The working memory of vibelang.smithers.sh (ruling VL-23): what Will ruled, what we decided and why, and what comes
next. Every decision lands here in the same change as the code it shapes.

| Page | What it holds |
| --- | --- |
| [Rulings](rulings.md) | Will's words, VL-1 to VL-33. The source of truth. |
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
| [0014](decisions/0014-agent-tour.md) | Learn more is a ten-step theatre tutorial: numbered app drives, sound-off subtitles and durable controls (VL-31) |
| [0014 theatre walkthrough](decisions/0014-agent-tour.md#vl-31-theatre-walkthrough-2026-11-08-lane-vl-learnmore) | Ten app-driving steps, sound-off subtitles, durable pause/seek and reload (VL-31) |
| [0014 production fixes](decisions/0014-agent-tour.md#other-choices) | Tour docs and current narration stay in view; durable reading holds, paragraphs, keyboard control, inert background and control announcements |
| [0015](decisions/0015-fuzzing.md) | Effect fork as `@smthrs/fuzz`, corpus, budgets, whole-app fuzz targets and independent coverage |
| [0015 worker and view branches](decisions/0015-fuzzing.md#lane-vl-fuzz2-worker-and-view-branches-2026-11-09) | Lane vl-fuzz2: steered targets for the view, viewport, sequencer, action runs, conversation object, issues and wiki hosts |
| [0015 the rest of the server](decisions/0015-fuzzing.md#lane-vl-fuzz2-the-rest-of-the-server-2026-11-10) | Lane vl-fuzz2: worker and core files held to their contracts, the probe Worker, wiki links |
| [0015 surfaces, history and actions](decisions/0015-fuzzing.md#lane-vl-fuzz3-surfaces-history-and-actions-2026-11-10) | Lane vl-fuzz3: steered targets for the CLI, MCP and sign-in, the mythical history's sequencer and machines, and registered actions |
| [0016](decisions/0016-coverage.md) | Boundary tests, strict opt-in source gates and independent suite measurements |
| [0016 browser gate scope](decisions/0016-coverage.md#browser-gate-scope-the-leads-call-2026-11-10) | The browser gate counts `src/web` and what the bundle ships; unit and workerd gates keep every file (lane vl-coverage) |
| [0015 test-quality fixes](decisions/0015-fuzzing.md#test-quality-review-fixes-lane-vl-test-quality-2026-11-10) | Zero-execution gate, named oracles, clocks instead of sleeps, GitHub doubles that refuse (lane vl-test-quality) |
| [0016 vl-coverage2](decisions/0016-coverage.md#lane-vl-coverage2-2026-11-09) | HTTP, browser factory, mock actions, mock factory, state machine and live wiki at their boundaries; the reload-mid-reply fix (lane vl-coverage2) |
| [0016 vl-coverage2, worker gaps](decisions/0016-coverage.md#worker-surfaces-history-and-actions-gaps-lane-vl-coverage2-2026-11-10) | Every worker, surfaces, history and actions gap: tests, seven deletions, one VL-37 wait (lane vl-coverage2) |
| [0016 vl-coverage3](decisions/0016-coverage.md#lane-vl-coverage3-surfaces-history-and-actions-2026-11-10) | Surfaces, history and actions at their unit edges; the session guard as a seam; the inventory skips generated output (lane vl-coverage3) |
| [0016 inside workerd](decisions/0016-coverage.md#coverage-inside-workerd-lane-vl-coverage-workerd-2026-11-10) | Istanbul counters inside workerd joined with Node's V8 report by source position; the workerd suite's true numbers (lane vl-coverage-workerd) |
| [0016 measuring every gate](decisions/0016-coverage.md#measuring-every-gate-lane-vl-gatefix-2026-11-10) | One `run-heavy` command per VL-29 gate on a host or a 4-vCPU box; fuzz install check, relative `lsc`, `BENCH_REVISION`, web-server limit, proof inventory from the source marks (lane vl-gatefix) |
| [0016 unit and fuzz gates inside workerd](decisions/0016-coverage.md#unit-and-fuzz-gates-inside-workerd-lane-vl-coverage-workerd-2026-11-10) | The unit and fuzz gates count workerd execution; `worker/Api.vibe` runs as Alchemy builds and bridges it (lane vl-coverage-workerd) |
| [0017](decisions/0017-benchmarks.md) | Local/live methods, current-main measurements, content/session recovery benchmarks and unfinished strict source coverage |
| [0018 strengthening](decisions/0018-proofs.md#strengthening-lane-vl-proof-strengthen-2026-11-10) | Contracts that catch the reviewed bugs: `decide`'s authorization, the budget's reservation bound, unreported usage charged its ceiling, run and walkthrough frames, the meter step, harness honesty (lane vl-proof-strengthen) |
| [0018](decisions/0018-proofs.md) | Inventory and Dafny proofs of production decisions, executable mutations and explicit tool boundaries; five proofs lanes, the third on sequencers, commands and the worker, the fifth on issue-graph acyclicity and replay equivalence |
| [0018 fifth lane](decisions/0018-proofs.md#fifth-proofs-lane-vl-proveall5-issue-graph-acyclicity-and-replay-equivalence) | Issue forests and exact conversation/history journal replay; mutations and LemmaScript fixes (vl-proveall5) |
| [0018 vl-proveall4](decisions/0018-proofs.md#fourth-proofs-lane-vl-proveall4-updates-translation-helpers-and-the-last-inline-arms) | The wiki editor, People list, failed media and Chat arms proved; update's translation helpers checked against the proved steps; a People refresh no longer ends a grant's wait |
| [0018 outside the web app](decisions/0018-proofs.md#third-lane-batch-6-the-issues-hosts-decisions) | Third proofs lane: Issues, history pages, seed inputs, mock factory/accounts, wiki, action hosts and the mock sandbox device |
| [0018 web decisions](decisions/0018-proofs.md#web-viewport-and-history-page-batch-lane-vl-proveall2) | Viewport, history-page and spotlight decisions, real-coordinate tool fixes and explicit host boundaries (lane vl-proveall2) |
| [0019](decisions/0019-sign-in-and-roles.md) | GitHub identity; five project roles, first participation, explicit grants and demotions |
| [0020](decisions/0020-mythical-history.md) | The mythical history: one linear stack of epics and mythical commits in a History object, bootstrapped from VibeLang's real history; plan, start, note, approve and fold are flows people and the agent share (VL-22) |
| [0021](decisions/0021-wiki.md) | The working-memory wiki: shared pane, role-gated Markdown editing and person-owned review changes; agent drafts through the same flows |
| [0021 editing](decisions/0021-wiki.md#editing-by-role-lane-vl-wikiedit-2026-11-09) | Edit/Propose by role, person-owned review changes and chat drafts (lane vl-wikiedit) |
| [0022](decisions/0022-issues-and-vips.md) | GitHub issues and sub-issues, committed tasks, and agent-drafted VIP review changes |
| [0023](decisions/0023-actions.md) | Registered actions, slash commands, real run traces, agent/CLI/MCP surfaces and role gates |
| [0024](decisions/0024-sandboxes.md) | Sandboxes, shared flows, a single durable minute writer and opt-in offline Cloudflare Containers |
| [0025](decisions/0025-desktop.md) | Electrobun hosts the shared Foldkit app; local models, confined folders and flows run on Bun |
| [0026](decisions/0026-marketing-media.md) | Splash and empty-chat media; native posters and failure removal; former tour placements superseded by VL-31 |
| [0027](decisions/0027-acceptance-gates.md) | Human proposal approval and four same-revision LGTM/A- or better specification reviews; shared flows, reset history and suite state (lane vl-gates) |
| [0027 addenda](decisions/0027-acceptance-gates.md#vl-32-addenda-2026-11-09-lane-vl-gates2) | A- or better passes; new specification revisions keep acceptance, with both revision policies proved (lane vl-gates2) |
| [0028](decisions/0028-cli-and-mcp-sign-in.md) | CLI and MCP sign-in: GitHub device flow; the server names the agent's posts `<login> (agent)`, carries the person's role, and refuses it approve, fold and merge (VL-26) |

| [0029](decisions/0029-hosted-sign-in-broker.md) | Hosted sign-in through smithers.sh's registered callback, exact-origin registry, single-use PKCE-bound codes and retried temporary-token revocation (VL-33) |

| [0029 hardening](decisions/0029-hosted-sign-in-broker.md#hardening-after-review-2026-11-10-lane-vl-connect-hardening) | Security review fixes: pruned abandoned sign-ins, revoked device tokens, issue search from admission (lane vl-connect-hardening) |
| [0030](decisions/0030-read-deadlines-and-object-health.md) | Bounded issue/wiki reads, inspectable object startup and safe journal-decode failures; amended 2026-11-10 (lane vl-startup-hang): objects start under Alchemy's bridge, health names the start-up step |
| [0031](decisions/0031-public-reads.md) | Signed-out GitHub reads through smithers.sh's App; ETags, bounded cold reads and stale copies marked in the panes (lane vl-public-reads) |
| [0032](decisions/0032-record-replay.md) | Tests reach real GitHub through `@smthrs/testing`'s HttpRecording: replay by default, record or pass through; recordings scrubbed and scanned (VL-36, lane vl-record-replay) |
| smithers.sh `apps/mvp/docs/decisions/0165-hosted-site-github-delegation.md`, "Revocation and the authorization" | GitHub's page after sign-out cycles is its ten-new-tokens-an-hour prompt, not our revocations; sign-out keeps revoking, the connection survives (lane vl-github-authz) |
| [smithers.sh closed-scope check](roadmap.md) | apps/mvp cold scope check: admission and real terminal pump run; `github.reconcile.admission` and `github_reconcile_admissions` observe entry (lane vl-mvp-closed-scope) |

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

- Machine generation, receipt and checkpoint proof boundaries: [0018](decisions/0018-proofs.md#third-lane-batch-15-machine-admission-and-checkpoint-policies).
