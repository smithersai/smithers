# Cell versus native tool calls (#1846)

[Measured report](observed-2026-11-05/report.html) is a standalone HTML file with
all 50 task definitions, metadata, failures, uncertainty and raw SDK receipts
embedded. Open it directly; no server or network is required. The adjacent JSON
files are the machine-readable observations. Generating HTML alone is not a
measurement.

## Reproduce

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
CELL_BENCH_CREDENTIAL_FILE="$CODEX_HOME/auth.json" CELL_BENCH_COHORT=my-subscription \
node --import vibelang/register packages/smithers/agent/harness/benchmarks/cell-comparison/run.mjs \
  "$PWD/packages/smithers/agent/harness/benchmarks/cell-comparison/new-campaign"
```

On a shared lane host use its `run-heavy` wrapper. The output directory must be
fresh and inside this benchmark directory. `--probe` after the output path runs
one pair and explicitly marks its manifest as a probe. Campaigns require the
whole immutable 50-task roster. No failed task is automatically repeated.

Configuration uses Effect Config:

- `CELL_BENCH_MODEL`: requested model, default `gpt-6-luna`.
- `CELL_BENCH_COHORT`: public credential cohort label, default `configured-subscription`.
- `CELL_BENCH_CREDENTIAL_FILE`: existing authorized Codex subscription login.
  No machine-specific default is supplied; absent configuration produces an
  authentication failure receipt. Signing reads the configured file by
  name; credential values and account IDs never enter requests, realms,
  manifests, model receipts, reports or step keys. This benchmark does not
  rotate credentials or fall back to another account/model. An unavailable or
  expired login becomes an explicit failed observation.
- `CELL_BENCH_SOURCE_REVISION`: base revision label; precise measured source
  identity is each manifest's SHA-256 table and archived source snapshots.

The account's model catalog listed `gpt-6-luna` before this run. An earlier
`gpt-6.1-sol` probe was rejected by the provider; its raw refusal is retained
under `probe-02`. `probe-01` retains startup metadata, not a completed measurement. `probe-03` verifies model access in both configurations.
Probes are excluded from campaign results and costs. The unsupported-model
probe predates the explicit `access_failure` classification and retains its
original `model_failure` label. It must not be counted as task-quality data.

## Method

`tasks.json` fixes the complete task instructions, input tables, expected
answers, fixture seeds and IDs before measurement. Five families each contain
ten seeds: filter, group, latest-revision deduplication, join and normalize tags.
Both arms see identical task instructions; input data is available only through
the same recorded `records` action. Answers stay out of model prompts. A test
checks all 50 independently generated answers by executing reference programs
in production QuickJS, with actual durable records actions.

Each model call uses `@smthrs/agent`'s `ModelStep.run`, with one engine attempt.
Both arms have the same model, cohort, low reasoning effort and six-turn cap.
The cell arm runs JavaScript in the production persistent QuickJS sandbox; the
native tool arm uses function schemas for `records` and `submit`. Tasks execute
sequentially with alternating arm order. Fixture seeds do not seed provider
sampling: the subscription protocol has no sampling-seed field. There is one
sample per task and arm. These are data-processing microtasks, not coding-agent
tasks, and their results cannot support a general coding or production claim.

The SDK libraries used are the catalog's `@smthrs/agent`, `@smthrs/model`,
`@smthrs/harness`, `@smthrs/flow`, and `@smthrs/platform-node`. The SDK exposes
QuickJSSandbox only through its public subpath, hence that documented exception
to root imports. No new model runtime or filesystem adapter is introduced.
This standalone benchmark CLI is kept in the batch's exclusively owned folder;
it registers a typed flow programmatically instead of changing the shared
repository flow registry. The SQLite host journals model calls and records
reads. JSON receipts are the portable publication; the local engine database
is ignored and preserved on the measuring host.

The report includes Wilson 95% end-to-end success intervals and a conservative
paired Hoeffding 95% bound, with its independence assumption and exclusions.
Provider access failures count as attempted end-to-end failures, with unknown
spend where usage is absent. Paired task quality excludes access/provider/host
failures; the report calls out that conditional selection. Token usage and the
SDK rate-card snapshot are retained; USD values are estimates, not subscription
invoices. Unpriced or partially metered totals stay unknown.

## Verify

```sh
node --import vibelang/register packages/smithers/agent/harness/benchmarks/cell-comparison/verify.mjs \
  "$PWD/packages/smithers/agent/harness/benchmarks/cell-comparison/observed-2026-11-05"
node --experimental-test-coverage --test-coverage-include='**/cell-comparison/analysis.mjs' \
  --test packages/smithers/agent/harness/benchmarks/cell-comparison/analysis.check.mjs
node --import vibelang/register --test \
  packages/smithers/agent/harness/benchmarks/cell-comparison/measure.check.mjs
```

The offline checks are also registered as the benchmark package’s `offline` target.
Their `.check.mjs` names keep Node’s test runner separate from the parent
package’s Vitest discovery.

The verifier requires the entire paired roster, immutable corpus and source
hashes, unchanged receipt bytes, matched model requests and a summary/report
recomputed from raw observations. Historical measurement sources are retained
as gzip files under `sources/` inside the campaign; verification hashes their
exact decompressed bytes, and later verifier fixes do not rewrite its
manifest or its observations. The report embeds all artifacts needed to inspect
results offline. Runtime tests inject faulty Effect model services for unhappy
paths, and run the real QuickJS sandbox for the corpus oracle. The reporting
logic has executed 100% statement/branch/function coverage; benchmark CLI code
is validated by the actual model campaign, not a claim of full package coverage.
