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
1d  formal proof gates                 done (local)  0018: 33 marked production modules verify; 1601/1601 current mutations rejected
                                                      (vl-audit-vl29, 2026-11-10); proof, mutation and inventory gates run in PACKAGE.ts.
                                                      Whole-app work is 1g.
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

- **Proofs of all logic (0018, lane vl-proveall): in progress.** The inventory holds 3,485 executable items. LemmaScript reads destructured, computed and local records, `Message.match` in expressions with JavaScript's short-circuits, and one type per string-literal union; the screens `update`'s decisions read from the Model, the wiki draft round trip, and the Model writes of Escape, the tour's start and end, the sandbox, opening a wiki page, six screen arms, mode, launch, post, the editor, tour replay, and the single-write arms and after-step are proved a changed person or role retiring the old scope, the actions panel's list and started run, every issue arm's write, the wiki editor's and the sandbox answer's writes, an applied event's write, the actions panel's run, follow, step, clock and cancel writes, a post's client, and the replay, stream, theatre, sandbox-pane, media, mode and filter writes (batches 40 to 55, 227 mutations rejected). LemmaScript also reads TypeScript's structural types, a project's declaration files, host types and Foldkit commands (the stranded nyc-02 fixtures). A module's passing proof is reused while nothing it reads changes. Every Model write in `update` and its helpers goes through a proved function (0018 batch 55); its dispatch table and commands are recorded boundaries.
- **Proofs outside the web app (0018, lane vl-proveall3): in progress.** Proved: sequencer, follow and command arguments; pages, docs paths, prompt form, protocol limits and the session origin; mock chunks, the cookie rule and catalog roles; the bootstrap seed's choices; the sandbox meter delay. Three defects fixed: two surrogate-pair cuts, and a long history search that never showed its matches. New kernels cover Issues request/failure/revision rules; history totals and ordering; mock reply, actor journals and accounts; wiki pages and edit gates; action recovery and settlement; mock sandbox commands and leases. Native safe-revision guards reject corrupt or exhausted state before host work. The next marked kernels cover seed input order and batching plus action-list admission and mock settlement; their runtime/codec boundaries remain explicit in 0018. Decisions inside shell rows (2026-11-13): the landing check refuses a branch in a shell row that `verify/shell-branches.tsv` does not record with a reason; batches 46 to 50 proved request body limits, the budget's write-once reservation, the signed-out viewer, run and machine lifecycle, sign-in, the export's planner and check and the seed; 0 open candidates; batches 51 to 54 gave every shell branch a proof or a recorded reason; batch 55 (2026-11-14) proved or recorded as no decision the last 26 reviewed rules. A mutant that no longer typechecks is counted invalid and named, and the landing check refuses it. Stamp on main `960599ec` (2026-11-14): 20,438 obligations, 0 errors; 3,050/3,050 mutants rejected, 0 invalid.
- **Issue-graph acyclicity and replay equivalence (0018, lane vl-proveall5): done.** No sequence of issue writes creates a cycle, and replaying a conversation's or the history's journal reproduces the live state; both proved over the real decision functions. LemmaScript gains `//@ opaque`, `//@ reveal` and the constants a copied contract names.

- **Proofs strong enough to catch real bugs (0018, lane vl-proof-strengthen): landed.** `decide` is tied to the role policy for every grant and action; the day's budget reserves each call's ceiling under its lock (twenty concurrent admissions no longer pass the limit); unreported usage is charged its ceiling; runs, walkthroughs and the meter step are framed; the harness no longer counts a callee's precondition or trusts an unmarked import. Each physical provider call, reissues included, reserves and settles its own ceiling. Still open: the daily bound is charges ≤ limit + `over` (a provider overrunning its own ceiling), and restated policy tables prove no further property.

- **Proofs of the web decision modules (0018, lane vl-proveall2): in progress.** Viewport steps and the history page's guards, merge, reads and arm frames, the tour spotlight box, the PageUp distance and the viewport's active, scrollable and touch steps are proved; 99 new mutations rejected. Remaining rows name host or tool boundaries.
- **Proofs of the web views (0018, lane vl-proveall2): done.** Every choice the web views draw is proved in decision modules (Actions, Sandboxes, account, wiki, issues, history and chat views, Markdown escaping); 142 mutations rejected. Regexps, Unicode casing and Html construction remain named boundaries.
- **Forall-exists proofs (0018, lane vl-proveall2): done.** LemmaScript's witness statement (`//@ assert ... by exists(k, C)`) closes the Dafny gap in `verify/bugs/forall-exists-witness.dfy`; Markdown inline pieces now prove each piece's parity. The order of equal pieces is not proved.
- **Proofs of the server decisions (0018, lane vl-proveall2): done.** No `worker/` row is left marked not proved: the account host, Actions, sandbox, draft and site decisions are proved modules; `eventKey`'s ordering stays a recorded tool gap.

- **Proofs of update's helpers and last inline arms (0018, lane vl-proveall4): in progress.** Wiki editor (opening, Cancel, submit, save, starting source), People list, failed media and Chat arms proved, 34 mutations rejected; the arms named in batch 33 call proved decisions; translation helpers checked by property tests, with formal translation still unproved; one product defect fixed.

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
- **smithers.sh closed-scope check (lane vl-mvp-closed-scope, 2026-11-10): done.** Cold `alchemy dev` checks with and
  without `17ebb33a`'s bridge hunk ran both reconcile admissions and the actual terminal pump. Reconcile admission is
  joined inside the request; pumps and socket renewal/expiry use the object's own scope. The terminal check uses a
  real tmux fixture because the local rootless Docker forge gateway refused its connection. The next smithers.sh
  deploy adds `github.reconcile.admission` (span and log) and `github_reconcile_admissions` (counter), with fixed names
  and no payload, and retains the shared bridge fix. Full receipts and scope audit are in the lane report on nyc-01.

- Brick 2 policy and shared authentication: decision [0019](decisions/0019-sign-in-and-roles.md); lane vl-roles.
- **vl-fuzzpkg, in progress:** `@smthrs/fuzz` landed at 100%. Fuzz-only, every file under `scripts/` and `infra/` is at 100% (the seed, wiki, agent-context and preflight CLIs over generated inputs; the Alchemy stack per stage); `src/web/main.vibe` is at 667/667 lines and 762/823 branches. The whole app is at 91.7% of lines and 85.2% of branches (thirteenth session), below the 100% goal. Fixed from its findings: wiki reads while GitHub fails, unreachable reply objects, a reused action-run id, issue and wiki numbers JSON cannot carry. Open: `main.vibe`'s 53 arms and the other `src/web/` files (decision 0015).
- **vl-fuzz2 (0015), second scope met for lines:** every `worker/` and `src/core/` file outside vl-fuzzpkg's and vl-fuzz3's; 54 were below 100% at `45f23a98`. At 100% under fuzzing now: the probe Worker body, the live Factory and accounts clients, object start-up, the wiki link rule and pages, the reply and tour machines, the issue graph, the mock factory, replay, tool-refusal and walkthrough decisions; `worker/Accounts.vibe` from 237/311 lines to most of its sign-in, broker and device paths. Fixed: a refused specification review in mock mode left the reply working for 5 minutes. First scope met: the five view files, the history host, the sequencer, Objects, action runs, Issues and Wiki. At `full15` (2026-11-13) all 104 fuzz files pass and 9 lines in scope remain, 3 of them unreachable or by design; a 30-minute campaign found only harness defects, all fixed. Session 17 (2026-11-13): `full15`'s nine lines run under chosen cases (`9b76bab5`, `c8d32448`); `full18` misses 9 lines in scope, six in proof batches 40 to 45 (`Accounts`, `Issues`) and three draw-dependent. Session 18: the line gate green at `c33db232` (`full21`, job `df2d75b4`): every line in scope runs, and runs without a draw, from chosen inputs or a seeded floor (`@smthrs/fuzz` `minExecutions`; floor-only job `efcb6b82`). Not the fuzz gate: 43 branch arms were open in 20 files. Session 19: all 43 run from chosen inputs or every execution, each case checked by its arm's mutant (one equivalent survivor); four arms removed with proofs.
- **vl-fuzz3 (0015), scope nearly met:** `src/surfaces`, `src/history` and `src/actions` at 1546/1548 fuzz-only lines and 1122/1142 branches (from 1293/1544 and 821/1142); 25 of 36 files at 100%, each remaining arm listed in 0015 (race guards, fallbacks of total functions, defensive arms). Fixed: sandbox commands' refusals named the message, not the sandbox; a sign-out whose settings can't be removed died instead of answering one sentence.

- **Tour production fixes (vl-tourfix, 0014):** docs and the current paragraph share the maximized pane; live and mock use durable word-count reading holds; Escape retains keyboard control, maximization isolates chat, status announces control, and later replies exclude tour history.

- **vl-actions (0023):** third-run actions implementation targets published 0.0.12. The service-spread compiler bug is
  authorized and fixed upstream with strict negative controls; publication needs Will. Actions do not need to wait
  for that release. The report retains exact browser/workerd/flow/scene/proof/fuzz/benchmark checks and live-auth boundaries.

- **Source coverage (0016, lane vl-coverage): in progress.** Per-file tables now record independent unit, Chromium
  and Node-client workerd snapshots. Startup has 57 boundary cases at all-four 100%; native/HTTP history recovery and
  amendment focus are tested. Session 20 adds recorded GitHub/workerd browser recovery, agent run read failure,
  and removal of unread wiki cache writes. The Sol resume adds client-path, durable action admission/replay/cancellation, optional
  Container graph and emitted wiki-command tests. Whole-app strict gates remain red. Bundled attribution has both VibeLang and plain-JS
  reproductions; the installed workerd inspector cannot enable precise collection. No runtime source is excluded.
  Session 24: unit 7/202 files below 100%, all named in 0016; browser 477 checks green, 1,820 of 6,307 branches open.

- **Unit coverage, second lane (0016, lane vl-coverage2): partial.** `worker/Http.vibe`, `src/web/backend.vibe`,
  `src/actions/MockActions.vibe`, `src/actions/execution.vibe`, `src/core/conversation.vibe` and `src/core/LiveWiki.vibe`
  reach 100% unit coverage on all four metrics; `src/core/MockFactory.vibe` keeps three race-only or invariant-guarded paths. A mock
  reply interrupted by a reload no longer blocks its conversation. Unrecordable engine steps now return a typed unavailable failure while their durable runs remain recoverable; caller cancellation stays interruption. Other files below 100% remain.

- **Unit coverage, third lane (0016, lane vl-coverage3): partial.** Surfaces, history and actions: 17 files missing
  103 items down to 2 files missing 2 branches, each named in 0016 with its reason (an exhaustive `match`'s
  no-match arm awaiting Will; a V8 range defect, reproduction `coverage-v8-suspend-else-arm`); four dead fallbacks
  deleted; the proof inventory no longer fails after a build.

- Brick 6: [0024](decisions/0024-sandboxes.md), sandbox UI and shared lifecycle flows; real Container activation awaits trusted 0019 identity and deployment receipts.

- **Rulings audit (vl-audit):** [rulings status](rulings-status.md) holds each ruling's state, evidence and owner.
  Fixed: the page follows its conversation from the start (VL-12, VL-26); view transitions tested (VL-17). The
  VL-19 media gap is closed by 0026 (vl-media), below.

- **Review (vl-review2):** [review of 2026-11-08](review-2026-11-08.md). Fixed: idle sandbox metering and reads in
  the chat. Open, with owners: Durable Object engine retention, idempotent history tool writes.

- **Marketing media (vl-media, 0026):** splash and empty-chat assets remain; VL-31 supersedes the former per-stop Tour placements; designer source preserved in `designs/media/`; browser loading, reduced motion, native failure and phone checks. Lead deploys.

- **Coverage inside workerd (0016, vl-coverage-workerd): measured in every gate, not at 100%.** The workerd suite,
  unit and fuzz gates join each workerd isolate's Istanbul counters with Node's V8 report by source position;
  `worker/Api.vibe` runs as Alchemy builds and bridges it. `pnpm test:workerd --coverage` collects and gates both
  runtimes. Sandbox objects run on real workerd SQLite with a faulty Container service; successful Container
  execution still needs the authorized binding. Unit: 99.60% lines, 32/163 files below 100%. Fuzz without Chromium:
  90.97% lines; with diagnostic Chromium credit: 93.29%, 94/163 files below 100% (dated receipts in 0016).

- **Benchmarks (0017, vl-bench): not done.** vl-bench's last receipt: 6,760/7,468 lines (90.52%), 100 files below
  strict thresholds; vl-audit-vl29's merge without Chromium evidence: 109 of 159 files below (2026-11-10). Earlier, hosted-broker main `ca292c70`: 54 files / 128 behavior checks pass; independent source-profile coverage was 5,827/7,036 src/worker lines (82.82%), with 95 files below strict thresholds. Twenty added groups, explicit sync/async runner controls and validated local/live observations are retained. No unit/fuzz counters, src/worker exclusions or tolerance changes. Exact future Container/GitHub/OAuth/deployed-API cases remain in 0017.

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

- **Connect hardening (0029, smithers.sh 0165, lane vl-connect-hardening): implemented and landed.** All nine
  findings of the 2026-11-10 security review fixed with failing-first tests; deployment adds `BROKER_LIMIT`. Lead
  deploys.
- **Test quality (0015, lane vl-test-quality): landed.** Review findings 1, 2 and 4 to 11 fixed with mutation checks; sign-in wall-clock waits and the protocol-double ruling (finding 3) open.

- **VL-29 measurement tooling (0016 "Measuring every gate", lane vl-gatefix).** One `run-heavy` command per gate for a 4-vCPU box: web-server limit from `E2E_SERVER_SECONDS`, Chromium evidence stored once per run, `BENCH_REVISION` off a checkout, relative `lsc`, fuzz install check, fuzz roster equal to the unit gate's, proof inventory read from `//@ verify`. Supported box image needs Node >= 26.4 and git >= 2.41; the current Node 24.22.2/git 2.39.5 image needs an upgrade (lead). Coverage gates remain red until the suite lanes close their measured gaps.

- **Public reads (0031, lane vl-public-reads): implemented locally.** Signed-out wiki, issue and history reads go through
  smithers.sh's App (0165 addendum), cached with ETags and served stale when GitHub refuses; `GITHUB_TOKEN` is gone.
  Lead deploys smithers.sh first, with `reads` on vibelang's registry entry.

- **GitHub authorization after sign-out (smithers.sh 0165, lane vl-github-authz): landed.** GitHub's page at the
  eighth sign-in cycle is its hourly limit of ten new tokens; revoking a token keeps the authorization. Sign-out keeps
  revoking. `smithers_auth_github_consent` shows it in production; lead deploys.

- **vl-coverage, current continuation (0016): in progress.** The factories' engine seams, both specification revision
  policies, sandbox error preservation, wiki recovery/archive rendering, total tour lookup and real-jj seed
  refusal/recovery are tested. The measured unit gaps in this lane are closed apart from the recorded V8 and
  exhaustive-match branch gaps. fuzz-preflight runs as emitted JavaScript and is at 100% (Vitest cannot read
  `vibelang/register` subprocess output).
  Whole-app coverage remains below 100%; independent unit, Chromium and workerd receipts are in 0016.
  The lead keeps each strict gate opt-in until its passing commit.

- **Public reads follow-up (0030/0031, lane vl-public-reads):** repository-ID pagination, bounded cold issue reads,
  cache patience, health that waits briefly for startup, and a `Stale` mark with its confirmation time. The lead deploys.

- VL-9 / VL-29: machine policy proof batch covers fourteen kernels and forty mutations; final gates pending, durable host boundaries remain in 0018.



- Proofs, vl-proveall3 batches 25–30: history text, mock commit reads, wiki fields, note scans and long-input regressions; [contracts and boundaries](decisions/0018-proofs.md#third-lane-batch-30-long-history-scans-and-nonempty-evidence-captures).
- Proofs, vl-proveall3 batches 32–35: every shell row in `src/core`, `src/actions`, `src/history`, `src/surfaces` and `scripts/` calls a proved decision or names its boundary; `bucketsOf` remains; [modules and boundaries](decisions/0018-proofs.md#third-lane-batches-32-to-35-every-shell-row-outside-the-web-app).
- Proofs, vl-proveall3 batch 37: the counter export, submission base and reply accounting shells call proved decisions; the whole proof and mutation gate on boxes; [findings](decisions/0018-proofs.md#third-lane-batch-37-three-new-worker-shells-and-the-whole-gate-on-boxes).
- Proof gate, vl-proveall3: on main `f3ca4a2f`, 84/84 proof files (20,064 obligations) and 2,880/2,880 mutants; [per-file table](decisions/0018-proofs.md#the-whole-gate-on-one-main-revision-vl-proveall3-2026-11-13).
