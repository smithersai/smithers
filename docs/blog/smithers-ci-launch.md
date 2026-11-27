# Introducing Smithers CI: Fast CI for Agents, With Zero Stale Passes

When coding agents iterate on a repository, CI latency becomes the bottleneck on every single turn. Yet most teams hesitate to adopt incremental CI caching for a good reason: **a fast cache that ever gives you a stale pass is worse than no cache at all.**

Today we are releasing **`smithers-ci`** — a zero-config tool that reads the CI you already have, records the exact files each step reads at the Linux kernel boundary, and proves the speedup on your own git history before modifying a single file in your repo.

```sh
bunx smithers-ci
```

## Prove it on your history first

With no arguments, `smithers-ci` does not ask you to rewrite your workflows or migrate to a new build system:

1. **Read** — Parses your `.github/workflows/*`, `Justfile`, `Makefile`, `package.json` scripts, or `turbo.json`.
2. **Trace & Cache** — Runs each step inside a bubblewrap jail under `smthrs-observe`, a small C supervisor using Linux seccomp `USER_NOTIF` that records every file read, directory listing, symlink traversal, and network attempt.
3. **Replay** — Replays your recent commits in temporary copies both ways: baseline CI and cached normal mode.
4. **Report** — Prints exact wall time, CPU seconds, cache reuse reasons, and every single verdict difference.

If normal mode ever disagrees with your baseline CI on even one commit, `smithers-ci` exits non-zero and refuses to print a speedup.

When you trust the replay, one command writes the generated workflow:

```sh
bunx smithers-ci apply
```

## Two modes: strict parity or predictive speed

- **Normal mode (default):** Reuses a step only when every recorded input matches cryptographically. If a step opens an external network connection, sends unconnected UDP to a server outside its run, touches an unknown Linux syscall, or mutates an input in place, Smithers CI refuses to cache it and tells you why.
- **Fast mode (`--mode fast` / `--mode both`):** Opt-in predictive test selection using an API key (`AI_GATEWAY_API_KEY`) or a signed-in Claude/Codex CLI. Skipped targets are always reported as **skipped**, never as passed, and never written to the cache.

## Real numbers, including when it isn't faster

- **`tj/commander.js` (JS / Jest / ESLint):** **1.74× faster** (434 s → 250 s across 4 commits in a 4 vCPU Cloudflare Sandbox; 1.61×–1.83× on bare metal), reusing 18 of 25 steps on one-file edits with **0 mismatches**.
- **`smithersai/needlefish` (Zig 0.17.1, 3,350 tests):** Cold 4-core Linux suite cut from 590 s → 299 s, warm leaf edits in **1.8 s**, 56% of the last 600 real commits under 30 s locally, and 18–139 s on 4-core GitHub runners.
- **`smithersai/vibelang` (TypeScript / Go):** **1.3× faster** with 0 mismatches.
- **`pallets/click` (short Python CI):** **0.84×** — honestly reported as slower when startup cost outweighs step reuse.

## Built to earn trust at the kernel boundary

Most build caches rely on hand-maintained input globs that drift on day two. Instead, we built `smthrs-observe` (C compiled with Zig) around a single shared table of **104 Linux 7.0 syscalls** (`RecordedCalls.ts`), keeping cache-miss recording overhead to **1.02×–1.16×** wall time.

Before cutting `1.0.0-rc.19`, we ran:

- **7 independent adversarial ship reviews** attacking symlink escapes, `openat2(RESOLVE_IN_ROOT)`, `renameat2(RENAME_EXCHANGE)`, `io_uring` shared-memory races, read-then-modify inputs, directory `st_nlink` changes, daemon port races, and 7 cache-tampering scenarios.
- **3 rounds of tri-model code review** across all 142 source files.
- **6 Lean 4 formal reference specifications** (51 `.lean` files, 387+ theorems, 0 `sorry`) checked against the live TypeScript/VibeLang implementation via ~55,685 differential fuzz queries.
- **Cloudflare Sandbox isolation** (`scripts/box-replay.mjs`) for replaying untrusted repositories with zero host secrets or host checkouts.

## Try it today

Run `bunx smithers-ci --commits 5` in any Linux or macOS Git repository, or read the full documentation at [ci.smithers.sh/docs](https://ci.smithers.sh/docs).
