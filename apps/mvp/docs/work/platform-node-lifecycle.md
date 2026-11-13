---
title: Platform host lifecycle cleanup
status: done
area: sdk
owner: Codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5001
---

Use the library catalog's `@smthrs/platform-node` host service; no dependency is added.

Runtime cleanup disarms its signal deadline and leaves the caller free to finish.
Provider fetch retries socket errors on its existing pool; session-fatal repairs
drain and release retired pools while preserving unread responses. Host shutdown
still aborts unfinished bodies. Confinement discovers the host when its layer is
built, and shares the ambient host snapshot.

Validation on Node `26.5.0`:

- Package `check` and `lint` pass.
- All 24 lifecycle regression cases and the signal-status mapping case pass.
- Before the fix, the shutdown, warm-connection and lazy-discovery regressions
  fail. Repeated fatal repairs retain two through five scope finalizers on the
  original implementation; the fixed transport retains exactly one.
- Real child processes cover successful cleanup, a second signal, and expired
  deadlines at `0` and `1000` milliseconds. Real TLS connections cover retired
  pool draining, delayed response reads, and cancellation on host close.
- The full suite records 1,484 passes, 17 failures and 41 skips. Every failing
  test also fails with unchanged source; the container lacks native sandbox
  prerequisites. This is not a passing full-suite or 100% coverage receipt.
  Coverage thresholds are unchanged.

The intercepted-exit test assumed a zero deadline must fire even after cleanup
had finished. Real-process cases replace that expectation and its global exit
replacement.
