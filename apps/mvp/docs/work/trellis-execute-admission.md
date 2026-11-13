---
title: Trellis execute admission
status: done
area: patterns
owner: Codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4709
---

`Trellis.execute` returns malformed-plan refusals through the Effect error
channel and admits leaf factories under the shared concurrency bound.
Call-time plan and option snapshots are preserved. Admission stops at its
first refusal and rejects cyclic, unreadable, or excessively nested inputs
without a synchronous exception.

Eight regression tests fail on the original implementation. The final package
run passes all 853 tests with 100% statements, branches, functions, and lines,
plus typecheck and lint. Astra and Fable reviews found no remaining blockers.

The generated API page and LLM bundle pass their consistency checks, and all
52 published-package documentation tarball checks pass. The durable
`pnpm docs:sync` and `pnpm docs:check` commands could not finish because the
native `smithers-jj-export` helper was unavailable; their direct generation
and consistency checks passed.
