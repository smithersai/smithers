# Uphill

Continuous metrics and Lighthouse-style hill climbing for every repository on Smithers (`wevm/uphill`).

## Plugin (`plugins/uphill/`)

Built as a first-party UI plugin on the public `@smthrs/plugin` interface (ruling PLUGIN-1, [plugins](plugins.md)):

- **View (`uphill/scorecard`)**: mounted at `/$owner/$repo/-/uphill`, rendering `@smthrs/ui`'s `<UphillScorecard />` over the repository's `core/feeds` (`uphill` and optional `uphill/history` feed documents decoded by `@smthrs/rpc`'s `Uphill`).
- **Repository tab (`repo.tabs`)**: shows `Uphill` with a live 0–100 score badge (`good` >= 90, `warn` >= 50, `poor` < 50) whenever the repository publishes an `uphill` feed.
- **Command & keys**: `/uphill` opens the scorecard; `j` and `k` step through category filters.

## Sandbox & coding agent

- `infra/sandbox/Dockerfile` pins `uphill` (`v0.0.11`, verified by SHA-256 for `amd64` and `arm64`) into `/usr/local/bin/uphill` so every branch sandbox and CI job container has `uphill` offline.
- `worker/flows/TodoAgent.vibe` instructs the TODO agent to follow `.agents/uphill/rules.md` and verify changes with `uphill --compact` when a repository defines Uphill metrics.

## Publishing reports to a repository feed

Publish `.uphill/report.json` (either raw or wrapped as `{ report, commit, branch, updatedAt, history, rules }`) to `POST /api/repos/<owner>/<name>/feeds` under document name `uphill` (visibility `public` or `maintainers`). Because `uphill` is a top-level index name, Electric syncs it eagerly to browsers.

## Tests

- `packages/rpc/test/Uphill.test.ts`: 100% coverage of report/envelope schemas, score bands, and SI/duration formatters.
- `packages/smithers/ui/tests/uphill.test.tsx`: `UphillGauge` and `UphillScorecard` rendering, deltas, opportunities, changes, and trend sparkline.
- `apps/mvp/plugins/uphill/src/model.test.ts` and `tab.test.ts`: feed extraction, history merging, category stepping, keyboard events, and refusal handling.

## Execution provenance and trust isolation

Every Uphill backpressure audit report carries server-verified execution provenance (`trusted_sandbox`, `trusted_maintainer`, or `untrusted_contributor`):

- **Trusted runs** (`trusted_sandbox` or `trusted_maintainer`) publish to the canonical `uphill` feed document, write to the shared Smithers Cloud build cache, and are eligible to satisfy merge and release gates.
- **Untrusted community runs** (`untrusted_contributor`) are encouraged and rendered transparently under isolated `uphill/untrusted-<login>` feed documents with an explicit `Untrusted community run` / `Informational only` / `Cache isolated` provenance banner and a one-click `Re-run in Smithers sandbox` action for maintainers. Untrusted runs can never overwrite canonical reports, poison the shared cache, or satisfy merge gates.
