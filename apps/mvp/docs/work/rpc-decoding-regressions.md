---
title: RPC path and persisted card decoding regressions
status: done
area: sdk
owner: codex-mini-fix-packages-rpc-src-894259
updated: 2026-10-21
links: [../../../../packages/rpc/docs/cards.md]
---

Reproduce and fix the five reported RPC findings: repository activity paths,
optional command field types, retained legacy content, cloud agent inventories,
and malformed agent entries. Use the existing runtime-free `@smthrs/rpc`
contract schemas; no new library or app behavior is needed.

All five findings reproduced and fixed. Repository activity paths reject unsafe
segments with a tagged error. Optional command text rejects other types. Retired
cards retain their body and original payload in `payload.recorded`, with saved
model API keys and environment variable values stripped. Cloud inventories reach
their declared schema; malformed agent entries reach validation instead of being
dropped. No new library was selected; the existing RPC contract implementation
remains pure and runtime-free. Errors omit input content.

Validation on Node 26.5.0 after `pnpm install --frozen-lockfile --offline`:

- `pnpm --filter @smthrs/rpc exec vitest run test/DecodingRegressions.test.ts`:
  before fixes, all 65 original regression cases failed for the reported reasons.
- `pnpm --filter @smthrs/rpc exec vitest run --exclude test/DecodingRegressions.test.ts`:
  before fixes, 4,209 tests passed across 99 files.
- `pnpm --filter @smthrs/rpc test`: after fixes, 4,282 tests passed across 100
  files, including round trips, frame decoding, malformed inputs, input
  immutability and credential stripping.
- `pnpm exec smithers-build test '//packages/rpc:importRules'`: passed.
- Package test TypeScript check and ESLint/dprint checks of changed RPC files:
  passed.
- E2e: not run (mini clone).
