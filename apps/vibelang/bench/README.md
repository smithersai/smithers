# Factory benchmarks

Run `pnpm bench` for local in-process, browser and workerd observations plus the deterministic regression gate,
`pnpm bench:browser` for Chromium, and `pnpm bench:live` for three production runs
that spend real model tokens. `pnpm bench:coverage` measures only benchmark files
with V8 and strict 100% per-file thresholds. No unit/fuzz tests enter this run.

JSON observations live in ignored `bench/results/`; retain them with the run report.
Each includes timestamp, machine, tool versions, source revision, method, limitations
and raw samples. `baseline.json` is a reviewed deterministic input. Timing artifacts
are never promoted automatically. `wiki/benchmarks.md` holds methods and findings.

The typed targets are `//apps/vibelang:bench`, `:benchCoverage` and `:benchLive`.
Use `--no-cache` with `smthrs target` for fresh observations; direct package commands always execute.
Coverage and live targets are exclusive. The strict coverage gate is currently red; it is not a certificate.

Browser source profiling builds with `--mode bench-coverage` (unminified). The real Vite/Node skipped-return control
must stay uncovered; minifier folding loses that distinction in the generic bundled converter. Timings use the
normal optimized build. Cross-runtime maps normalize only open-ended end columns, identically to the shared V8
provider; source ranges must still match completely. No threshold or production exclusion is relaxed.

Every workload declares `sync` or `async` at registration. Tinybench's automatic detection invokes plain callbacks
once before measurement, and a Promise-returning probe can overlap the first measured sample. The harness disables
that detection through Vitest's supported `async` option. Real-runner controls require exactly three callbacks
and maximum concurrency one with warmup disabled; coverage requires one callback. Earlier timing receipts without
explicit registration are historical observations and cannot establish isolated, unwarmed execution.


Worker public reads are opt-in, and always anonymous:
```sh
BENCH_PUBLIC_GITHUB=1 pnpm exec vitest bench --run --config bench/config.ts bench/public-github.bench.vibe
BENCH_SITE_READS=1 pnpm exec vitest bench --run --config bench/config.ts bench/public-github.bench.vibe
E2E_PORT=4536 BENCH_PUBLIC_GITHUB=1 pnpm bench:coverage
```
The first command checks real GitHub issue/wiki projection and a cache-eviction fault after the real cache TTL;
it makes no GitHub mutation. The second checks deployed read responses and retains a failure artifact when
content is unavailable. It is currently red for the deployed issues endpoint. Neither requests a model.
The draft Budget failure benchmark intentionally waits through the production two-minute retry policy; its
single observation measures whole failure latency, including that wait. See 0017 and the benchmark wiki.
