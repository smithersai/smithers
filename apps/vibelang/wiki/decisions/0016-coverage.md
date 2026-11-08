# 0016. Coverage of the VibeLang sources

**Status:** in progress, 2026-11-07. **Rulings:** VL-5, VL-7, VL-14, VL-29.

The goal remains 100% lines, branches, functions and statements for each production file, independently per suite.
That goal has **not been achieved**. No source file is excluded. This decision records landed behavioral tests and
the coverage prototype retained by lane `vl-coverage`; the new coverage commands and PACKAGE gates are not yet on
main because the gate is red and the lane's landing instruction requires green parts.

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
Snapshot provenance: unit at `af56fa418a48`; workerd and Chromium at `efb00d0f5854`, with the retained strict-gate prototype. Later source additions and passing ordinary tests do not change these frozen measurements.

Percentages show **before → after**, independently for each suite. A dash means the file was absent from that
snapshot's source roster, not excluded. CSV retains every covered/executable count. The initial unit snapshot has 38
files and one timing-related assertion failure; the refreshed snapshots have 90 runtime files. Workerd and browser had no original
pre-work baseline: their before columns are the first retained earlier instrumented snapshots, already during the
lane's work. Different source rosters and the corrected provider mean these are snapshots, not a controlled delta.
Workerd values count Node execution only. All Chromium values remain diagnostic pending the bundled source-range
fix; even an unexecuted source return can receive a false statement hit. No production file is excluded.

## Unit

Before: lines 65.25% (849/1301), branches 68.36% (590/863), functions 59.68% (268/449), statements 63.53% (1007/1585).

After: lines 77.51% (3133/4042), branches 75.2% (2509/3336), functions 68.19% (995/1459), statements 73.72% (3727/5055).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `infra/Stack.vibe` | 0% → 100% | 0% → 100% | 100% → 100% | 0% → 100% |
| `infra/WorkerBuild.vibe` | 0% → 100% | 100% → 100% | 100% → 100% | 0% → 100% |
| `scripts/agent-context.vibe` | 0% → 100% | 0% → 100% | 0% → 100% | 0% → 100% |
| `scripts/mythical-seed.vibe` | — → 100% | — → 94.44% | — → 93.75% | — → 96.92% |
| `src/core/Factory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/IssuesFactory.vibe` | — → 92.3% | — → 76.76% | — → 100% | — → 81.81% |
| `src/core/LiveAccounts.vibe` | — → 28% | — → 0% | — → 8.33% | — → 22.58% |
| `src/core/LiveFactory.vibe` | 25% → 70% | 8.33% → 40% | 27.27% → 94.44% | 24.44% → 67.07% |
| `src/core/MockAccounts.vibe` | — → 98.52% | — → 86.66% | — → 91.66% | — → 95.6% |
| `src/core/MockFactory.vibe` | 100% → 97% | 87.5% → 84.72% | 100% → 96.42% | 97.41% → 95.16% |
| `src/core/conversation.vibe` | 100% → 98.07% | 96.68% → 91.75% | 100% → 95.65% | 96.89% → 96.46% |
| `src/core/flowDecision.vibe` | — → 90.9% | — → 94.11% | — → 100% | — → 91.66% |
| `src/core/flows.vibe` | 89.23% → 90.62% | 97.36% → 95.34% | 70.83% → 71.87% | 88.73% → 90.26% |
| `src/core/issueFlows.vibe` | — → 90.62% | — → 100% | — → 88.88% | — → 91.89% |
| `src/core/issueSchemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/mockDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/mockReplies.vibe` | 100% → 100% | 100% → 75% | 100% → 83.33% | 100% → 95.83% |
| `src/core/protocolDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/roles.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/sandboxDecision.vibe` | — → 96.36% | — → 84.72% | — → 93.33% | — → 86.84% |
| `src/core/sandboxHost.vibe` | — → 85.39% | — → 78.72% | — → 96.29% | — → 80.09% |
| `src/core/sandboxMeter.vibe` | — → 100% | — → 94.28% | — → 100% | — → 94.59% |
| `src/core/sandboxMock.vibe` | — → 100% | — → 62.22% | — → 91.3% | — → 91.66% |
| `src/core/sandboxPolicy.vibe` | — → 100% | — → 100% | — → 66.66% | — → 75% |
| `src/core/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sequenceDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/tourStops.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 100% → 100% | 86.2% → 100% | 100% → 100% | 94.11% → 100% |
| `src/history/LiveMythical.vibe` | — → 100% | — → 92.3% | — → 100% | — → 97.72% |
| `src/history/MockMythical.vibe` | — → 100% | — → 100% | — → 96.42% | — → 97.56% |
| `src/history/MythicalHistory.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/history/Sequencer.vibe` | — → 92.7% | — → 75% | — → 100% | — → 90.26% |
| `src/history/flowMachine.vibe` | — → 100% | — → 94.73% | — → 100% | — → 93.75% |
| `src/history/flows.vibe` | — → 89.18% | — → 80% | — → 75% | — → 88.63% |
| `src/history/mythical.vibe` | — → 98.49% | — → 95.76% | — → 100% | — → 94.62% |
| `src/history/pages.vibe` | — → 100% | — → 93.33% | — → 100% | — → 100% |
| `src/history/roles.vibe` | — → 83.33% | — → 100% | — → 0% | — → 83.33% |
| `src/history/schemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/history/seed.vibe` | — → 99.41% | — → 89.71% | — → 100% | — → 98% |
| `src/history/seed/vibelang.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/history/tools.vibe` | — → 96.29% | — → 93.61% | — → 88.88% | — → 97.05% |
| `src/history/wire.vibe` | — → 100% | — → 97.43% | — → 100% | — → 100% |
| `src/surfaces/backend.vibe` | 72.72% → 76.92% | 66.66% → 50% | 75% → 75% | 69.23% → 73.33% |
| `src/surfaces/cli-entry.vibe` | 0% → 100% | 0% → 100% | 0% → 100% | 0% → 100% |
| `src/surfaces/cli.vibe` | 0% → 100% | 0% → 87.5% | 0% → 100% | 0% → 94.44% |
| `src/surfaces/commandDecision.vibe` | — → 100% | — → 84.84% | — → 100% | — → 100% |
| `src/surfaces/commands.vibe` | 90.74% → 89.81% | 72.22% → 75.71% | 63.63% → 70.27% | 84.61% → 86.2% |
| `src/surfaces/manifest.vibe` | 0% → 100% | 100% → 100% | 0% → 100% | 0% → 100% |
| `src/surfaces/mcp-entry.vibe` | 0% → 100% | 100% → 100% | 0% → 100% | 0% → 100% |
| `src/surfaces/mcp.vibe` | 0% → 100% | 0% → 50% | 0% → 100% | 0% → 94.11% |
| `src/web/backend.vibe` | 85.71% → 76.92% | 66.66% → 100% | 80% → 57.14% | 86.66% → 71.73% |
| `src/web/entry.vibe` | 0% → 0% | 100% → 0% | 100% → 100% | 0% → 0% |
| `src/web/historyApp.vibe` | — → 62.58% | — → 73.19% | — → 48.48% | — → 57.48% |
| `src/web/historyBackend.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/historyStartup.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/historyView.vibe` | — → 85.36% | — → 80% | — → 88.37% | — → 85.71% |
| `src/web/main.vibe` | 86.15% → 72.59% | 79.27% → 68.96% | 80.48% → 59.41% | 80.48% → 63.48% |
| `src/web/markdown.vibe` | 100% → 100% | 93.75% → 100% | 100% → 100% | 100% → 100% |
| `src/web/media.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/roleView.vibe` | — → 83.33% | — → 81.25% | — → 71.42% | — → 85.18% |
| `src/web/sandboxView.vibe` | — → 94.11% | — → 91.3% | — → 83.33% | — → 94.73% |
| `src/web/screenDecision.vibe` | — → 100% | — → 92.95% | — → 100% | — → 94.28% |
| `src/web/startup.vibe` | 96% → 96.55% | 50% → 75% | 100% → 100% | 93.1% → 94.11% |
| `src/web/styles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/view.vibe` | 100% → 100% | 97.4% → 93.79% | 100% → 100% | 100% → 98.38% |
| `src/web/viewport.vibe` | 97.5% → 100% | 86.79% → 98.27% | 92.85% → 100% | 92.45% → 100% |
| `worker/Accounts.vibe` | — → 14.11% | — → 12.85% | — → 11.9% | — → 13.77% |
| `worker/AgentModel.vibe` | 0% → 100% | 100% → 100% | 0% → 100% | 0% → 100% |
| `worker/Api.vibe` | 0% → 26.22% | 0% → 0% | 0% → 0% | 0% → 23.18% |
| `worker/Budget.vibe` | 18.75% → 100% | 0% → 100% | 0% → 100% | 16.66% → 100% |
| `worker/HistoryObject.vibe` | — → 10% | — → 6.66% | — → 3.03% | — → 8% |
| `worker/HistoryTools.vibe` | — → 50% | — → 50% | — → 33.33% | — → 50% |
| `worker/Http.vibe` | 20.51% → 100% | 18.42% → 95.71% | 9.09% → 94.11% | 17.64% → 97.75% |
| `worker/MainLog.vibe` | — → 67.44% | — → 68.96% | — → 58.33% | — → 63.33% |
| `worker/ObjectStorage.vibe` | 10% → 10% | 0% → 0% | 0% → 0% | 7.14% → 7.14% |
| `worker/Objects.vibe` | 8.47% → 9.58% | 0% → 4% | 4.87% → 8.69% | 6.75% → 7.44% |
| `worker/Reply.vibe` | 34.57% → 59.81% | 32.94% → 61.33% | 37.5% → 58.82% | 33.07% → 59.05% |
| `worker/SandboxAccounts.vibe` | — → 10% | — → 2.7% | — → 0% | — → 7.69% |
| `worker/SandboxHttp.vibe` | — → 13.33% | — → 0% | — → 0% | — → 9.52% |
| `worker/SandboxMachine.vibe` | — → 1.51% | — → 0% | — → 0% | — → 1.05% |
| `worker/SandboxTools.vibe` | — → 72.72% | — → 50% | — → 70% | — → 75% |
| `worker/Sandboxes.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Sequencer.vibe` | 61.38% → 94.39% | 33.84% → 96.29% | 61.11% → 90.69% | 56.34% → 95.38% |
| `worker/Tour.vibe` | 46.66% → 59.45% | 16.66% → 28.57% | 35.29% → 54.54% | 41.81% → 54.54% |
| `worker/Unreachable.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/agentContext.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/budgetDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `worker/index.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/replyReasons.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |

## Workerd — Node clients only

Before: lines 17.7% (373/2107), branches 6.18% (89/1440), functions 7.98% (61/764), statements 15% (397/2646).

After: lines 11.7% (473/4042), branches 3.56% (119/3336), functions 4.72% (69/1459), statements 9.57% (484/5055).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `infra/Stack.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `infra/WorkerBuild.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `scripts/agent-context.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/mythical-seed.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/Factory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/IssuesFactory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/LiveAccounts.vibe` | — → 28% | — → 0% | — → 8.33% | — → 22.58% |
| `src/core/LiveFactory.vibe` | 100% → 62.85% | 71.42% → 23.33% | 92.3% → 61.11% | 89.13% → 53.65% |
| `src/core/MockAccounts.vibe` | — → 2.94% | — → 0% | — → 0% | — → 2.19% |
| `src/core/MockFactory.vibe` | 4.47% → 3.59% | 0% → 0% | 0% → 3.57% | 3.29% → 2.89% |
| `src/core/conversation.vibe` | 33.62% → 19.23% | 20.23% → 10.99% | 27.5% → 13.04% | 26.03% → 14.48% |
| `src/core/flowDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/flows.vibe` | 22.72% → 22.91% | 0% → 0% | 0% → 0% | 20.83% → 19.46% |
| `src/core/issueFlows.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/issueSchemas.vibe` | — → 0% | — → 100% | — → 0% | — → 0% |
| `src/core/mockDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/mockReplies.vibe` | 58.82% → 60% | 0% → 0% | 20% → 16.66% | 47.82% → 54.16% |
| `src/core/protocolDecision.vibe` | — → 42.85% | — → 21.87% | — → 62.5% | — → 35% |
| `src/core/roles.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/sandboxDecision.vibe` | — → 1.81% | — → 0% | — → 0% | — → 1.31% |
| `src/core/sandboxHost.vibe` | — → 0.56% | — → 0% | — → 0% | — → 0.47% |
| `src/core/sandboxMeter.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/sandboxMock.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/sandboxPolicy.vibe` | — → 50% | — → 100% | — → 0% | — → 25% |
| `src/core/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sequenceDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/tourStops.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 42.3% → 56% | 0% → 21.42% | 33.33% → 33.33% | 31.42% → 48.27% |
| `src/history/LiveMythical.vibe` | 66.66% → 71.79% | 38.46% → 38.46% | 50% → 56.25% | 60.52% → 63.63% |
| `src/history/MockMythical.vibe` | 3.33% → 2.94% | 100% → 100% | 8.33% → 3.57% | 2.85% → 2.43% |
| `src/history/MythicalHistory.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/history/Sequencer.vibe` | 0% → 2.08% | 0% → 0% | 0% → 0% | 0% → 1.76% |
| `src/history/flowMachine.vibe` | — → 33.33% | — → 23.68% | — → 22.22% | — → 28.12% |
| `src/history/flows.vibe` | 19.71% → 20.27% | 0% → 0% | 0% → 0% | 15.9% → 17.04% |
| `src/history/mythical.vibe` | 3.3% → 3% | 0% → 0% | 0% → 0% | 2.2% → 2.15% |
| `src/history/pages.vibe` | — → 8.33% | — → 0% | — → 0% | — → 6.52% |
| `src/history/roles.vibe` | 57.14% → 83.33% | 0% → 100% | 0% → 0% | 50% → 83.33% |
| `src/history/schemas.vibe` | 100% → 96.87% | 100% → 100% | 100% → 0% | 100% → 91.17% |
| `src/history/seed.vibe` | 9.27% → 9.94% | 0% → 0% | 0% → 0% | 6.96% → 8.45% |
| `src/history/seed/vibelang.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `src/history/tools.vibe` | — → 11.11% | — → 0% | — → 0% | — → 8.82% |
| `src/history/wire.vibe` | 55.55% → 51.35% | 0% → 10.25% | 0% → 20% | 41.66% → 40.42% |
| `src/surfaces/backend.vibe` | 92.3% → 92.3% | 83.33% → 75% | 42.85% → 50% | 86.66% → 86.66% |
| `src/surfaces/cli-entry.vibe` | 100% → 100% | 100% → 100% | 66.66% → 100% | 100% → 100% |
| `src/surfaces/cli.vibe` | 93.75% → 93.75% | 62.5% → 62.5% | 71.42% → 83.33% | 88.88% → 88.88% |
| `src/surfaces/commandDecision.vibe` | — → 88.88% | — → 72.72% | — → 80% | — → 90% |
| `src/surfaces/commands.vibe` | 65.3% → 57.4% | 34.32% → 17.14% | 24.24% → 21.62% | 63.02% → 55.17% |
| `src/surfaces/manifest.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/mcp-entry.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/surfaces/mcp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/backend.vibe` | 82.14% → 58.97% | 50% → 45.45% | 60% → 28.57% | 80% → 52.17% |
| `src/web/entry.vibe` | 0% → 0% | 100% → 0% | 100% → 100% | 0% → 0% |
| `src/web/historyApp.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/historyBackend.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/historyStartup.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/historyView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/main.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/markdown.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/media.vibe` | — → 0% | — → 100% | — → 0% | — → 0% |
| `src/web/roleView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/sandboxView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/screenDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/startup.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/styles.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/web/view.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/viewport.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Accounts.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/AgentModel.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `worker/Api.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Budget.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryObject.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryTools.vibe` | — → 25% | — → 0% | — → 0% | — → 25% |
| `worker/Http.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/MainLog.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ObjectStorage.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Objects.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Reply.vibe` | 12.87% → 12.14% | 0% → 0% | 0% → 0% | 10.92% → 10.23% |
| `worker/SandboxAccounts.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/SandboxHttp.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/SandboxMachine.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/SandboxTools.vibe` | — → 18.18% | — → 0% | — → 0% | — → 16.66% |
| `worker/Sandboxes.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Sequencer.vibe` | 0.99% → 0.93% | 0% → 0% | 0% → 0% | 0.79% → 0.76% |
| `worker/Tour.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Unreachable.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/agentContext.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/budgetDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/index.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/replyReasons.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |

## Chromium — diagnostic mapping

Before: lines 47.87% (1182/2469), branches 53.72% (1313/2444), functions 61.93% (729/1177), statements 53.08% (1953/3679).

After: lines 43.15% (1778/4120), branches 46.41% (2293/4940), functions 56.38% (1091/1935), statements 48.38% (3077/6360).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `infra/Stack.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `infra/WorkerBuild.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `scripts/agent-context.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/mythical-seed.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/Factory.vibe` | 100% → 0% | 100% → 100% | 100% → 100% | 100% → 0% |
| `src/core/IssuesFactory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/LiveAccounts.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/LiveFactory.vibe` | 22.72% → 14.1% | 7.14% → 1.92% | 33.33% → 22.72% | 27.14% → 16.27% |
| `src/core/MockAccounts.vibe` | — → 95.89% | — → 54.54% | — → 76.66% | — → 92.53% |
| `src/core/MockFactory.vibe` | 92.95% → 89.26% | 61.45% → 57.57% | 92% → 81.69% | 89.05% → 86.7% |
| `src/core/conversation.vibe` | 87.93% → 74.03% | 66.41% → 58.29% | 90% → 82.19% | 80.9% → 71.22% |
| `src/core/flowDecision.vibe` | 50% → 72.72% | 47.05% → 47.82% | 66.66% → 80% | 50% → 80% |
| `src/core/flows.vibe` | 73.52% → 79% | 69.11% → 65.88% | 61.11% → 61.7% | 74.77% → 78.53% |
| `src/core/issueFlows.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/issueSchemas.vibe` | — → 0% | — → 100% | — → 0% | — → 0% |
| `src/core/mockDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/mockReplies.vibe` | 100% → 85% | 100% → 50% | 100% → 55.55% | 89.65% → 78.94% |
| `src/core/protocolDecision.vibe` | 14.28% → 0% | 0% → 0% | 36.36% → 0% | 10% → 0% |
| `src/core/roles.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/sandboxDecision.vibe` | — → 78.18% | — → 64.7% | — → 96.55% | — → 71.28% |
| `src/core/sandboxHost.vibe` | — → 66.85% | — → 59.76% | — → 86.48% | — → 63.14% |
| `src/core/sandboxMeter.vibe` | — → 93.54% | — → 77.41% | — → 100% | — → 84.9% |
| `src/core/sandboxMock.vibe` | — → 96% | — → 25% | — → 86.66% | — → 92.45% |
| `src/core/sandboxPolicy.vibe` | — → 66.66% | — → 100% | — → 0% | — → 50% |
| `src/core/schemas.vibe` | 35.29% → 0% | 100% → 100% | 100% → 100% | 45% → 0% |
| `src/core/sequenceDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/tourStops.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 28.57% → 28% | 0% → 0% | 0% → 0% | 33.33% → 31.42% |
| `src/history/LiveMythical.vibe` | 10.81% → 7.14% | 0% → 0% | 0% → 0% | 13.11% → 8.33% |
| `src/history/MockMythical.vibe` | 100% → 100% | 66.66% → 66.66% | 96.15% → 97.29% | 98% → 98.33% |
| `src/history/MythicalHistory.vibe` | 66.66% → 0% | 25% → 0% | 100% → 0% | 40% → 0% |
| `src/history/Sequencer.vibe` | 73.62% → 73.19% | 42.1% → 35.71% | 93.75% → 89.83% | 75.97% → 73.56% |
| `src/history/flowMachine.vibe` | — → 66.66% | — → 41.17% | — → 94.11% | — → 58.33% |
| `src/history/flows.vibe` | 82.43% → 83.11% | 58.33% → 52.5% | 62.16% → 62.16% | 80.76% → 80.57% |
| `src/history/mythical.vibe` | 80.16% → 0% | 68.93% → 0% | 84.21% → 0% | 77.07% → 0% |
| `src/history/pages.vibe` | — → 77.77% | — → 72.22% | — → 96.55% | — → 83.87% |
| `src/history/roles.vibe` | 75% → 57.14% | 37.5% → 100% | 100% → 0% | 72.72% → 70% |
| `src/history/schemas.vibe` | 100% → 0% | 100% → 100% | 100% → 0% | 100% → 0% |
| `src/history/seed.vibe` | 3.31% → 2.92% | 0% → 0% | 0% → 0% | 4.83% → 4.24% |
| `src/history/seed/vibelang.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/tools.vibe` | — → 11.11% | — → 0% | — → 0% | — → 13.33% |
| `src/history/wire.vibe` | 44.44% → 21.62% | 0% → 0% | 0% → 0% | 38.46% → 19.6% |
| `src/surfaces/backend.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/cli-entry.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/cli.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/commandDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/surfaces/commands.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/manifest.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/surfaces/mcp-entry.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/surfaces/mcp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/backend.vibe` | 87.87% → 86.36% | 75% → 80.95% | 81.25% → 82.14% | 90.74% → 89.41% |
| `src/web/entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/historyApp.vibe` | 84.49% → 86.22% | 59.74% → 55.8% | 79.41% → 77.35% | 83.7% → 83.38% |
| `src/web/historyBackend.vibe` | 95.83% → 96.29% | 50% → 66.66% | 73.68% → 90.9% | 91.66% → 98.24% |
| `src/web/historyStartup.vibe` | 85.18% → 92.59% | 83.33% → 88.88% | 100% → 100% | 84.44% → 91.11% |
| `src/web/historyView.vibe` | 71.95% → 73.17% | 78.01% → 75.73% | 88.4% → 92.06% | 73.22% → 74.78% |
| `src/web/main.vibe` | 95.07% → 91.13% | 83.57% → 69.49% | 95.74% → 83.5% | 92.21% → 86.29% |
| `src/web/markdown.vibe` | 92.59% → 92.59% | 84.61% → 84.61% | 100% → 100% | 90.9% → 90.9% |
| `src/web/media.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/roleView.vibe` | — → 95.83% | — → 92.96% | — → 100% | — → 94.87% |
| `src/web/sandboxView.vibe` | — → 94.11% | — → 71.11% | — → 100% | — → 96.66% |
| `src/web/screenDecision.vibe` | 75% → 75% | 85.21% → 86.61% | 100% → 100% | 62.16% → 62.16% |
| `src/web/startup.vibe` | 92.3% → 89.65% | 100% → 100% | 100% → 100% | 93.02% → 91.83% |
| `src/web/styles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/view.vibe` | 82.22% → 85.45% | 85.03% → 88.7% | 95.45% → 96.22% | 74.62% → 79.77% |
| `src/web/viewport.vibe` | 97.5% → 95.83% | 65.71% → 62.03% | 100% → 100% | 93.24% → 91.66% |
| `worker/Accounts.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/AgentModel.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `worker/Api.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Budget.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryObject.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryTools.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Http.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/MainLog.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ObjectStorage.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Objects.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Reply.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SandboxAccounts.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/SandboxHttp.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/SandboxMachine.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/SandboxTools.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Sandboxes.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Sequencer.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Tour.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Unreachable.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `worker/agentContext.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `worker/budgetDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/index.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/replyReasons.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |

<!-- measurements:end -->

Browser boundary cases additionally cover the default answer, rejected/unavailable tour starts, retry after an
unavailable end, and native touch end/cancellation followed by Latest. Read-only native event evidence distinguishes
an earlier follow scroll's end from the actual gesture ending; the test waits for the latter before tapping.

The source-map control and generator-process checkpoint declares the root's patched coverage provider and matching
Vitest 5.0.0 (provider declaration awaiting VL-5 approval). `build:scripts` emits operational scripts and a separate
ignored test tree, both with source maps and inline sources. Tests execute those actual emissions, retaining their
maps for subprocess collection. Context tests cover missing, current, changed and written output. The mythical seed
command reads a real two-commit jj main and JSONL queue, skips malformed entries, resolves both revset batches,
groups a landed stack and rejection notes, repeats deterministically, and preserves the previous seed when jj or
queue input fails. These are passing behavioral tests; installing the provider is not a 100% coverage claim.

The provider's open-ended source ranges had a second, independent defect: real Node execution of every branch
could still leave duplicate zero branch/function counters. A plain async JavaScript control reproduces it too.
The monorepo's existing provider patch now normalizes only infinite **end** columns to the original source line's
UTF-16 length before merging. It preserves finite positions and hit counts. Six real subprocess controls cover
JS/VibeLang with all branches executed, an unvisited conditional return, and one unused same-line function.
The compiler, its maps and product code generation are unchanged. The bundled conditional-return defect above is
separate and remains unresolved.

Native touch assertions use the actual first touchmove position. Under instrumentation the answer grew between
the earlier CDP measurement (1425) and first move (1743); the valid swipe ended at 1508 with following paused.
Comparing to the stale pre-gesture position was incorrect. Read-only native event evidence retains that failure.

History startup now has 57 boundary cases over a real window and the mounted Foldkit application: query/stored-role combinations, missing/empty/invalid/duplicate role input, unavailable storage through a faulty
Window service, unavailable health through a faulty HttpClient, cancellation on disposal, role-specific controls,
direct epic/commit hashes and native link navigation back to the outline. Happy paths use the product MockMythical
flows and real browser-host services. The module independently measures100% lines, branches, functions and
statements (27/27,10/10,9/9,32/32); that per-module validation does not replace the red whole-app gate.

The startup matrix includes all 25 query/stored-role combinations, each of the five query-only and storage-only roles, and the invalid, empty and duplicate-query boundaries. Native runtime navigation separately checks New and Community: both can read the history and have no planning or folding control.

Native form tests run the history update, view, subscriptions and commands over the actual MockMythical durable
flows. They cover an empty-title refusal and recovery, a new or existing epic, every note section, Start, Approve,
Fold, insertion, cancellation and amendment without a duplicate commit. Folding intentionally clears the completed
task/lane; its real commit remains linked. An amendment focused the close button because ShowPlan requested the
absent title field. The failed-first runtime regression and Chromium check now require Task focus; one selector
chooses the title or task field present in that dialog.

HTTP-backed runtime tests serve the real history protocol over a loopback socket and run LiveMythical over the native
Node HTTP client. An injected faulty Effect transport fails a chosen operation; healthy operations still reach the
real server and product durable flows. Initial-read Retry and each write's unavailable/retry path preserve inputs
and state, then record exactly one recovered result. An inner scope closes the runtime/client before the server,
including its persistent SSE connection. The tests never route or intercept browser requests.

Dead code removed: reasonOf now accepts the actual Refused | Unavailable union. Refused always has a required
refusal string, so the optional-field fallback to "refused" could never occur through the typed public service.
Both real refusal and unavailable transport outcomes remain covered.

A plain JavaScript minified control also reproduces false statement credit on the unvisited return: actual result 7,
statement count 1 on the return-9 line, branches [1,0]. This isolates generic bundled attribution without loading
VibeLang. The unbundled VibeLang map still agrees with real execution; no compiler or minifier behavior was changed.
