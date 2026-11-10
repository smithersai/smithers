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
open, an agent reply that calls the history and wiki tools, history writes, action runs (one with an agent's trusted
entry props) and ProjectAccounts with sign-in configured from fixture-only secrets. The benchmark host built that
configuration without a `Scope`, so `Accounts.configured()` answered `undefined` and the configured branch never ran;
it is now scoped as `test/workerd/accounts.vibe` is. Lines 120, 229 and 246 to 248 stay uncovered: they run only in a
reply for a signed-in owner (its role read, an announced agent action, a wiki draft for that owner), and signing in
needs GitHub (0165). **Web sign-in (2026-11-10).** `bench/accounts-web.bench.vibe` signs a person in through the OAuth callback with an injected GitHub auth service in Node, so `worker/Accounts.vibe`'s callback, session and sign-out lines no longer need a GitHub credential. **Signed-in issue and wiki routes (2026-11-10).** These held a request open past 120 s with GitHub unreachable until `vl-connectfix` bounded reads (0030). `bench/issues-wiki-web.bench.vibe` measures a signed-in person's issue list, new issue, comment, wiki read and idempotent Save through injected `IssueHost` and `WikiHost` services; `bench/accounts-offline.bench.vibe` measures the same routes with GitHub unreachable and holds the read bound. Complementary hits on exactly matching branch arms may combine; different shapes stay uncovered.
Executable lines are statement start lines, as in Istanbul; a declaration's hit never executes its whole nested body.
**Browser coverage across navigations (2026-11-10).** The Chromium dump ran once per workload, at its end, but V8 precise coverage reports only the current document's scripts: a page left by `page.goto` lost its counts. Workloads now dump before each navigation (`collectBrowserCoverage` in `bench/browser.spec.ts`). With the issues and panel-arms workloads this recovers 118 `src/` + `worker/` lines. Still uncovered in `src/web/main.vibe`, by cause:

- Fault arms that need a faulty service injected in the browser (media, tour events, sandbox, actions, post and tour refusals, roles and events streams: lines 320, 425, 451, 503, 510, 761, 895, 909, 1231, 1258, 1304, 1365). The fault-injection pages exist only in the `e2e` build; the timing build is the production bundle.
- The ⌘K `/mock` and `/live` switch (783–784, 1385–1387) reloads the page itself, and V8 drops a document's counts on reload. Dumping first would need request interception, which the suite does not use.
- Escape with nothing open on the chat surface reaches another arm, not `none` (611).
- Seven lines ran in Chromium but compile to different statement ranges in the bundle than in Node (`main.vibe` 946, 1121, 1131; `roleView.vibe` 34, 36; `MockFactory.vibe` 338; `markdown.vibe` 114), and four have no bundle statement at all (`main.vibe` 1119, 1120, 1130, 1270). The merge credits only identical ranges, so no browser workload can cover them.

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

