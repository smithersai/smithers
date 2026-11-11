---
title: Close RPC source guard gaps
status: done
area: sdk
owner: Codex
updated: 2026-11-11
links: ["https://github.com/smithersai/smithers/issues/4539"]
---

Repair the raw-failure and runtime-free dependency guards in `@smthrs/rpc`.
Use a shared recursive source walk, resolve Error subclasses by module and inspect schema parsing,
and cover static, side-effect, dynamic and CommonJS imports.

Keep existing validation behavior: `digestSync` documents `TypeError`, deployment
and recorded-action decoders use Zod validation, and
`docs/context-preflight.md` distinguishes schema validation from tagged sequence
rejection. Record these exact existing sites with reasons; reject stale exceptions
and every new unreviewed site.

Validation:

- `pnpm run check` and `pnpm run lint` pass in `packages/rpc`.
- The complete package suite passes: 4,166 tests in 88 files, with 100% measured
  statements, branches, functions and lines.
- Restoring the original raw scanner makes 29 regression checks fail. Restoring
  the original import scanner and shallow traversal makes 10 checks fail.
  The strengthened guards pass all 83 focused checks.
- Class inheritance, inherited tags, commented imports and nested source
  directories have regression coverage.
