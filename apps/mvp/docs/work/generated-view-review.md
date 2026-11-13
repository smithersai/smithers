---
title: Generated view review corrections
status: done
area: views
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4933
---

Correct error classification, synchronous entry-point checks, JSX member
admission, frame runtime hashing, docs fences and empty iframe ancestry in
`@smthrs/views`.

Library catalog: `@smthrs/views` owns generated-view checking and rendering,
docs indexes and external-page framing checks. These fixes extend its existing
checker and realm without introducing another rendering path.

Regression evidence: the initial 61-case suite had 40 failures on the unchanged
base. The final 68-case suite includes forged internal errors and nullish throws.
All 422 tests in the 20 runnable package suites pass, with 100% statement,
branch, function and line coverage. Package typecheck and lint pass.

The full package run also executes `test/BrowserBundle.test.ts` and
`test/Workerd.test.ts`. These have the same missing `.vibe` esbuild-loader
failure on the unchanged base; the tooling gap is recorded on the issue and
is unchanged by this fix. Both `pnpm docs:sync` and `pnpm docs:check` pass.
