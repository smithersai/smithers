# Roadmap

Bricks in order. A brick is done when its end-to-end test passes against the deployment (TEST-1).

```
brick                                   state         proof
1a  splash, ⌘K, chat, mock agent        done          e2e/ (dark, light, phone) passes against the deployment; Astra and Fable
                                                      reviews fixed (25 findings), each with a test that failed first
1b  live agent on Cloudflare            done (local)  0010: a Durable Object per conversation runs the sequencer and its reply's
                                                      durable flow (@smthrs/agent ModelStep, engine in the object's SQLite);
                                                      LiveFactory over HTTP + SSE. `pnpm test:workerd` 8 passed (+1 opt-in
                                                      real-model case); `alchemy dev` + e2e/live.spec.ts pass. Deploy is next.
1c  dogfooding surfaces                 done (mock)   CLI, MCP server and skill over Factory; 21 surface tests plus the existing
                                                      25 tests; emitted CLI + stdio McpClient + exact schema parity (0009).
                                                      Live mode uses LiveFactory at VIBELANG_FACTORY_URL (0010).
1d  formal proof gates                 done (local)  0018: seventeen marked production modules, 962/962 current mutations rejected;
                                                      proof, mutation and inventory gates run in PACKAGE.ts. Whole-app work is 1g.
1f  Learn more: live app tutorial        done (local)  0014/VL-31: ten theatre steps, exact subtitles, optional sound, pause and seek;
                                                      Mock/live share one durable flow; scene, flow, workerd and browser checks
1g  every suite covers the whole app    started       VL-29: unit, fuzz and benchmark coverage at 100% each; proofs of
                                                      all logic; fuzzing from the Effect fork as @smthrs/fuzz
1e  wiki in the app                     done (local)  0021: current Markdown at /wiki/<page> in the shared maximizable pane;
                                                      people and the agent open through vibelang/wiki/open and PaneOpened;
                                                      source writes require 0019's explicit credential connection; lead deploys
2   sign-in and roles                   done (local)  0019: shared GitHub auth, five mock identities, numbered grants; live callback setup/deploy remain (VL-21)
3   issues as a tree, tasks, VIPs       in progress   0022: browser/CLI/MCP, GitHub sub-issues, commitments and repository VIP reviews; live chat held by issues-nested-effect
4   actions and slash commands          done (local)   0023: registered actions, memory/workerd hosts, real traces, slash and agent calls;
                                                      published 0.0.12; signed sessions/current grants, recovery/cancel regression checks; lead deploy remains
5   mythical history                    done (local)  0020: the History machine proved (linearity, no loss, exactly one), the
                                                      bootstrap of 6,737 real commits, the flows, the live object and /history;
                                                      read by page (lane vl-mythical2); live writes wait for 0019's policy
6   sandboxes with minutes              in progress   0024: mock UI and shared flows; durable allowance/Container hosts; live policy and binding gated
7   Electrobun desktop app              done (local)  0025: shared Foldkit UI, native folder picker and local model; Linux native e2e; macOS build is the lead's
```

- **Proofs of all logic (0018, lane vl-proveall): in progress.** The inventory contains 2,508 executable items. Seventeen modules carry contracts and 962 current mutant copies match actual Dafny rejections; unproved logic and tool boundaries remain explicit.
- **Proofs outside the web app (0018, lane vl-proveall3): in progress.** Sequencer, follow and command argument decisions proved; one title-cut defect fixed.

- **Proofs of the web decision modules (0018, lane vl-proveall2): in progress.** Viewport steps and the history page's guards, merge, reads and arm frames are proved; 75 new mutations rejected. Remaining rows name host or tool boundaries.

- **CLI and MCP sign-in (VL-26): implemented; lead deploys.** 0028: `login`/`logout` run GitHub's device flow through the shared
  integrations auth; the server names the agent's posts `<login> (agent)`, carries the person's role and refuses it
  approve, fold and merge. Journaled native flows, private shared settings and a persistent MCP host are covered. Live sign-in waits on device flow enabled on the GitHub OAuth app (the lane report).

## Open work outside this app

- **Effect 4.1.1 upgrade landing (2026-11-07).** 57 commits in nyc-01 `~/vl/ws-effect41`; all typecheck/check gates
  pass. Lane `vl-e41land` classifies each remaining red as pre-existing or introduced and fixes introduced ones before
  it lands. Reproductions of upstream defects it found: `~/vl/vibelang-bugs/` and
  `~/vl/effect41-evidence/` on nyc-01.
- **VibeLang bugs to fix upstream** (reproductions on nyc-01 under `~/vl/vibelang-bugs/`): `vibelang-error-subclass-is`
  (after `--fix`, `is` stops matching a subclass of an error), `vibelang-format-npm-reference` (the formatter can't
  resolve its shipped binary on Linux). EK4802 on Effect CLI Commands is fixed and queued (`1794050628-ek4802`).
- **Done: the app is a workspace package (2026-11-07).** With the monorepo on Effect 4.1.1, VibeLang 0.0.12 and
  Alchemy beta.85, `apps/vibelang` installs with the repository (`workspace:*` Smithers packages, no standalone
  lockfile, `setup` script or style-guide alias) and declares its targets in `PACKAGE.ts`.
- **Alchemy's state store.** Alchemy beta.85 keeps state in format v8; apps/mvp's beta.83 keeps the account's default
  store at v7. This stack uses its own store, `smithers-vibelang-state` (infra/Stack.vibe). Moving apps/mvp to beta.85
  migrates the default store, so that deploy and the migration happen together.
- **`@smthrs/ui-css`** holds `@smthrs/ui`'s framework-free CSS so React and Foldkit share one stylesheet.

- Brick 2 policy and shared authentication: decision [0019](decisions/0019-sign-in-and-roles.md); lane vl-roles.
- **vl-fuzzpkg, in progress:** `@smthrs/fuzz` landed at 100%. Fuzz-only coverage is 90.9% of lines and 81.9% of branches at the ninth session, below the 100% goal; `worker/apiObjects.vibe` is at 100%. Fixed from its findings: a wiki read while GitHub fails answers at the engine's 5-second deadline, and a reply whose Budget, Accounts or History object is unreachable fails visibly at its 5-minute deadline. The eighth 30-minute campaign found nothing. Open: `src/web/main.vibe` (741/815 branches), unbounded draft spends, Alchemy's `.make` bodies (decision 0015).
- **vl-fuzz2 (0015), scope partly met:** the five view files, the history host and the sequencer are at 100% fuzz-only lines and branches; Objects 111/112 and 47/49, Wiki 137/172 and 196/234, Issues 256/290 and 429/460, action runs 114/117 and 152/168, each gap listed in 0015 (most need the 0165 delegate or a failing engine store). Steered targets run every scenario per execution, so coverage no longer falls with host load. The fuzz gate's Node and Chromium reports merge by source position, as the benchmark gate's do. Fixed: unnamed blank chat links and issue-card buttons, a lost wiki edit text, a tour-behind-a-waiting-reply deadlock, and a seek after a second tour failing in the engine store.

- **Tour production fixes (vl-tourfix, 0014):** docs and the current paragraph share the maximized pane; live and mock use durable word-count reading holds; Escape retains keyboard control, maximization isolates chat, status announces control, and later replies exclude tour history.

- **vl-actions (0023):** third-run actions implementation targets published 0.0.12. The service-spread compiler bug is
  authorized and fixed upstream with strict negative controls; publication needs Will. Actions do not need to wait
  for that release. The report retains exact browser/workerd/flow/scene/proof/fuzz/benchmark checks and live-auth boundaries.

- **Source coverage (0016, lane vl-coverage): in progress.** Per-file tables now record independent unit, Chromium
  and Node-client workerd snapshots. Startup has 57 boundary cases at all-four 100%; native/HTTP history recovery and
  amendment focus are tested. The Sol resume adds client-path, durable action admission/replay/cancellation, optional
  Container graph and emitted wiki-command tests. Whole-app strict gates remain red. Bundled attribution has both VibeLang and plain-JS
  reproductions; the installed workerd inspector cannot enable precise collection. No runtime source is excluded.

- **Unit coverage, second lane (0016, lane vl-coverage2): partial.** `worker/Http.vibe`, `src/web/backend.vibe`,
  `src/actions/MockActions.vibe`, `src/actions/execution.vibe`, `src/core/conversation.vibe` and `src/core/LiveWiki.vibe`
  reach 100% unit coverage on all four metrics; `src/core/MockFactory.vibe` keeps three race-only or invariant-guarded paths. A mock
  reply interrupted by a reload no longer blocks its conversation. Other files below 100% remain.

- **Unit coverage, third lane (0016, lane vl-coverage3): partial.** Surfaces, history and actions: 17 files missing
  103 items down to 7 missing 15, each named in 0016 with its reason; four dead fallbacks deleted; the proof inventory
  no longer fails after a build.

- Brick 6: [0024](decisions/0024-sandboxes.md), sandbox UI and shared lifecycle flows; real Container activation awaits trusted 0019 identity and deployment receipts.

- **Rulings audit (vl-audit):** [rulings status](rulings-status.md) holds each ruling's state, evidence and owner.
  Fixed: the page follows its conversation from the start (VL-12, VL-26); view transitions tested (VL-17). The
  VL-19 media gap is closed by 0026 (vl-media), below.

- **Review (vl-review2):** [review of 2026-11-08](review-2026-11-08.md). Fixed: idle sandbox metering and reads in
  the chat. Open, with owners: Durable Object engine retention, idempotent history tool writes.

- **Marketing media (vl-media, 0026):** splash and empty-chat assets remain; VL-31 supersedes the former per-stop Tour placements; designer source preserved in `designs/media/`; browser loading, reduced motion, native failure and phone checks. Lead deploys.

- **Benchmarks (0017, vl-bench): not done.** Hosted-broker main `ca292c70`: 54 files / 128 behavior checks pass; independent source-profile coverage is 5,827/7,036 src/worker lines (82.82%), with 95 files below strict thresholds. Twenty added groups, explicit sync/async runner controls and validated local/live observations are retained. No unit/fuzz counters, src/worker exclusions or tolerance changes. Exact future Container/GitHub/OAuth/deployed-API cases remain in 0017.

- **Both acceptance gates (0027, lane vl-gates): implemented locally.** Maintainer-person VIP approval; Astra, Sol, Fable and Opus same-revision LGTM/A- or better specification acceptance; keep acceptance on edits and retain prior reset history, real flows, proofs/mutations, scenes, browser and workerd routes. Lead deploys.

- **vl-learnmore (0014, VL-31):** ten-step theatre tutorial, exact subtitles and optional sound, numbered app drives,
  durable pause/seek and private Mock reload recovery; designer source preserved in `designs/onboarding/`.

- **Wiki editing (0021, vl-wikiedit):** designed Edit/Propose pane, person-owned fork/commit/review through shared integrations; agent drafts for explicit person submission; fixture, HTTP, SQLite, CLI/MCP and browser checks. People merge; lead deploys.

- **Gate 2 addenda (0027, lane vl-gates2): implemented locally.** A+, A and A- pass; B+ refuses. The accepted mock
  starts with A, A, A-, A-; edits keep acceptance and receipts. Both explicit revision policies retain proofs and
  negative controls; memory/workerd, CLI/MCP, scene, fuzz, benchmark and browser cases track keep. Lead deploys.

- **Object start-up hang (0030 amendment, lane vl-startup-hang): fixed locally.** Alchemy's bridge gave constructors a
  closed Scope; patched, with a cold `alchemy dev` regression and named start-up steps. The lead deploys and watches
  `/api/health/objects`.
- **Hosted sign-in broker (0029, lane vl-authbroker): implemented locally.** Shared signed-origin/PKCE handoff through
  smithers.sh's existing callback; no new redirect URL. Both apps' local checks precede the lead's coordinated deploy.

- Hosted sign-in cleanup (0029): revoke temporary GitHub tokens in a retried flow action; count exhausted revokes
  without failing sign-in. Failed MVP callbacks hand unkept pairs to its existing sealed cleanup flow.
