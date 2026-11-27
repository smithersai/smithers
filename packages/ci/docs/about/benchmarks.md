---
title: "Benchmarks"
description: "Verified replay speedups, recording overhead, and soundness measurements from packed tarballs on real repositories."
---

Every figure on this page comes from packed-tarball runs of `smithers-ci` against real repositories and real processes (no mocked commands). When a repository reuses too few steps to beat baseline wall time, `smithers-ci` prints that plainly rather than hiding the regression.

## Verified repository replays

| Repository              | Stack                      | Environment                                  | Baseline → Normal                   | Speedup                 | Mismatches | Notes                                                                             |
| ----------------------- | -------------------------- | -------------------------------------------- | ----------------------------------- | ----------------------- | ---------- | --------------------------------------------------------------------------------- |
| `tj/commander.js`       | JavaScript / Jest / ESLint | 4 vCPU Cloudflare Sandbox (`smthrs-observe`) | 434 s → 250 s (4 commits)           | **1.74×**               | **0**      | 18 of 25 steps reused on one-file commits; 1.61×–1.83× on bare metal              |
| `smithersai/needlefish` | Zig 0.17.1 (3,350 tests)   | 4-core Linux & GitHub runners                | 590 s → 299 s cold; 1.8 s warm leaf | **1.29×** cached replay | **0**      | 56% of last 600 commits run under 30 s locally; 18–139 s on 4-core GitHub runners |
| `smithersai/vibelang`   | TypeScript / Go            | Linux x86_64 (`smthrs-observe`)              | Native Smithers build replay        | **1.3×**                | **0**      | Content-addressed workspace targets                                               |
| `pallets/click`         | Python / pytest / tox      | Linux x86_64 (`smthrs-observe`)              | Short CI dominated by startup       | **0.84×**               | **0**      | Honestly reported as slower when reuse cannot offset startup cost                 |

## Recording overhead (`smthrs-observe`)

On Linux x86_64 and aarch64 (kernel 5.19+), `smthrs-observe` uses seccomp `USER_NOTIF` with a ptrace fallback for signal storms instead of `strace`:

- **Wall-time overhead on cache-miss steps:** `1.02×` to `1.16×` (measured 9% wall / 11% CPU on full-miss replays), inside the documented one-sixth budget.
- **Process isolation:** Every job runs inside a bubblewrap user namespace with its own checkout, `$HOME`, and `/tmp`; background servers started by a step remain alive only for their job and terminate before the build returns (0 of 8 port-race failures after namespace drain).
- **Syscall coverage:** 104 Linux 7.0 file and network syscalls in one shared table (`RecordedCalls.ts`); `io_uring_setup` returns `ENOSYS` so unobservable shared-memory rings cannot bypass recording; unknown syscalls refuse caching instead of risking a stale pass.

## Soundness & verification

- **Zero stale passes under adversarial testing:** 7 independent ship reviews verified `smthrs-observe` and `strace` against symlink escapes, `openat2(RESOLVE_IN_ROOT)`, `renameat2(RENAME_EXCHANGE)`, read-then-modify inputs, directory link-count (`st_nlink`) changes, unconnected UDP/Unix sends to external daemons, `io_uring` races, and 7 cache-store corruption attacks.
- **Formal & fuzz verification:** 6 standalone Lean 4 reference specifications (51 `.lean` files, 387+ machine-checked theorems with 0 `sorry`) paired with ~55,685 live differential fuzz queries and 40 property/fuzz suites across `packages/ci` and `build-cli`.
- **Untrusted repositories:** Repositories you do not trust (such as `elizaOS/eliza`) replay strictly inside isolated Cloudflare Sandboxes via `scripts/box-replay.mjs` with zero host credentials, zero host checkouts, and zero shared caches. See [A repository you do not trust](untrusted.md).
