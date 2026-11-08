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
