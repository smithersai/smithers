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
probed 2026-11-08), so parent Node coverage cannot count worker execution. In this command the workerd bundles carry
Istanbul counters (`test/support/workerdCoverage.ts`): esbuild's bundle map chains through the compiler maps, the
instrumented bundle runs the real Durable Object flows, and each dispose reads `globalThis.__coverage__` from the
user isolate over the inspector before it exits, writing the dump with both maps under `coverage/bench-workerd/`.

**The merged gate.** Vitest's own threshold check is off in this command, because workerd evidence exists only after
the process exits. `bench/merge-coverage.ts` then remaps each dump (instrumented to bundle to source), unions it
with the Vitest map and enforces 100% lines, branches, functions and statements per file across `src/`, `worker/`,
`infra/` and `scripts/`. A file with no Node-side execution is gated on its workerd-remapped structure. A file
executed in both keeps its Vitest structure. Cross-runtime credit requires identical complete statement or function
declaration ranges; branch credit requires the same type and ordered arm ranges. Missing/non-finite columns never
establish execution. Complementary hits on exactly matching branch arms may combine; different shapes stay uncovered.
Executable lines are statement start lines, as in Istanbul; a declaration's hit never executes its whole nested body.
A line no benchmark should run is excluded only with its reason recorded in `merge-coverage.ts` and here:
`scripts/mythical-seed.vibe` line 103 (`Refused` guard) is unreachable from real input because `intentsOf`
guarantees by construction that `decide` accepts every seeded intent and `decideWithinCapacity` refuses only at
2^53 events.

The denominator includes `src/`, `worker/`, `infra/` and `scripts/`, matching the coverage lane’s source scope and adding the browser bundle solely to collect source-mapped evidence. No production line is excluded by this decision. The 100% benchmark-only coverage requirement remains open until
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

Latest complete benchmark-only receipt (`6a979627e06c4be522557d65f6ffa8bb8320b349`): Test Files 43 passed (43); Tests 103 passed (103); Duration 923.61s (tests 94%, import 3%, transform 2%, environment 1%). The merged count is 5,083/6,675 src/worker lines (76.15%); 93 files fail one or more strict thresholds. No `src/` or `worker/` line is excluded. Full per-file counters, methods and limitations appear in [the benchmark table](../benchmarks.md). The 100% requirement remains unfinished.


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
