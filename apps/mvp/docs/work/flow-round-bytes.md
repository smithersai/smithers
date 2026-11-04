---
title: Bound file-tree round cursor history
status: done
area: flows
owner: codex-roundbytes
updated: 2026-11-03
links: []
---

Measured main at d1a1e834 on the mini with fresh SQLite stores, the roundperf synthetic flow, and the real file-tree test seam. Library catalog entries: `@smthrs/flow`, `@smthrs/engine-store`, `@smthrs/platform-node`. This private lane must not land or push; its report and exact review receipt go only to the requesting session.

The generic engine remains bounded. The second growth is `Cursor.nodes`: `advance()` kept every completed tree node, and each successor copied that map into its payload and handoff result. The node-heavy fixture's round-800 state/journal bytes were 6,807/37,195; after pruning dead mappings they are 1,549/20,200. Necessary live parents remain, including null failure markers. The action records optional `forgetNodes`, so cleanup replays deterministically and old outcomes still decode. History remains in settled round records and journals. Arbitrary live inputs can still grow; this does not establish the cause of every production timing increase or change #4438.

The deterministic byte gate failed before the fix (late state 6,807 > 2,599 bytes), then passed for both flows through 800 rounds, with a fresh-host SQLite replay that runs no settled action again. All 12 file-tree tests pass, as does the CLI test killed between create/attach and after a send, with no duplicate writes. The repository flow VibeLang typecheck passes. The original roundperf harness also passes 800 rounds. No wall-clock threshold or full-suite coverage claim is made. The byte gate is part of the existing issuesFileTree target; its generated target-index entry was regenerated and drift-checked on the mini. Its documentation defines byte accounting and the linear retained-history contract.
