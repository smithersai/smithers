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

- Fault arms that need a faulty service injected in the browser (media, tour events, sandbox, actions, post and tour refusals, roles and events streams: lines 320, 425, 451, 503, 510, 761, 895, 909, 1231, 1258, 1304, 1365 as of `7803d917`). The fault-injection pages exist only in the `e2e` build; the timing build is the production bundle. **Decided 2026-11-10 (the lead):** timing benchmarks stay on the production bundle, so their numbers describe what people run. Fault-path coverage runs against the `e2e` build as a separately named set, `bench/browser-faults.spec.ts` (`bench/playwright-faults.config.ts`, built into `dist-e2e/`, run by `bench/browser.bench.vibe` as `chromium-faults`). Its Chromium counts merge into this gate; its artifacts, `fault-coverage-<name>`, record build `e2e-fault-coverage` and the steps that passed, never a duration, and no timing from it is quoted. Eight workloads put one faulty Effect service under the real app (`test/support/FaultyFactory.vibe` faults `refuse`, `tour-refuse`, `disconnect`, `tour-events`, `tour-control`, `end-tour-unavailable`, `stale`, `sandbox-read`, `sandbox-start`, `roles`; `test/support/FaultyActions.vibe`; the media page's unloadable image) and check the screen the fault and its recovery leave; nothing intercepts a request.
  **Defect found by this set and fixed:** a failed sandbox start, stop or command lost its alert and Retry within a second, because the open pane's one-second read ran `loadedSandbox`, which ends any operation and clears its failure. The pane's read now runs `polledSandbox` and `polledFailure` (`src/web/paneDecision.vibe`, verified), which leave an operation's wait or failure alone; regression `test/sandboxFailure.runtime.test.vibe`.
- The ⌘K `/mock` and `/live` switch (783–784, 1385–1387) reloads the page itself, and V8 drops a document's counts on reload. Covered since 2026-11-10 without touching the request: in coverage mode each document pauses in its own `beforeunload` while the collector dumps (783–784, 1385–1386, `command-k-mock-switch`). Line 1387 runs after `beforeunload`, and the new document's commit ends any later pause (`pagehide` never pauses), so Node covers it: `bench/web-commands.bench.vibe` runs `SwitchMode` in happy-dom (`web-mode-switch-command`).
- Escape during a pending wiki Save keeps the editor and request (`none`, line 611 at `7803d917`). The `web-wiki-state` corpus asserts unchanged model identity and no emitted command.
- Fourteen lines run in Chromium but the merge cannot credit them, because the bundle maps them to a different statement range than Node does, or to none. The merge does not guess across shapes. Re-measured on 2026-11-11 and run in Node instead, all but one now count ("Source-map lines in Node" below). Measured on the `c5bbf81b` snapshot, whose text at these lines is unchanged on `5e37278e`, by remapping its retained Chromium dumps with the merge's own conversion and listing each line's statement ranges (start column, Chromium vs Node):

  | Line | Chromium | Node | Kind |
  | --- | ---: | ---: | --- |
  | `src/web/main.vibe` 948 | 8 | 18 | declarator vs initializer |
  | `src/web/main.vibe` 1123, 1133 | 14 | 21 | declarator vs initializer |
  | `src/core/MockFactory.vibe` 338 | 16 | 26 | declarator vs initializer |
  | `src/web/markdown.vibe` 114 | 12 | 20 | declarator vs initializer |
  | `src/web/roleView.vibe` 34, 36 | 39 | 38 | inside vs at the opening parenthesis |
  | `src/web/main.vibe` 1121, 1122, 1132, 1272 | none | 21–24 | no bundle statement |
  | `src/web/historyApp.vibe` 476 | none | 60 | no bundle statement |
  | `src/web/theatre.vibe` 59 | none | 19 | no bundle statement |
  | `src/core/MockFactory.vibe` 454 | none | 18 | no bundle statement |

  An earlier measurement named `main.vibe` 946, 1119, 1120, 1130, 1131 and 1270. Their Chromium and Node ranges now match, or Node runs them, so they are covered. `historyApp.vibe` 476, `theatre.vibe` 59 and `MockFactory.vibe` 454 were not named before; each follows a line Chromium ran, with no branch between.

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

**Finding: an unreachable GitHub now holds a signed-in issue read 12 s (2026-11-10, lane vl-bench2).** After `19d7afac`
raised the issue read's engine deadline to 12 s and its Accounts boundary to 13 s (0030, cold reads), the same
workload's issue read retries GitHub's immediate transport failure until the 12 s deadline: one sample took 12,091 ms,
against about 5 s before. The wiki read still answers at its 5 s deadline. The benchmark's former shared 10 s bound
failed; it now checks each route's own 0030 boundary, issues 13 s and wiki 6 s. Answering a connection failure before the
deadline is a read-policy change for 0030's owner, so this lane records it and changes no product code.

**Receipt (2026-11-10, lane vl-bench2, `f52ffeba`).** `pnpm bench:coverage`: 70/70 files and 148/148 tests pass; the
strict per-file gate exits 1 for 102 files. Merged benchmark-only coverage is 6,989/7,576 `src/` + `worker/` lines
(92.25%) and 2,010/2,299 `worker/` lines (87.43%). Accounts went from 82 uncovered lines to 8 (the read-queue
deadline, participation and a cross-origin sandbox principal). Issues and Wiki keep 130 and 59, almost all GitHub
success paths.

**Receipt (2026-11-10, lane vl-bench2, `4e4241d4`).** `pnpm bench:coverage` on a 4-vCPU box through `run-heavy`,
with `node bench/merge-coverage.ts` run even after a failed workload: 93/96 files and 196/204 tests pass, 2 files and 7
tests skipped (opt-in). The single failure is `bench/scripts.bench.vibe`, the box image's git 2.39 named under
"Off-host runs"; it passes on nyc-01's git 2.43. The merge unions 167 files (104 with workerd evidence, 98 with
Chromium) and exits 1 on the strict gate. Statement-start lines from the merged map: `worker/` 2,157/2,380 (90.63%),
`src/` 5,261/5,379, `src/` + `worker/` 7,418/7,759 (95.61%). Opt-in GitHub workloads did not run in this receipt, so
`worker/PublicReads.vibe:38-39` (cache write and eviction failures) count as uncovered here, although
`public-cache-eviction-failure` executes the eviction failure when `BENCH_PUBLIC_GITHUB=1`.

The remaining `worker/` lines, by reason:

| Lines | Reason |
|---|---|
| `Issues.vibe` 131, `Wiki.vibe` 59 | A signed-in person's delegated GitHub reads and writes: owner-only (GitHub sign-in). |
| `apiObjects.vibe` 252-254 | An agent action run's wiki draft for its owner. Recorded here as owner-only; wrong, now `api-objects-maintainer-action-run` (below). |
| `SandboxAccounts.vibe` 7, `SandboxMachine.vibe` 3 | Container bindings, present only with a sandbox image: real Cloudflare Containers (VL-35). |
| `WikiDraft.vibe`, `VipDraft.vibe`, `SpecificationReviewers.vibe` 2 each | Usage fallbacks; reachable through a failing journal read, now `draft-journal-fault` (below). |
| `Reply.vibe` 369-370 | A non-busy `StartReply` refusal: a reply to a post the store no longer holds, an empty id or a full sequence. Now `reply-lost-post` (below). |
| `HistoryActions.vibe` 26, 39, 44; `Objects.vibe` 114, 250-251; `apiObjects.vibe` 122 | Default arms, default parameters and routing defects no production caller reaches. Decided below: deleted, except `Objects.vibe` 250-251; `apiObjects.vibe` 122 is owner-only. |
| `budgetDecision.vibe` 60-61 | The superseded `charge` helper: deleted (below). |

`worker/Tour.vibe`'s `spoken` (line 6 above) had no production caller and is deleted on main by `5467d0b8`, as
production code the product never runs.

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

**Recorded GitHub writes (2026-11-10, vl-record-replay).** `bench/issues-delegated.bench.vibe` and
`bench/wiki-delegated.bench.vibe` replay real GitHub's recorded answers for `codeplanesmithers/smithers-vibelang-e2e`
(`test/recordings/issues.json`, `wiki.json`; [0032](0032-record-replay.md)) instead of the in-memory GitHub. Each
callback runs the journey the test recorded through smithers.sh's real delegation host and checks every write's
visible result and the person's write count. They always replay and never reach GitHub; GitHub latency and rate
limits are not measured.

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

The draft usage-report fallbacks (`worker/WikiDraft.vibe:62`, `worker/VipDraft.vibe:60`,
`worker/SpecificationReviewers.vibe:53`) were recorded here as unreachable in production (lane vl-bench2, 2026-11-10).
That was wrong; see "Defensive lines decided" below: on `CloudflareRuntime`, a failing durable journal read makes
`usageOf` fail, and `bench/draft-journal-fault.bench.vibe` now runs all three. The legacy budgetDecision.charge
helper is superseded by reservations and is deleted. These lines remain counted; no artificial successful service, direct coverage-only call or deletion was introduced. Person-owned
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


**Daily reservation corpus after main's budget change (2026-11-10, Codex).** A real Budget over the object-storage
ledger admits exactly one of two concurrent seven-token ceilings under a ten-token cap, retains one hold on replay,
settles a reported two once, charges seven for an unusable report, refuses excess admission and records a one-token
overshoot when a one-token call reports two. Exact receipts [2,7,2], totals [11,0,1] and zero holds are asserted.
A second corpus injects four faulty Ledger reads and checks fail-closed/no write, then replays a seeded charged
receipt with a retained hold and requires release without another charge. These use real semaphore/ledger/accounting
code over the Node KV adapter, three unwarmed journeys each. No provider, real corruption, eviction or UTC rollover
claim; the actual Worker companion uses the same named reservation/settlement API over real local RPC.

After main's reservation change, `worker/budgetDecision.vibe`'s legacy `charge` function (lines 59–62 at c5bbf81b)
had no src/worker callers. No direct invocation was added merely to credit this unused helper; lane vl-coverage2
deleted it on 2026-11-10 (decision 0016, "Dead budget charge").
It is an additional retained legacy/proof boundary, separate from the already named browser/Node source-map lines.


**Complete current receipt and additive reply recovery (2026-11-10, Codex).** At `de20c189` on `c5bbf81b`, all
87 benchmark files / 182 checks passed in the 18:54–19:20 UTC collection. All 265 input hashes matched. Src lines
5,251/5,342 (98.30%), worker 2,178/2,374 (91.74%), total 7,429/7,716 (96.28%); 111/164 files still miss at least
one strict metric. This later source roster adds 77 runtime lines, so the percentage is not directly comparable
to the older base. Raw maps, exact sources and every per-file count are in the lane report's retained evidence.

Further reply corpora run the actual Reply flow, agent/QuickJS and sequencer over the Node KV/memory engine with
the local deterministic HTTP/SSE model. A cell whose preview says First then fails must be replaced by exactly
Second, with one restart, one finish, two model calls, thirty reported tokens and no hold. A local 402 response
must settle the credit failure, one request and the configured ceiling charge. The tag boundary additionally
handles a native revoked Proxy and other malformed inputs without propagating its getter exception. Three
unwarmed complete corpora; initialization/serving/assertions included, no inference/WAN latency claim.

`fault-coverage-draft-spend` and `fault-coverage-vip-draft-spend` are separately named and **counts only**. The VIP workload repeats the unreachable model-call charge for a VIP draft (`worker/VipDraft.vibe`): `budget`, one model request, one vip/unreachable warning, zero charges and the call's retained reservation. BENCH_COVERAGE=1 or BENCH_FAULTS=1 enables
one wiki draft whose real Budget admits but whose injected Spend cannot record its model call's charge
(`model/<id>`; the run's own release reaches the real budget). The call meter's ledger retries must exhaust within
the four-minute test deadline. Check one model request, two admissions (the run's and the call's), multiple
settlement attempts, the exact budget refusal, one fixed wiki/unreachable warning, zero
charges and the original retained ceiling. It records no duration; none is quoted. The runtime is Node with local
HTTP model and memory/KV storage, not the browser e2e fault build. New hits join only against unchanged source bytes.


**Poster-bound specification reviews (2026-11-10, Codex).** The product mock agent requests all four named
reviewers from the fixture maintainer's post. Exact LGTM/A/A/A-/A- replies, revision two, matching journal records,
four sequence advances and unchanged specification text are checked. This exercises the actual poster-bound read
and registered mock review flows. Three fresh unwarmed four-review journeys include setup, scripted delays and
assertions. It runs no actual Codex/Claude/provider process and performs no GitHub write; real review inference is
outside this measurement. Counts are collected additively only while the production source hashes still match.


**Combined receipt after two additive collections, 2026-11-10.** The full `de20c189` run passed 87 files / 182
checks. The reply/fault add-on passed 2 files / 3 checks; the mock specification add-on passed 1 file / 1 check.
All 265 original input hashes still match after both collections. The existing position merge joins their real
hits: src 5,252/5,342 (98.32%), worker 2,183/2,374 (91.95%), total **7,435/7,716 (96.36%)**. This combines one
complete run and two additive runs; it is not a single 90-file execution. The strict four-metric goal remains open
in 111 files. No line/threshold/merge rule changed. Later documentation regeneration is outside this frozen receipt.

Additional completed normal observations, nyc-01, Node 26.5.0, two reserved cores/shared host, three unwarmed
callbacks. Min/median/max milliseconds; methods below, no tail-percentile claim. Each raw artifact keeps its own
source revision, machine and toolchain.

| Workload | Callbacks | Min ms | Median ms | Max ms | Artifact |
| --- | ---: | ---: | ---: | ---: | --- |
| `reply-agent-recovery` | 3 | 89.870 | 118.780 | 314.408 | `2026-11-10T19-26-06.552Z-reply-agent-recovery.json` |
| `reply-safe-failure-tags` | 3 | 0.124 | 0.147 | 0.420 | `2026-11-10T19-26-06.706Z-reply-safe-failure-tags.json` |
| `mock-agent-specification` | 3 | 280.045 | 293.491 | 419.984 | `2026-11-10T19-41-04.373Z-mock-agent-specification.json` |

Reply recovery is a two-world corpus through the real memory engine, agent/QuickJS and sequencer over Node KV,
with deterministic HTTP/SSE model responses: preview replacement plus a provider-credit failure and exact reported
or ceiling settlement. Setup, serving, metrics and assertions are included; actual inference/WAN are excluded.
Safe tags include five classifications and native revoked-Proxy allocation. Mock specification review includes
all four product fixture reviewers, exact literal replies/journal changes and scripted delays. These are whole
corpora, not per-token/individual-call latency. Initialization/shared-host/cold-sample variation remains included.

The separately named draft fault artifact contains **counts only**: 12 settlement attempts, one admission, one
model request, one warning, zero charged tokens and the retained 327,680-token ceiling in the instrumented sample.
Its approximately two-minute policy is a configured deadline; no observed fault duration is published.

## Delegated issue and wiki writes (lane vl-bench, 2026-11-10)

`bench/issues-delegated.bench.vibe` and `bench/wiki-delegated.bench.vibe` run `worker/Issues.vibe` and
`worker/Wiki.vibe`'s durable flows over Node SQLite object storage, with every GitHub call going through smithers.sh's
real per-person connection host (`fuzz/delegated.vibe`) to the in-memory GitHub over the real client protocol
(`fuzz/issues-node-fake.vibe`). That is the seam the unit coverage tests use; nothing intercepts a request. One
maintainer journey per callback, on a fresh store and GitHub:

| Workload | Journey | Checked every callback |
| --- | --- | --- |
| `issues-delegated-writes` | new, split, comment, link, commit to the agent, uncommit, VIP proposal, accept, decline | selected number, parent, note, task, assignee, labels, VIP state and review URL, approver, closed state |
| `wiki-delegated-edit` | read, drafted edit, save, second proposal | page source, draft and its kept copy, both review URLs, the kept draft cleared after save |

Each fails when its product write is removed: decline without `issue.close` reads `"open"`; a save that keeps the
draft fails the cleared check. Limitations: no api.github.com latency, rate limit or network; SQLite, not a Durable
Object; the wiki writer is a deterministic `WikiWriter` service, not the model. Live writes remain the opt-in
`GITHUB_TEST_TOKEN` tests. On nyc-01 at 22:10 UTC (load about 21), nine Issues flows took 3,856 ms mean (about 430 ms
each) and four wiki flows 815 ms (about 200 ms each), three samples each. Every Issues write ends by re-reading the
issue list, the selected issue's timeline and comments and, for a VIP, its reviews (GitHub is the truth, 0165); that
re-read dominates. It is a recorded finding, not a fix; this benchmark is the regression for any change that narrows it.

**Measured benchmark coverage at `c3a8187b` (2026-11-10, 23:12 to 23:53 UTC, nyc-01, load 21 to 52).** One complete
`pnpm bench:coverage`: 98 files passed, 2 skipped; 203 tests passed, 7 skipped; Vitest, 111 workerd-evidenced and 105
Chromium-evidenced files merged. It ran on nyc-01 with `run-heavy --overflow host` because the box image's git 2.39
fails `bench/scripts.bench.vibe`, and `bench:coverage` merges only after every workload passes. Lines of `src/` and
`worker/`: **7,785/7,936 (98.10%)**, src 5,447/5,554 (98.07%), worker 2,338/2,382 (98.15%), up from 7,435/7,716
(96.36%) at c5bbf81b. `worker/Issues.vibe` went from 91 uncovered lines to 6, `worker/Wiki.vibe` from 46 to 5. The
strict all-metric gate still fails in 121 files.

The largest remaining file, `src/core/issueGraphDecision.vibe` (26/46, new from the proof lanes), is mostly
specification: `issueAncestorAt` (25-30) and the functions after `issuesAfter` run only in proofs, and VibeLang has no
spec-only function (`~/vl/vibelang-bugs/spec-only-function/`); they stay counted. `src/web/markdown.vibe` fell from 104/106 to 97/106 with no
change to the file, because its tables and continued list items were credited only by whichever wiki pages the view
workloads rendered; `markdown-compile` now renders one fixed document with every block the compiler knows.

## Defensive lines decided (lane vl-bench2, 2026-11-10)

The lead ruled as owner (AGENTS.md, no dead code): code that cannot run in production is deleted, with its tests
adjusted; a guard for a real invariant that a faulty injected service can break gets a workload that breaks it. No
threshold changed and no line is excluded.

| Lines | Decision | Why |
|---|---|---|
| `worker/budgetDecision.vibe` `charge`, `Charge` | Deleted | No caller since reservations replaced it (`reserve`, `settle`). 0018's inventory refreshed; no mutation targeted it. |
| `worker/HistoryActions.vibe` default arms of `intentOf` and `poll` | Deleted | `ActionRuns` sends only history and sandbox runs to this host. `start` and `receipt` now take a prepared `HistoryInvocation` (`src/actions/execution.vibe`, `isHistory`), so a post or tour cannot reach them. `ActionRuns.start` routes by the prepared invocation. Its alarm prepares the stored request only once the run settled, to read the receipt: a request stored by an older deployment or before a crash may no longer prepare (fuzz `actions/run-hosts`, regression `b924c254907df2e4`). |
| `worker/HistoryActions.vibe` default `admit` | Deleted | Optional, passed to the SDK's own optional `canStart`, as `Objects.executionHost` already does. |
| `worker/Objects.vibe` `toursOf`'s no-op `wake` default | Deleted | Required now. Every composition that provides Tours passes the object's one real waker (`tourWaker`) instead of a silent no-op; tests whose tours never wake pass `() => Effect.void`. |
| `worker/WikiDraft.vibe`, `worker/VipDraft.vibe`, `worker/SpecificationReviewers.vibe` usage fallbacks | Kept; `draft-journal-fault` | The earlier "unreachable" finding was wrong. On `CloudflareRuntime` over object storage, a failing journal entry read fails the agent and then `usageOf` (`BudgetAccountingUnavailable`), as `test/writerAccounting.coverage.test.vibe` already showed. The benchmark injects a faulty storage service (`fuzz/faulty-store.ts`) and requires the failure answer, zero model calls, one `vibelang.budget.usage` warning with outcome `unavailable`, the whole ceiling charged once and the reservation freed. Red check: a fallback that charges zero fails it (spent 0, expected 327,680). |
| `worker/Reply.vibe` 369-370 | Kept; `reply-lost-post` | `StartReply` refuses a reply to a post the conversation does not hold. A conversation store restored from an older copy answers exactly that to a reply execution that outlived it. The benchmark runs the production reply registration over the real sequencer and such a store: answer null, one `refused` log, no event written, no budget, history or model call. Red check: composing anyway fails it. |
| `worker/apiObjects.vibe` 122, 252-254 | Covered; `api-objects-maintainer-action-run` | Not defensive and not owner-only: `ActionIdentity.fromAccounts` asks `role` for an owner the accounts allow to act, and the run's wiki draft calls the owner's draft RPC. The earlier claim that a workerd owner gains a role only by GitHub sign-in was wrong: with sign-in configured, `VIBELANG_INITIAL_MAINTAINER_ID` grants the initial maintainer at the accounts object's start. The benchmark starts a `vibelang/Post` run with trusted props naming owner 1 on `test/workerd/bench-api.vibe` and requires History Start's `unknown` (a viewer gets `forbidden`) and the writer's `draft` refusal from the owner's draft. Red check: an owner's draft refused as forbidden fails it. |
| `worker/SandboxAccounts.vibe` 7, `worker/SandboxMachine.vibe` 3 | Counted; live only | They bind the account and machine Durable Objects to a Container image, so they run only in a deployed stage with Containers. The Container recording (d7d3245c) holds the probe's HTTP exchanges, so `sandbox-live-replay` replays the client side and cannot run them; the lines ran when `pnpm test:sandboxes-live` recorded it on the vl-test stage. Benchmark coverage of a deployed Worker is not collected, so they stay uncovered and counted. |
| `worker/Objects.vibe` 250-251 (`unrouted`) | Kept, uncovered | `ExecutionObject.make` requires a router; reply and tour executions start no child. Only an engine store holding a child route for one reaches it. A workload would have to forge the engine store's routing rows, coupling a benchmark to SDK internals. The fix belongs in `@smthrs/platform-cloudflare`: an optional router for objects whose flows start no child, with its defect covered by the SDK's own tests. Proposed, not done in this lane. |

**Receipt (lane vl-bench2, 2026-11-11 03:00 to 03:58 UTC).** `pnpm bench:coverage` on a 4-vCPU `playwright` box
through `run-heavy` (`BENCH_REVISION` set, Chromium installed in the job), merge run regardless of workload exit, at
`5ec6dd4d` (main `d99515a1` plus this lane's change before the shared `tourWaker`). 98 files passed, 3 failed, 2
skipped; 203 tests passed, 3 failed, 7 skipped; 180 files merged (113 workerd, 106 Chromium). The failures:
`bench/scripts.bench.vibe` (box git 2.39, "Off-host runs"), and `sandbox-objects` and `sandbox-faults`, whose
expectations predated `e50b2cc2` (sandbox refusals name their cause); both now expect the named reasons and pass. The
box returns only stdout, so totals are not stated; `worker/` has 71 uncovered lines in 8 files:

| File | Uncovered | Reason |
|---|---|---|
| `sandboxProbeFetch.vibe`, `SandboxProbe.vibe` | 37, 7 | New probe Worker for the live Container stage (lane vl-containers-live); waits on its recording. |
| `SandboxAccounts.vibe`, `SandboxMachine.vibe` | 7, 3 | Container bindings (VL-35); wait on `test/recordings/sandboxes-live.json`. |
| `Issues.vibe` 151, 254, 263-266 | 6 | A stale signed-in read, an unsupported op, the retry after a refused connection: fault paths of the delegated benches (lanes vl-bench, vl-record-replay). |
| `Wiki.vibe` 105-106, 177-178, 196 | 5 | A connection lost mid-edit, the same retry, a request body that times out: the same lanes' fault paths. |
| `Objects.vibe` 250-251 | 2 | `unrouted`, above. (285 and 331 were the waker lambdas this change first inlined; one `tourWaker` replaced them.) |
| `PublicReads.vibe` 38-39 | 2 | Opt-in `BENCH_PUBLIC_GITHUB`, as before. |

New workloads: `draft-journal-fault`, `reply-lost-post`, `api-objects-maintainer-action-run` (wiki/benchmarks.md).

## Source-map lines in Node, sign-in faults (lane vl-bench, 2026-11-11)

**Re-measured at `040c5684`.** One `bench:coverage` on a 4-vCPU box, 04:13 to 05:12 UTC. Three Vitest files failed and
the maps were merged anyway: `sandbox-faults` and `sandbox-objects` still expect sandbox refusals without the
`reason` that `e50b2cc2` added (lane vl-bench2 holds the fix), and `scripts.bench.vibe` needs git 2.41 or later, which
the box image lacks. Lines of `src/` and `worker/`: **7,866/8,063 (97.56%)**, src 5,508/5,620, worker 2,358/2,443. The
worker denominator grew with the new probe Worker (`worker/sandboxProbeFetch.vibe`, 37 lines uncovered).

Of the fourteen lines above, three are credited now: `main.vibe` 948, `markdown.vibe` 114 (through
`markdown-compile`) and `historyApp.vibe` 476. The other eleven fall into two shapes, read from the box's Chromium dumps
with the merge's own conversion:

| Shape | Lines | Node vs Chromium |
| --- | --- | --- |
| Same statement, other start column | `main.vibe` 1123, 1133; `roleView.vibe` 34, 36; `MockFactory.vibe` 349 | initializer vs declarator; at vs inside the opening parenthesis |
| No bundle statement | `main.vibe` 1121, 1122, 1132, 1272; `theatre.vibe` 59; `MockFactory.vibe` 465 | Rolldown joins consecutive declarations or inlines a single-use constant |

The e2e report answers both shapes with the build's own structure (0016, "Build structure"), because the browser is
its only runtime. The benchmark merge keeps Node's structure for a file Node also runs, so Chromium still credits it
by identical start only. Instead of a rule that guesses across shapes, the lines now run in Node:
`bench/web-dom.bench.vibe` embeds the actual app (Foldkit runtime, update, view and the shipped subscriptions) in
happy-dom over `MockFactory` and `MockActions`.

| Workload | Journey | Checked every sample |
| --- | --- | --- |
| `web-wiki-links` | Ctrl-click a wiki link, click it, ask the agent to open the designs wiki, ask it to draft a roadmap edit, click the answer's Review link | Ctrl-click ignored; pane follows the link; pane at `designs/index`; editor on the roadmap holding the page plus the request as its note |
| `web-account-menu-keys` | open the account menu, ArrowDown, ArrowUp, ArrowUp, ArrowDown, Enter | focused item after each key; menu still open |
| `web-tour-keys` | Learn more, Tab, Shift+Tab | tour events arrive; first control, then a wrap to the last; first stop |
| `web-wiki-state` (extended) | a retried Save; a second page's editor after a save | same key under a fresh recovery key; the page's embedded source |
| `signin-device-faults` | a waited sign-in the person authorizes; a device grant and a sign-out whose factory refuses connections; a pending-flow file that can't be written | exact sentences; the pending flow kept; the session forgotten |

Messages for a person's other steps (choosing an identity, typing a post) enter through one test channel
(`bench/dom-input.ts`); no product subscription, command or service is replaced. Limitations: happy-dom has no layout,
paint or speech; synthetic mouse and keyboard events stand in for a pointer and a keyboard; the mock agent's 25 ms
chunk delays are included; sign-in's identity provider is the local fixture and "unreachable" is a refused loopback
connection. Each workload fails when its product behavior is removed: a wiki-link selector that matches nothing reads
`/wiki/index` where `/wiki/rulings` was expected, and an ArrowDown that focuses People times out waiting for Sign out.

A coverage run of only the three changed files credits, in Node, 21 of the 22 lines this range aimed at: `main.vibe`
1121-1123, 1132, 1133, 1272, 1351; `roleView.vibe` 34, 36; `theatre.vibe` 59; `MockFactory.vibe` 465; `wiki.vibe` 31;
`wikiEditorDecision.vibe` 103; `signin.vibe` 86, 131, 138, 196. `MockFactory.vibe` 349, the mock's tour control, led to a product defect, below.

**Defect found and fixed: a refused tour control showed "Connection lost".** The sequencer refuses Pause, Resume and
a seek until the walkthrough's first step is driven (`not-replying`, `src/core/decide.vibe`), but the theatre's
controls are on screen as soon as the tour's first event arrives. `ControlTour` turned every failure into
`FailedTourEvents`, so a Pause (or Space) in that window showed "Connection lost" while the tour kept playing. In the
mock the window is about 50 ms; against the live Worker it is the drive's round trip. A `Refused` answer now leaves
the controls showing the tour as it is (`src/web/main.vibe`); only an unreachable agent or a backend without controls
reports a lost connection. Regression: `test/mainCommands.coverage.test.vibe` (failed first) and `web-tour-pause`,
which fails with `early: 'Connection lost'` when the fix is reverted. That workload's second Space pauses the tour, so
Node now runs `MockFactory.vibe` 349.

**Remaining in `src/web`, `src/core` and `src/surfaces`** at `040c5684` with this range (61 lines):

- Specification-only functions, waiting on lane vl-ghost-functions, which moves them out of runtime code (35):
  `issueGraphDecision.vibe` 20, `flowDecision.vibe` 135-139 and 203-206, `core/replayDecision.vibe` 22, 30, 40,
  `sequencerDecision.vibe` 19, 20, `issueDecision.vibe` 208.
- Sandbox paths measured while `sandbox-objects` and `sandbox-faults` failed before reaching them (6):
  `machineDecision.vibe` 29, 36, 102, `sandboxHost.vibe` 198, 199, `sandboxMock.vibe` 38. Re-measure after
  vl-bench2's fix; Container paths beyond these use the real-Container recording once it is on main.
- Not yet benchmarked (20): all but two now run, below. `startup.vibe` 38 and 88 stay: they answer a browser whose
  storage throws on access (storage blocked, or a sandboxed frame); no workload blocks storage yet.

**Small paths, Factory refusals, the Container replay (2026-11-11).** Each line in the table ran in a coverage run of
only the new files (Node, nyc-01, 07:41 to 08:08 UTC):

| Workload | Journey | Lines | Checked every sample |
| --- | --- | --- | --- |
| `web-tour-pause` | Learn more; Space as soon as the first event arrives; Space once the walkthrough runs | `MockFactory.vibe` 349 | the early press shows no error and leaves the tour playing; the second pauses it |
| `src-edge-decisions` | the issue fixture's engine errors, session cookie choice, a link above the wiki root, a decision lookup miss, a lone surrogate's conversation path, not-deployed and write-failure wording, Markdown with no resolver | `issueFixtureDecision.vibe` 54, 60; `protocolDecision.vibe` 117; `wikiLinks.vibe` 14; `wikiPageDecision.vibe` 85; `wire.vibe` 52; `backend.vibe` 32; `commandDecision.vibe` 145; `markdown.vibe` 174 | values written out in the file |
| `wiki-proposal-restart` | propose, rebuild the engine over the same store, retry the key, change the text under it | `WikiFactory.vibe` 63, 64 | same review link; `conflict`, unwritten; one stored proposal |
| `docs-open-flow` | `vibelang/docs/open` on the flow engine, an opened and an unknown page | `flows.vibe` 477 | the flow answers what its step answered |
| `cli-sandbox-run-text` | start a sandbox, `sandbox-run` with no operation id, as text | `commands.vibe` 268 | output `hi` |
| `client-local-answers` | `LiveAccounts.choose`; history forced to mock | `LiveAccounts.vibe` 32; `historyBackend.vibe` 34 | `AccountUnavailable`; mode `mock` twice |
| `live-factory-refusals` | post, open wiki, tour control, tour and end tour answered by a 409 refusal body | `LiveFactory.vibe` 51 | each fails as `Refused busy` |

`LiveFactory.vibe` 120, a terminal command's answer, runs in `sandbox-live-replay` (lane vl-bench2's replay of the
real Container recording), which this lane measured before that workload landed and dropped its own copy. Non-tautology
check: with the tour fix reverted and `wikiLinks.vibe`'s `out.push("..")` removed, `web-tour-pause` and
`src-edge-decisions` both fail; sources restored. Limitations: the decisions are pure functions timed alone; the docs
step and the factory refusal are injected services (a deterministic step, an Effect `HttpClient` answering 409), not
the Worker; `cli-sandbox-run-text` runs the command in process because one mock CLI process can't hold a running
sandbox across two invocations; `web-tour-pause`'s early press must land before the mock drives step 1, and a sample
where it lands later fails rather than passing.

**Re-measured at `2d7bb99a`** (this range on `166e444b`), one `bench:coverage` on a 4-vCPU box, 07:55 to 08:29 UTC.
The same three Vitest files failed as at `040c5684` (`sandbox-faults` and `sandbox-objects`, held by lane vl-bench2;
`scripts.bench.vibe`, the box's git 2.39) and the maps were merged anyway. Lines of `src/` and `worker/`:
**7,910/8,074 (97.97%)**, src 5,551/5,631 (98.58%), worker 2,359/2,443. This lane's scope:

| Directory | Lines | Uncovered |
| --- | ---: | --- |
| `src/surfaces` | 507/507 | none |
| `src/web` | 1,969/1,973 | `startup.vibe` 38, 88 (storage that throws); `issueDecision.vibe` 208 (specification only); `markdown.vibe` 174 (below) |
| `src/core` | 1,990/2,032 | specification only, waiting on lane vl-ghost-functions (34): `issueGraphDecision.vibe` 20, `flowDecision.vibe` 9, `replayDecision.vibe` 3, `sequencerDecision.vibe` 2; sandbox paths behind vl-bench2's failing files (6): `machineDecision.vibe` 29, 36, 102, `sandboxHost.vibe` 198, 199, `sandboxMock.vibe` 38; `LiveAccounts.vibe` 32 (since covered); `wikiLinks.vibe` 14 (below) |

`LiveAccounts.vibe` 32 is `signInAgent`, not `choose` (31) as the table above first read; `client-local-answers` now
calls both. **Finding, coverage merge:** `wikiLinks.vibe` 14 and `markdown.vibe` 174 run in `src-edge-decisions` and
count in a Vitest run of that file alone (2 hits and 1), but read 0 in the full merged map, where the rest of the same
workload counts (`wire.vibe` 52, `protocolDecision.vibe` 117). Both modules also run in the emitted wiki script
(`scripts/wiki.vibe`, through `pnpm wiki:build` and `scripts.bench.vibe`), so the full run's subprocess coverage of
the same source is the likely cause; not diagnosed. Per-file counts and merged maps:
`~/vl/vl-bench-evidence/2026-11-11-claude-resume5/` on nyc-01.

**Sandbox and storage paths, and a merge that lost hits (2026-11-11).**

*The merge loss was a provider defect, now fixed.* Vitest's V8 provider merges raw V8 coverage by script URL before
it maps anything back to source. `bench/browser.bench.vibe` starts Playwright, whose web server runs `pnpm wiki:build`
(`node --import=vibelang/register scripts/wiki.vibe`). That child inherits the worker's `NODE_V8_COVERAGE` and dumps
`src/core/wikiLinks.vibe` and `src/web/markdown.vibe` under the same URLs the worker imported through Vite. The
loader's code is not Vite's, so its offsets landed on the wrong ranges of the worker's script, and lines the worker ran
read 0. The repository's `@vitest/coverage-v8` patch now keeps a child's script only when Node ran the file as written
(its top-level range spans exactly the file's length) and counts the rest under `DEBUG=vitest:coverage` ("Dropped N
child-process scripts a module loader rewrote"). A native-loaded child was never credited correctly (0016,
`~/vl/vibelang-bugs/coverage-native-loader/`); now it can't take a worker's hits either. Regression:
`test/coverageProvider.test.vibe`, "keeps a worker's hits when a native-loader child runs the same source", which read
0 for the worker's line before the fix. The unit gate (`pnpm test:coverage`) after the fix lists the same files below
100% as main's runs that morning, plus `historyView.vibe` 59, new in main's `9164011d`.

*Sandbox lines.* With lane vl-bench2's fixes, `sandbox-objects` and `sandbox-faults` pass, and `machineDecision.vibe`
29, 36, 102 count. `sandboxHost.vibe` 198-199 never ran: the invalid clock in `sandbox-faults` fails in `load()`
(`emergency` from line 88), before the meter. New workloads:

| Workload | Journey | Lines | Checked every sample |
| --- | --- | --- | --- |
| `sandbox-meter-fault` | start a sandbox; use at 2^53 - 1 ms; one second; the alarm's `tick` | `sandboxHost.vibe` 198, 199 | `meter-overflow`; one stop; ledger stopped; `meterFailure` recorded |
| `sandbox-mock-alarm` | the product mock: start, 60 TestClock seconds, the mock alarm's meter | `sandboxMock.vibe` 38 | a meter logged after start returned |
| `startup-storage-refused` | the real page behind a Window whose storages throw, at `/` and `/?agent=mock` | `startup.vibe` 38, 88 | fresh tour session, sound off, first-visit tour; the ask renders |

Non-tautology: with `emergency` removed from `sampled`, the mock's meter call removed, or either storage catch made to
touch storage again, the matching workload fails; sources restored. Limitations: the ledger's use is written directly
(no product path reaches 2^53 - 1 ms); the mock's minute is TestClock time; storage refusal is an injected Window
proxy, not a browser setting.

*Re-measured* with this range, one `bench:coverage` on a 6-vCPU Playwright box, 10:28 to 11:17 UTC. Three Vitest files
failed: `scripts.bench.vibe` (box git 2.39), `budget-reservations` (fails the same way on nyc-01 without coverage:
`[3, 0, 0, 0, 0]` where `[3, 0, 0, 0, 3]` is expected; main's), and the browser fault-path workload (Playwright
locator timeouts on the composer status). Lines of `src/` and `worker/`: **7,957/8,098 (98.26%)**.

| Directory | Lines | Uncovered |
| --- | ---: | --- |
| `src/surfaces` | 507/507 | none |
| `src/web` | 1,976/1,981 | `issueDecision.vibe` 208 (specification only); `main.vibe` 429, 766 and `issuesView.vibe` 83, 84, behind the failed browser fault-path workload |
| `src/core` | 1,998/2,032 | specification only, waiting on lane vl-ghost-functions (34) |

Sandbox Container bindings (`SandboxAccounts`, `SandboxMachine`, `SandboxProbe`, `sandboxProbeFetch`) remain live
only, as above.


## Resume 8: budget boundaries and named imports (2026-11-11, lane vl-bench)

`call-meter-ceilings` exercises the physical meter's unusable-answer-ceiling arm (formerly `CallBudget.vibe:45`).
Five inputs cover absent, nonpositive, fractional and overflowing ceilings. Each returns `engine_failed`,
releases only the parent reservation, never admits a provider call and does not mark the ledger unavailable.

`web-action-clock` runs the real app over product MockFactory/MockActions in happy-dom. It opens Actions, starts a
Tour, waits for the app's own active-run subscription to advance the rendered elapsed time, and cancels the run.
No clock message is injected. The measured interval includes the one-second subscription wait; it is feedback
latency, not clock throughput. The full map showed the requested moved line is the action-follow reconnect, not this clock callback; `web-action-follow-recovery` covers it.

The physical-call ledger's app retries are removed under DUR-2 (0030). Fault workloads now require exactly one
failed charge attempt, one model request, a retained reservation and one terminal budget warning/count. The previous
918.76 ms wiki measurement included three app retries and is historical; no speed-up is claimed.

The provider regression for named-import member initializers reproduces with plain TypeScript and VibeLang. A
source statement such as `let tree = Mod.EMPTY` must be counted for both `import { Mod }` and `import * as Mod`.
Its identical initializer in an uncalled function must remain zero. The provider's import-binding filter, not
VibeLang's compilation or source maps, owns the fix; no source exclusion or coverage threshold changes.

`bench/merge-coverage.ts` refuses a report with no source file under the current checkout (empty, or written by
another checkout) and exits 1 instead of certifying zero files at 100%. `test/benchmarkCoverageGate.test.vibe`
runs the actual command on both inputs.

### Deployed sandbox binding counters (resume 9, 2026-11-12)

`pnpm bench:sandboxes-live` is opt in and runs exactly one lifecycle on `vl-test`: Start, write `saved`, Stop
(checkpoint), Start (restore), read `saved`, Stop, then sweep checking the Container's own stopped status.
The same body and oracle run against `test/recordings/sandboxes-live.json` in the ordinary replay benchmark.
Replay supplies no server execution evidence.

The test stage now uses `accountWithMachines(leaseClamped)` and `gatewayWithAccounts` from the product binding
module. Production uses the same constructors with the unchanged namespace. The probe keeps its ten-minute lease
clamp; its account and machine bodies are unchanged. Both binding shapes expose an internal counter RPC; only the
probe mounts `/api/probe/coverage`, protected by the existing token and owner deadline. No production HTTP route
exports counters. The ordinary production build has no instrumenter.

The probe's deferred rolldown plugin reuses decision 0016's `instrumentRolldown`: each app module receives
Istanbul counters with its own compiler map before bundling. The collector exports three snapshots, from the
Worker, account and machine isolates, after teardown and two checked counter-endpoint refusals (bad token: 403;
valid token with GET: 405). Neither refusal reaches an object RPC or starts compute. Transport failures are reduced
to a content-free typed error before the reporter can print a request or token. It rejects empty isolates, missing binding modules, invalid
counts and compiler source contents that differ from this checkout. Deploy paths may differ (Mac versus Linux);
verified source paths are relocated before remapping. `bench/merge-coverage.ts` reads `bench/results/sandbox-raw/`
and joins accepted evidence through the existing source-position merger. Thresholds and exclusions are unchanged.
A recording or an old deployment's map cannot substitute for matching deployed execution.

Spend: one lite Container at a time and two sequential generations under one owner deadline of ten minutes;
the nine-minute client deadline, failure sweep, account meter and clamped Container inactivity timeout bound
cleanup. No model or GitHub call. Snapshots and object storage persist until `pnpm run destroy:sandboxes-test --yes`.
Instrumented elapsed time is retained as one observation with machine, versions, timestamp and method, never as
an uninstrumented latency baseline or tail percentile. Deployment and live execution are performed by the lead
on the Mac through the vault wrapper. The resume 10 receipt below supplies the first matching live counters.

Benchmark-only provenance: reserve vl-test, deploy immediately before the one benchmark, and run no other suite
against it between deployment and export. A fresh random build id is embedded by the build-time plugin on each
deploy process, forcing a new Worker version even when authored source is unchanged; the deferred plugin is
memoized within that process so plan/build/apply see the same id. All three isolate snapshots must name that
same build. The artifact records it. This prevents a no-op redeploy from reusing cumulative counters from a
previous suite; startup caused by this fresh deployment is part of the measured setup.

The Container recorder added on main is retained, using its existing probeMachine body through machineWithBody.
Deploy this benchmark with VIBELANG_SANDBOX_CONTAINER_MODE=record. After the lifecycle, the collector reads the
existing lifecycle Container recording and checks it is nonempty, then pulls counters. This read starts no compute
and exercises the existing recording RPC; this lane writes none of the other lane's recording files. The recorder
retains at most 2000 entries per object. Other suites may run after the benchmark snapshots have been saved.
The timed interval is the full lifecycle including sweep/assertions; the separate metered window ends at Stop.

A gate regression found during integration: an empty Node report plus runtime-only counters could certify the
subset that runtime supplied. The guard now requires the canonical Node source roster even when runtime maps
produce nonempty merged rows. benchmarkCoverageGate.test.vibe adds that actual-command case. The red command
exited 0 over one runtime-only file; the fixed command exits 1. No threshold or exclusion changed.

### Live receipt accepted (resume 10, 2026-11-12)

The lead deployed main f9f2964ff3bc, ran one sandbox benchmark (1/1, 19.5 s runner duration), and destroyed the
stage; all three commands exited 0. The raw lifecycle observed 14,891 ms including Stop/sweep and assertions,
14,230 ms through second Stop. These are one instrumented observation, with no broader latency claim.
[The measurement](../benchmarks.md#deployed-sandbox-observation-resume-10-2026-11-12) records method, client,
artifacts, correctness checks, bounded spend, cleanup and limits.

The unchanged collector accepts all 70 deployed modules and the single shared build id after checking embedded
compiler source bytes. Mac paths are relocated only after verification. A fresh benchmark-only Node/workerd/
Chromium collection is merged twice with its local evidence held constant, once without and once with these
counters. No unit/fuzz counters, replayed responses, synthetic fixture hits or different deployed builds supply
execution credit. Resume 10's report retains the complete per-file comparison and both raw merged maps.
The strict four-metric gate, source roster and all specification-only lines remain counted.

Resume 10's accepted live dump closes all binding lines: Accounts 6/13 → 13/13, Machine 2/6 → 6/6,
Probe 6/12 → 12/12. Across the measured src/worker roster it adds 103 lines: 8,839/9,184 → 8,942/9,184.
The fresh roster leaves 242 uncovered positions, so the earlier "only 35" expectation is not a certificate for this
snapshot. The [coverage method and table](../benchmarks.md#coverage-from-the-deployed-counters) retain that limit.
The public-wiki benchmark now checks actual owner-scoped draft persistence and both returned page observations;
it no longer requires the removed `wiki/page/index` storage. The original failed oracle and corrected passing
checks are separate receipts. Only source-identical benchmark Node maps join, by position; control coverage is
disabled and the passing map is checked unchanged. The local evidence is held constant for the live comparison.

## Refusal and OAuth benchmark assertions

Issue [#5338](https://github.com/smithersai/smithers/issues/5338) found that the workerd actions matrix read its
expected column and the exchange-failure workload stopped at missing broker configuration. Compare actual response
statuses with the expected column, and require the same assertion to reject a `200` substitution at each row.

Keep missing broker configuration as `workerd-account-missing-broker`. The separate
`workerd-account-exchange-failure` workload selects the account service's existing direct OAuth configuration only
in the unshipped fault host. It uses real PKCE state, cookie signatures, SQLite storage and journaled HTTP routes
with an injected failing Effect exchange. Counts-only readback establishes one exchange, consumed pending state,
unchanged stored-session count and no exchange on replay. Assert the failure redirect, deleted state cookie,
absent new session cookie, anonymous readback and preservation of the prior session. This measures neither the
hosted broker nor Connect. Correct artifact methods describe these distinct paths; earlier receipts do not
establish the claimed exchange-failure or actions-refusal behavior.

## Resume 11: exact non-runtime inventory (2026-11-12)

| File | Statement-start positions on resume 10's frozen source | Why a product benchmark cannot reach them |
| --- | --- | --- |
| `src/core/flowDecision.vibe` | 135,136,137,138,139,203,204,205,206 (9) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/core/issueGraphDecision.vibe` | 25,26,27,28,29,30,149,157,166,175,185,196,205,216,227,238,250,266,279 (19) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/core/replayDecision.vibe` | 22,30,40 (3) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/core/sequencerDecision.vibe` | 19,20 (2) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/core/wikiBuildDecision.vibe` | 66,67,90,91,92,93,94,121,122,123,141,142,191,192,202,203,211,212,213,214,241,242,243,261,262,263 (26) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/history/areaDecision.vibe` | 49,50,59,60,61,71,72,73,74,82,83,84,85,86 (14) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/history/pageDecision.vibe` | 56,57 (2) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/history/replayDecision.vibe` | 20,28,86,101 (4) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/history/seedInputDecision.vibe` | 58,59,77,78,79 (5) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/history/seedSanitizeDecision.vibe` | 34,35,81,82,83,84,85,86,87,88,111,112,113,145,146,190,191,192,193,194,195,218,219,220 (24) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/history/seedTextDecision.vibe` | 59,60,102,103 (4) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/history/trailerDecision.vibe` | 43,44,57,58,59,60,71,72,84,85,86,95,96,97,104,112 (16) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/web/issueDecision.vibe` | 208 (1) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `src/web/modelWrite.vibe` | 70,71,139 (3) | Proof-contract model or lemma only. Runtime callers use the iterative implementation; invoking this body just to raise a counter would measure a different algorithm. VIP-43 must provide the specification-only form. |
| `worker/Objects.vibe` | 255,256 (2) | `unrouted.start` and `unrouted.wake` are engine invariant traps. The fixed Reply and Tour graphs declare no child-flow start or round handoff. A valid execution cannot call these callbacks; directly invoking a trap would not benchmark that graph. |

The earlier 35-position estimate predates recursive proof specifications introduced alongside the iterative text
walks. Resume 11's source audit identifies **132** specification-only statement-start positions, including the three
in `modelWrite` (`escapeWritesIssues`, `screenKept`; its own unit test explicitly calls them proof-only). The initial
242-position audit classified those three as runtime until their callers were checked; corrected totals are 132
specification positions, 40 new runtime positions and 70 existing runtime positions not reached in that collection.
The initial file/position table and exact source text remain in the lane report/evidence, including that correction.
No source exclusion or threshold change is made. These positions stay in every denominator.

The newly counted recursive specifications include wiki scans, scope parsing, seed input selection, redaction and
sentence boundaries, whitespace capture and trailer parsing. Their iterative counterparts run in the actual app.
The fixed workloads now supply boundary inputs directly, so runtime coverage no longer depends only on whichever
wiki pages or history happened to be loaded. Fault browser workloads continue on the e2e build with counts only;
production browser timings use the optimized build. Replayed provider/Container bytes are labeled replay, never live.

Current-main live evidence must be re-collected: the resume9 dump matches 69 of its 70 source modules on the initial
resume11 base 892446d8, but `src/actions/Actions.vibe` changed. The source-checked collector remains unchanged and
refuses that whole dump. The 31/31 deployed binding receipt remains qualified to resume10's frozen cohort; it is not
silently credited to this revision. The lead-only deploy/one bounded lifecycle/destroy commands and limits are in
the report and platform board. No deployment was made by this lane.

### Retained runtime workloads

The resume 11 corpus exercises runtime boundaries through their actual callers: repeated-title and regenerated
history folds, native outside commits, main ancestry with an unknown parent, Export dispatch, history session and
role-stream recovery in a mounted app, sandbox and tour subscriptions, delegated issue/wiki read fallback, immutable
submission-base recovery, and the probe's machine/container record/replay routes and expired-lease sweep. Recorded
GitHub reads use the committed native HTTP recordings; provider failures inject faulty Effect services. No request
is intercepted. Every workload asserts the returned state, receipt, output or refusal; a counter alone is no oracle.

The newly landed history publisher is measured through its real durable execution host, SQLite adapter and the
product mock repository. Small one-tree/two-object batches make the pauses observable; the workload checks no
partial publication, no writes in a quiet round and folding of the next main commit. Fault workloads verify a failed
batch publishes nothing and recovers next round, a secondary limit's retry-after goes through the engine policy,
and unavailable main, disabled publishing and empty history have the specified outcomes. TestClock advances the
alarms and retries; those simulated intervals are never reported as wall-clock latency. The production optimized
browser build supplies timings; e2e/fault builds supply counts only. Happy DOM timings include the actual mounted
runtime but cannot measure browser layout or paint.

The publisher's `worker/HistoryObject.vibe` `unrouted.start` and `unrouted.wake` are two additional invariant traps
introduced after the frozen 242-position audit. Its Publish graph routes no child start or external wake; next rounds
continue in the same object. Valid publisher executions cannot reach either trap. Like Objects' two Reply/Tour
traps, they remain counted and are named here rather than directly called to manufacture execution credit.

### Fresh local receipt and deployed-only paths

The first complete resume 11 collection on production base `680039b8` covers **9,185/9,354** src/worker lines
(98.19%), with 169 positions open. Its one failed workload has an obsolete warm-health oracle: History's final
startup step is now `publish`. The corrected workerd workload passes separately; the final full collection includes
that exact assertion. The original failed receipt is retained and is not described as a fully passing suite.

The remaining local runtime gaps from that map are the export repository's protected-ref guard and the probe's
sweep before the owner expires. New result-checked workloads publish the three allowed refs in a real product
memory repository, reject mixed/aliased protected-ref transactions without partial writes, and sweep a running
local workerd sandbox through its Stop flow before expiry. Production timings include these journeys; simulated
publisher pauses remain identified as TestClock time.

These 26 positions await the source-matching deployed run; they are not exclusions:

| File | Positions | Required execution |
| --- | --- | --- |
| `worker/SandboxAccounts.vibe` | 16,17,18,20,28,29,30 (7) | Alchemy account binding against the deployed real machine/Container and its counter RPC. |
| `worker/SandboxMachine.vibe` | 14,15,16,17 (4) | Deployed machine binding and the real Container protocol. |
| `worker/SandboxProbe.vibe` | 19,20,24,25,26,27 (6) | Deployed probe Worker context, binding routes and instrumented export. |
| `worker/sandboxBenchmark.vibe` | 13,14,15,16,17,18,19,20,21 (9) | Test-stage authenticated counter handler over those actual bindings and the instrumenter's global counters. |

The last handler is not mounted by production. Supplying invented isolate snapshots or replaying an old dump
through replacement bindings would not establish execution in the deployed build. Its real test-stage workload
already exists; the lead-only run and unchanged source checker supply the execution evidence. The old live receipt
remains qualified to its earlier source, never copied into this cohort to hide the pending deployment.

### Base 5e577601: new code and moved oracles

Main moved 238 commits between the resume 11 base 1b8ba47b and 5e577601. The full collection on that base
(final17) failed three checks and left new code without a workload. Each moved oracle follows the product change
that moved it, and no threshold changed:

| Benchmark | Product change | New oracle |
| --- | --- | --- |
| `specification.bench.vibe` | c5a2f3f9 retains a passing panel across revisions | All four seats stay accepted; each state keeps the revised specification's `accepted` receipt. |
| `history-commands.bench.vibe` | A failed History read names the read (`kind`, `id`, `from`) so the person can retry it | The four reads return their exact `read`. |
| `web-dom.bench.vibe` | A lost action follow shows the run Disconnected until the person reconnects | One failed follow, the Connection lost alert, the person's Reconnect click, then two follows. |

New workloads, each asserting results: `reply-accounting.bench.vibe` (refused admission, a reservation held while
Budget is lost and charged once after recovery, an interrupted cleanup that retries), the refused agent Read in
`actions.bench.vibe`, `history-read-retry` and the Reconnect step in `history-stream-faults.bench.vibe`,
`action-legacy-routes` in `action-tour-repeat.bench.vibe`, and the fuzz preflight in `scripts.bench.vibe`.

These positions on 5e577601 are specification-only or invariant traps and stay counted:

| File | Positions | Why no benchmark runs them |
| --- | --- | --- |
| `src/core/replyDecision.vibe` | 100–104 (`replyLawful`) | Proof-contract predicate; no runtime caller. |
| `src/core/flowDecision.vibe` | 107–110 (`tourLawful`) | Proof-contract predicate; no runtime caller. |
| `src/core/wikiLinkDecision.vibe` | 56 (`foldedPrefix`) | Recursive specification of the iterative fold; called only by itself and contracts. |
| `worker/Objects.vibe` | 256, 257 | Reply's `unrouted.start` and `unrouted.wake` traps (the Reply/Tour traps above, moved by new lines). |

The final collection on main 02315e2b found two more groups. `src/core/MockFactory.vibe` 310–311 (a restored
journal with a repeated or skipped event number is trimmed) has `mock-journal-trimmed`. The counter export's
decisions `benchmarkPath` and `benchmarkAnswer` (`worker/sandboxWorkerDecision.vibe` 192, 203–205) have one
caller, the test-stage handler `worker/sandboxBenchmark.vibe`, so they join its deployed-only row.

### Source-matching live receipt (resume 12, 2026-11-13)

The lead deployed main `a54642d6`, ran `pnpm bench:sandboxes-live` once (1/1) and destroyed `vl-test`; all three
commands exited 0. The source-checked collector, unchanged, accepts all 77 deployed modules from the Worker, account
and machine isolates under one build id (`ddfcb2ac-a68e-4507-a687-5bfd6fab2483`) against a checkout of `a54642d6`.
All 33 deployed-only positions now run:

| File | Positions | Without live counters | With live counters |
| --- | --- | ---: | ---: |
| `worker/SandboxAccounts.vibe` | 16, 17, 18, 20, 28, 29, 30 | 6/13 | 13/13 |
| `worker/SandboxMachine.vibe` | 14–17 | 2/6 | 6/6 |
| `worker/SandboxProbe.vibe` | 19, 20, 24–27 | 6/12 | 12/12 |
| `worker/sandboxBenchmark.vibe` | 14–23 | 0/10 | 10/10 |
| `worker/sandboxWorkerDecision.vibe` | 192, 203–205 | 36/40 | 40/40 |
| `infra/SandboxImage.vibe` | 4, 5 | 0/2 | 2/2 |

Method: a fresh benchmark-only collection on `a54642d6` (Node, workerd and Chromium), merged once without and once
with the lead's dump; the local evidence is identical in both merges. The merge adds exactly these 33 positions and
nothing else. `src/` + `worker/`: 9,587/9,760 → **9,618/9,760 (98.55%)**; `infra/` 10/12 → 12/12.

Of the 142 open positions, 133 are specification-only (VIP-43). Four are the invariant traps
(`HistoryObject` 149–150, `Objects` 256–257). Five are runtime code main added after the 02315e2b collection, each
with a runtime caller and no workload yet:

| Position | Caller | Workload it needs | Workload (resume 13) |
| --- | --- | --- | --- |
| `src/web/actionModel.vibe` 35–36 | `actionView.vibe` 48, a refused write's result | The agent's door sends a blank lane and a blank note; the run's Result reads "Needs a lane." / "Needs text."; any other refusal reads its reason. | `web-refused-blank-writes` |
| `src/web/main.vibe` 1099 | the action follow stream | A follow that closes cleanly before its run settles yields `FailedActionFollow`, like a transport failure. | `web-action-follow-closed` |
| `src/web/modelWrite.vibe` 622 | `main.vibe` 715, tour replay | A tour receipt of kind `replay`: fresh tour client, next epoch. | `web-tour-replay-finish` |
| `src/web/modelWrite.vibe` 650 | `main.vibe` 747, tour finish | A walkthrough that finishes: tour off, draft cleared. | `web-tour-replay-finish` |

### Keeping up with main (resume 13, 2026-11-13)

**The five runtime positions.** `bench/web-dom.bench.vibe` runs the real app in happy-dom.
`web-refused-blank-writes` uses the mock page's backend (`BrowserFactory` forced to mock, which gives the mock agent
the page's Actions as its door). The agent runs `/start` with a blank lane, `/note` with blank text and `/start` on a
missing commit, and each Result reads "Needs a lane.", "Needs text." or "No such epic or commit.".
`web-action-follow-closed` injects `test/support/FaultyActions.vibe`'s `follow-close`: the run stays queued and reads
Disconnected, and Reconnect follows it again. `bench/web-actions.bench.vibe`'s `web-tour-replay-finish` sends the
reducer a tour event past a gap (a fresh tour client and the next epoch), then the last stop (tour off, draft
cleared). Each workload failed with its line mutated (the refusal words, the clean-close `FailedActionFollow`, the
replay epoch), and passed after the source was restored.

**Full collection on main `6f779528`.** `pnpm bench:coverage` (job `vl-bench:r13b-coverage`, cfbox node26, Node
26.5.0, 22:07–22:49 UTC): 118 files passed, 1 skipped. Local merge: `src/` + `worker/` **9,605/9,777 (98.24%)**,
`infra/` 10/12. All five positions run. The live dump from `a54642d6` no longer merges: the collector refuses
`worker/SandboxMachine.vibe` ("source mismatch; redeploy this source") because main's `c8d32448` moved the binding
classes' counter export into `worker/benchmarkCounters.vibe`.

**Two paths main's changes left without a workload.** Main's `794817bc` binds the account and machine objects in the
workerd world, so the forged-role sandbox writes in `sandbox-workerd` now reach the account object. No benchmark ran
the signed-out gateway's start, stop and command refusals (`worker/SandboxHttp.vibe` 22–24) any more. `withCounters`
(`worker/benchmarkCounters.vibe` 7) is new. `bench/sandbox-signed-out.bench.vibe` holds `sandbox-signed-out` (the
gateway on a Node loopback server: viewer snapshot, three 403 forbidden) and `sandbox-counter-export`. A focused
coverage run of that file counts all four positions. With them, 9,609/9,777 (98.28%); a full merge confirms this with
the next batch.

**Deployed-only positions, moved.** The same code as the resume 12 table, with new line numbers:
`worker/SandboxAccounts.vibe` 17, 18, 19, 21, 29, 30, 31; `worker/SandboxMachine.vibe` 15–18;
`worker/SandboxProbe.vibe` 19, 20, 24–27; `worker/sandboxBenchmark.vibe` 14–23; `worker/sandboxWorkerDecision.vibe`
192, 203–205; `infra/SandboxImage.vibe` 4, 5 (31 in `src/` + `worker/`, 2 in `infra/`). They need a live run of the
current source: the lead deploys a main that contains `c8d32448`, runs `pnpm bench:sandboxes-live` once, and destroys
`vl-test`, as in resume 12. The 168 open positions in `src/` + `worker/`: 133 specification-only (VIP-43), 4 invariant
traps and these 31.

**Second batch: main `51fab4e3`.** Full collection (job `vl-bench:r13c-coverage`, cfbox node26, 23:28–00:14 UTC):
119 files passed, 1 skipped; `src/` + `worker/` **9,672/9,842 (98.27%)**. The four sandbox positions above run. Main's
`b8e22c43` moved sign-in's answer from a one-line ternary into `src/surfaces/signinDecision.vibe`'s `refusalOf` and
`refusalMessage`. Their "failed" answers (65, 76) became separate lines that no workload ran: a waited `login` whose
poll fails. `signin-device-wait-failed` (`bench/signin-device.bench.vibe`) waits while GitHub's token endpoint answers
an undefined error, and then a token for a person the factory doesn't know. Each wait ends with "Sign-in failed.", and
no session is stored. A focused run counts both lines, and the workload failed with the sentence mutated. With it,
9,674/9,842 (98.29%); open in `src/` + `worker/`: 133 specification-only, 4 traps, 31 deployed-only.

**Live result artifacts.** Live results follow the artifact rule above: `bench/results/` is ignored, so the live JSON
and the 6 MB counter dump stay out of the repository. Both are retained on nyc-01 under
`~/vl/vl-bench-evidence/live-a54642d6/`, with the lead's run log and both merged maps.

A collection on base `a54642d6` needs main's `bbbdcdd1` (workerd counters read `file:` URL sources as paths). Without
it, `bench/merge-coverage.ts` exits on the first workerd dump: VibeLang 0.0.13's esbuild plugin names inline-map
sources by `file://` URL, and Istanbul resolves them beside the module. This collection applied the same conversion
at remap time; the remapped maps are identical.

### Second source-matching live receipt (resume 14, 2026-11-14)

Main's `c8d32448` moved the binding counter export into `worker/benchmarkCounters.vibe`, so the `a54642d6` dump no
longer merged. The lead deployed main `f46f5a78` (which contains `c8d32448` and `51fab4e3`) to `vl-test` at 02:02 UTC,
ran `pnpm bench:sandboxes-live` once (1/1) and destroyed the stage; deploy, benchmark and destroy each exited 0. The
collector, unchanged, accepts the dump's 78 counter files (build `7f4d8b63-89c3-4d71-a66d-ce1a92b622df`) against a
checkout of `f46f5a78`.

Method: as in resume 12. One benchmark-only collection on `f46f5a78` (job `vl-bench:live14-coverage`, cfbox node26,
Node 26.5.0, 4 vCPU, 02:10–02:44 UTC: 119 files passed, 1 skipped), merged once with and once without the dump. The
local evidence is identical in both merges; the dump adds exactly the 33 positions below and nothing else.

| File | Positions | Without live counters | With live counters |
| --- | --- | ---: | ---: |
| `worker/SandboxAccounts.vibe` | 17, 18, 19, 21, 29, 30, 31 | open | run |
| `worker/SandboxMachine.vibe` | 15–18 | open | run |
| `worker/SandboxProbe.vibe` | 19, 20, 24–27 | open | run |
| `worker/sandboxBenchmark.vibe` | 14–23 | open | run |
| `worker/sandboxWorkerDecision.vibe` | 192, 203–205 | open | run |
| `infra/SandboxImage.vibe` | 4, 5 | open | run |

`src/` + `worker/`: 9,669/9,837 → **9,700/9,837 (98.61%)**; `infra/` 10/12 → 12/12. The 137 positions still open
are the 133 specification-only lines (VIP-43) and the 4 invariant traps (`HistoryObject` 149–150, `Objects`
256–257); no runtime line is open. The strict four-metric gate still exits 1 on them. No threshold or exclusion
changed.

Artifacts stay on nyc-01 under `~/vl/vl-bench-evidence/live-f46f5a78/` (the lead's JSON, `sandbox-raw/`,
`lead-run.log`) and `~/vl/vl-bench-evidence/resume14/` (job script, summary script, collection log). The JSON
records the Mac working-copy revision `2f8bc823`; the lead's log names main `f46f5a78`. Neither is relabeled.

A later main that changes any deployed module's source opens these positions again until the next live run.
