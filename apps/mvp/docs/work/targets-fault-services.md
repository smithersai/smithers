---
title: Target fault tests use injected services
status: done
area: targets
owner: codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5054]
---

Replace module mocks in execution, generated-file durability and finding-store
tests with injected fault capabilities (TEST-2, TEST-7). Keep native execution,
publication and record-open flags as the defaults.

Uses the existing Effect service capabilities and the catalog's
`@smthrs/platform-node` process host. No new dependency or runtime.

Validation:

- Ten selected regressions fail against the unchanged parent implementation.
- The three affected test files pass 113 tests; two Docker integration cases
  require a locally available daemon and image and are skipped here.
- The complete package suite passes 3,313 tests with three platform/environment
  skips, and all configured coverage thresholds pass.
- Package typecheck and lint pass.
- `pnpm docs:sync` and `pnpm docs:check` complete successfully.
