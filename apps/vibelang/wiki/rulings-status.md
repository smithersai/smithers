# Rulings status

Each of Will's [rulings](rulings.md) against what `main` and https://vibelang.smithers.sh do, with evidence. Lane
`vl-audit` keeps this page true; a lane that lands work on a ruling updates its row. Checked 2026-11-08 against
`main@origin` 2347bf86 and the deployment (read only).

States: **done** (evidence on main or production), **lane** (a running lane owns the rest), **gap** (no lane owns it).

| Ruling | State | Evidence | Owner |
| --- | --- | --- | --- |
| VL-1 factory app, final version | done | `apps/vibelang`; production `/` serves it (200) | — |
| VL-2 built on Effect in VibeLang | done | every source file is `.vibe`; `.ts` files name the tool that needs them (0001) | — |
| VL-3 deploy fast | done, deploy behind main | production `/api/health` says `live`; `/history` (brick 5) is 404 there, so main is ahead | lead deploys |
| VL-4 Effect, Cloudflare, Alchemy, Foldkit, Smithers, VibeLang | done | `infra/Stack.vibe`; `foldkit` 0.170.0; `@smthrs/*` workspace packages in `package.json` | — |
| VL-5 no other dependencies | done, approvals pending | runtime deps are `effect`, `foldkit`, `vibelang-runtime` and `@smthrs/*`; test tools awaiting approval are listed in 0008 and 0016 | Will |
| VL-6 Electrobun native app | lane | design `~/vl/designs/desktop/` on nyc-01; no code on main | vl-desktop (0025) |
| VL-7 fix upstream | ongoing | 31 reproductions under nyc-01 `~/vl/vibelang-bugs/`; each lane names its own | each lane |
| VL-8 one distributed state machine | done | `src/core/conversation.vibe` `decide`/`apply`/`receive`; client and Durable Object apply the same events (0003) | — |
| VL-9 prove the state machine of every feature | lane | `pnpm verify` and `pnpm verify:broken` (0005, 0018) | vl-proveall (0018) |
| VL-10 one Effect API; CLI, skill, MCP and web are its clients; every UI surface tested | done | `Factory` (0002); `test/commands`, `cli`, `mcp`, `schemaParity` tests; 138 browser cases in 3 projects; CLI `read` and MCP `initialize` answered against production | — |
| VL-11 everything is a flow | done | `vibelang/Post` and `vibelang/Reply` flows (0011, 0012); `test/live.workerd.test.vibe` reads the runs from the engine | — |
| VL-12 multiplayer, simplest robust | done | sequencer event stream (0007); two followers in `test/MockFactory.test.vibe` and `test/live.workerd.test.vibe`; the page joins its conversation at start, `test/dogfood.runtime.test.vibe` | — |
| VL-13 UI always works in mock mode | done | every browser suite except the opt-in `e2e/live.spec.ts` runs the mock (0004) | — |
| VL-14 every suite covers the whole codebase on its own | lane | unit: 0016; fuzz: 0015; benchmarks: 0017. Browser and workerd coverage are diagnostic only (0016) | vl-coverage, vl-fuzzpkg, vl-bench |
| VL-15 `Arbitrary` for properties and fuzzing | done | `test/conversation`, `mythical`, `pages`, `flowMachine` tests use `Arbitrary`; fuzzing 0015 | vl-fuzzpkg |
| VL-16 splash, ⌘K, chat in smithers.sh's style | done | `e2e/chat.spec.ts`; `sui-*` classes from `@smthrs/ui-css` | — |
| VL-17 everything is a chat, maximizable panes, view transitions | done | splash and docs panes maximize (`e2e/tour.spec.ts`); typed transitions `to-chat`/`to-splash`, none for ⌘K: `e2e/transitions.spec.ts` | — |
| VL-18 copy GitHub | lane | no current surface has a GitHub counterpart beyond the history; the designs for issues, actions, wiki and roles follow GitHub | vl-issues, vl-actions, vl-wiki, vl-roles |
| VL-19 marketing materials throughout | done (local) | all 10 original files plus 2 new posters: splash, five tour stops and empty chat; [0026](decisions/0026-marketing-media.md), `e2e/media.spec.ts`, designer source in `wiki/designs/media/`; lead deploys | vl-media |
| VL-20 VIPs, issues versus tasks, issue tree | lane | design `~/vl/designs/issues/`; not on main | vl-issues (0022) |
| VL-21 five roles and promotion | done (local) | 0019; shared GitHub sign-in, numbered grants, five offline identities, People UI and promotion tests | lead: GitHub callback/configuration and deploy |
| VL-22 mythical history viewable; work runs through its flows | done (local) | 0020; `e2e/history.spec.ts`; CLI `history`, `plan`, `start`, `note`; not deployed | lead deploys |
| VL-23 wiki is the working memory | done; in-app lane | this wiki; `/wiki` in the app is not on main | vl-wiki (0021) |
| VL-24 actions and slash commands by role | lane | SDK foundation landed; app held (0023) | vl-actions (0023) |
| VL-25 sandboxes with minute allowances | lane | metered sandboxes (0024); 0019 binds human sessions and offline owners; live agent tools remain closed | lead deploys; vl-sandboxes: originating live-agent owner |
| VL-26 dogfood in parallel: agent by MCP/skill/CLI, Will by UI | done | the page follows the shared conversation from the start; `test/dogfood.runtime.test.vibe` (real app plus the commands); `e2e/live.spec.ts` "the CLI's post reaches an open page" (emitted CLI plus browser on `alchemy dev`) | — |
| VL-27 dark only | done | `e2e/chat.spec.ts` checks dark in the light project (0013) | — |
| VL-28 Learn more tour | done | 0014; `e2e/tour.spec.ts`, `e2e/tourfix.spec.ts` | vl-tourfix |
| VL-29 finish everything: 100% by each suite, fuzzing package, proofs, history, designs | lane | designs exist for all seven features without UI (`~/vl/designs/{actions,desktop,issues,mythical,roles,sandboxes,wiki}`); the rest is the rows above | per row |

## Fixed by this audit

- **VL-12, VL-26.** A tab followed the home conversation only after its own first post, so Will could not watch the
  agent's CLI or MCP work without posting. The page now follows from the start. Tests failed first.
- **VL-17.** No test held the view transitions. `e2e/transitions.spec.ts` fails when the transition is removed or
  runs on every change.
