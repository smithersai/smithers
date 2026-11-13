---
title: Browser SQL maintenance and service test boundaries
status: done
area: sdk
owner: codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/4987]
---

Tab compaction now fails with a named, documented error before SQLite runs it.
Receipt tables, existing transactions and stored rows stay intact. Private
interpreter assertions use their actual inputs. Worker tests use real message
ports and event targets; host tests use one real ZenFS and just-bash mount.
The browser suite also exercises the dedicated worker's default boundary.

Catalog entries: `@smthrs/platform-browser` for browser host services and
`@smthrs/observability` for content-free runtime records. No new library or runtime.

The package suite passes 465 tests at 100% coverage, with typecheck and lint.
SQL regressions include scripts, batches, comments, quoted comment text and
transaction continuity. Generated API and language-model documentation match
their sources; all 52 published-package documentation checks pass.
