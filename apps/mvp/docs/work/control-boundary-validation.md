---
title: Control boundary validation and defect redaction
status: done
area: control
owner: codex
updated: 2026-10-22
links: []
---

Reproduce and fix negative budget ceilings, engine cancellation attribution,
watch cursor combinations, cross-scheme browser origins, and raw RPC defect logs.
Uses the library catalog's `@smthrs/control` entry and existing Effect schemas,
HTTP routing, and logging. No new libraries or device schema changes.

All five findings reproduced: the original focused run failed 12 assertions,
including HTTP Origin accepted by an HTTPS Web endpoint and raw defect text in
unary/streaming logs. A real Node TLS regression also failed (200 instead of 403).

Schemas now enforce nonnegative ceilings, anonymous engine cancellations, and
cursor/run requirements. RPC logs retain only a fixed diagnostic. Origin checks
compare scheme as well as authority. Relative-URL hosts inject `RequestScheme`;
unknown schemes fail closed and forwarding headers are never trusted implicitly.
Native gateway, CLI, and the runnable example supply their known HTTP scheme;
gateway `requestScheme: "https:"` explicitly supports a trusted TLS terminator.

Validation on Node 26.5.0 after the offline frozen install:

- Control: `node ../flows/database/scripts/test-matrix.mjs --maxWorkers=2`:
  2,394 passed, 2 skipped across SQLite/Postgres; merged coverage 100% in all four dimensions.
- Gateway: `pnpm exec vitest run --maxWorkers=2` with `~/.bun/bin` on PATH:
  917 passed; coverage 100% in all four dimensions.
- CLI `test/ControlSurface.test.ts`: 28 passed; flow example 24: 33 passed
  (`vitest run <file> --coverage.enabled=false --maxWorkers=2`).
- Control and gateway `tsc -p tsconfig.test.json --noEmit`: passed.
- MVP `tsc --noEmit`: passed before and after. Device schemas: 6 passed before
  and after; the same unrelated global coverage gate fails at the same percentages
  in both focused runs. No schema version or migration needed.
- All four affected packages' `importRules` targets pass. Missing targets were
  added with scoped rules, and the target index regenerated.
- Changed control source ESLint passes. Astra review found no remaining issues.
- E2E: not run (mini clone).
