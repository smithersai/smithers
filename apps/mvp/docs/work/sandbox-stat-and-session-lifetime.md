---
title: Repair sandbox stat failures and resumed session lifetimes
status: done
area: sdk
owner: Codex
updated: 2026-11-12
links: ["https://github.com/smithersai/smithers/issues/4689"]
---

Linux guest `stat` now reports `NotFound` for a missing parent or a dangling
link. The adapter uses `stat`'s C-locale diagnostic, exit status and utility
prefix, preserving permission refusals and utility or transport failures.

Vercel acquisition extends every positive shortfall between the reported
session deadline and the lifetime requested from acquisition, including
lifetimes at or below five minutes. This also fills a fresh session's
shortfall after acquisition latency; a refused extension fails acquisition.
A session with no reported deadline retains the existing create-remainder
fallback. Public APIs are unchanged.

Validation:

- On `fd9d27835cd7`, eight selected regression cases fail: four missing-path
  variants and four stopped or running short-session renewals.
- All 33 tests in `ContainerFileSystem.test.ts` and 27 tests in
  `VercelSandbox.test.ts` pass on unprivileged Linux, including the
  search-permission case.
- Package `pnpm run check` and `pnpm run lint` pass.
- Full package `vitest run --maxWorkers=2`: 1,008 tests pass, 37 are
  skipped. Statements, branches, functions and lines each have 100% coverage.
  The run uses an unprivileged Linux user and a searchable tool path.
- Independent code reviews found no remaining blocking issue.

No live Vercel request was made because the test environment has no Vercel
credentials. The injected SDK tests execute commands through real shells
against real files. The [vendor SDK reference](https://vercel.com/docs/sandbox/sdk-reference#sandbox.extendtimeout)
defines extension duration in milliseconds.
