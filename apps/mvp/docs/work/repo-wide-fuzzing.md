---
title: Zig coverage-guided fuzzing, cross-package fuzz suites, and fuzz-discovered bug fixes
status: done
area: testing
owner: antigravity
updated: 2026-11-22
links: []
---

Library catalog: fuzzing (`@smthrs/fuzz`) and Vitest fuzz adapter (`@smthrs/testing/Vitest`).

Extended the unified repository fuzz runner (`scripts/fuzz-repo.mjs`) with:
- Zig 0.17.1 LLVM coverage-guided (`--fuzz=<N>`) and smoke fuzz targets for `packages/smithers/build/build-cli/native/observe.c` and `packages/smithers-ffi` (`live_document` C ABI), wired to `pnpm fuzz:zig`, `pnpm fuzz:zig:campaign`, and `pnpm fuzz:all` (with automatic `calls.h` generation on fresh checkouts).
- Additional Rust fuzz targets (`flows-jj::fuzz_abi_and_ops`, `smithers-ffi::fuzz_targets`, and `smithers-ffi::atomic_glob`).
- 19 cross-package `@smthrs/fuzz` + `FuzzSimulation` suites (`fuzz/*.fuzz.test.ts`, 71 tests) covering previously unfuzzed packages (`@smthrs/chain`, `@smthrs/registry`, `@smthrs/build-cli`, `@smthrs/sandbox`, `@smthrs/migrate`, `@smthrs/model`, `@smthrs/std`, `@smthrs/integrations`, `@smthrs/gateway`, `@smthrs/flow`) plus security/CRDT/Lean-kernel invariants.

Real bugs caught and fixed with regression tests:
1. `packages/smithers/build/build-cli/native/observe.c`: 1-byte buffer overflow in `keyOf` when `capacity == 0` or `capacity == 1` on `"/"`.
2. `packages/ci/src/inventory/Glob.vibe`: malformed character classes (`[9-0]`, `[!]`, `[^]`, `[a-c-e]`, `[[:alpha:]]`) emitted invalid RegExp / POSIX ERE patterns.
3. `packages/smithers/migrate/src/internal/Ts.ts`: unpaired UTF-16 surrogates sent over JSON-RPC panicked `typescript-go` (`jsontext: invalid surrogate pair`).
