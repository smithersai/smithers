---
title: Browser capabilities and shared sandbox leases
status: done
area: testing
owner: automation
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5253
---

Clipboard journeys must read back the real clipboard in Chromium and WebKit using each browser's supported permissions.
Offline identity recovery must use WebKit's disconnectable transport and reserve CDP connection-state overrides for Chromium.
Sandbox tool journeys must exclude lifecycle cleanup on the shared branch checkout while retaining their model read lease.

Regression coverage uses real browser APIs and filesystem resource leases through `pnpm test:production-runner`.
The existing product journeys retain their clipboard, identity adoption, queued-owner isolation and resumed-write assertions.

The four native browser regressions and three shared-checkout lease regressions pass.
The baseline browser calls reproduce `Unknown permission: clipboard-write` and `CDP session is only available in Chromium`;
the baseline resource declarations admit overlapping checkout users.
The complete runner passes `27/28` tests, with its existing `cold-search.spec.ts` declaration gap remaining
(related review finding: [#5247](https://github.com/smithersai/smithers/issues/5247)).
The WebKit readback pastes into a temporary field and verifies that the field is removed and the original focus restored.

Package `typecheck` reports identical existing diagnostics before and after this change, with no added diagnostic.
Package `lint` reports `18` existing errors in untouched source files.
`pnpm run target-index` succeeds without generated changes.
Full signed-in application journeys were not run; these receipts cover the harness's real browser APIs and resource leases.
