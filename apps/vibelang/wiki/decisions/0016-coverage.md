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
refer to Node clients only. The final per-file snapshot follows when the prototype's final measurement completes.

<!-- measurements:start -->
Final snapshot pending.
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

History startup now has57 boundary cases over a real window and the mounted Foldkit application: query/stored-role combinations, missing/empty/invalid/duplicate role input, unavailable storage through a faulty
Window service, unavailable health through a faulty HttpClient, cancellation on disposal, role-specific controls,
direct epic/commit hashes and native link navigation back to the outline. Happy paths use the product MockMythical
flows and real browser-host services. The module independently measures100% lines, branches, functions and
statements (27/27,10/10,9/9,32/32); that per-module validation does not replace the red whole-app gate.

The startup matrix includes all 25 query/stored-role combinations, each of the five query-only and storage-only roles, and the invalid, empty and duplicate-query boundaries. Native runtime navigation separately checks New and Community: both can read the history and have no planning or folding control.
