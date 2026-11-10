# 0017. Benchmarks at every boundary

**Status:** in progress, 2026-11-07. **Rulings:** VL-14, VL-29; TEST-8.

**Decision.** Use the tools already in the repository: Vitest's built-in benchmark runner, Playwright's Chromium,
and the existing Miniflare/workerd host. Add no runtime dependency or benchmark library. Vitest 5 exposes `bench`
on the test context; `bench/artifact.vibe` calls that runner. Benchmark workloads check their results on every
execution. They do not import unit or fuzz suites.

`pnpm bench` builds the CLI/MCP surfaces, runs the local workloads and the deterministic regression gate, including
Chromium on port 4503 (`E2E_4503` overrides it). `pnpm bench:live` deliberately opts in to three production API and
browser samples at https://vibelang.smithers.sh, including real model tokens. It is an exclusive build target;
wildcards do not spend model tokens. Strict benchmark-only coverage is a separate exclusive qualification target; its unresolved thresholds are reported explicitly. All three commands have targets that use the repository's typed `Smithers.Shell.Test` flow machinery.

**Gate.** The committed `bench/baseline.json` records actual indexed entry reads by `decide`, `apply` and `receive`
on 10, 1,000 and 100,000-entry transcripts. A transparent Proxy counts reads of the real input; the output must still
contain every original entry and the correct new post, with pending confirmation removed. The roster must match,
all baseline counters must be finite/nonnegative, and each count may rise at most 5%, rounded up. Zero stays zero.
Wall time on shared nyc-01 is observational. CI never updates the baseline. A missing roster and a baseline reduced
beyond tolerance both failed negative-control runs before the final gate passed.

**Method and artifacts.** Ignored `bench/results/<UTC timestamp>-<suite>.json` retains machine, runtime/tool versions,
source revision, workload method, limitations, raw latency/throughput samples and assertions' successful result.
Fresh paths use exclusive creation. `bench/baseline.json` is the reviewed input, not a timing claim. The wiki table
links observations to their method and artifact filenames. Three-sample cases publish individual samples or means,
never a claimed p95/p99. Vitest's raw statistics may include extrapolated tails; the wiki does not interpret them
as established percentiles.

Single transitions scan transcripts of 10/1,000/100,000 completed posts. Replays contain exactly that many events:
one post, one reply start, one-character deltas and finish. This isolates a long stream from a growing entry count;
it does not claim that 100,000 distinct-post replay is fast. Web scene timing includes vnode construction,
serialization and queries, with no layout/paint. The browser separately checks native Command-K, focused prompt,
first visible render and one keystroke. CLI and MCP timings include their own emitted processes; MCP includes
initialize, discovery, call and teardown. The product mock includes its intentional 25ms scripted chunk delays.
Workerd runs the real sequencer, SQLite durable engine, alarms, HTTP/SSE adapter, agent, QuickJS and tour tools
against a local deterministic HTTP model endpoint. That measures flow overhead without inference, WAN or provider
contention; real model latency belongs only to the live run.

**Live definitions.** A fresh object is the first read of a unique conversation; warm is its repeated read. A client
cannot force an isolate/CDN/OS cold start, so neither is labeled as such. Post acceptance ends at its HTTP response;
first event and first visible answer delta end at decoded numbered SSE events; settlement ends at ReplyFinished and
is checked against the final snapshot. Following starts after acceptance, as the command client's normal post/read
sequence does. The public protocol exposes projected answer deltas, not the provider's first raw token. Every live
sample records UTC and the artifact records local time of day. No content or credentials are written to artifacts.

**Coverage.** `pnpm bench:coverage` runs only the same benchmark workloads, once each, under V8; it does not publish
instrumented timing claims. Vitest excludes its timing project from coverage, so the small `workload` adapter chooses
single execution for this command and the built-in runner for timing. It reuses `vl-coverage`'s monorepo
`@vitest/coverage-v8` 5.0.0 (including the repository's native-loader patch) and matching Vitest 5.0.0. Emitted
surface and script builds retain source maps and V8's subprocess collection is enabled. Workerd is another V8
isolate whose installed inspector build rejects the Profiler domain (`Profiler is not enabled` on every target,
probed 2026-11-08), so parent Node coverage cannot count worker execution. In this command each app module in a
workerd bundle (`src/`, `worker/`, `infra/`, `scripts/`) carries Istanbul counters added before bundling
(`instrumentModules` in `test/support/workerdCoverage.ts`), with the VibeLang compiler's own source map as the input
map: the same compiled output and map Vitest's V8 remap reads in Node, so both runtimes place a statement at the same
source range. The bundle runs the real Durable Object flows, and each dispose reads `globalThis.__coverage__` from the
user isolate over the inspector before it exits, writing the dump under `coverage/bench/workerd-raw/`.

Instrumenting the finished bundle instead (until 2026-11-09) remapped through esbuild's bundle map, which moved
statement starts (`Effect.runSync` mapped to `runSync`'s column). Whenever Node also loaded a file, the exact-range
union dropped its workerd hits: `worker/apiObjects.vibe`, which `bench/resources.bench.vibe` loads through
`worker/Api.vibe`, read 54.92% of lines with both suites against 64.29% with the workerd suite alone. With
per-module counters it reads 66.84% (`test/workerdCoverageShape.test.ts` guards the column).

**The merged gate.** Vitest's own threshold check is off in this command, because workerd evidence exists only after
the process exits. `bench/merge-coverage.ts` then remaps each dump through each module's compiler map, unions it
with the Vitest map (`test/support/coverageUnion.ts`, shared with the fuzz gate, 0015) and enforces 100% lines, branches, functions and statements per file across `src/`, `worker/`,
`infra/` and `scripts/`. A file with no Node-side execution is gated on its workerd-remapped structure. A file
executed in both keeps its Vitest structure. Cross-runtime credit requires identical complete statement or function
declaration ranges; branch credit requires the same type and ordered arm ranges. Missing/non-finite columns never
establish execution. The one exception is Istanbul's implicit `else` arm of an `if` without `else`, which has no
coordinates in either runtime; it matches by its branch's complete range. Before 2026-11-09 it made every such `if`
uncredited across runtimes (`worker/apiObjects.vibe` branches 37.29% before, 57.63% after, same run).

**API objects (2026-11-10).** `bench/api-workerd.bench.vibe` drives `worker/apiObjects.vibe` through tours, wiki
open, an agent reply that calls the history, wiki and docs tools (opening the roadmap and a docs page in the pane), history writes, action runs (one with an agent's trusted
entry props) and ProjectAccounts with sign-in configured from fixture-only secrets. The benchmark host built that
configuration without a `Scope`, so `Accounts.configured()` answered `undefined` and the configured branch never ran;
it is now scoped as `test/workerd/accounts.vibe` is. Lines 120, 229 and 246 to 248 stay uncovered: they run only in a
reply for a signed-in owner (its role read, an announced agent action, a wiki draft for that owner), and signing in
needs GitHub (0165). **Web sign-in (2026-11-10).** `bench/accounts-web.bench.vibe` signs a person in through the OAuth callback with an injected GitHub auth service in Node, so `worker/Accounts.vibe`'s callback, session and sign-out lines no longer need a GitHub credential. **Signed-in issue and wiki routes (2026-11-10).** These held a request open past 120 s with GitHub unreachable until `vl-connectfix` bounded reads (0030). `bench/issues-wiki-web.bench.vibe` measures a signed-in person's issue list, new issue, comment, wiki read and idempotent Save through injected `IssueHost` and `WikiHost` services; `bench/accounts-offline.bench.vibe` measures the same routes with GitHub unreachable and holds the read bound. **Live clients (2026-11-10).** `bench/live-clients.bench.vibe` drives the browser's own `liveIssues` and `liveWiki` clients (`src/core/LiveIssues.vibe`, `src/core/LiveWiki.vibe`) against the same loopback Accounts object, sending the site's Origin and the session cookie as a browser on the site does, and checks decoded states and the decoded `sign-in` refusals of a signed-out person. Complementary hits on exactly matching branch arms may combine; different shapes stay uncovered. **Held reads, host actions and a second tour (2026-11-10).** `bench/accounts-read-deadline.bench.vibe` holds a signed-in issue write on a latch in the injected `IssueHost`, so the issue list queued behind it reaches `worker/Accounts.vibe`'s six-second read deadline. `bench/history-actions-host.bench.vibe` runs Plan, Start, Note and Show, and sandbox start, command and stop, as actions through the production action index and per-run hosts (`worker/HistoryActions.vibe`). `bench/tour-again.bench.vibe` presses Learn more while a question waits, after its reply, and again after Escape; it found the tour-restart bug below, and its second workload drives `worker/Budget.vibe`'s corrupt-ledger refusal.
Executable lines are statement start lines, as in Istanbul; a declaration's hit never executes its whole nested body.
**Browser coverage across navigations (2026-11-10).** The Chromium dump ran once per workload, at its end, but V8 precise coverage reports only the current document's scripts: a page left by `page.goto` lost its counts. Workloads now dump before each navigation (`collectBrowserCoverage` in `bench/browser.spec.ts`). With the issues and panel-arms workloads this recovers 118 `src/` + `worker/` lines. Still uncovered in `src/web/main.vibe`, by cause:

- Fault arms that need a faulty service injected in the browser (media, tour events, sandbox, actions, post and tour refusals, roles and events streams: lines 320, 425, 451, 503, 510, 761, 895, 909, 1231, 1258, 1304, 1365 as of `7803d917`). The fault-injection pages exist only in the `e2e` build; the timing build is the production bundle. **Decided 2026-11-10 (the lead):** timing benchmarks stay on the production bundle, so their numbers describe what people run. Fault-path coverage runs against the `e2e` build as a separately named set, `bench/browser-faults.spec.ts` (`bench/playwright-faults.config.ts`, built into `dist-e2e/`, run by `bench/browser.bench.vibe` as `chromium-faults`). Its Chromium counts merge into this gate; its artifacts, `fault-coverage-<name>`, record build `e2e-fault-coverage` and the steps that passed, never a duration, and no timing from it is quoted. Seven workloads put one faulty Effect service under the real app (`test/support/FaultyFactory.vibe` faults `refuse`, `tour-refuse`, `disconnect`, `tour-events`, `end-tour-unavailable`, `sandbox-read`, `sandbox-start`, `roles`; `test/support/FaultyActions.vibe`; the media page's unloadable image) and check the screen the fault and its recovery leave; nothing intercepts a request.
  **Defect found by this set and fixed:** a failed sandbox start, stop or command lost its alert and Retry within a second, because the open pane's one-second read ran `loadedSandbox`, which ends any operation and clears its failure. The pane's read now runs `polledSandbox` and `polledFailure` (`src/web/paneDecision.vibe`, verified), which leave an operation's wait or failure alone; regression `test/sandboxFailure.runtime.test.vibe`.
- The ⌘K `/mock` and `/live` switch (783–784, 1385–1387) reloads the page itself, and V8 drops a document's counts on reload. Covered since 2026-11-10 without touching the request: in coverage mode each document pauses in its own `beforeunload` while the collector dumps (783–784, 1385–1386, `command-k-mock-switch`). Line 1387 runs after `beforeunload`, and the new document's commit ends any later pause (`pagehide` never pauses), so Node covers it: `bench/web-commands.bench.vibe` runs `SwitchMode` in happy-dom (`web-mode-switch-command`).
- Escape during a pending wiki Save keeps the editor and request (`none`, line 611 at `7803d917`). The `web-wiki-state` corpus asserts unchanged model identity and no emitted command.
- Seven lines ran in Chromium but compile to different statement ranges in the bundle than in Node (`main.vibe` 946, 1121, 1131; `roleView.vibe` 34, 36; `MockFactory.vibe` 338; `markdown.vibe` 114), and four have no bundle statement at all (`main.vibe` 1119, 1120, 1130, 1270). The merge credits only identical ranges, so no browser workload can cover them. These 11 lines wait for Will's answer on the VibeLang source-map fix (asked 2026-11-10); the merge does not guess across shapes in the meantime.

**No exclusions (2026-11-10).** The gate excludes no line: a gate is not passed by hiding production code.
Code nothing in `src/` or `worker/` calls is deleted, each with its reason in its commit: the post continuation model
in `flowDecision.vibe` (`begin`, `record`, `canDispatch`, `dispatch`, `lawful`, `dispatches`), `sameReply`,
`planAction`, `tourStream`, `beginScreenTour`, `endScreenTour`, `gatewayLive` and `principalOf`. Test oracles the
product never calls moved into the tests that use them: `Narration` (`test/walkthrough.test.vibe`), `seedFrom`
(`test/support/seedFrom.vibe`), `HISTORY_ROLES`, `PEOPLE_ONLY` and `SeedJson` (the fuzzers now use `leastRole`,
`peopleOnly` and `Schema.fromJsonString(Seed)`). `scriptedReplies` stays: the compile check of every scripted
answer needs it and the reply table is private; it runs at module load, so it costs no coverage.

These stay counted and uncovered:

- Functions only proof contracts call, waiting on a VibeLang specification-only function form (a VIP the lead is
  raising): `replyLawful` and `tourLawful` (`src/core/flowDecision.vibe` 134–140, 202–207), `issueAncestorAt`
  (`src/core/conversation.vibe` 817–824), `issueKnownAction` (`src/web/issueDecision.vibe` 207–209) and
  `lawful` (`src/history/flowMachine.vibe` 149–153).
- `scripts/mythical-seed.vibe` line 103, the `Refused` guard: `intentsOf` guarantees `decide` accepts every seeded
  intent, so only a `seedOf` defect reaches it.

The denominator includes `src/`, `worker/`, `infra/` and `scripts/`, matching the coverage lane’s source scope and adding the browser bundle solely to collect source-mapped evidence. No production line is excluded. The 100% benchmark-only coverage requirement remains open until
its executed per-file report meets it; a configured threshold is not a coverage receipt. See `wiki/benchmarks.md`.

**A found regression in the tests.** The existing Factory concurrency case failed on untouched main as well as this
lane. Its fixed count of scheduler yields/virtual-clock steps could advance before asynchronous engine/crypto work
registered its next sleep. The concurrency test now waits for the other room's actual finished event and checks the
busy room still has queued work. Disposal waits for the first real delta before closing the scope, checks all tracked
workers exited and the follower stopped, and checks no later publication. All nine lifecycle cases pass; no product
mock timing or engine behavior changed.

**Language gap retained.** `vibelang-native-event-service` under the lane’s `~/vl/vibelang-bugs/` reproduces EK4402 for native event construction even through injected Document. No compiler behavior or TypeScript-only test adapter was changed. Native-event benchmarks run at Playwright’s already-required `.ts` boundary and drive the real VibeLang application.

**Native keyboard recovery.** The native-browser benchmark found that a pending Home/PageUp scroll could outlive Latest and republish a pause after the button was clicked. Chat page-scroll keys now apply an immediate page/line scroll instead of a continuing native animation. Repeated position-only pauses no longer overwrite the initial upward intent. A new upward gesture still vetoes a queued follow. The same failing native benchmark guards the fix.

**Review corrections.** Astra identified modified page-scroll shortcuts bypassing the follow veto, omitted infrastructure coverage, and missing browser-artifact revision. Two keyboard tests failed before Ctrl+Home and Meta+ArrowUp gained the same synchronous veto and immediate scroll. Coverage includes infrastructure and scripts; browser artifacts now record their benchmark revision separately from deployment identity (unknown when production does not expose it).


**Coverage qualification.** Decision 0016's retained `coverage-source-ranges` reproduction shows that minified
Chromium coverage can credit an unexecuted source return. Browser source-line/statement figures are diagnostic,
not proof of executed lines. The installed workerd inspector rejects precise V8 coverage, so the parent V8 collector
cannot credit worker execution; independent instrumented dumps supply that evidence. Neither limitation is hidden by an exclusion. Changing VibeLang compilation
or source-map behavior requires Will's prior decision (VL-7); no such change is made in this lane.
The only generated-code exclusion is `dist/assets/rolldown-runtime-*.js`: Vite's own bootstrap has no app source map,
so its generated lines do not belong in the production-source denominator. No `src/` or `worker/` line is excluded.
Workerd's independent Istanbul counters are now collected by the shipped test host. Their remapped results and the
Chromium results remain diagnostic while the bundled attribution negative control is unresolved; a green workload
or a configured threshold is not a trustworthy 100% execution certificate.

**Sandbox compiler boundary.** After sandbox main 965fb766, the new workerd benchmark hit the retained `~/vl/vibelang-bugs/nested-benchmark-effect/` reproduction: an inner `runPromise(effect { … })` inside an async benchmark callback built by an outer Effect is typed as a plain function. The same inner program compiles in the control; no request runs. Its workerd benchmark fragment is deferred, with no substitute path or compiler behavior change. Independent product-mock Factory, integer meter and agent-binding benchmarks continue. An upstream compiler fix requires Will’s prior VL-7 decision and the VibeLang merge queue.

**Issue flows (0022).** Benchmarks cover every fixture-host issue command individually and as a complete retained-state journey, all role/review decisions, ordered observations, tree refusals, stable hashed execution/recovery identities, and cached-replay authorization after a role downgrade. Full affected-row equality rejected a deliberate link/body-loss mutation. These measure local durable flow overhead; they make no GitHub latency or write claim.

**Source receipts.** Raw artifact revisions are never relabeled after rebasing. The complete tracked source snapshot for measured `7d66df9f` is retained with its receipt because main advanced before publication. Later focused observations retain their own revisions; the wiki states which receipts it combines.

**Media and input completeness.** All five stop assets, reduced-motion posters, fault mapping/fallback, model dispatch and bounded telemetry have benchmark assertions. Chromium observes a real hero frame and native programmatic pause/play, with automation/cache/decoder limits. Public media files are declared target inputs so an asset-only change invalidates the test cache. Keyed history replay additionally runs the real binding and SQLite write path in workerd, once per identical cell call.

**Accounts and role views (0019).** Added real MockAccounts lifecycle/replay, LiveAccounts faulty-transport cases, real workerd session signatures/expiry/revocation and durable current-role authorization, disabled configuration and an injected GitHub exchange failure. The trusted test host issues synthetic sessions; no successful provider exchange or actual account mutation is claimed. Native UI visits all five roles, People permissions, confirmation/cancel/Escape, account-menu keys, sign-out, mock sign-in/retry and participation promotion. No session token or cookie is retained in result JSON.

**Maintenance scripts and emitted-script evidence.** `bench/scripts.bench.vibe` times the emitted maintenance
scripts as real child processes: the mythical seed over a fixture jj repository and merge queue (write, determinism,
failed reads leaving prior output) and the agent context generator (missing/stale check rejection, write, fresh
check). The coverage command's include list gained `dist-scripts/**/*.js` and `dist-script-tests/**/*.js`: the
provider's extended-context path filters by the executed file before remapping, so the emitted scripts' V8 evidence
was previously dropped before their maps could credit `scripts/*.vibe`. The seed's `Refused` guard
(scripts/mythical-seed.vibe line 103) is unreachable from real input: `intentsOf` guarantees by construction that
`decide` accepts every seeded intent, and `decideWithinCapacity` refuses only at 2^53 events. It is a defensive
guard against a `seedOf` defect, not behavior a benchmark should reach; exclusion reason recorded here per the
lane rule, enforced when the merged gate lands with the workerd collector.

**Resumed qualification, 2026-11-09.** Four failed-first merger cases reject enclosing-statement credit, same-line
function/branch borrowing and incomplete columns, while allowing exact matches and complementary exact arm hits.
Earlier figures from the line-span merger are superseded; no percentage from that heuristic establishes execution.
No compiler behavior, dependency, threshold or production exclusion changes in this correction.

The expanded corpus independently benchmarks real SQLite conversation hosts (queued posts, owner-preserving
duplicates, alarm settlement, sequencer recovery, cancellation tombstones), action hosts (request conflicts,
terminal traces, queued cancellation and current-role revocation), all dispatch/progress/startup/theatre decisions,
and specification revision/review/keep through product mock flows (0027's VL-32 addenda). The wiki generator runs actual emitted child
processes on fixture files, checking deterministic output and preservation after real read failures. Run that command
separately from ordinary wiki-process tests, which share its ignored compiler fixture directory. No test suite is
imported into the benchmark suite and no GitHub request is intercepted.

Native browser workloads follow VL-31's private walkthrough stream: Pause/Play, real issue/VIP/wiki destinations,
Escape and pane controls. They also measure real action Run/trace/Cancel/Re-run with distinct execution identities.
The workerd deadline includes three complete reading budgets; shortening real reading holds
would invalidate the method. Production's `/api/health` now exposes its deployed commit; live artifacts retain it
when present and leave it unknown when absent. The successful sandbox workerd lifecycle/metering benchmark is now
on main; the older nested-Effect reproduction above is retained as history, not an active deferral of that workload.

**Qualified source build, 2026-11-09.** The retained plain-JavaScript control reproduces the bundled converter's
false credit without VibeLang: actual result 7, an unvisited return-9 statement credited, branch arms `[1, 0]`.
Unminified JavaScript and VibeLang controls both leave that return uncovered. `benchCoverageBundle.test.vibe` runs
the actual app Vite configuration, executes a real native V8 subprocess and remaps its counters. It failed before
the coverage build selected `--mode bench-coverage`; it now passes. This is source coverage before minifier folding,
not a claim that optimized-bundle statement attribution is sound. Normal timing observations use the optimized build.
No VibeLang compiler, emitted program semantics, dependency or threshold changes.

The cross-runtime merger also applies the shared provider's exact Infinity-end-column normalization using the
original UTF-16 source line length. Its failed-first test preserves finite/missing columns and every hit count.
The full 41-file, 100-workload coverage run passed its behavioral assertions. Replacing its browser evidence with
five source-build workloads preserves the tracked production source; before/after source hashes are retained with
the receipt. The strict merged gate still fails. The wiki and lane report publish both Node-only counters and the
merged statement-start counters, never the superseded outer-span heuristic. No `src/` or `worker/` line is excluded.


**Shared configuration and wiki update, 2026-11-09.** After decision 0016 landed, the benchmark collector imports
its canonical provider options, subprocess collection and full source roster. Only the benchmark include list runs;
collection thresholds are deferred until workerd and Chromium evidence joins, where the same strict 100% per-file
thresholds apply. No threshold is relaxed. This is a complete collection on one archived production source snapshot,
not a combination with unit/fuzz execution or an older product tree. Before/after hashes match for all tracked
production sources. The earlier 41-file run and source-browser replacement above remain historical receipts.

The wiki addition also benchmarks native Edit/Save/Propose, Escape, role revocation, and reviewing/submitting a
scripted agent draft. Each review leaves repository Markdown unchanged. Emitted CLI and persistent stdio MCP
benchmarks exercise all four wiki operations; the MCP method explicitly includes readback and write replay.
The exact catalog check failed first when Wiki became the eighteenth command, then passed after its roster update.
A coverage attempt cancelled for that update exits 130 and supplies no published corpus.

Earlier pre-0028 benchmark-only receipt (`6a979627e06c4be522557d65f6ffa8bb8320b349`): Test Files 43 passed (43); Tests 103 passed (103); Duration 923.61s (tests 94%, import 3%, transform 2%, environment 1%). The merged count is 5,083/6,675 src/worker lines (76.15%); 93 files fail one or more strict thresholds. No `src/` or `worker/` line is excluded. Full per-file counters, methods and limitations appear in [the benchmark table](../benchmarks.md). The 100% requirement remains unfinished.


**CLI/MCP identity on fresh main (0028).** Identity landed while the complete coverage run was frozen. Its later
focused timing covers the literal guest/person/agent label rule, four-process CLI sign-in/ask/logout/repeated-logout
journeys, and persistent five-call MCP sign-in/signed-post/logout/guest-post/readback journeys. Exact public schemas,
author labels, settled counts and removed session files are checked. Real private settings and durable SQLite session
actions run in scoped temporary directories; no real credentials, provider exchange, network or model is involved.
Wiki CLI/MCP cases likewise receive isolated settings so a previous real or fixture sign-in cannot change their role.
The exact current catalog retains all twenty commands, including login/logout. These three new identity groups and
nine affected surface groups pass; their timing artifacts retain the later source revisions. They do not contribute
counters to the earlier 43-file/103-workload coverage run, whose denominator predates 0028. Additional identity/session
coverage is therefore still required alongside the gaps already recorded. No number is relabeled as current-head coverage.


**Publication graph regression.** The fresh-main target-index check rejected two app-owned source globs crossing
into the newly vendored LemmaScript package. That package now exports `compilerSources` as an owned filegroup;
both app proof targets consume it. Target-index generation passes, and target inspection retains the compiler label
in the proof target's dependencies/cache inputs. Its package README documents consumption. The original failed
check is retained in the lane report; no compiler implementation or proof contract is changed.


**Current-main resume, 2026-11-09.** The first new complete run measures production `3fa8df73048e0e655858c7bf3cfc3269a429a35d`, including 0028: 44 files / 106 workloads pass, but the strict merge exits 1 for 97 files. It covers **5,221 / 6,947 src/worker executable statement-start lines (75.15%)**. This supersedes the older pre-0028 percentage as a current-main observation. All tracked source hashes match before/after; the build creates the ignored generated wiki module before collection, and its exact bytes and hash are archived too. Raw maps, source-profile browser bundles and the production snapshot are retained with the lane report. No unit/fuzz execution contributes.

The resume adds independent benchmarks through production issue/wiki HTTP handlers and SQLite runtimes, actual product fixture hosts, native workerd credential/meter/recovery boundaries, native session files and durable Actions/Poll, browser Command effects and stale-response reducer corpora. Every callback checks its returned result and retained state. Typed faulty Effect services cover unsuccessful operations without request interception; successful fixture operations remain explicitly product mock mode. Session telemetry measurements use a scoped MetricRegistry to isolate benchmark samples. These additions make no 100% claim before their complete merged receipt.

The rejected browser-command fault overlays reproduce published VibeLang 0.0.12 dropping retrieved service methods from a spread. Minimal reproduction and compiler diagnostics: `~/vl/vibelang-bugs/bench-factory-spread/` on nyc-01 (the already documented 0023 service-spread class). No adapter, type coercion or TypeScript substitute bypasses that diagnostic; no compiler behavior change is introduced. Independent command journeys continue through real product services.

**External boundaries remain in the denominator.** The following are precise planned benchmarks, not implemented or executed success claims. Their paths remain uncovered rather than excluded. Each needs the indicated real resource/authority; a lane does not create GitHub writes or turn on live compute.

| Unmeasured path | Exact planned benchmark | Correctness and prerequisite |
| --- | --- | --- |
| A real Cloudflare Container behind `worker/machineObject.vibe`, the Alchemy bindings in `worker/SandboxMachine.vibe` and `worker/SandboxAccounts.vibe`, `infra/SandboxImage.vibe` | `bench/live-container.bench.vibe` → `container-checkpoint-restart` | Start a real offline Container as an authorized person, write/read exact bytes, Stop/checkpoint/restart, verify retained bytes, current generation, once-only command replay and exact metering. Requires Will's pending yes/no, deployed binding and trusted test session. |
| Successful provider mutations/reconciliation in `worker/Issues.vibe` | `bench/live-github-issues.bench.vibe` → `github-issue-write-reconciliation` | In an explicitly authorized test repository, create/comment/link/split/assign/unassign and propose a VIP; inspect native ids, parent/body/assignee and authored document/review; replay each key with exactly one write. Acceptance/decline are explicit person actions, never lane approval or merge. Requires designated person credentials and write authorization. |
| Person-owned fork/branch/fenced commit/review in `worker/Wiki.vibe` | `bench/live-github-wiki.bench.vibe` → `github-wiki-review-reconciliation` | Read native source/head, draft, Save/Propose, inspect immutable author and exact single-file review, cached replay, changed-head conflict and unchanged base Markdown. Requires an explicitly authorized test repository and person credentials. No merge. |
| Browser OAuth callback/credential connection in `worker/Accounts.vibe` and real device flow in `src/surfaces/signin.vibe` | `bench/live-oauth.bench.vibe` → `oauth-device-and-browser-session` | Human completes the real hosted-broker callback and device grant; verify single-use origin/nonce/PKCE redemption and callback fragment removal, then check exact origin, agent/person session kind, carried current role, restart/resume polling, refusal/expiry, revocation and removed private credentials. Requires enabled provider setup and a human grant. No cookie/code/token in artifacts. |
| Authenticated Alchemy API wiring in `worker/Api.vibe` | `bench/live-authenticated-api.bench.vibe` → `api-person-and-agent-authorization` | Real deployed bindings and human-issued sessions; public versus signed post labels, current-role revocation and same-origin/agent-only restrictions, unchanged state on refused writes. Container/GitHub mutations additionally need the prerequisites above. Local workerd fixture hosts do not establish this deployment wiring. |

**Sandbox objects on an in-memory Container (2026-11-09).** `bench/sandbox-objects.bench.vibe` runs the production account and machine bodies (`worker/accountObject.vibe`, `worker/machineObject.vibe`) and gateway in real workerd SQLite through `identityFromPolicy`. It checks generation fencing, once-only command replay, checkpoint restore, role and binding refusals, and Container faults. `test/workerd/bench-sandbox.vibe` supplies an in-memory Container that answers the run tool's fence protocol, so this measures object, ledger and fencing overhead only. It is not the `container-checkpoint-restart` benchmark above, which stays planned. Benchmark-only coverage after this change: 5,938 / 7,042 src/worker statement-start lines (84.32%); the strict gate stays red.

**API Worker bodies and GitHub-bound paths (2026-11-09).** `worker/Api.vibe` now holds only Alchemy bindings; the object bodies and fetch handler are `worker/apiObjects.vibe`, imported by `test/workerd/bench-api.vibe`. `bench/api-workerd.bench.vibe` runs them in real workerd SQLite through `apiFetch`, alarms, and a deterministic HTTP model service. Objects reach each other by `fetch`, not Alchemy RPC, and sign-in is unconfigured there. `bench/github-faults.bench.vibe` covers `worker/MainLog.vibe` refusals and a VIP draft through an injected faulty `HttpClient`.

These paths wait for a GitHub test credential and stay in the denominator. GitHub doubles do answer some benchmark happy paths: `bench/signin-device.bench.vibe` (GitHub's device endpoints on loopback, `test/support/deviceSignIn.vibe`) and `bench/accounts-web.bench.vibe` (a canned `GitHubAuth`); whether such protocol doubles may stand in on a happy path awaits Will's ruling (vl-review-tests finding 3). The paths below have no double:

| File | Waits for GitHub | Runs without it |
| --- | --- | --- |
| `worker/Issues.vibe` | `verifiedVip` after a marker matches; `read` after its first page; every write in `perform` after `read`, including its title, missing, tree, assignee, closed and review refusals; the `executeIssues` observer | policy, sign-in and connect refusals, unavailable writer, `draft`, HTTP validation, `publicIssues` method refusal |
| `worker/MainLog.vibe` | the commit-returning `return found` over real commits | transport, status, JSON, shape, empty-page and out-of-reach refusals |
| `worker/Wiki.vibe` | a successful source read and its `note`; a draft after its source read; every write after its first authorized read, including conflict and empty-change refusals | sign-in refusal, empty draft, unavailable writer, retained draft before `connect` |

Skipped by decision 0165: `connect`, `/api/auth/github` and `worker/IssueCredentials.vibe`.

Ordinary reachable control/error paths also remain; they are reported per file and are not folded into these external deferrals. No new source exclusion, threshold change, dependency, deployment or GitHub mutation is authorized by this table.

### Runner preflight correction (2026-11-09)

Failed-first controls against the real Vitest/Tinybench runner found that automatic function classification invokes
a plain callback before measurement. A three-sample sync workload executed four times; a plain Promise-returning
workload executed four times and reached concurrency two. The callback's native syntax is not sufficient evidence
of async classification. All workloads now declare sync/async explicitly with Vitest's supported `async` registration
option. The same controls require exactly three calls and maximum concurrency one, or exactly one call in benchmark
coverage mode. No dependency, compiler, deadline, result assertion, or coverage threshold changes.

A complete attempted timing run passed 124 workloads but timed out at 120 seconds in issue-host recovery; it is a
failed run. The unchanged isolated recovery case passed, and tracing independently established the extra probe and
overlap. Causation of that timeout is unproven. Both attempted complete timing receipts precede the runner fix and
are retained only as superseded diagnostics. Historical timings without explicit registration do not substantiate
isolated unwarmed execution. Coverage bypasses Tinybench, so the initial 75.15% source-profile receipt is unaffected.

**Expanded complete receipt (2026-11-09).** Production parent `6886bb65022164f79cf6df922eb197d3c9c10343`, archived benchmark snapshot `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`: **5,789/6,991 src/worker executable statement-start lines (82.81%)**. Timing and benchmark-only coverage each pass 53 files / 127 tests (125 workload groups plus two real-runner controls); Vitest durations 1,175.28/1,191.00 seconds. The strict merged coverage gate exits 1 for 95 files. No src/worker exclusion or threshold changes. Source refactors and issue updates landed between the initial 75.15% parent and this parent; these are named snapshots, not a controlled attribution of every denominator change to the benchmark additions.

Every executable source hash, including the generated wiki runtime, matches before/after collection. Ignored `.d.vibe.ts` declaration outputs were regenerated and are separately archived/listed, never credited as execution. Raw JSON, full per-file Node/merged counts, exact uncovered lines and all four strict metrics, source bundles/maps and hashes are retained with `~/vl/vl-bench.REPORT.md`. The full corrected timing roster and fresh production observations (2026-11-09 12:35 UTC, deployment `7993617b64`) are in the benchmark wiki. Ordinary reachable gaps and the exact external prerequisites above remain unfinished.

**Fresh-main integration.** After the frozen measurement, main `1c2c2ca4` lands VL-32 addenda: A- or better passes and accepted specification revisions keep prior approval. Both that lane’s updated gate/specification benchmarks and explicit runner registration are preserved; the new host corpus expects the native `revision` history event. The 82.81% receipt remains qualified to `6886bb65`; it is not relabeled as coverage of the later policy. Final validation runs on the integrated main.

**Hosted-broker integration (0029).** Main `96c51b17` adds hosted sign-in and shared local-cookie admission. Both workerd helper exports and testing tool records are retained. An independent result-checked cookie-admission benchmark covers secure/loopback names, canonical-origin constraints, length and character boundaries. A new complete source-profile collection on this main follows; the earlier 82.81% receipt remains historical rather than being relabeled as broker coverage.

**Complete hosted-broker receipt.** On production parent `6227bf09c9a5ce33557990e4cbea361ab19a5c4e`, all 54 benchmark files / 128 tests (126 workload groups plus two runner controls) pass in normal timing and independent coverage. Twenty added groups include the independent cookie-admission corpus. Coverage is **5,816/7,035 src/worker statement-start lines (82.67%)**; strict merge exits 1 for 95 files. No src/worker exclusion or threshold changes. Normal/instrumented suite durations: 1112.79s/1221.99s. The earlier 82.81%/6,991-line denominator predates hosted sign-in and is archived separately. All executable-source before/after hashes match; generated declaration-only deltas are separately retained. Methods, complete per-file metrics, exact uncovered positions and final local/live artifacts remain with the lane report.

**Workerd History correction.** The refused-run fix exposed a false-positive old benchmark: the local host supplied viewer to History even for a signed person's action, and the refusal was marked passed. Earlier `workerd-actions` successful-latency observations are withdrawn. The unshipped host now mirrors production's owner/current-role delegation, including a fresh grant lookup for every write. The benchmark decodes the actual History answer, checks one real retained commit and exact replay readback. Mock and Node SQLite regressions independently fail first on old settlement and check both refused and accepted writes. A complete recollection follows; no earlier counters are silently combined with it.

**Complete hosted-broker receipt.** On production parent `ca292c707458c8970651fe06559bbe2ac803ae28`, all 54 benchmark files / 128 tests (126 workload groups plus two runner controls) pass in normal timing and independent coverage. Twenty added groups include the independent cookie-admission corpus. Coverage is **5,827/7,036 src/worker statement-start lines (82.82%)**; strict merge exits 1 for 95 files. No src/worker exclusion or threshold changes. Normal/instrumented suite durations: 1165.09s/1266.37s. Earlier 82.81% pre-broker and 82.67% pre-History-readback receipts are archived separately; old workerd-actions successful-latency observations are withdrawn. All executable-source before/after hashes match; generated declaration-only deltas are separately retained. Methods, complete per-file metrics, exact uncovered positions and final local/live artifacts remain with the lane report.

Publication continuity: after collection on production parent `ca292c70`, main advanced to `bf596767`. No app src/worker/bench/infra or native benchmark host changed. The browser helper only adds exports unused by benchmarks; new ordinary coverage tests and an unused helper are checked by the full post-rebase unit/typecheck run. MVP deployment/analytics changes do not reach the imported broker host; the private-adapter change emits declarations only. Timing and coverage remain attributed to their exact archived pre-rebase source, never relabeled. The intervening patch and validation receipts are retained with the lane report.

**CLI startup (2026-11-10).** `bench/cli-startup.bench.vibe` pins startup by the number of modules each CLI command
loads (`bench/baseline.json` `startupModules`, the same 5% tolerance), because wall time on shared nyc-01 varies
with load. It also requires that only sign-in loads the durable Node host. Lazy sign-in imports cut `--help` from 1,462
to 864 modules and its median from 3,082 to 1,810 ms (interleaved, same load). Method and limitations are in the
benchmark wiki.

**Broker sign-in and account history (2026-11-10, lane vl-bench2).** `bench/accounts-broker.bench.vibe` runs
smithers.sh's broker and the site's Accounts object in workerd (`test/workerd/authbroker.vibe`), so the broker
sign-in, Connect GitHub with its return parameters, Disconnect and their refusals no longer wait for a GitHub
credential: GitHub is the host's injected token service, the same seam as web sign-in. `serveAuthBroker` now passes
the bundle's coverage flag, as the other workerd hosts do. `bench/accounts-history.bench.vibe` measures one account
step after 10 and 150 earlier ones (226 against 429 ms): every step opens a journal that decodes up to 4,096 recent
events. `462049cc` gave Accounts' steps `EXECUTION_RETENTION`, the one-day retention every other object already used,
which bounds that history to a day's steps; `test/accountsRetention.test.vibe` pins it.

**Actions, replies and history tools (2026-11-10, lane vl-bench2).** `bench/action-tour-repeat.bench.vibe` presses
Tour twice before its alarm on the production action hosts; the second press finds the tour running (`ActionRuns`
line 53), so the accepted-but-queued recovery at lines 54-61 stays uncovered. The deterministic model service (`bench/fixtures.vibe`)
gains three phrases: "Bench empty." (an empty answer), "Bench throws." (a cell that throws) and "Bench history." (a cell
that pages an epic, a commit and a search, then calls Plan and Note). `bench/reply-outcomes.bench.vibe` and
`bench/agent-history.bench.vibe` post them to the API Worker's objects in workerd. Cancelling a post's reply while
it runs stays uncovered (`worker/ActionRuns.vibe` 145-148): the reply runs within the alarm that dispatches it, so
cancelling it mid-run needs a model held mid-answer.

**Issues and wiki with GitHub unreachable (2026-11-10, lane vl-bench2).** Decision 0030 bounds a signed-in person's
issue and wiki reads, so `bench/accounts-offline.bench.vibe` now sends them with GitHub an offline HttpClient, an
injected faulty service: each read answers "unavailable" in about 6 s, and writes without a connection answer
`connect`. The exclusion of these routes from every benchmark above no longer applies to their refusal paths; their
GitHub success paths still wait for a GitHub credential.

**Receipt (2026-11-10, lane vl-bench2, `f52ffeba`).** `pnpm bench:coverage`: 70/70 files and 148/148 tests pass; the
strict per-file gate exits 1 for 102 files. Merged benchmark-only coverage is 6,989/7,576 `src/` + `worker/` lines
(92.25%) and 2,010/2,299 `worker/` lines (87.43%). Accounts went from 82 uncovered lines to 8 (the read-queue
deadline, participation and a cross-origin sandbox principal). Issues and Wiki keep 130 and 59, almost all GitHub
success paths.

## Off-host runs (lane vl-gatefix, 2026-11-10)

The complete receipts above ran on an idle 48-core nyc-01. On nyc-01 at load 80 to 95 and on a 4-vCPU box,
`bench/browser.bench.vibe` failed on Playwright's 120 s web-server limit before any check, so the merged gate had no
Chromium evidence; on a box, `bench/artifact.vibe` also refused every artifact because a packed tree has no `jj`
checkout. The web-server limit is now `E2E_SERVER_SECONDS` (default 600 s, and the local global deadline grows with
it), and the artifact takes `BENCH_REVISION` where there is no checkout. The command for a box is in 0016,
"Measuring every gate".


The parent benchmark's timeout now includes `E2E_SERVER_SECONDS` too. The browser suite gained a ninth workload;
its parent checks for executed passing workloads instead of requiring the stale text “8 passed”. A separate fixture
bug made the first-visit tour workload fail: the shared init script marked every navigation as returning, overriding
the workload's `bench:first-visit` session flag. The shared script now honors that flag, so the existing automatic-tour
assertion exercises an actual first visit. No application tour behavior changed.

**Remaining-gap corpus (2026-11-10, Codex continuation).** `mock-agent-requests.bench.vibe` drives the shipped mock
agent through BrowserFactory and the registered action/issue/wiki flows: request Plan, refuse an unknown action,
retain the original poster's authority across an identity change while a tour holds its reply, file an issue, split
#38 and refuse a draft of the generated decisions index. Each sample checks the reply and resulting records.
`history-recovery.bench.vibe` additionally folds unannotated and unknown-trailer commits into a new and then reused
scope epic, checking the exact recovered history, event order and duplicate no-op. `api-workerd.bench.vibe` adds
warm `/api/health/objects` reads for all five objects, checking startup, build and stable object identity. The first
two measure product memory-host flows; the last uses the production object bodies in workerd. No successful GitHub
response is synthesized, no new dependency is added, and none of these measurements includes model inference.

`object-startup.bench.vibe` adds initialization/recovery around the real budget and object-storage ledger, with a
faulty `Ledger.read` service. It checks failed health without health-triggered retries, unavailable HTTP forwarding,
explicit recovery and once-only charging. After main introduced daily reservations, admission supplies a reply and ceiling, and settlement supplies its reported usage; the same case requires one five-token receipt, zero retained hold and seven total tokens. A second workload holds an uninterruptible ledger read through the real
five-second call deadline, then releases it and retries. Its duration includes the designed deadline; it is not a
normal request latency or CPU-throughput measurement. These are Node-host wrapper measurements; the separate
workerd health workload checks the actual five production object bodies. Its Budget RPC corpus now supplies named reservation/settlement arguments, replays an open hold and a settled charge, and refuses readmission of the charged key; five real RPC calls per callback in the frozen c5bbf81b receipt. Current main's stronger nine-call corpus additionally refuses overflow and independently observes exact remaining day capacity; that corpus is preserved. Its cold health workload stays first, and the stable ready/identity checks are separately named api-objects-health-warm after the object journeys.


**Public GitHub reads and remaining recovery gaps (2026-11-10, Codex).** Both project repositories are publicly
readable; a GitHub test credential is not needed for those reads. `BENCH_GITHUB_READS=1 pnpm bench` and
`BENCH_GITHUB_READS=1 pnpm bench:coverage` add the actual public issue/wiki hosts via their production durable read
flows, product ETag cache and local SQLite/KV. One sample each: issue pagination, selected timeline/comments and exact
read-receipt replay; wiki bytes/revision compared with the real provider, persisted projection and a restored local
draft. Product MockAccounts supplies local authority. No successful HTTP double, credential or provider write is
used; only counts are retained. Without the flag the two named cases skip and contribute no execution evidence.
Anonymous quota and volatile provider state are limitations. GitHub write success paths remain unmeasured.

The same corpus adds an owner-bound agent reply whose draft reaches the account RPC and is refused for its viewer,
and Escape during a pending wiki Save keeps the exact request without emitting more work. Sandbox recovery checks
actual Stop receipts after exhausted minutes and a lost lease, a failed emergency stop recovered by a healthy host,
a pending start whose permission was revoked, and a held command whose uncertainty survives replay without another
machine call. The platform uses product memoryMachines and a retained store in memory, with explicit faulty services.

Retained mock journals cover a half-written reply becoming a visible failure before the next post answers, one
resumed tour, and an ownerless sandbox request refusing to start. The journal is a healthy memory adapter with seeded
records, not evidence of an actual process kill or browser storage durability. A delayed real Digest opens each of
two Reply/Tour contention windows; exact event order, one reply, driven/undriven tour, actual contention log and tour
run outcomes are checked. Latches are bounded and always released. Timings describe controlled fault overhead, not
its natural frequency.

`dispatch.bench.vibe` scans last/middle/none/all dispatched queues and projects started/driven/ended tours at 10,
1,000 and 100,000 posts, with inputs built outside timing. The authorization-journal corpus checks an exact accepted
event advances only the cursor and preserves roles/entries, while the viewer is refused. All assertions run inside
the measured callback. No threshold, exclusion list, production behavior or language behavior is changed.

**Cancellation during model streaming and browser setup (2026-11-10, lane vl-bench2, Codex).** The interrupted-reply
benchmark previously held budget admission, before the model answered. Its loopback HTTP model now pauses between
SSE fragments; cancellation must leave the entry and registered run cancelled through a host restart, with one model
request and no completed answer. The new regression first failed at its bounded pause wait when the scripted
endpoint ignored the latch.

The overlay over "Ask the agent" was a benchmark setup race with the intentional first-visit tour. Main's returning
visitor setup removed that race, but also suppressed the arms workload's deliberate first-visit reload. That
workload failed first at its `first-visit-auto-tour` assertion (15 s, no Walkthrough). The shared init script now
honors its explicit session flag, including the fresh contexts used to time first render and Command-K. No product
tour behavior changes.

 
**Independent worker continuation (2026-11-10, Codex, base 0b937f1d plus benchmark patch).** The full benchmark-only
run passed 75 files / 156 tests, including eight Chromium journeys. A further wiki agent draft/replay workload
passed timed and instrumented; its counters join by exact source position with the full run, with identical
src/worker bytes verified by SHA-256. This is one full run plus one additive benchmark, not a single 76-file run.
Combined: 2,067/2,321 worker lines (89.06%), 7,208/7,636 src+worker lines (94.39%); the strict gate remains red.
ActionRuns (120/120), Budget (22/22) and WikiTools (9/9) now have full line coverage.

The new wiki workload runs the real reply, tool binding and product fixture wiki flows. Its model cell drafts
the same page twice; both review links, one stored addition, unchanged source, no submission, active-actor pane
events and one model request are checked. Node SQLite and the fixture wiki engine are measured, with scripted
model answers; neither GitHub nor inference latency is measured.

The remaining HistoryActions lines 26,39,44 are defensive Post/Tour refusals on the history-only host, which
ActionRuns never routes there. Objects 114 is its unused default no-op wake callback; 250-251 are invariant failures
for child-flow/round routing that Reply and Tour never perform. No direct coverage-only invocation was added;
these guards remain counted. Account participation/origin, startup faults, reply restart/error edges and the
credentialed GitHub hosts remain open. No threshold or denominator was reduced.

Main independently landed the same first-visit init correction in e8a2845563a8 while this measurement ran.
The continuation keeps that shared init and additionally marks the first-render workload's own fresh contexts as
returning visitors. The live UI-only run passed three samples on deployment 6a3c8b517c at 15:42 UTC (07:42 PST),
without a model call; raw sample times and limitations are in the benchmark wiki.


## Anonymous worker reads and failure recovery (lane vl-bench2, 2026-11-10)

The issue and wiki repositories are public: their ordinary source reads do not require a person's GitHub sign-in.
`bench/public-github.bench.vibe` opts in with `BENCH_PUBLIC_GITHUB=1` and sends real anonymous GETs through
production GitHub hosts, durable SQLite execution and PublicReads. Untimed native issue/comments and immutable
contents reads are the independent oracles. Every sample checks actual identity/content, ordering, comments,
timeline, revisions and retained storage. One empty application-cache observation and three warm-cache samples
are retained. Native oracle calls warm transport first; this is no DNS/TLS/OS cold-start or isolated cache-speedup
claim. Cold includes migrations; warm reads use new durable keys on the growing journal.

A real GitHub read also primes the cache-eviction case. After the actual TTL expires, faulty Effect services
return an upstream 404 and refuse cache deletion. The operation must remain missing and retain its last-good
page, rather than turn an authoritative missing response into content. The failure phase is injected; no request
is intercepted and no synthetic successful provider response is supplied. Its one observation includes 31 seconds
of intentional waiting. Successful person-owned writes, private draft reads and delegation/reconciliation remain
deferred; the earlier table's blanket deferral of ordinary public issue/source reads is superseded by this receipt.
Matching VIP document/reviewer reads still need a real matching native VIP fixture; current public issues supply none.

Additional worker workloads check the full chunked history snapshot/reopen, malformed event refusal and exact
repair, startup under an expired scope, a caller bounded while critical startup storage waits, safe HTTP refusal
on failed initialization and explicit next-call recovery. Actual workerd sessions cover participation and
cross-origin sandbox refusal, and public health reads cover all five object classes. The real reply/agent/QuickJS
path checks a streamed answer replaced once after its cell fails, all three closed sandbox tools, and a guest's
List/Start/Read/Cancel of the same public Tour action, including its terminal cancelled state and announcement.
A wiki draft with an unreachable charge waits through the real two-minute policy, fails budget, logs/counts once,
charges zero tokens, retains its reservation and makes exactly one model request. Its single observation is dominated by policy waiting.
A separate ledger workload fills a shared day with ten concurrent calls, checks held/refused admissions, exact
reported, unreported and over-ceiling charges, then reopens and replays settlement without charging twice.
A refused action id also keeps its original journal payload on changed-request reuse, with one conflict counter
and no phantom run, after main's native directory fix.

No new dependency, threshold change, production exclusion, GitHub mutation, live inference or deploy. Product
MockFactory/Mythical tools are named where used; scripted model endpoints measure agent/flow overhead only.
Node KV/memory journal cases establish host contracts, not disk durability. Workerd cases bridge objects by fetch
rather than Alchemy RPC. Every callback checks its result; three samples establish no tail percentile.

The completed f765f8ed source-profile receipt is 2,158/2,321 worker lines (92.98%), 7,281/7,639 src+worker lines
(95.31%). It combines the 80-file/166-test full benchmark run with explicitly retained focused collections on
identical source bytes; it is not a single final full-roster run. The strict all-metric gate remains red.
Main subsequently changed worker, browser/history and SDK auth code, so a fresh rebased receipt follows in the
benchmark wiki and lane report; these numbers remain labeled with their measured base.

`BENCH_SITE_READS=1` probes https://vibelang.smithers.sh without credentials, mutation or model. At
2026-11-10 16:49:26 UTC (08:49 PST), deployment 6a3c8b517c returned issues **503 in 5,643 ms** and wiki
**200 in 2,494 ms**; the content assertion fails and a JSON failure artifact retains only health, fixed routes,
statuses and durations. Health separately observed starting/unreachable objects. This is a deployed finding,
not a proved source-level cause; the lead owns deployment and production investigation.


## Worker source receipt: c5bbf81b, 2026-11-10

Measured product base c5bbf81b37eee13665edf28252aa0a52aafd8878 plus the worker benchmark patch:
**2,201/2,374 worker lines (92.71%)**, **7,355/7,716 src+worker lines (95.32%)**.
The canonical full roster is 7,467/7,846 lines (95.17%); all four unchanged 100% thresholds remain red for 112 files.
This is a source receipt for that base. Main later changed public-read deadlines/cache behavior and stale UI;
the landing compatibility checks do not make these counters a measurement of those later changes.

The full benchmark-only collection passed 82 files / 174 tests, with one opt-in deployed-content skip and one
old Budget RPC benchmark failure after main changed its signature. The corrected API-only collection passed
independently in both timing and coverage modes, including an exact remaining-capacity check after replay.
Both failed-case workerd dumps were quarantined; their invalid call earns no coverage. The canonical Node map
joins the corrected collection by complete source range using the repository's mergeByPosition, before the
standard workerd/Chromium gate. The complete canonical file roster is preserved. The 155 tracked src/worker
sources retain SHA-256 faa49b51e12329689c6fa8cb7e679d4258a6a082b2f4803a29aaa76501f72af2;
the generated wiki matches its preserved browser source map, SHA-256
57798ff1e3204e9cfdf589e89c44f839b3f29a0f80d85783805bf8059416bfd1. No source exclusion or threshold change.
This is a full collection plus an explicitly recorded correction, not one green full-roster invocation.

The draft usage-report fallbacks still need a faulty journal-recovery workload: SDK usageOf can fail
AccountingUnavailable during journal recovery. This continuation has not exercised that boundary. The legacy
budgetDecision.charge helper is superseded by reservations. These lines remain counted; no artificial successful service, direct coverage-only call or deletion was introduced. Person-owned
GitHub paths, a matching native VIP fixture, actual Container execution and the previously named unreachable
routing guards remain as recorded above. A fresh full coverage receipt is still needed for later main changes.



A later focused ledger-fault workload on 868ca298 passed (one executed case, two selector skips).
It closes Budget's negative-hold and lost-reservation guards, checks no writes on either failure and exact
remaining capacity after repair/reopening. Budget and both direct app dependencies are byte-identical to
c5bbf81b (hashes in the module receipt); exact-position module-only union reaches **46/46 Budget lines**,
52/53 statements, 7/7 functions and 56/58 branches. This module result does not relabel the overall receipt
as coverage of later main. No changed module's old counters are reused.


## Fresh compatibility and stale-copy observations: 479f05a3

Typecheck and full unit passed: 242 files passed / three skipped; 2,105 cases passed, one expected failure,
four skipped (exit 0). Nine changed benchmark files passed 22 cases with one opt-in production skip (exit 0).
The final expanded issue/wiki stale-copy journey passed independently in both timing and coverage mode:
one executed case / four selector skips each, exit 0. The earlier wiki-only version also passed both modes.

The stale journey primes two real anonymous caches, waits through the actual 30-second TTL, then injects only
upstream 503 responses. Exact pinned native wiki text/blob, the complete issue snapshot and native issue 1,
the unchanged wiki cursor, the next issue read cursor, and both initial confirmation timestamps are checked.
The two failed attempts before the runner's 19:39 UTC GitHub quota reset failed during native oracle setup;
they are not latency observations. The post-reset workload completed and is retained in JSON.

These local timings use nyc-01 under run-heavy (four cores for the latest checks) with a shared host and WAN.
Setup, complete journeys, correctness checks and policy waits are included except the explicit untimed native
oracles and workerd host bootstrap named above and in each JSON artifact. The cache cases include a 31-second
wait; draft settlement expiry includes the real two-minute retry policy. One cold/TTL/deadline observation
or three warm/ordinary samples establish no tail percentile or isolated cache speedup. Scripted model HTTP/SSE
measures native agent/flow overhead without inference. Node object KV/memory journal cases establish host
contracts; actual workerd cases use native objects and SQLite reached through fetch bridges, not Alchemy RPC.
Every artifact retains the exact callback method, limitations, machine, versions, source revision and samples.
The full coverage percentages remain the c5bbf81b source receipt, separate from these later compatibility checks.


**Integrated benchmark-only receipt (2026-11-10, Codex).** On nyc-01, source `62cbbccd` on main `f765f8ed`, the
full suite passed **83 files / 174 checks**, with public GitHub reads enabled, all production-bundle Chromium
journeys and the separate e2e fault coverage set. Collection ran 16:54:13–17:23:52 UTC (08:54–09:23 PST), two reserved
cores, matching local Chromium and the gatefix build deadline. The strict merged gate exited 1: 109 files missed
at least one metric. Lines: src 5,198/5,318 (97.74%), worker 2,138/2,321 (92.12%), combined 7,336/7,639 (96.03%).
All 256 collected source hashes matched before and after, including the generated wiki. These remain diagnostic
coverage counts with the attribution qualifications above; instrumented timings are never published.

An additive collection at `95de2858` passed **3 files / 13 checks**: web state, DOM views and action proxy/default
host. SHA-256 verified unchanged production bytes before joining with the existing `mergeByPosition` helper.
Only benchmark sources changed. This is one full run plus an additive run, not a single full run of the later
roster. Combined lines: src **5,216/5,318 (98.08%)**, worker **2,138/2,321 (92.12%)**, total **7,354/7,639 (96.27%)**;
108 files still miss at least one strict metric. Exact maps, source hashes and all per-file counts are retained in
the lane report/evidence. No counters, thresholds, exclusions or merge semantics changed.

The additive web corpus submits `/sandbox` and checks the exact start identity and dock command, low-minute warning
retention, exhaustion, new-month clearing and stale response fences. DOM scenes verify GitHub connect/fork/install
recovery controls and settled issue cards with exact linked children, closed state and a blank accessible label.
The action proxy runs every door against product MockActions, cancels unbound calls before selection and checks
settlement, replay, run order, cancellation and missing-run refusal. An embedded ActionDevice without a device
refuses all three sandbox operations. Its two 20 ms waits and scripted mock delays are included and declared; no
proxy CPU-only or container latency is claimed. `github-wiki-public-read` now labels its source.length count
`sourceUtf16Length`; older artifacts named it `sourceBytes` incorrectly and hold UTF-16 code units, not bytes.
The actual source/revision equality assertions are unchanged.

Largest remaining gaps are the actual GitHub mutation hosts (Issues 91 lines, Wiki 46), Container bindings awaiting
spend authorization, the five specification-only functions, the 11 already named browser/Node shape lines awaiting
Will, and the retained error/invariant paths listed per file in the report. Public reads need no write token and
have now run; mutation success remains unmeasured. Defensive history-only Post/Tour and impossible child-flow guards
remain counted rather than being called solely to satisfy a counter. The 100% requirement remains open.


**Explicit surface sessions and plain output (2026-11-10, Codex).** A further backend corpus rejects malformed JSON,
invalid shape, wrong-origin and non-session explicit credentials with the exact typed error, then builds the real
live layers after a real local workerd health request using a valid-shaped fixture session. A closed loopback port
must yield the exact unreachable failure. Workerd startup and temporary-directory creation occur outside timing;
layer construction, validation, real loopback and failed connection are included. Health does not authenticate the
fixture cookie, so this is not sign-in authority evidence. No provider write or successful HTTP double is used.

A plain command corpus executes the actual product mock backend: ask and settled nonempty read, Plan/Start/Note and
full history output, sandbox start/replay/stop with exact identity/generation and whole-minute display with fractional usage. It checks
literal plain text through public command render handlers. Fresh settings, layers, durable flows and scripted reply
delays are included; process/IPC startup and actual Containers are outside this timing. Three unwarmed journeys;
these are command execution/formatting costs, not formatting CPU cost. The issue DOM corpus additionally checks a
generic failure exposes its alert and no unrelated Fork or Install action. New observations and coverage receipts
are recorded separately from the earlier frozen maps.
