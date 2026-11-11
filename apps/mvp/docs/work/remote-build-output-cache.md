---
title: Remote build output cache
status: done
area: build
owner: Codex
updated: 2026-11-11
links: [../../../../packages/smithers/build/docs/workspace/remote-caching.md]
---

The CLI publishes verified output blobs before action metadata and restores
them into a fresh local content store. Fixed-size chunks and a compact index
support files larger than one protocol artifact while preserving older local
entries. Remote failures leave the local cache usable.

Real hosted Worker and self-hosted service handlers verify fresh-cache bytes
and permissions, a 40 MiB file, chunk-boundary properties, publication ordering,
reader credentials, rate limits, corruption and missing chunks. A real runner
restores its declared output without executing the tool again. The new content
store module has enforced 100% statement, branch, function and line coverage.

Deployment verification still requires an endpoint and ephemeral credentials;
the in-process service tests are the executed evidence.

Bulk artifact discovery probes at most 128 digests with a batch-scaled deadline.
Real hosted and self-hosted handlers restore 520 outputs with identical bytes
and modes, and the target runner reports a hit without rerunning the tool.
Regressions cover slow discovery, bounded request/body timeouts and recovery
after a later probe returns `429`; six fail on the prior implementation.
