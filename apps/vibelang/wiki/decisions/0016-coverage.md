# 0016. Coverage of the VibeLang sources

**Status:** in progress, 2026-11-07. **Rulings:** VL-5, VL-7, VL-14, VL-29.

The goal remains 100% lines, branches, functions and statements for each production file, independently per suite.
That goal has **not been achieved**. No source file is excluded. This decision records landed behavioral tests and
the coverage commands. `pnpm e2e` measures and reports Chromium coverage without failing on it. The strict gates
`pnpm test:coverage` and `pnpm e2e:coverage` are the exclusive PACKAGE targets `coverage` and `browserCoverage`: a
person asks for them, no wildcard selects them, and they stay red until every file reaches 100%. Exclusive is the
same pattern as `benchCoverage` and `fuzzCoverage`. Exclusive is not a threshold change: both gates hold 100%.

## Landed behavior

The new tests exercise sequencer replay, ordering and reply attempts; real loopback HTTP and product mock flows;
HTTP byte/name/cursor/schema boundaries; faulty Effect transports and protocol responses; subscription cancellation;
budget limits, repeated charges and rounding; model configuration and agent projections; history reads, planning,
work, notes, approval and folding; shared browser-backend selection, timeout and cancellation; viewport input; and
chunk boundaries. The Alchemy stack is tested as a real resource graph in dev, production and custom-domain modes,
with its selected state adapters resolved without initializing or deploying their providers.

Two product bugs found by this lane already landed with regressions (0014): ending a tour did not restore composer
focus, and a tour accepted between choosing a post and starting its reply could permanently lose the accepted
post's answer. That reply now drives the accepted tour as a durable child and uses the engine's retry policy before
starting the same reply, retaining oldest-post ordering and natural tour completion. The contended start has an
outcome-only log/counter and a reply span; no user content is logged.

Later dead code removed (2026-11-09): in `src/web/main.vibe`, the `?? 0` epoch defaults when an account or role change loads actions (the new epoch is always a number) and the `?? ""` wikiAfter default (reached only when no entry matches an undefined id).

Dead code removed: the unused custom chunk-size parameter (every product caller uses 24), and the markdown capture's
unreachable undefined fallback (the regular expression always captures a string, including an empty string).

## Coverage prototype and tool list

The prototype uses the monorepo's patched `@vitest/coverage-v8` **5.0.0**, matching Vitest **5.0.0**, and existing
`ast-v8-to-istanbul` **1.0.5** for Chromium conversion. No new runtime dependency is proposed. Declaring those test
tools in this app awaits Will's **VL-5 approval**. The prepared PACKAGE targets and scripts enforce all four 100%
thresholds per file, include all of `src/`, `worker/`, `scripts/` and `infra/`, and currently fail. Configuring the
thresholds is not evidence of achieving them.

The compiler/Vite maps preserve `.vibe` names and lines in the unbundled Vitest path. A negative control observes an
unvisited Effect return at its original fixture line 4 and a threshold-only child exit 1 despite a passing assertion.
Emitted CLI/MCP processes retain maps and inline source text. The prototype browser suite uses Playwright's built-in
`page.coverage` without a new browser dependency, retains raw Chromium evidence, and checks map source content
against the checkout. Its full-source zero seed retains tree-shaken exports and entirely unvisited files. Vite's
generated module/preload helpers and pure re-export facades contain no app source; no production `.vibe` is excluded.

## Measurement blockers

**Bundled line and statement coverage is not yet trustworthy.** The real Chromium negative control returns 7 from
`answer(true)` but credits the unexecuted `return 9` source line after Vite minification combines two returns into
one conditional return. The unused export stays uncovered. The unbundled compiler map and real V8 execution agree;
the post-bundle statement granularity changes in `ast-v8-to-istanbul`. Branch arms retain `[1, 0]`.
`~/vl/vibelang-bugs/coverage-source-ranges/` on nyc-01 contains the minimal fixture, reproduction, both real executions
and ranges, maps and observed statement positions. The Chromium regression remains an expected failure in the
prototype; an unexpected pass will require removing that marker after the upstream fix. No build/compiler behavior
was changed as a workaround. Will's decision is required before the upstream change; a fix must have a regression
and land through VibeLang's merge queue.

Precise coverage could not be enabled on the installed workerd **1.20261019.1** inspector, directly or through Miniflare: Runtime enables and a real fetch answers 200, but
Profiler.startPreciseCoverage reports `Profiler is not enabled`; takePreciseCoverage reports no started collection.
`pnpm test:workerd --coverage` in the prototype measures Node clients and surface subprocesses only. Worker execution
remains uncredited. Two real-model tests remain opt-in without an authorized configured model credential.

VibeLang 0.0.12 also loses service-Shape methods on object spread (TS2741, compiler exit 2). Minimal reproduction and
the blocked reply-recovery decorator test are under `~/vl/vibelang-bugs/service-shape-spread/`. No workaround or
compiler behavior change was made; Will's approval for upstream work is pending.

## Measurements

The lane report `~/vl/vl-coverage.REPORT.md` and evidence directory `~/vl/vl-coverage-evidence/` on nyc-01 retain exact
per-file before/after tables, covered/executable counts, original uncovered lines, commands and exits. Totals change
as other lanes land history and proof modules. Browser line/statement figures are diagnostic only; workerd figures
refer to Node clients only. The per-file snapshot below records the measured revisions; it is not a 100% claim.

<!-- measurements:start -->
Snapshot provenance: all three suites at `9861d6f26e36` (2026-11-09), each table showing the previous snapshot (unit `af56fa418a48`, workerd and Chromium `efb00d0f5854`) → this one. Passing ordinary tests do not change these frozen measurements.

Percentages show **previous snapshot → this snapshot**, independently for each suite. A dash means the file was absent from that
snapshot's source roster, not excluded. CSV retains every covered/executable count. The initial unit snapshot has 38
files and one timing-related assertion failure; the refreshed snapshots have 90 runtime files. Workerd and browser had no original
pre-work baseline: their before columns are the first retained earlier instrumented snapshots, already during the
lane's work. Different source rosters and the corrected provider mean these are snapshots, not a controlled delta.
Workerd values count Node execution only. All Chromium values remain diagnostic pending the bundled source-range
fix; even an unexecuted source return can receive a false statement hit. No production file is excluded.

## Unit

Previous snapshot: lines 77.51% (3133/4042), branches 75.2% (2509/3336), functions 68.19% (995/1459), statements 73.72% (3727/5055).

At `9861d6f26e36` less its last two issuesView scene cases (the run just before them; 1548 passed, 3 skipped): lines 90.88% (6592/7253), branches 88.32% (7006/7932), functions 87.78% (2378/2709), statements 88.9% (8318/9356).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | 0% → 100% | 100% → 100% | 100% → 100% | 0% → 100% |
| `infra/Stack.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `infra/WorkerBuild.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `scripts/agent-context.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `scripts/mythical-seed.vibe` | 100% → 100% | 94.44% → 94.44% | 93.75% → 93.75% | 96.92% → 96.92% |
| `scripts/wiki.vibe` | — → 100% | — → 92.85% | — → 100% | — → 100% |
| `src/actions/Actions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/LiveActions.vibe` | — → 100% | — → 95.23% | — → 96% | — → 98.14% |
| `src/actions/MockActions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/agent.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/catalog.vibe` | — → 100% | — → 97.5% | — → 100% | — → 100% |
| `src/actions/execution.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/tools.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/wire.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/assets/wiki.generated.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/Factory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/IssuesFactory.vibe` | 92.3% → 97.36% | 76.76% → 86.06% | 100% → 100% | 81.81% → 90% |
| `src/core/LiveAccounts.vibe` | 28% → 96.15% | 0% → 91.66% | 8.33% → 92.3% | 22.58% → 93.75% |
| `src/core/LiveFactory.vibe` | 70% → 100% | 40% → 83.33% | 94.44% → 100% | 67.07% → 94.38% |
| `src/core/LiveIssues.vibe` | — → 100% | — → 100% | — → 85.71% | — → 93.75% |
| `src/core/LiveWiki.vibe` | — → 33.33% | — → 0% | — → 30% | — → 28.57% |
| `src/core/MockAccounts.vibe` | 98.52% → 98.7% | 86.66% → 88.23% | 91.66% → 92.3% | 95.6% → 96.07% |
| `src/core/MockFactory.vibe` | 97% → 98.06% | 84.72% → 95.74% | 96.42% → 100% | 95.16% → 97.45% |
| `src/core/MockJournal.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/VipWriter.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/WikiFactory.vibe` | — → 98.46% | — → 90.27% | — → 100% | — → 94.31% |
| `src/core/WikiWriter.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/accountCookieDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/accountCookies.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/conversation.vibe` | 98.07% → 100% | 91.75% → 100% | 95.65% → 100% | 96.46% → 100% |
| `src/core/decide.vibe` | — → 100% | — → 96.26% | — → 100% | — → 97.7% |
| `src/core/flowDecision.vibe` | 90.9% → 100% | 94.11% → 100% | 100% → 100% | 91.66% → 100% |
| `src/core/flows.vibe` | 90.62% → 91.51% | 95.34% → 93.58% | 71.87% → 68.18% | 90.26% → 90.95% |
| `src/core/identityDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/issueFlows.vibe` | 90.62% → 100% | 100% → 100% | 88.88% → 100% | 91.89% → 100% |
| `src/core/issueSchemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/mockDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/mockReplies.vibe` | 100% → 100% | 75% → 75% | 83.33% → 83.33% | 95.83% → 95.65% |
| `src/core/protocolDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/roles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sandboxDecision.vibe` | 96.36% → 96.36% | 84.72% → 87.5% | 93.33% → 93.33% | 86.84% → 89.47% |
| `src/core/sandboxHost.vibe` | 85.39% → 100% | 78.72% → 100% | 96.29% → 100% | 80.09% → 100% |
| `src/core/sandboxMeter.vibe` | 100% → 100% | 94.28% → 94.28% | 100% → 100% | 94.59% → 94.87% |
| `src/core/sandboxMock.vibe` | 100% → 100% | 62.22% → 71.11% | 91.3% → 95.65% | 91.66% → 95.83% |
| `src/core/sandboxPolicy.vibe` | 100% → 100% | 100% → 100% | 66.66% → 66.66% | 75% → 75% |
| `src/core/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sequenceDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/specification.vibe` | — → 100% | — → 79.62% | — → 100% | — → 90.9% |
| `src/core/tourStops.vibe` | 100% → — | 100% → — | 100% → — | 100% → — |
| `src/core/walkthroughSteps.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wiki.vibe` | — → 93.33% | — → 76.92% | — → 100% | — → 96.29% |
| `src/core/wikiDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wikiFlows.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wikiLinks.vibe` | — → 100% | — → 93.54% | — → 100% | — → 100% |
| `src/core/wikiSchemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/LiveMythical.vibe` | 100% → 100% | 92.3% → 83.33% | 100% → 100% | 97.72% → 95.74% |
| `src/history/MockMythical.vibe` | 100% → 100% | 100% → 100% | 96.42% → 96.42% | 97.56% → 97.67% |
| `src/history/MythicalHistory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/Sequencer.vibe` | 92.7% → 92.7% | 75% → 75% | 100% → 100% | 90.26% → 90.26% |
| `src/history/flowMachine.vibe` | 100% → 100% | 94.73% → 92.47% | 100% → 100% | 93.75% → 91.3% |
| `src/history/flows.vibe` | 89.18% → 89.47% | 80% → 77.77% | 75% → 75% | 88.63% → 88.88% |
| `src/history/mythical.vibe` | 98.49% → 95.74% | 95.76% → 94.76% | 100% → 96.55% | 94.62% → 92.3% |
| `src/history/pages.vibe` | 100% → 100% | 93.33% → 93.33% | 100% → 100% | 100% → 100% |
| `src/history/roles.vibe` | 83.33% → 100% | 100% → 100% | 0% → 100% | 83.33% → 100% |
| `src/history/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/seed.vibe` | 99.41% → 100% | 89.71% → 90.65% | 100% → 100% | 98% → 98.5% |
| `src/history/seed/vibelang.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/tools.vibe` | 96.29% → 96.29% | 93.61% → 93.61% | 88.88% → 88.88% | 97.05% → 97.05% |
| `src/history/wire.vibe` | 100% → 100% | 97.43% → 97.14% | 100% → 100% | 100% → 100% |
| `src/surfaces/backend.vibe` | 76.92% → 91.11% | 50% → 68.57% | 75% → 64.28% | 73.33% → 84.48% |
| `src/surfaces/cli-entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/cli.vibe` | 100% → 100% | 87.5% → 90% | 100% → 100% | 94.44% → 94.44% |
| `src/surfaces/commandDecision.vibe` | 100% → 100% | 84.84% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/commands.vibe` | 89.81% → 100% | 75.71% → 91.79% | 70.27% → 100% | 86.2% → 100% |
| `src/surfaces/manifest.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/mcp-entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/mcp.vibe` | 100% → 100% | 50% → 50% | 100% → 100% | 94.11% → 95% |
| `src/surfaces/session.vibe` | — → 93.65% | — → 70.83% | — → 81.81% | — → 86.66% |
| `src/surfaces/sessionFlow.vibe` | — → 96.55% | — → 100% | — → 90% | — → 97.14% |
| `src/surfaces/signin.vibe` | — → 98.13% | — → 90.21% | — → 61.53% | — → 89.36% |
| `src/web/actionModel.vibe` | — → 100% | — → 82.75% | — → 90% | — → 95.65% |
| `src/web/actionView.vibe` | — → 86.66% | — → 84.8% | — → 77.77% | — → 85.36% |
| `src/web/backend.vibe` | 76.92% → 100% | 100% → 100% | 57.14% → 100% | 71.73% → 100% |
| `src/web/entry.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `src/web/historyApp.vibe` | 62.58% → 100% | 73.19% → 100% | 48.48% → 100% | 57.48% → 100% |
| `src/web/historyBackend.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/historyStartup.vibe` | 100% → 100% | 100% → 91.66% | 100% → 100% | 100% → 97.36% |
| `src/web/historyView.vibe` | 85.36% → 98.63% | 80% → 91.72% | 88.37% → 97.67% | 85.71% → 98.78% |
| `src/web/issueDecision.vibe` | — → 98.87% | — → 89.24% | — → 95% | — → 99.28% |
| `src/web/issues.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/issuesView.vibe` | — → 100% | — → 99.53% | — → 100% | — → 100% |
| `src/web/main.vibe` | 72.59% → 100% | 68.96% → 99.67% | 59.41% → 100% | 63.48% → 100% |
| `src/web/markdown.vibe` | 100% → 100% | 100% → 95.78% | 100% → 100% | 100% → 99.33% |
| `src/web/media.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/modeSwitch.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/modelDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/paneDecision.vibe` | — → 100% | — → 97.61% | — → 100% | — → 95.23% |
| `src/web/roleView.vibe` | 83.33% → 83.33% | 81.25% → 83.33% | 71.42% → 71.42% | 85.18% → 85.18% |
| `src/web/sandboxView.vibe` | 94.11% → 94.11% | 91.3% → 94.56% | 83.33% → 83.33% | 94.73% → 94.73% |
| `src/web/screenDecision.vibe` | 100% → 100% | 92.95% → 100% | 100% → 100% | 94.28% → 100% |
| `src/web/startup.vibe` | 96.55% → 92% | 75% → 45.45% | 100% → 84.61% | 94.11% → 79.68% |
| `src/web/startupDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/styles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/theatre.vibe` | — → 100% | — → 80% | — → 100% | — → 94.11% |
| `src/web/theatreDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/tourDecision.vibe` | — → 100% | — → 95% | — → 100% | — → 94.73% |
| `src/web/view.vibe` | 100% → 100% | 93.79% → 82.65% | 100% → 100% | 98.38% → 98.27% |
| `src/web/viewDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/viewport.vibe` | 100% → 100% | 98.27% → 98.27% | 100% → 100% | 100% → 100% |
| `src/web/wikiView.vibe` | — → 92.85% | — → 86.81% | — → 78.94% | — → 89.74% |
| `worker/Accounts.vibe` | 14.11% → 99.62% | 12.85% → 95.61% | 11.9% → 93.54% | 13.77% → 98.37% |
| `worker/ActionDirectory.vibe` | — → 94.44% | — → 83.33% | — → 88.23% | — → 96% |
| `worker/ActionIdentity.vibe` | — → 100% | — → 95% | — → 100% | — → 100% |
| `worker/ActionRuns.vibe` | — → 97.43% | — → 87.5% | — → 94.11% | — → 93.75% |
| `worker/ActionsHttp.vibe` | — → 100% | — → 94.73% | — → 90% | — → 98.36% |
| `worker/AgentModel.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/Api.vibe` | 26.22% → 19.91% | 0% → 0% | 0% → 0% | 23.18% → 17.49% |
| `worker/Budget.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/HistoryActions.vibe` | — → 90.9% | — → 78.94% | — → 81.81% | — → 86.48% |
| `worker/HistoryObject.vibe` | 10% → 96.66% | 6.66% → 100% | 3.03% → 90.9% | 8% → 96% |
| `worker/HistoryTools.vibe` | 50% → 100% | 50% → 100% | 33.33% → 100% | 50% → 100% |
| `worker/Http.vibe` | 100% → 100% | 95.71% → 100% | 94.11% → 100% | 97.75% → 100% |
| `worker/IssueCredentials.vibe` | — → 93.75% | — → 55.55% | — → 72.72% | — → 83.33% |
| `worker/Issues.vibe` | — → 61.62% | — → 54.09% | — → 50% | — → 56.84% |
| `worker/MainLog.vibe` | 67.44% → 100% | 68.96% → 96.55% | 58.33% → 100% | 63.33% → 98.33% |
| `worker/ObjectStorage.vibe` | 10% → 90% | 0% → 83.33% | 0% → 81.81% | 7.14% → 85.71% |
| `worker/Objects.vibe` | 9.58% → 87.96% | 4% → 76.08% | 8.69% → 91.66% | 7.44% → 88.97% |
| `worker/Reply.vibe` | 59.81% → 65.44% | 61.33% → 51.85% | 58.82% → 58.82% | 59.05% → 63.46% |
| `worker/SandboxAccounts.vibe` | 10% → 100% | 2.7% → 100% | 0% → 100% | 7.69% → 100% |
| `worker/SandboxHttp.vibe` | 13.33% → 93.33% | 0% → 97.05% | 0% → 70% | 9.52% → 92.85% |
| `worker/SandboxMachine.vibe` | 1.51% → 100% | 0% → 100% | 0% → 100% | 1.05% → 100% |
| `worker/SandboxTools.vibe` | 72.72% → 72.72% | 50% → 50% | 70% → 70% | 75% → 75% |
| `worker/Sandboxes.vibe` | 0% → 100% | 0% → 100% | 0% → 100% | 0% → 100% |
| `worker/Sequencer.vibe` | 94.39% → 94.95% | 96.29% → 85.29% | 90.69% → 97.87% | 95.38% → 95.8% |
| `worker/SpecificationReviewers.vibe` | — → 32.25% | — → 25% | — → 10% | — → 26.19% |
| `worker/Tour.vibe` | 59.45% → 100% | 28.57% → 100% | 54.54% → 100% | 54.54% → 100% |
| `worker/Unreachable.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/VipDraft.vibe` | — → 73.33% | — → 60% | — → 33.33% | — → 65.85% |
| `worker/Wiki.vibe` | — → 74.34% | — → 76.52% | — → 54.9% | — → 67.42% |
| `worker/WikiDraft.vibe` | — → 43.75% | — → 14.28% | — → 22.22% | — → 36.36% |
| `worker/WikiTools.vibe` | — → 100% | — → 83.33% | — → 100% | — → 92.3% |
| `worker/accountObject.vibe` | — → 10.41% | — → 0% | — → 5.12% | — → 6.32% |
| `worker/agentContext.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/budgetDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/index.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/liveDispatchDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `worker/machineObject.vibe` | — → 1.58% | — → 0% | — → 5.88% | — → 1.08% |
| `worker/replyProgressDecision.vibe` | — → 88.23% | — → 81.25% | — → 90% | — → 86.36% |
| `worker/replyReasons.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |

## Workerd — Node clients only

Previous snapshot: lines 11.7% (473/4042), branches 3.56% (119/3336), functions 4.72% (69/1459), statements 9.57% (484/5055).

At `9861d6f26e36`: lines 12.93% (938/7254), branches 4.75% (377/7934), functions 6.71% (182/2709), statements 10.6% (992/9351).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `infra/Stack.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `infra/WorkerBuild.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `scripts/agent-context.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/mythical-seed.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/actions/Actions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/LiveActions.vibe` | — → 93.02% | — → 71.42% | — → 80% | — → 83.33% |
| `src/actions/MockActions.vibe` | — → 1.75% | — → 0% | — → 5.55% | — → 1.32% |
| `src/actions/agent.vibe` | — → 36.36% | — → 100% | — → 16.66% | — → 29.41% |
| `src/actions/catalog.vibe` | — → 37.5% | — → 0% | — → 0% | — → 37.5% |
| `src/actions/execution.vibe` | — → 2.56% | — → 0% | — → 0% | — → 1.96% |
| `src/actions/tools.vibe` | — → 30.76% | — → 0% | — → 0% | — → 28.57% |
| `src/actions/wire.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/assets/wiki.generated.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/Factory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/IssuesFactory.vibe` | 0% → 2.63% | 0% → 0.81% | 0% → 6.25% | 0% → 2% |
| `src/core/LiveAccounts.vibe` | 28% → 26.92% | 0% → 0% | 8.33% → 7.69% | 22.58% → 21.87% |
| `src/core/LiveFactory.vibe` | 62.85% → 66.23% | 23.33% → 23.33% | 61.11% → 65% | 53.65% → 57.3% |
| `src/core/LiveIssues.vibe` | — → 27.27% | — → 0% | — → 14.28% | — → 18.75% |
| `src/core/LiveWiki.vibe` | — → 26.66% | — → 0% | — → 10% | — → 19.04% |
| `src/core/MockAccounts.vibe` | 2.94% → 2.59% | 0% → 0% | 0% → 0% | 2.19% → 1.96% |
| `src/core/MockFactory.vibe` | 3.59% → 3.08% | 0% → 0% | 3.57% → 2.56% | 2.89% → 2.54% |
| `src/core/MockJournal.vibe` | — → 0% | — → 100% | — → 0% | — → 0% |
| `src/core/VipWriter.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `src/core/WikiFactory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/WikiWriter.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/accountCookieDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/accountCookies.vibe` | — → 88.88% | — → 81.81% | — → 50% | — → 66.66% |
| `src/core/conversation.vibe` | 19.23% → 39.83% | 10.99% → 33.83% | 13.04% → 39.74% | 14.48% → 31.11% |
| `src/core/decide.vibe` | — → 1.81% | — → 0% | — → 0% | — → 1.14% |
| `src/core/flowDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/flows.vibe` | 22.91% → 17.57% | 0% → 0% | 0% → 0% | 19.46% → 15.42% |
| `src/core/identityDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/issueFlows.vibe` | 0% → 31.25% | 0% → 55.55% | 0% → 22.22% | 0% → 29.72% |
| `src/core/issueSchemas.vibe` | 0% → 83.33% | 100% → 100% | 0% → 0% | 0% → 83.33% |
| `src/core/mockDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/mockReplies.vibe` | 60% → 57.89% | 0% → 0% | 16.66% → 16.66% | 54.16% → 52.17% |
| `src/core/protocolDecision.vibe` | 42.85% → 35.29% | 21.87% → 15.9% | 62.5% → 55.55% | 35% → 28% |
| `src/core/roles.vibe` | 100% → 80% | 100% → 0% | 100% → 0% | 100% → 80% |
| `src/core/sandboxDecision.vibe` | 1.81% → 1.81% | 0% → 0% | 0% → 0% | 1.31% → 1.31% |
| `src/core/sandboxHost.vibe` | 0.56% → 0.57% | 0% → 0% | 0% → 0% | 0.47% → 0.47% |
| `src/core/sandboxMeter.vibe` | 0% → 3.03% | 0% → 0% | 0% → 0% | 0% → 2.56% |
| `src/core/sandboxMock.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/sandboxPolicy.vibe` | 50% → 50% | 100% → 100% | 0% → 0% | 25% → 25% |
| `src/core/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sequenceDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/specification.vibe` | — → 18.75% | — → 0% | — → 20% | — → 13.63% |
| `src/core/tourStops.vibe` | 100% → — | 100% → — | 100% → — | 100% → — |
| `src/core/walkthroughSteps.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiFlows.vibe` | — → 31.25% | — → 47.61% | — → 22.22% | — → 29.72% |
| `src/core/wikiLinks.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiSchemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 56% → 59.25% | 21.42% → 21.42% | 33.33% → 33.33% | 48.27% → 51.61% |
| `src/history/LiveMythical.vibe` | 71.79% → 73.17% | 38.46% → 41.66% | 56.25% → 56.25% | 63.63% → 63.82% |
| `src/history/MockMythical.vibe` | 2.94% → 0% | 100% → 0% | 3.57% → 0% | 2.43% → 0% |
| `src/history/MythicalHistory.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/history/Sequencer.vibe` | 2.08% → 2.08% | 0% → 0% | 0% → 0% | 1.76% → 1.76% |
| `src/history/flowMachine.vibe` | 33.33% → 21.56% | 23.68% → 12.9% | 22.22% → 13.63% | 28.12% → 17.39% |
| `src/history/flows.vibe` | 20.27% → 19.73% | 0% → 0% | 0% → 0% | 17.04% → 16.66% |
| `src/history/mythical.vibe` | 3% → 2.83% | 0% → 0% | 0% → 0% | 2.15% → 2.05% |
| `src/history/pages.vibe` | 8.33% → 8.33% | 0% → 0% | 0% → 0% | 6.52% → 6.52% |
| `src/history/roles.vibe` | 83.33% → 83.33% | 100% → 100% | 0% → 0% | 83.33% → 83.33% |
| `src/history/schemas.vibe` | 96.87% → 96.87% | 100% → 100% | 0% → 0% | 91.17% → 91.17% |
| `src/history/seed.vibe` | 9.94% → 9.94% | 0% → 0% | 0% → 0% | 8.45% → 8.45% |
| `src/history/seed/vibelang.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `src/history/tools.vibe` | 11.11% → 11.11% | 0% → 0% | 0% → 0% | 8.82% → 8.82% |
| `src/history/wire.vibe` | 51.35% → 54.28% | 10.25% → 11.42% | 20% → 20% | 40.42% → 44.18% |
| `src/surfaces/backend.vibe` | 92.3% → 62.22% | 75% → 45.71% | 50% → 35.71% | 86.66% → 51.72% |
| `src/surfaces/cli-entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/cli.vibe` | 93.75% → 93.75% | 62.5% → 70% | 83.33% → 83.33% | 88.88% → 88.88% |
| `src/surfaces/commandDecision.vibe` | 88.88% → 88.88% | 72.72% → 72.72% | 80% → 80% | 90% → 90% |
| `src/surfaces/commands.vibe` | 57.4% → 54.76% | 17.14% → 11.19% | 21.62% → 19.17% | 55.17% → 47.05% |
| `src/surfaces/manifest.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/mcp-entry.vibe` | 0% → 100% | 100% → 100% | 0% → 100% | 0% → 100% |
| `src/surfaces/mcp.vibe` | 0% → 82.35% | 0% → 0% | 0% → 83.33% | 0% → 80% |
| `src/surfaces/session.vibe` | — → 84.12% | — → 66.66% | — → 63.63% | — → 78.66% |
| `src/surfaces/sessionFlow.vibe` | — → 96.55% | — → 100% | — → 80% | — → 94.28% |
| `src/surfaces/signin.vibe` | — → 87.96% | — → 74.46% | — → 50% | — → 74.64% |
| `src/web/actionModel.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/actionView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/backend.vibe` | 58.97% → 45.31% | 45.45% → 40% | 28.57% → 15.78% | 52.17% → 41.66% |
| `src/web/entry.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `src/web/historyApp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/historyBackend.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/historyStartup.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/historyView.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/issueDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/issues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/issuesView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/main.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/markdown.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/media.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/web/modeSwitch.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/modelDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/paneDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/roleView.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/sandboxView.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/screenDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/startup.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/startupDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/styles.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/web/theatre.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/theatreDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/tourDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/view.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/viewDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/viewport.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/wikiView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Accounts.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ActionDirectory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionIdentity.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionRuns.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionsHttp.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/AgentModel.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `worker/Api.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Budget.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryActions.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/HistoryObject.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryTools.vibe` | 25% → 25% | 0% → 100% | 0% → 0% | 25% → 25% |
| `worker/Http.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/IssueCredentials.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Issues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/MainLog.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ObjectStorage.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Objects.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Reply.vibe` | 12.14% → 10.29% | 0% → 0% | 0% → 5.88% | 10.23% → 8.97% |
| `worker/SandboxAccounts.vibe` | 0% → 0% | 0% → 0% | 0% → 100% | 0% → 0% |
| `worker/SandboxHttp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SandboxMachine.vibe` | 0% → 0% | 0% → 100% | 0% → 100% | 0% → 0% |
| `worker/SandboxTools.vibe` | 18.18% → 18.18% | 0% → 0% | 0% → 0% | 16.66% → 16.66% |
| `worker/Sandboxes.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Sequencer.vibe` | 0.93% → 0.84% | 0% → 0% | 0% → 0% | 0.76% → 0.69% |
| `worker/SpecificationReviewers.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Tour.vibe` | 0% → 0% | 0% → 100% | 0% → 0% | 0% → 0% |
| `worker/Unreachable.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/VipDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiTools.vibe` | — → 11.11% | — → 0% | — → 16.66% | — → 15.38% |
| `worker/accountObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/agentContext.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/budgetDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/index.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/liveDispatchDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/machineObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/replyProgressDecision.vibe` | — → 5.88% | — → 0% | — → 10% | — → 4.54% |
| `worker/replyReasons.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |

## Chromium — diagnostic mapping

Previous snapshot: lines 43.15% (1778/4120), branches 46.41% (2293/4940), functions 56.38% (1091/1935), statements 48.38% (3077/6360).

At `9861d6f26e36`: lines 44.02% (3252/7387), branches 50.45% (6254/12394), functions 55.09% (2012/3652), statements 47.72% (5581/11695).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `infra/Stack.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `infra/WorkerBuild.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `scripts/agent-context.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/mythical-seed.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/actions/Actions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/LiveActions.vibe` | — → 4.44% | — → 0% | — → 0% | — → 4.65% |
| `src/actions/MockActions.vibe` | — → 94.11% | — → 54.16% | — → 70.45% | — → 88.26% |
| `src/actions/agent.vibe` | — → 58.33% | — → 100% | — → 42.85% | — → 48.38% |
| `src/actions/catalog.vibe` | — → 62.5% | — → 97.5% | — → 100% | — → 72.72% |
| `src/actions/execution.vibe` | — → 42.5% | — → 11.32% | — → 13.33% | — → 30.37% |
| `src/actions/tools.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/actions/wire.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/assets/wiki.generated.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/Factory.vibe` | 0% → 100% | 100% → 100% | 100% → 100% | 0% → 100% |
| `src/core/IssuesFactory.vibe` | 0% → 88.31% | 0% → 73.89% | 0% → 90% | 0% → 81.95% |
| `src/core/LiveAccounts.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/LiveFactory.vibe` | 14.1% → 12.64% | 1.92% → 1.92% | 22.72% → 20.83% | 16.27% → 14.89% |
| `src/core/LiveIssues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/LiveWiki.vibe` | — → 5.88% | — → 0% | — → 0% | — → 6.06% |
| `src/core/MockAccounts.vibe` | 95.89% → 97.61% | 54.54% → 55.55% | 76.66% → 83.87% | 92.53% → 94.66% |
| `src/core/MockFactory.vibe` | 89.26% → 90.84% | 57.57% → 60.91% | 81.69% → 79.79% | 86.7% → 87.2% |
| `src/core/MockJournal.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/VipWriter.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `src/core/WikiFactory.vibe` | — → 0% | — → 0% | — → 3.57% | — → 0% |
| `src/core/WikiWriter.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `src/core/accountCookieDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/accountCookies.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/conversation.vibe` | 74.03% → 70.53% | 58.29% → 70.4% | 82.19% → 85.71% | 71.22% → 62.78% |
| `src/core/decide.vibe` | — → 98.18% | — → 79.62% | — → 100% | — → 96.03% |
| `src/core/flowDecision.vibe` | 72.72% → 36.92% | 47.82% → 32.14% | 80% → 75% | 80% → 31.18% |
| `src/core/flows.vibe` | 79% → 77.38% | 65.88% → 61.18% | 61.7% → 53.03% | 78.53% → 79.18% |
| `src/core/identityDecision.vibe` | — → 50% | — → 75% | — → 100% | — → 33.33% |
| `src/core/issueFlows.vibe` | 0% → 91.17% | 0% → 75% | 0% → 91.66% | 0% → 92.98% |
| `src/core/issueSchemas.vibe` | 0% → 91.66% | 100% → 100% | 0% → 66.66% | 0% → 95.45% |
| `src/core/mockDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/mockReplies.vibe` | 85% → 84.21% | 50% → 50% | 55.55% → 55.55% | 78.94% → 78.37% |
| `src/core/protocolDecision.vibe` | 0% → 11.76% | 0% → 0% | 0% → 33.33% | 0% → 8% |
| `src/core/roles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sandboxDecision.vibe` | 78.18% → 78.18% | 64.7% → 64.7% | 96.55% → 96.55% | 71.28% → 71.28% |
| `src/core/sandboxHost.vibe` | 66.85% → 68.57% | 59.76% → 59.27% | 86.48% → 91.89% | 63.14% → 65.25% |
| `src/core/sandboxMeter.vibe` | 93.54% → 93.93% | 77.41% → 77.41% | 100% → 100% | 84.9% → 85.71% |
| `src/core/sandboxMock.vibe` | 96% → 96% | 25% → 29.76% | 86.66% → 90% | 92.45% → 93.39% |
| `src/core/sandboxPolicy.vibe` | 66.66% → 66.66% | 100% → 100% | 0% → 0% | 50% → 50% |
| `src/core/schemas.vibe` | 0% → 80% | 100% → 100% | 100% → 100% | 0% → 81.81% |
| `src/core/sequenceDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/specification.vibe` | — → 82.35% | — → 63.21% | — → 83.33% | — → 73.77% |
| `src/core/tourStops.vibe` | 100% → — | 100% → — | 100% → — | 100% → — |
| `src/core/walkthroughSteps.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wiki.vibe` | — → 93.33% | — → 57.77% | — → 100% | — → 84.37% |
| `src/core/wikiDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiFlows.vibe` | — → 38.23% | — → 47.61% | — → 16.66% | — → 38.59% |
| `src/core/wikiLinks.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiSchemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 28% → 33.33% | 0% → 0% | 0% → 0% | 31.42% → 36.84% |
| `src/history/LiveMythical.vibe` | 7.14% → 6.81% | 0% → 0% | 0% → 0% | 8.33% → 7.89% |
| `src/history/MockMythical.vibe` | 100% → 100% | 66.66% → 50% | 97.29% → 97.29% | 98.33% → 98.41% |
| `src/history/MythicalHistory.vibe` | 0% → 66.66% | 0% → 25% | 0% → 100% | 0% → 40% |
| `src/history/Sequencer.vibe` | 73.19% → 74.22% | 35.71% → 35.71% | 89.83% → 89.83% | 73.56% → 74.28% |
| `src/history/flowMachine.vibe` | 66.66% → 52.94% | 41.17% → 37.57% | 94.11% → 82.92% | 58.33% → 41.09% |
| `src/history/flows.vibe` | 83.11% → 82.05% | 52.5% → 47.22% | 62.16% → 63.15% | 80.57% → 80.28% |
| `src/history/mythical.vibe` | 0% → 78.01% | 0% → 67.25% | 0% → 84.61% | 0% → 74.15% |
| `src/history/pages.vibe` | 77.77% → 77.77% | 72.22% → 72.22% | 96.55% → 96.55% | 83.87% → 83.87% |
| `src/history/roles.vibe` | 57.14% → 71.42% | 100% → 100% | 0% → 100% | 70% → 80% |
| `src/history/schemas.vibe` | 0% → 62.5% | 100% → 100% | 0% → 33.33% | 0% → 64.1% |
| `src/history/seed.vibe` | 2.92% → 2.92% | 0% → 0% | 0% → 0% | 4.24% → 4.24% |
| `src/history/seed/vibelang.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/tools.vibe` | 11.11% → 11.11% | 0% → 0% | 0% → 5.88% | 13.33% → 14.89% |
| `src/history/wire.vibe` | 21.62% → 22.85% | 0% → 0% | 0% → 0% | 19.6% → 21.27% |
| `src/surfaces/backend.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/cli-entry.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/cli.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/commandDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/commands.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/manifest.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/surfaces/mcp-entry.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/surfaces/mcp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/session.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/surfaces/sessionFlow.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/surfaces/signin.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/actionModel.vibe` | — → 100% | — → 68.42% | — → 100% | — → 96.96% |
| `src/web/actionView.vibe` | — → 90% | — → 82.71% | — → 87.5% | — → 90.56% |
| `src/web/backend.vibe` | 86.36% → 85.91% | 80.95% → 73.33% | 82.14% → 82.97% | 89.41% → 86.56% |
| `src/web/entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/historyApp.vibe` | 86.22% → 86.3% | 55.8% → 57.04% | 77.35% → 77.84% | 83.38% → 84.09% |
| `src/web/historyBackend.vibe` | 96.29% → 96.29% | 66.66% → 66.66% | 90.9% → 90.9% | 98.24% → 98.24% |
| `src/web/historyStartup.vibe` | 92.59% → 93.75% | 88.88% → 68.18% | 100% → 100% | 91.11% → 92.72% |
| `src/web/historyView.vibe` | 73.17% → 82.19% | 75.73% → 77.11% | 92.06% → 92.06% | 74.78% → 81.65% |
| `src/web/issueDecision.vibe` | — → 53.93% | — → 69.16% | — → 71.79% | — → 48.02% |
| `src/web/issues.vibe` | — → 100% | — → 85.13% | — → 100% | — → 97.05% |
| `src/web/issuesView.vibe` | — → 94.87% | — → 80.42% | — → 94.11% | — → 94.16% |
| `src/web/main.vibe` | 91.13% → 80.84% | 69.49% → 64.95% | 83.5% → 78.21% | 86.29% → 78.24% |
| `src/web/markdown.vibe` | 92.59% → 57.54% | 84.61% → 43.25% | 100% → 51.16% | 90.9% → 52.91% |
| `src/web/media.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/modeSwitch.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/modelDecision.vibe` | — → 48.14% | — → 46.66% | — → 65% | — → 38.8% |
| `src/web/paneDecision.vibe` | — → 36.84% | — → 30.95% | — → 37.5% | — → 36.36% |
| `src/web/roleView.vibe` | 95.83% → 95.83% | 92.96% → 93.18% | 100% → 100% | 94.87% → 94.87% |
| `src/web/sandboxView.vibe` | 94.11% → 94.11% | 71.11% → 71.11% | 100% → 100% | 96.66% → 96.66% |
| `src/web/screenDecision.vibe` | 75% → 68.29% | 86.61% → 78.04% | 100% → 94.54% | 62.16% → 56.6% |
| `src/web/startup.vibe` | 89.65% → 94% | 100% → 62.5% | 100% → 78.94% | 91.83% → 91% |
| `src/web/startupDecision.vibe` | — → 66.66% | — → 80.55% | — → 100% | — → 50% |
| `src/web/styles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/theatre.vibe` | — → 100% | — → 93.67% | — → 100% | — → 100% |
| `src/web/theatreDecision.vibe` | — → 27.77% | — → 87.5% | — → 100% | — → 16.12% |
| `src/web/tourDecision.vibe` | — → 68.75% | — → 47.5% | — → 83.33% | — → 54.54% |
| `src/web/view.vibe` | 85.45% → 94.33% | 88.7% → 84.21% | 96.22% → 96.55% | 79.77% → 87.64% |
| `src/web/viewDecision.vibe` | — → 54.54% | — → 72.11% | — → 92.3% | — → 37.5% |
| `src/web/viewport.vibe` | 95.83% → 95.83% | 62.03% → 63.88% | 100% → 100% | 91.66% → 92.85% |
| `src/web/wikiView.vibe` | — → 96.42% | — → 63.18% | — → 83.33% | — → 93.54% |
| `worker/Accounts.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ActionDirectory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionIdentity.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionRuns.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionsHttp.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/AgentModel.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `worker/Api.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Budget.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryActions.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/HistoryObject.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryTools.vibe` | 0% → 0% | 0% → 100% | 0% → 0% | 0% → 0% |
| `worker/Http.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/IssueCredentials.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Issues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/MainLog.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ObjectStorage.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Objects.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Reply.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SandboxAccounts.vibe` | 0% → 0% | 0% → 0% | 0% → 100% | 0% → 0% |
| `worker/SandboxHttp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SandboxMachine.vibe` | 0% → 0% | 0% → 100% | 0% → 100% | 0% → 0% |
| `worker/SandboxTools.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Sandboxes.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Sequencer.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SpecificationReviewers.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Tour.vibe` | 0% → 0% | 0% → 100% | 0% → 0% | 0% → 0% |
| `worker/Unreachable.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `worker/VipDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiTools.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/accountObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/agentContext.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `worker/budgetDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/index.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/liveDispatchDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/machineObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/replyProgressDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/replyReasons.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |

## Client path regressions (Sol resume, 2026-11-08)

The new 54-case public-client matrix failed first in 14 cases (40 passed). `LiveFactory.openWiki` bypassed
identifier admission and sent a path containing `undefined` for empty, oversized or malformed UTF-16 conversation
IDs. It now uses the same admission as every other operation. `LiveActions` threw URIError for unpaired surrogates
in run filters/IDs; each method and stream now fails with typed `ActionFailure(input)` before transport. A faulty
Effect transport counts attempted calls; all invalid inputs require zero. Real loopback HTTP additionally preserves
a 128-code-unit identifier and an emoji/slash/query/fragment identifier, including the numbered wiki event and room
isolation. All 77 selected client/HTTP cases pass; no dependency, interception or compiler change is involved.

The real SQLite action-index/per-run tests additionally cover idempotent posts, changed-input conflicts, no-model
reply traces, tutorial park/cancel/rerun, current-grant checks, and Plan/Start/Note/Show through the actual history
flows. A role downgrade before alarm admission exposed an app bug: the SDK correctly cancelled the unadmitted
intent without an engine row, but the app then defected while polling that nonexistent row. The receipt adapter
now handles only `FlowExecutionNotFound` accompanied by the SDK's durable cancellation tombstone; an unexpected
missing row remains an error. Both reply and history hosts use it. The first runtime run failed one of four
cases; six action cases now pass, including a negative control without the tombstone. The new receipt path logs,
spans and counts only the bounded outcome `unadmitted-cancelled`.

The Alchemy graph matrix now also compiles the optional offline Container declaration, its machine/account DO
bindings and the linked Container resource, without provider initialization or deployment. The emitted wiki
command runs on real fixture files: nested/absolute/external/hash links, decision metadata and ruling deduplication,
ordering, non-Markdown omission, deterministic output and read failures preserving prior output. Its output lives
only in the ignored compiler fixture tree. No runtime source is excluded and no dependency was added.


## A refused history write is a failed run (2026-11-09)

Plan, Start and Note answer a refusal as a value, so their flow succeeds. The run settles as `failed` with the
refusal kept in its result, live and in mock mode, through `refused` in `src/actions/execution.vibe`.

## Paths a Node unit test can't close (2026-11-09)

The unit gate still fails below 100%. No file below is excluded and no threshold changed; each stays counted as uncovered.

| Path | Needs | Test that covers it once available |
| --- | --- | --- |
| `worker/SandboxMachine.vibe`, Container paths of `worker/SandboxAccounts.vibe` | A real Container binding. Live sandboxes wait on Will's yes/no (Containers spend). No scripted Container namespace. | `test/sandbox.container.workerd.test.vibe`, opt-in on `VIBELANG_SANDBOX_TEST_URL` and `VIBELANG_SANDBOX_TEST_COOKIE`, skipped with that reason |
| `worker/Api.vibe` | Workerd isolate coverage. Its Durable Object wiring runs only in workerd, and a Node run would need scripted namespaces. | `pnpm test:workerd`, once VibeLang 0.0.13 is on npm with the source-map fix (`f5d37aa764af`) and workerd reports precise coverage |
| `worker/SpecificationReviewers.vibe` | Stays unbound by decision 0027. | None until it is bound |
| `worker/VipDraft.vibe`, model paths of `worker/Reply.vibe` | A model credential reference in the environment. | `test/live.workerd.test.vibe` covers Reply, opt-in on `CEREBRAS_API_KEY`. `test/vipDraft.test.vibe` covers `VipDraft`, opt-in on the same key |
| GitHub read, write, VIP proposal and label paths of `worker/Issues.vibe` (`githubHost`) | Needs the GitHub test token: a real GitHub token for the test repository. No fake GitHub (`test/issuesGithub.coverage.test.vibe` was one and is deleted). | `test/issues.github.test.vibe`, opt-in on `GITHUB_TEST_TOKEN` |
| GitHub write paths of `worker/Wiki.vibe` | A real GitHub token for the test repository. | `test/wikiEdit.github.test.vibe`, opt-in on `GITHUB_TEST_TOKEN` |

## Lane vl-coverage2 (2026-11-09)

A second unit lane beside vl-coverage, on the files vl-coverage does not own. Same provider, thresholds and
`pnpm test:coverage`; nothing excluded and no threshold changed. Unit suite only: the browser, workerd, fuzz and
benchmark suites were not measured by this lane.

Before is main `92651c71` (1407 passed / 3 skipped). After is this lane's last commit on a later main (1488 passed /
3 skipped); the All files row includes other lanes' work landed between them.

| File | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- |
| `worker/Http.vibe` | 82/93 (88.17%) → 93/93 (100%) | 82/106 (77.35%) → 104/104 (100%) | 17/23 (73.91%) → 23/23 (100%) | 102/126 (80.95%) → 126/126 (100%) |
| `src/web/backend.vibe` | 52/73 (71.23%) → 64/64 (100%) | 18/25 (72%) → 15/15 (100%) | 22/38 (57.89%) → 38/38 (100%) | 55/86 (63.95%) → 72/72 (100%) |
| `src/core/MockFactory.vibe` | 239/254 (94.09%) → 254/259 (98.06%) | 126/152 (82.89%) → 135/141 (95.74%) | 75/80 (93.75%) → 78/78 (100%) | 290/311 (93.24%) → 306/314 (97.45%) |
| `src/actions/MockActions.vibe` | 114/118 (96.61%) → 114/114 (100%) | 73/95 (76.84%) → 89/89 (100%) | 31/40 (77.5%) → 36/36 (100%) | 139/159 (87.42%) → 151/151 (100%) |
| `src/actions/execution.vibe` | 32/41 (78.04%) → 39/39 (100%) | 32/38 (84.21%) → 36/36 (100%) | 13/17 (76.47%) → 17/17 (100%) | 43/53 (81.13%) → 51/51 (100%) |
| `src/core/conversation.vibe` | 232/241 (96.26%) → 241/241 (100%) | 378/402 (94.02%) → 402/402 (100%) | 74/78 (94.87%) → 78/78 (100%) | 310/331 (93.65%) → 331/331 (100%) |
| `src/core/LiveWiki.vibe` | 5/15 (33.33%) → 15/15 (100%) | 0/4 (0%) → 4/4 (100%) | 3/10 (30%) → 10/10 (100%) | 6/21 (28.57%) → 21/21 (100%) |
| All files | 6379/7178 (88.86%) → 6582/7251 (90.77%) | 6709/7843 (85.54%) → 6951/7936 (87.58%) | 2249/2677 (84.01%) → 2342/2709 (86.45%) | 7950/9249 (85.95%) → 8274/9354 (88.45%) |

**Bug fixed.** A tour or demo conversation's retained `MockJournal` can end mid-reply. Restoring it left the room
busy forever: later posts were never answered and a tour was refused `busy`. Restoring now fails that reply with the
live wording (0014). Regression: `test/mockFactory.coverage.test.vibe`, red first (reply unfinished after 10 s).

**Dead code deleted** (each named in its commit): tour-control's integer and negative step checks (`Seq` rejects
both); the browser factory's "unavailable" throws for issues, wiki and tour control (both selectable factories supply
them); `EndTour`'s action invocation kind, execute case and mock registration (internal, refused by every gate before
`prepare`); MockActions' `invalid-run` and `cancel-failed` mappings and missing-invocation checks; `Tours.finish`'s
unused reason; MockFactory's `account-unavailable` mapping, the scripted agent's wiki read, history and prompt
fallbacks and two always-defined `??` fallbacks.

**Left uncovered in `src/core/MockFactory.vibe`, not excluded:**

| Lines | Why a test can't reach it deterministically |
| --- | --- |
| 90-97 | Covered since 2026-11-09 by `test/mockReplyRace.coverage.test.vibe`. The mock reads `Digest` from context; a Digest that holds the reply's first journaled digest on a latch opens the window between dispatch and `StartReply`, and a second latch on the handed tour's `vibelang/tour/start` step opens the window before its run starts. |
| 102 | Deleted 2026-11-09. `StartReply` refused for a reason other than `busy` needs a second dispatch of the post, which the answer loop never makes, or 2^53 events. The start step now has no success value and every refusal is contention. |
| 327 | `Tours.ended` after the tour already ended: between `running` and the subscription. Nothing in that window calls a service a test can hold, so only the fiber scheduler reaches it; the check keeps `ended` from waiting forever. |

**Flow bodies (fixed 2026-11-09).** `src/core/flows.vibe` had 14 flows whose `body` was `() => Node.succeed(…)` and
whose behavior `engine.register` attached at registration, a second, opaque shape the flow package documents as
internal. Each body now sequences one declared action per step it journaled before, in the same order:
`vibelang/post/record` then `vibelang/post/dispatch`, `vibelang/tour/record` then `vibelang/tour/dispatch`,
`vibelang/tour/start` then `vibelang/tour/guide`, `vibelang/tour/end` then `vibelang/tour/wake`, and
`vibelang/tour/request/<control>` then `vibelang/tour/signal`. A step that runs only after an accepted one is a
`Node.branch`. Reply is one step, `vibelang/reply/answer`: what it does inside is its host's composition. The docs
and wiki tools are one `…/pane/open` step, and the sandbox flows their `…/commit` step. Each host attaches the steps'
implementations with `Interpreter.layerWithImplementations`; they read `Posts`, `Tours`, `SandboxHost` and
`ActionDevice` from context. Mock actions guide a tour by following the factory's events until that tour ends.
`test/flowBodies.test.vibe` pins every step name and both arms of each branch, so the journal, the Actions pane
(`bench/browser.spec.ts` "chat, scroll, home, tour and escape actions"), spans and metrics name real steps. The first
version of this fix (44053da0) wrapped each body in one `<flow>/perform` step, and the Actions pane showed
`perform · running` instead of the tour's `start` and `guide`. Resuming a run journaled before either change (a tour
parked across the deploy) is untested.

**More flow bodies (2026-11-09).** The same rule now holds for four more flows. `vibelang/GrantRole`
(`src/core/MockAccounts.vibe`) is its `vibelang/role/record` step. `vibelang/actions/Request`
(`worker/ActionDirectory.vibe`) is `vibelang/actions/index` then `vibelang/actions/start`, and `vibelang/actions/Cancel`
is `vibelang/actions/cancel`; the steps act on the request admitted at the door, so a replay's JSON conflict check
compares identical bytes. `vibelang/Session` (`src/surfaces/sessionFlow.vibe`) branches on its payload to
`vibelang/session/login`, `…/poll` or `…/logout`. The seven history flows (`src/history/flows.vibe`, `tools.vibe`) still
have placeholder bodies: Plan, Start, Note and show also run on the action host (`src/actions/execution.vibe`,
`worker/HistoryActions.vibe`), which calls the history through `HistoryReader` and has no `Caller` principal to journal
the history's `authorize` step. Closing them needs that principal on the action host.

**A reply-started tour stayed parked (fixed 2026-11-09).** A reply refused `busy` by a tour accepted after its
dispatch ran that tour as its own child execution. Ending the tour woke only the tour the answer loop started, so the
child stayed parked forever with no `vibelang.tour.run` outcome, though the reply still answered. Now each room has one
tour sequencer, the only driver of `vibelang/Tour` runs: the answer loop and a contended reply both hand it the tour
and wait for that run to end, and `Tours.wake` resumes the sequencer's run. Regression: case 1 of
`test/mockReplyRace.coverage.test.vibe` (ending the tour logs the run's `inactive` outcome); it failed before the fix
with no outcome. The same case still asserts the reply answers, which caught the earlier two-driver hang.

**Service Shape spread.** `test/support/overlaidAccounts.vibe` lists the `Accounts` members, as `overlaid.vibe` does
`Factory`'s, because spreading a service Shape drops its methods in VibeLang 0.0.12. The upstream fix awaits
publication (roadmap, vl-actions); the helper can become a spread once 0.0.13 is consumed.

## vl-coverage, ninth session (2026-11-09)

Unit suite only, same provider and thresholds; nothing excluded, no threshold changed. Before is the run at
`5353bea5` (1561 passed / 3 skipped); after is the run on this session's last test commit (1655 passed / 3 skipped).
All files: lines 90.82% → 91.38%, branches 87.86% → 89.48%, functions 88.84% → 89.91%, statements 88.91% → 89.75%.
Counts are covered/total; lines count lines that start a statement.

| File | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- |
| `src/web/main.vibe` | 665/665 → 664/664 | 836/841 → 821/823 | 371/371 → 370/370 | 883/883 → 882/882 |
| `src/surfaces/signin.vibe` | 106/108 → 108/108 | 85/94 → 93/94 | 16/26 → 25/26 | 127/142 → 141/142 |
| `src/web/actionView.vibe` | 26/30 → 30/30 | 106/125 → 123/123 | 21/27 → 27/27 | 35/41 → 41/41 |
| `src/web/view.vibe` | 53/53 → 53/53 | 143/173 → 160/163 | 33/33 → 33/33 | 57/58 → 58/58 |
| `src/web/issueDecision.vibe` | 90/91 → 91/91 | 230/257 → 257/257 | 21/22 → 22/22 | 141/142 → 142/142 |
| `src/core/IssuesFactory.vibe` | 74/76 → 74/75 | 105/122 → 114/120 | 16/16 → 16/16 | 90/100 → 96/99 |
| `src/web/startup.vibe` | 46/50 → 47/50 | 10/22 → 18/22 | 11/13 → 11/13 | 51/64 → 55/64 |
| `src/history/mythical.vibe` | 135/141 → 141/141 | 181/191 → 190/191 | 28/29 → 29/29 | 180/195 → 194/195 |
| `src/surfaces/backend.vibe` | 41/45 → 45/45 | 24/35 → 33/35 | 9/14 → 12/14 | 49/58 → 55/58 |

Types that forced a default that cannot happen were fixed instead of tested: `update` always answers a commands list
(`WithCommands`), `Model.theatre` is required (init sets it, nothing clears it), `fixtureHost`'s lock is required,
and `model.tourError ?? ""` and `split("/").at(-1) ?? name` are gone.

Left uncovered in these files, each still counted:

| Where | Why no test reaches it |
| --- | --- |
| `src/web/main.vibe:403`, two arms | The connect, fork and install wording; decision 0165's lane owns connect. |
| `src/surfaces/signin.vibe:88` | The session file removed by another process between `login` writing it and reading it back. |
| `src/surfaces/signin.vibe:116` | The durable wait's own journal failing after a poll succeeded; needs a FileSystem fault at one call. |
| `src/web/view.vibe:46`, `:147` | `WALKTHROUGH[step - 1]` missing; the theatre's step stays within 1 to 10. Indexed access types it optional. |
| `src/core/IssuesFactory.vibe:52` | The host's own permission and execution-id check; `act` authorizes and derives the id first. |
| `src/core/IssuesFactory.vibe:62` | An empty key; `IssueRequest`'s `DurableText` refuses it before a flow runs. |
| `src/core/IssuesFactory.vibe:93` | The `switch`'s `default`; every non-creating write is one of its cases. |
| `src/core/IssuesFactory.vibe:115`, `:123`, `:126` | A request op with no flow, and an engine failure other than an id conflict. |
| `src/history/mythical.vibe:562` | `rank < 0` after `epicOf` matched; the commit exists, so it has a rank. Kept for the proof. |
| `src/surfaces/backend.vibe:61` | A request to another origin; no live client sends one. Kept: it keeps the cookie on its origin. |
| `src/surfaces/backend.vibe:80`, `:83` | A mock session read that fails, and mock accounts missing; `mockFactoryFor` always has accounts (vl-coverage2's file). |
| `src/web/startup.vibe:72` to `:75` | Reachable, not yet tested: the browser journal of tour and demo conversations, reached by running a tour on the started page. |
