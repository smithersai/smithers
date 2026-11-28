# Uphill

Continuous metrics and Lighthouse-style hill climbing for every repository on Smithers (`wevm/uphill`).

## Plugin (`plugins/uphill/`)

Built as a first-party UI plugin on the public `@smthrs/plugin` interface (ruling PLUGIN-1, [plugins](plugins.md)):

- **View (`uphill/scorecard`)**: mounted at `/$owner/$repo/-/uphill`, rendering `@smthrs/ui`'s `<UphillScorecard />` over the repository's eager `core/feeds` index (`uphill`, `uphill-index`, `uphill-index-maintainers`) and on-demand `core/feed` subscriptions (`uphill/untrusted-*` community previews and `uphill/history`, decoded by `@smthrs/rpc`'s `Uphill`). On-demand `core/feed` shapes open only while the scorecard view listens and close when the viewer leaves.
- **Repository tab (`repo.tabs`)**: listens only to `core/feeds` and shows `Uphill` whenever a canonical `uphill` report or indexed community preview exists, displaying the 0–100 score badge (`good` >= 90, `warn` >= 50, `poor` < 50) strictly for the trusted canonical baseline.
- **Command & keys**: `/uphill` opens the scorecard; `j` and `k` step through category filters.
- **Safe progress & failure states**: while indexed previews or history are syncing over `core/feed`, the scorecard shows `LoadingBar` and `Skeleton` progress instead of claiming no report exists; refused on-demand reads surface an explicit unavailable notice.

## Index and on-demand feed discovery

`GET /api/shapes/feeds` intentionally keeps slash-named documents out of the eager repository index (`name NOT LIKE '%/%'`, [decision 0128](../decisions/0128-repository-feeds.md)). To discover isolated previews and trend history without relaxing that rule:

- `worker/feeds/UphillIndex.vibe` maintains two lightweight top-level index documents with identical visibility to the rows they reference: `uphill-index` (`visibility = 'public'`) and `uphill-index-maintainers` (`visibility = 'maintainers'`). Each lists bounded references (`{ version: 1, previews, history }`) to `uphill/untrusted-*` and `uphill/history` of the same visibility, serialized under a per-repository advisory lock, written only when changed, and deleted once empty.
- Both `POST /api/repos/<owner>/<name>/feeds` (`worker/feeds/Api.vibe`) and MCP `audit_report_publish` (`worker/mcp/CloudFactoryTools.vibe`) update the visibility-partitioned indexes inside the same Postgres transaction as the feed document write.
- Migration `0141_uphill_feed_index` idempotently backfills `uphill-index` and `uphill-index-maintainers` for pre-existing `uphill/untrusted-*` and `uphill/history` rows.
- Mirror failures in `audit_report_publish` are never ignored: the tool increments `smithers_uphill_feed_mirrors` (`outcome = failed`), logs `uphill.feed_mirror.failed` with safe metadata only, and returns `unavailable` reporting the persisted object key and SHA-256 so callers can retry idempotently.

## Sandbox & coding agent

- `infra/sandbox/Dockerfile` pins `uphill` (`v0.0.11`, verified by SHA-256 for `amd64` and `arm64`) into `/usr/local/bin/uphill` so every branch sandbox and CI job container has `uphill` offline.
- `worker/flows/TodoAgent.vibe` instructs the TODO agent to follow `.agents/uphill/rules.md` and verify changes with `uphill --compact` when a repository defines Uphill metrics.

## Publishing reports to a repository feed

Publish `.uphill/report.json` (either raw or wrapped as `{ report, commit, branch, updatedAt, history, rules }`) to `POST /api/repos/<owner>/<name>/feeds` under document name `uphill` (visibility `public` or `maintainers`), or call the repository MCP `audit_report_publish` tool. Because `uphill`, `uphill-index`, and `uphill-index-maintainers` are top-level index names, Electric syncs them eagerly to authorized browsers.

## Tests

- `packages/rpc/test/Uphill.test.ts`: 100% coverage of report/envelope schemas, visibility-partitioned feed index helpers, score bands, and SI/duration formatters.
- `packages/smithers/ui/tests/uphill.test.tsx`: `UphillGauge` and `UphillScorecard` rendering, deltas, opportunities, changes, and trend sparkline.
- `apps/mvp/plugins/uphill/src/model.test.ts`, `tab.test.ts`, and `components/Uphill.test.ts`: 100% coverage of index reference merging, on-demand `core/feed` subscription lifecycle, live updates, refusal handling, and local React rendering.
- `apps/mvp/worker/feeds/UphillIndex.test.ts` and `worker/mcp/CloudFactoryTools.test.ts`: real Postgres + Electric index upkeep, visibility enforcement, `0141_uphill_feed_index` backfill idempotency, and mirror write failure surfacing.
- `apps/mvp/tests/UphillDiscovery.test.ts`: end-to-end producer-to-feed-to-view tests over real Postgres, Electric, ChatApi, `PluginsUi`, and local React rendering, covering both an existing backfilled report and live updates.

## Execution provenance and trust isolation

Every Uphill backpressure audit report carries server-verified execution provenance (`trusted_sandbox`, `trusted_maintainer`, or `untrusted_contributor`):

- **Trusted runs** (`trusted_sandbox` or `trusted_maintainer`) publish to the canonical `uphill` feed document, write to the shared Smithers Cloud build cache, and are eligible to satisfy merge and release gates.
- **Untrusted community runs** (`untrusted_contributor`) are encouraged and rendered transparently under isolated `uphill/untrusted-<login>` feed documents (referenced via the matching `uphill-index` or `uphill-index-maintainers` index) with an explicit `Untrusted community run` / `Informational only` / `Cache isolated` provenance banner. Untrusted runs can never overwrite canonical reports, poison the shared cache, or satisfy merge gates.
