---
title: Refuse malformed landing locks immediately
status: done
area: process
owner: Codex
updated: 2026-11-03
links: [land-to-main.md, ../../../../../.smithers/flows/land/workspace.mjs, ../../../../../.smithers/flows/land/workspace.test.mjs]
---

The bootstrap land helper must reject a non-directory lock immediately, name
its path and filesystem type, and preserve it for an operator to investigate.
It must continue to wait for directory locks without reclaiming them.

The shared `acquireLock` implementation also protects `commit.mjs`; that entry
point needs no separate implementation. This repairs the existing bootstrap
helper using Node's filesystem API, as the maintenance skill permits; no new
library or flow runtime is introduced.

Validation: `node --test .smithers/flows/land/workspace.test.mjs`. The regular
file regression failed before the fix after the full 1,200 ms test timeout.
After the fix, all 16 tests pass, including prompt regular-file rejection
(2.1 ms), unchanged inode/content, symlink preservation, directory contention,
and bounded waits. The review tool stores independent review receipts.
Publication is not authorized.
