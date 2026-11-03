---
title: Keep failed feed handoffs retryable
status: done
area: repository-access
owner: codex
updated: 2026-11-02
links:
  - ../../worker/flows/RedactFeed.test.ts
---

Finding 4: a successor start without its barrier receipt must fail durable routing. The engine retries the same start before settlement; no new retry mechanism. Library catalog: `@smthrs/flow` and `@smthrs/platform-cloudflare`.

Regression: `a failed successor receipt keeps the predecessor retryable before it settles`. Against main, the real ExecutionHost returned Settled after Postgres rejected the receipt; expected Retrying. The test repairs the dependency and fires the durable alarm directly, without sleeps or test retries.

Validation: Latitude regression: 1 passed, 0 failed, 12 skipped by the name filter. Receipt recovery routes the same successor again before settlement.

Final integration: all 13 RedactFeed tests passed, 0 skipped, within the 284-test combined run. The worker typecheck also passed.
