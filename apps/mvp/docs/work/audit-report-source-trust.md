---
title: Preserve community audit provenance on import
status: in-progress
area: audit
owner: codex-dogfood
updated: 2026-11-27
links: []
---

Import the existing Smithers CI community report through the repository MCP and surface community previews and history in the hosted Uphill view without relaxing the feed index slash exclusion.

## Library catalog & contract (`@smthrs/rpc`)

The library catalog’s `@smthrs/rpc` `Uphill` module decodes native Uphill reports and Smithers CI Lighthouse category IDs while preserving commit and provenance metadata. It now also defines the lightweight visibility-partitioned feed index contract (`uphill-index` for `public`, `uphill-index-maintainers` for `maintainers`, `buildFeedIndex`, `decodeFeedIndex`) referencing on-demand `uphill/untrusted-*` previews and `uphill/history`.

## Index discovery, backfill, and failure surfacing

- `apps/mvp/worker/feeds/UphillIndex.vibe` maintains `uphill-index` (`public`) and `uphill-index-maintainers` (`maintainers`) transactionally under a per-repository advisory lock, with identical visibility to the referenced rows, zero churn when unchanged, and automatic deletion once empty.
- `apps/mvp/worker/feeds/Api.vibe` (`ingest`) and `apps/mvp/worker/mcp/CloudFactoryTools.vibe` (`audit_report_publish`) both update the indexes atomically with the feed write.
- `audit_report_publish` no longer ignores feed mirror failures: failures record `smithers_uphill_feed_mirrors` (`outcome = failed`) and `uphill.feed_mirror.failed` (safe fields only) and throw `McpToolError(unavailable)` reporting the persisted object key and SHA-256 for idempotent retry.
- Migration `0141_uphill_feed_index` idempotently backfills existing `uphill/untrusted-*` and `uphill/history` rows (including existing production `uphill/untrusted-roninjin10`) into `uphill-index` / `uphill-index-maintainers`.
- `apps/mvp/plugins/uphill/` discovers preview and history references from `core/feeds`, opens real on-demand `core/feed` subscriptions only while the scorecard view listens (closing them on leave), renders `LoadingBar` / `Skeleton` progress while syncing, surfaces refused reads cleanly, and keeps canonical `uphill` baselines isolated from untrusted previews.

## Verification

- `@smthrs/rpc`: 100% coverage across `Uphill.ts` (including index helpers), typecheck, and lint.
- `apps/mvp`: 100% coverage across `plugins/uphill/src/{model,tab}.ts`, `worker/feeds/{Api,UphillIndex}.vibe`, and `db/migrations/0141_uphill_feed_index.ts`, plus local React SSR render tests, MCP mirror-failure surfacing tests, and end-to-end Postgres + Electric + `PluginsUi` tests covering both an existing backfilled PR 2 snapshot (score 82, commit `1dd29e1c`, gate `false`, baseline unchanged) and live updates.
- Live deployment and production smoke remain with the maintainer (not deployed by this change).
