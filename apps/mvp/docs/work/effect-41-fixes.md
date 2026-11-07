---
title: Effect 4.1 introduced regression repairs
status: done
area: dependencies
owner: claude-e41land
updated: 2026-11-07
links: []
---

The move to Effect 4.1.1, VibeLang 0.0.12 and Alchemy 2.0.0-beta.85 lands with no
test, typecheck, check or lint red only on the upgrade. Every comparison ran the
upgrade against a source-swap workspace of the `main` it lands on, each with its own
install and its own PostgreSQL, Electric and PgBouncer fixture.

Library catalog entries: existing @smthrs/integrations for GitHub; @smthrs/effect-electric
for Electric shapes; @smthrs/effect-tanstack-db for the spend receipt; Effect typed error
handling at public domain boundaries. No new library or app retry mechanism.

## Repairs

- `pwxqurxw`: the atomic filesystem promises native Node glob parity. Effect 4.1 deliberately
  replaces its Node adapter glob with shared Glob (4.1 changelog, PR 8829, commit d2b6bc7), so
  the test compares with Node's own glob; every case and pinned assertion stays.
- `vnoxwvvx`: the published rc.16 quickstart installs its Effect 4.0.5 cohort.
- `yqnylpxq`: pnpm patches for own `__proto__` child environment entries and statically visible
  NodeWS exports (`@effect/platform-node-shared`), signed-int64 OTLP numbers
  (`@opentelemetry/otlp-transformer`) and VibeLang base-error subclass matching
  (`vibelang-runtime`, which mirrors the upstream VibeLang fix and goes with 0.0.13).
- `qssnpmpq`: GitHub, coedit and runner Jobs fail with fresh typed domain errors; Effect 4.1's
  eager `mapError` keeps the transport failure's cause annotations.
- `kpknpzpo`: a one-element stream buffer lets a finite Electric reply observe its end and
  release its connection while the downstream holds the last chunk.
- `qnvllrmt`: `LiveQuery.observeSync` records the spend tab's shown alerts in the publication's
  own turn.
- `yllmpyst`, `srlorpop`, `rqkkvmyz`, `lrtqltlk`: package lint. The upgrade put imports above
  61 module headers, left unused and value-only imports, and left docs unformatted; ESLint
  also read VibeLang 0.0.12's generated `*.d.vibe.ts` declarations.

## Validation

- Full apps/mvp suite, six coverage-enabled shards per tree, 10,273 tests in 672 files each:
  `main` 77 failing names, upgrade 80, 74 shared. Of the six red only on the upgrade, five
  (attention panel, repo clone, terminal panel, timeline summary refusal, tab imports) pass
  on both trees in three paired reruns of their files (221 of 221 each) and in both earlier
  full upgrade runs; the sixth, `embeds.test.ts`'s route listener race, fails on `main` with
  the same `TypeError` at the same line in an earlier full run.
- The e41land non-MVP files pair test for test, except the TUI's Bun case, which timed out
  under load and passes on rerun.
- Recursive lint: only apps/mvp fails, with the same 18 errors on both trees.
- Frozen install, recursive typecheck and check, `pnpm docs:check`: pass.
